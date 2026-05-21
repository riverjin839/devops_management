"""
일일 K8s 클러스터 헬스 체크 서비스 (v2: SDK 기반)
- API 서버 상태 체크 (httpx — endpoint probe)
- 컴포넌트 상태 체크 (K8s SDK — kube-scheduler / kube-controller-manager pod)
- 노드 상태 체크 (K8s SDK)
- 시스템 파드 상태 체크 (K8s SDK)

이전 v1 은 subprocess kubectl 기반이라 backend 컨테이너에 kubectl binary 가 필수였고,
componentstatuses 가 K8s 1.27+ 에서 제거돼 silent fail 위험이 있었음. v2 는 BaseChecker
family 와 동일한 SDK 경로를 사용해 패턴 일관성을 확보한다.
"""
import os
import time
from datetime import datetime
from typing import Optional

import httpx
from kubernetes import client, config
from sqlalchemy.orm import Session

from app.models import Cluster, DailyCheckLog, CheckScheduleType, StatusEnum
from app.config import settings
from app.services.kubeconfig import ensure_kubeconfig_file


class DailyChecker:
    def __init__(self, db: Session):
        self.db = db
        self.timeout = settings.check_timeout_seconds
        # cluster 별 K8s client 캐시 — 한 cluster 의 4번 호출 안에서만 재사용
        self._v1: Optional[client.CoreV1Api] = None
        self._v1_cluster_id = None

    # ── K8s client (cluster 별 격리) ──────────────────────
    def _get_k8s_client(self, cluster: Cluster) -> client.CoreV1Api:
        """cluster 별 K8s SDK client.

        다중 cluster 환경에서는 `config.load_kube_config()` 가 global 상태를
        변경해 race 가 생긴다. `config.new_client_from_config()` 는 ApiClient
        를 직접 반환해 process 격리. 한 cluster 의 다중 호출은 instance cache.
        """
        if self._v1 is not None and self._v1_cluster_id == cluster.id:
            return self._v1

        kc_path = ensure_kubeconfig_file(cluster)
        api_client: client.ApiClient
        if kc_path and os.path.exists(kc_path):
            api_client = config.new_client_from_config(config_file=kc_path)
        else:
            try:
                config.load_incluster_config()
                api_client = client.ApiClient()
            except config.ConfigException:
                api_client = config.new_client_from_config()

        self._v1 = client.CoreV1Api(api_client)
        self._v1_cluster_id = cluster.id
        return self._v1

    async def run_daily_check(
        self,
        cluster_id: str,
        schedule_type: CheckScheduleType = CheckScheduleType.manual
    ) -> DailyCheckLog:
        """일일 체크 실행"""
        start_time = time.time()

        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if not cluster:
            raise ValueError(f"Cluster not found: {cluster_id}")

        # 각 체크 수행
        api_result = await self._check_api_server(cluster)
        components_result = await self._check_components(cluster)
        nodes_result = await self._check_nodes(cluster)
        pods_result = await self._check_system_pods(cluster)

        # 전체 상태 결정
        overall_status = self._determine_overall_status(
            api_result, components_result, nodes_result
        )

        # 에러/경고 수집
        errors, warnings = self._collect_messages(
            api_result, components_result, nodes_result, pods_result
        )

        # 체크 로그 생성
        check_log = DailyCheckLog(
            cluster_id=cluster.id,
            schedule_type=schedule_type,
            check_date=datetime.utcnow(),
            overall_status=overall_status,
            # API 서버
            api_server_status=api_result.get("status", StatusEnum.critical),
            api_server_response_time_ms=api_result.get("response_time_ms"),
            api_server_details=api_result.get("details"),
            # 컴포넌트
            components_status=components_result,
            # 노드
            nodes_status=nodes_result.get("nodes"),
            total_nodes=nodes_result.get("total", 0),
            ready_nodes=nodes_result.get("ready", 0),
            # 시스템 파드
            system_pods_status=pods_result,
            # 에러/경고
            error_messages=errors if errors else None,
            warning_messages=warnings if warnings else None,
            # 메타
            check_duration_seconds=int(time.time() - start_time),
        )

        self.db.add(check_log)

        # G-1: DailyChecker 가 cluster.status 의 authoritative source.
        # HealthChecker (addon-based) / DeepCheckService 는 자기 도메인 결과만 갱신.
        # SELECT FOR UPDATE 로 동시 갱신 race 차단 (Beat 09:00 + 사용자 수동 동시 발생 등).
        locked_cluster = (
            self.db.query(Cluster)
            .filter(Cluster.id == cluster.id)
            .with_for_update()
            .first()
        )
        if locked_cluster is not None:
            locked_cluster.status = overall_status
            locked_cluster.updated_at = datetime.utcnow()

        self.db.commit()
        self.db.refresh(check_log)

        # AI 자동 리뷰 + 알림은 Celery 로 비동기 위임 (점검 자체에는 영향 없음).
        # broker(Redis) 가 없거나 worker 가 꺼져 있어도 silently skip.
        try:
            from app.celery_app import run_review_and_notify
            run_review_and_notify.delay(str(check_log.id))
        except Exception:
            import logging
            logging.getLogger(__name__).debug(
                "Skipped AI review dispatch (Celery unavailable)", exc_info=True
            )

        return check_log

    async def _check_api_server(self, cluster: Cluster) -> dict:
        """API 서버 헬스 체크"""
        result = {
            "status": StatusEnum.critical,
            "response_time_ms": None,
            "details": {}
        }

        endpoints = ["/healthz", "/livez", "/readyz"]

        # cluster.tls_verify 옵트인. 기본 False (자체 서명 인증서 환경 호환).
        verify_tls = bool(getattr(cluster, "tls_verify", False))

        try:
            async with httpx.AsyncClient(verify=verify_tls, timeout=self.timeout) as client_:
                for endpoint in endpoints:
                    url = f"{cluster.api_endpoint}{endpoint}"
                    start = time.time()
                    try:
                        response = await client_.get(url)
                        response_time = int((time.time() - start) * 1000)

                        result["details"][endpoint] = {
                            "status_code": response.status_code,
                            "response_time_ms": response_time,
                            "body": response.text[:500] if response.text else None
                        }

                        if endpoint == "/healthz":
                            result["response_time_ms"] = response_time

                    except Exception as e:
                        result["details"][endpoint] = {
                            "error": str(e)
                        }

            # 상태 결정
            healthz = result["details"].get("/healthz", {})
            if healthz.get("status_code") == 200:
                if result["response_time_ms"] and result["response_time_ms"] < 3000:
                    result["status"] = StatusEnum.healthy
                else:
                    result["status"] = StatusEnum.warning
            else:
                result["status"] = StatusEnum.critical

        except Exception as e:
            result["details"]["error"] = str(e)

        return result

    async def _check_components(self, cluster: Cluster) -> dict:
        """Control plane 컴포넌트 체크 (SDK 기반).

        K8s 1.27+ 에서 componentstatuses API 가 제거됨. 대안으로 kube-system 의
        kube-scheduler, kube-controller-manager pod 상태로 판단. 동일 정보를
        addon-based `ControlPlaneChecker` 도 점검하지만, daily check 가 addon
        등록과 무관하게 control plane 기본 건강도를 확보하기 위해 자체 점검.
        """
        components: dict = {}

        # 라벨 ↔ 표시 이름
        targets = [
            ("component=kube-scheduler", "scheduler"),
            ("component=kube-controller-manager", "controller-manager"),
        ]

        try:
            v1 = self._get_k8s_client(cluster)
            for label, name in targets:
                try:
                    pods = v1.list_namespaced_pod(
                        namespace="kube-system",
                        label_selector=label,
                        timeout_seconds=self.timeout,
                    )
                except Exception as e:
                    components[name] = {
                        "status": StatusEnum.critical.value,
                        "message": f"list_namespaced_pod failed: {str(e)[:120]}",
                    }
                    continue

                total = len(pods.items)
                running_ready = sum(
                    1 for p in pods.items
                    if p.status.phase == "Running"
                    and all(cs.ready for cs in (p.status.container_statuses or []))
                )

                if total == 0:
                    status_val = StatusEnum.critical.value
                    msg = f"No {name} pods found"
                elif running_ready < total:
                    status_val = StatusEnum.warning.value
                    msg = f"{running_ready}/{total} ready"
                else:
                    status_val = StatusEnum.healthy.value
                    msg = f"{running_ready}/{total} ready"

                components[name] = {
                    "status": status_val,
                    "message": msg,
                    "ready": running_ready,
                    "total": total,
                }
        except Exception as e:
            components["error"] = f"K8s SDK init failed: {str(e)[:200]}"

        return components

    async def _check_nodes(self, cluster: Cluster) -> dict:
        """노드 상태 체크 (SDK 기반, NodeChecker 와 동일 로직)."""
        result: dict = {"nodes": [], "total": 0, "ready": 0}

        try:
            v1 = self._get_k8s_client(cluster)
            nodes = v1.list_node(timeout_seconds=self.timeout)
            result["total"] = len(nodes.items)

            for node in nodes.items:
                name = node.metadata.name
                conditions = {c.type: c for c in (node.status.conditions or [])}
                ready_cond = conditions.get("Ready")
                node_ready = bool(ready_cond and ready_cond.status == "True")

                if node_ready:
                    result["ready"] += 1

                capacity = node.status.capacity or {}
                result["nodes"].append({
                    "name": name,
                    "status": "Ready" if node_ready else "NotReady",
                    "cpu": capacity.get("cpu", "N/A"),
                    "memory": capacity.get("memory", "N/A"),
                    "pods": capacity.get("pods", "N/A"),
                })

        except Exception as e:
            result["error"] = str(e)[:300]

        return result

    async def _check_system_pods(self, cluster: Cluster) -> list:
        """kube-system 파드 상태 체크 (SDK 기반)."""
        pods: list = []

        try:
            v1 = self._get_k8s_client(cluster)
            pod_list = v1.list_namespaced_pod(
                namespace="kube-system",
                timeout_seconds=self.timeout,
            )
            for p in pod_list.items:
                restart_count = sum(
                    cs.restart_count or 0 for cs in (p.status.container_statuses or [])
                )
                pods.append({
                    "name": p.metadata.name,
                    "namespace": "kube-system",
                    "status": p.status.phase or "Unknown",
                    "restarts": restart_count,
                })

        except Exception as e:
            pods.append({"error": str(e)[:300]})

        return pods

    def _determine_overall_status(
        self, api_result: dict, components: dict, nodes: dict
    ) -> StatusEnum:
        """전체 상태 결정"""
        # API 서버 연결 자체가 실패했으면 pending(미연결) — 그 외 addon 결과는
        # 의미 없으므로 여기서 종료. critical 은 "연결은 되는데 addon 심각" 전용.
        if api_result.get("status") == StatusEnum.critical:
            return StatusEnum.pending

        # 컴포넌트 중 critical이 있으면 전체 critical
        for comp_name, comp_data in components.items():
            # error / _meta 같은 메타 키는 건너뜀
            if comp_name in ("error", "_meta"):
                continue
            if comp_data.get("status") == "critical":
                return StatusEnum.critical

        # 노드가 하나도 Ready가 아니면 critical
        if nodes.get("total", 0) > 0 and nodes.get("ready", 0) == 0:
            return StatusEnum.critical

        # 일부 노드가 NotReady면 warning
        if nodes.get("ready", 0) < nodes.get("total", 0):
            return StatusEnum.warning

        # API 서버가 warning이면 전체 warning
        if api_result.get("status") == StatusEnum.warning:
            return StatusEnum.warning

        return StatusEnum.healthy

    def _collect_messages(
        self, api_result: dict, components: dict, nodes: dict, pods: list
    ) -> tuple:
        """에러/경고 메시지 수집"""
        errors = []
        warnings = []

        # API 서버 에러
        if api_result.get("status") == StatusEnum.critical:
            errors.append(f"API Server: {api_result.get('details', {}).get('error', 'Unhealthy')}")

        # 컴포넌트 에러
        for name, data in components.items():
            if name == "error":
                errors.append(f"Components check failed: {data}")
            elif name == "_meta":
                if data.get("deprecated") or data.get("skipped"):
                    warnings.append(
                        f"componentstatuses 건너뜀: {data.get('reason', 'skipped')}"
                    )
            elif data.get("status") == "critical":
                errors.append(f"Component {name}: {data.get('message', 'Unhealthy')}")
            elif data.get("status") == "warning":
                warnings.append(f"Component {name}: {data.get('message', 'degraded')}")

        # 노드 에러
        not_ready = nodes.get("total", 0) - nodes.get("ready", 0)
        if not_ready > 0:
            warnings.append(f"{not_ready} node(s) not ready")

        # 파드 에러 (재시작 많은 파드)
        for pod in pods:
            if pod.get("restarts", 0) > 10:
                warnings.append(f"Pod {pod.get('name')} has {pod.get('restarts')} restarts")

        return errors, warnings
