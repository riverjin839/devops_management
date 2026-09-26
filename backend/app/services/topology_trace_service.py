import os
from dataclasses import dataclass, field
from typing import Optional

from kubernetes import client
from kubernetes.client.rest import ApiException
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.services.cilium_policy_analyzer import CiliumPolicyAnalyzer
from app.services.k8s_client_pool import K8sClientError, get_api_client_for_path, get_incluster_api_client
from app.services.kubeconfig import ensure_kubeconfig_file


@dataclass
class TraceTarget:
    target_type: str
    target_name: str


@dataclass
class PacketFlowRequest:
    host: str
    path: str = "/"
    protocol: str = "https"


@dataclass
class PacketFlowRequestV2:
    """확장된 패킷 흐름 추적 요청.

    direction=north-south: source 는 external FQDN/IP, destination 은
      "ingress-host:/path" 또는 "ns/service:port".
    direction=east-west: source 는 "ns/pod", destination 은 "ns/pod" 또는
      "ns/service:port".
    """
    direction: str               # "north-south" | "east-west"
    source: str                  # N-S: "internet" | FQDN/IP.  E-W: "ns/pod"
    destination: str             # "ns/pod" | "ns/service:port" | host+path
    protocol: str = "tcp"        # "tcp" | "http" | "https" | "grpc" | "udp"
    port: int | None = None
    path: str = "/"              # host 기반 ingress 에만 사용


class TopologyTraceService:
    def __init__(self, db: Session, cluster: Cluster):
        self.db = db
        self.cluster = cluster
        self._core_v1: client.CoreV1Api | None = None
        self._discovery_v1: client.DiscoveryV1Api | None = None
        self._api: client.ApiClient | None = None

    def _api_client(self) -> client.ApiClient:
        """클러스터별 격리 풀 클라이언트.

        예전엔 전역 `config.load_kube_config()` 로 로드해 동시 요청이 다른 클러스터로 새는 race 가
        있었고, `kubeconfig_path` 만 봐서 컨테이너 재시작으로 파일이 사라지면 in-cluster(= PEP 자신의
        클러스터)로 조용히 폴백하는 오답이 있었다. DB content 로 파일을 재생성하고(ensure), 등록된
        kubeconfig 가 아예 없을 때만 in-cluster 를 쓴다(로컬 기본 kubeconfig 폴백 없음).
        """
        if self._api is not None:
            return self._api
        kubeconfig = ensure_kubeconfig_file(self.cluster)
        if kubeconfig and os.path.exists(kubeconfig):
            self._api = get_api_client_for_path(kubeconfig)
            return self._api
        try:
            self._api = get_incluster_api_client(allow_local_fallback=False)
        except K8sClientError as e:
            if self.cluster.kubeconfig_path or getattr(self.cluster, "kubeconfig_content", None):
                raise ValueError(f"kubeconfig 파일을 찾을 수 없습니다: '{self.cluster.kubeconfig_path}'") from e
            raise ValueError(
                f"클러스터 '{self.cluster.name}'에 kubeconfig_path가 설정되지 않았고 in-cluster 환경도 아닙니다"
            ) from e
        return self._api

    def _get_clients(self) -> tuple[client.CoreV1Api, client.DiscoveryV1Api]:
        if self._core_v1 and self._discovery_v1:
            return self._core_v1, self._discovery_v1

        api = self._api_client()
        self._core_v1 = client.CoreV1Api(api)
        self._discovery_v1 = client.DiscoveryV1Api(api)
        return self._core_v1, self._discovery_v1

    def _get_networking_client(self) -> client.NetworkingV1Api:
        return client.NetworkingV1Api(self._api_client())

    @staticmethod
    def _safe_error_count(pod: client.V1Pod | None, node: client.V1Node | None) -> int | None:
        if pod and pod.status and pod.status.container_statuses:
            return sum(cs.restart_count or 0 for cs in pod.status.container_statuses)

        if node and node.status and node.status.conditions:
            not_ready = [c for c in node.status.conditions if c.type == "Ready" and c.status != "True"]
            return len(not_ready)

        return None

    @staticmethod
    def _safe_latency_ms(pod: client.V1Pod | None, node: client.V1Node | None) -> float | None:
        source = None
        if pod and pod.metadata and pod.metadata.annotations:
            source = pod.metadata.annotations
        elif node and node.metadata and node.metadata.annotations:
            source = node.metadata.annotations

        if not source:
            return None

        for key in ("monitoring.k8s.io/latency-ms", "topology.k8s.io/latency-ms", "latency_ms"):
            if key in source:
                try:
                    return float(source[key])
                except (TypeError, ValueError):
                    return None
        return None

    @staticmethod
    def _resolve_interface(node_obj: client.V1Node | None, infra_node: InfraNode | None) -> str | None:
        if node_obj and node_obj.metadata and node_obj.metadata.annotations:
            annotations = node_obj.metadata.annotations
            for key in ("topology.k8s.io/uplink-port", "network.kubernetes.io/uplink"):
                if key in annotations:
                    return annotations[key]

        if infra_node and infra_node.notes:
            for line in infra_node.notes.splitlines():
                line = line.strip()
                if line.lower().startswith("port:"):
                    return line.split(":", 1)[1].strip() or None

        return None

    def _build_hop(
        self,
        *,
        entity_type: str,
        entity_id: str,
        name: str,
        interface: str | None = None,
        latency_ms: float | None = None,
        error_count: int | None = None,
    ) -> dict:
        return {
            "entity_type": entity_type,
            "entity_id": entity_id,
            "name": name,
            "interface": interface,
            "latency_ms": latency_ms,
            "error_count": error_count,
        }

    def _get_pod(self, namespace: str, pod_name: str) -> client.V1Pod:
        core_v1, _ = self._get_clients()
        return core_v1.read_namespaced_pod(name=pod_name, namespace=namespace)

    def _get_service_backend_pod(self, namespace: str, service_name: str) -> client.V1Pod:
        core_v1, discovery_v1 = self._get_clients()

        slices = discovery_v1.list_namespaced_endpoint_slice(
            namespace=namespace,
            label_selector=f"kubernetes.io/service-name={service_name}",
        )

        for eps in slices.items:
            for endpoint in eps.endpoints or []:
                target_ref = endpoint.target_ref
                if target_ref and target_ref.kind == "Pod" and target_ref.name:
                    return core_v1.read_namespaced_pod(name=target_ref.name, namespace=namespace)

        raise ValueError(f"service '{service_name}'에 연결된 endpoint pod를 찾지 못했습니다")

    def trace(self, namespace: str, target: TraceTarget) -> list[dict]:
        core_v1, _ = self._get_clients()

        if target.target_type not in {"service", "pod"}:
            raise ValueError("target_type은 'service' 또는 'pod' 이어야 합니다")

        if target.target_type == "pod":
            pod = self._get_pod(namespace, target.target_name)
            entry_hop = self._build_hop(
                entity_type="pod",
                entity_id=pod.metadata.uid,
                name=pod.metadata.name,
                interface=pod.status.pod_ip,
                latency_ms=self._safe_latency_ms(pod, None),
                error_count=self._safe_error_count(pod, None),
            )
        else:
            pod = self._get_service_backend_pod(namespace, target.target_name)
            entry_hop = self._build_hop(
                entity_type="service",
                entity_id=target.target_name,
                name=target.target_name,
                interface=None,
                latency_ms=None,
                error_count=None,
            )

        if not pod.spec or not pod.spec.node_name:
            raise ValueError(f"pod '{pod.metadata.name}' 의 node 정보를 찾지 못했습니다")

        node = core_v1.read_node(name=pod.spec.node_name)
        infra_node = self.db.query(InfraNode).filter(
            InfraNode.cluster_id == self.cluster.id,
            InfraNode.hostname == node.metadata.name,
        ).first()

        hops: list[dict] = [entry_hop]

        if target.target_type == "service":
            hops.append(
                self._build_hop(
                    entity_type="pod",
                    entity_id=pod.metadata.uid,
                    name=pod.metadata.name,
                    interface=pod.status.pod_ip,
                    latency_ms=self._safe_latency_ms(pod, None),
                    error_count=self._safe_error_count(pod, None),
                )
            )

        node_interface = self._resolve_interface(node, infra_node)
        hops.append(
            self._build_hop(
                entity_type="node",
                entity_id=node.metadata.uid,
                name=node.metadata.name,
                interface=node_interface,
                latency_ms=self._safe_latency_ms(None, node),
                error_count=self._safe_error_count(None, node),
            )
        )

        switch_name = infra_node.switch_name if infra_node and infra_node.switch_name else "unknown-switch"
        hops.append(
            self._build_hop(
                entity_type="switch",
                entity_id=switch_name,
                name=switch_name,
                interface=node_interface,
                latency_ms=None,
                error_count=None,
            )
        )

        link_id = f"{node.metadata.name}:{node_interface or 'uplink'}->{switch_name}"
        hops.append(
            self._build_hop(
                entity_type="link",
                entity_id=link_id,
                name=link_id,
                interface=node_interface,
                latency_ms=None,
                error_count=None,
            )
        )

        return hops

    # ── Packet flow (외부 client → 내부 pod) ──────────────────────────
    def _find_ingress_for_host(
        self, host: str, path: str
    ) -> tuple[client.V1Ingress, client.V1IngressBackend, str]:
        """Search all namespaces for an Ingress matching the given host/path."""
        networking_v1 = self._get_networking_client()
        ingresses = networking_v1.list_ingress_for_all_namespaces()

        for ing in ingresses.items:
            for rule in ing.spec.rules or []:
                rule_host = getattr(rule, "host", None)
                if rule_host and rule_host != host:
                    continue
                http = getattr(rule, "http", None)
                if not http or not http.paths:
                    continue
                for p in http.paths:
                    p_path = p.path or "/"
                    if path == p_path or path.startswith(p_path.rstrip("*")):
                        return ing, p.backend, ing.metadata.namespace

        raise ValueError(f"host '{host}' path '{path}'에 매칭되는 Ingress를 찾지 못했습니다")

    def _get_service(self, namespace: str, service_name: str) -> client.V1Service:
        core_v1, _ = self._get_clients()
        return core_v1.read_namespaced_service(name=service_name, namespace=namespace)

    def _service_entry_info(self, svc: client.V1Service) -> tuple[str, Optional[str]]:
        """Return (entry_label, external_address) describing the service entry type."""
        spec = svc.spec
        svc_type = spec.type or "ClusterIP"

        if svc_type == "LoadBalancer":
            lb = svc.status.load_balancer if svc.status else None
            if lb and lb.ingress:
                ext = lb.ingress[0]
                addr = ext.ip or ext.hostname
                return ("LoadBalancer", addr)
            return ("LoadBalancer", None)

        if svc_type == "NodePort":
            ports = spec.ports or []
            node_ports = [str(p.node_port) for p in ports if p.node_port]
            return ("NodePort", f":{','.join(node_ports)}" if node_ports else None)

        return ("ClusterIP", spec.cluster_ip)

    def _find_ingress_controller_pod(self, ing: client.V1Ingress) -> Optional[client.V1Pod]:
        """Try to locate an Ingress-controller pod via IngressClass → controller deploy."""
        core_v1, _ = self._get_clients()

        class_name = (
            ing.spec.ingress_class_name
            or (ing.metadata.annotations or {}).get("kubernetes.io/ingress.class")
        )

        selectors = [
            "app.kubernetes.io/name=ingress-nginx",
            "app.kubernetes.io/component=controller",
            "app=istio-ingressgateway",
            "app=traefik",
        ]
        if class_name:
            selectors.insert(0, f"app.kubernetes.io/instance={class_name}")

        for selector in selectors:
            pods = core_v1.list_pod_for_all_namespaces(label_selector=selector, limit=1)
            if pods.items:
                return pods.items[0]
        return None

    def trace_packet_flow(self, req: PacketFlowRequest) -> list[dict]:
        """Trace the full E2E packet path: external client → pod → switch."""
        core_v1, _ = self._get_clients()

        hops: list[dict] = []

        # 1. External client
        hops.append(
            self._build_hop(
                entity_type="client",
                entity_id="external-client",
                name="External Client",
                interface=f"{req.protocol}://{req.host}{req.path}",
            )
        )

        # 2. DNS (logical hop)
        hops.append(
            self._build_hop(
                entity_type="dns",
                entity_id=req.host,
                name=req.host,
                interface="DNS lookup",
            )
        )

        # 3. Ingress resource lookup
        ing, backend, ing_ns = self._find_ingress_for_host(req.host, req.path)

        # 4. Ingress Controller pod (LB / NodePort entry)
        ctrl_pod = self._find_ingress_controller_pod(ing)
        if ctrl_pod:
            hops.append(
                self._build_hop(
                    entity_type="ingress_controller",
                    entity_id=ctrl_pod.metadata.uid,
                    name=f"{ctrl_pod.metadata.namespace}/{ctrl_pod.metadata.name}",
                    interface=ctrl_pod.status.pod_ip if ctrl_pod.status else None,
                    latency_ms=self._safe_latency_ms(ctrl_pod, None),
                    error_count=self._safe_error_count(ctrl_pod, None),
                )
            )
        else:
            hops.append(
                self._build_hop(
                    entity_type="ingress_controller",
                    entity_id="unknown-ingress",
                    name="Ingress Controller (unknown)",
                )
            )

        # 5. Ingress resource
        hops.append(
            self._build_hop(
                entity_type="ingress",
                entity_id=ing.metadata.uid,
                name=f"{ing_ns}/{ing.metadata.name}",
                interface=f"{req.host}{req.path}",
            )
        )

        # 6. Service
        svc_ref = backend.service
        if not svc_ref or not svc_ref.name:
            raise ValueError("Ingress backend에 service 정보가 없습니다")

        svc = self._get_service(ing_ns, svc_ref.name)
        entry_label, ext_addr = self._service_entry_info(svc)
        svc_port = svc_ref.port.number if svc_ref.port else None
        svc_interface = f"{svc.spec.cluster_ip}:{svc_port}" if svc_port else svc.spec.cluster_ip

        hops.append(
            self._build_hop(
                entity_type="service",
                entity_id=svc.metadata.uid,
                name=f"{ing_ns}/{svc.metadata.name} ({entry_label})",
                interface=ext_addr or svc_interface,
            )
        )

        # 7. Backend pod (via EndpointSlice)
        pod = self._get_service_backend_pod(ing_ns, svc.metadata.name)
        hops.append(
            self._build_hop(
                entity_type="pod",
                entity_id=pod.metadata.uid,
                name=f"{pod.metadata.namespace}/{pod.metadata.name}",
                interface=pod.status.pod_ip if pod.status else None,
                latency_ms=self._safe_latency_ms(pod, None),
                error_count=self._safe_error_count(pod, None),
            )
        )

        if not pod.spec or not pod.spec.node_name:
            raise ValueError(f"pod '{pod.metadata.name}' 의 node 정보를 찾지 못했습니다")

        # 8. Node
        node = core_v1.read_node(name=pod.spec.node_name)
        infra_node = self.db.query(InfraNode).filter(
            InfraNode.cluster_id == self.cluster.id,
            InfraNode.hostname == node.metadata.name,
        ).first()

        node_interface = self._resolve_interface(node, infra_node)
        hops.append(
            self._build_hop(
                entity_type="node",
                entity_id=node.metadata.uid,
                name=node.metadata.name,
                interface=node_interface,
                latency_ms=self._safe_latency_ms(None, node),
                error_count=self._safe_error_count(None, node),
            )
        )

        # 9. Switch (ToR)
        switch_name = infra_node.switch_name if infra_node and infra_node.switch_name else "unknown-switch"
        hops.append(
            self._build_hop(
                entity_type="switch",
                entity_id=switch_name,
                name=switch_name,
                interface=node_interface,
            )
        )

        return hops


    # ── v2 — 정책/Identity/Cilium-config 정보가 주입된 확장 trace ────────────

    def _build_hop_v2(
        self,
        *,
        entity_type: str,
        entity_id: str,
        name: str,
        interface: str | None = None,
        latency_ms: float | None = None,
        error_count: int | None = None,
        verdict: str = "info",          # "allow" | "deny" | "warn" | "info"
        notes: list[str] | None = None,
        policies: list[dict] | None = None,
        identity: dict | None = None,
        refs: list[dict] | None = None,
    ) -> dict:
        return {
            "entity_type": entity_type,
            "entity_id": entity_id,
            "name": name,
            "interface": interface,
            "latency_ms": latency_ms,
            "error_count": error_count,
            "verdict": verdict,
            "notes": notes or [],
            "policies": policies or [],
            "identity": identity,
            "refs": refs or [],
        }

    def _parse_ns_target(self, s: str) -> tuple[str, str, int | None]:
        """'default/my-svc:80' 또는 'default/pod' → (ns, name, port)."""
        name_part = s
        port: int | None = None
        if ":" in s:
            name_part, port_s = s.rsplit(":", 1)
            try:
                port = int(port_s)
            except ValueError:
                port = None
        if "/" not in name_part:
            raise ValueError(f"대상은 'namespace/name' 형식이어야 합니다: '{s}'")
        ns, name = name_part.split("/", 1)
        return ns, name, port

    def _resolve_pod(self, ns: str, name: str) -> client.V1Pod:
        core_v1, _ = self._get_clients()
        try:
            return core_v1.read_namespaced_pod(name=name, namespace=ns)
        except ApiException as e:
            if e.status == 404:
                raise ValueError(f"pod '{ns}/{name}' 를 찾을 수 없습니다") from e
            raise

    def _dest_kind(self, dest: str, has_ingress_host_hint: bool) -> str:
        """대상이 pod / service / ingress-host 중 무엇인지."""
        if "/" in dest:
            # ns/xxx[:port] 형식 — pod vs service 는 실제 조회로 판단
            ns, name, _ = self._parse_ns_target(dest)
            try:
                self._get_service(ns, name)
                return "service"
            except Exception:
                return "pod"
        # "/" 가 없으면 host (ingress)
        return "ingress-host" if has_ingress_host_hint else "unknown"

    def trace_v2(self, req: PacketFlowRequestV2) -> list[dict]:
        """확장 패킷 흐름. direction + source + destination 기반.

        반환 hop 은 기존 v1 포맷 상위호환: 추가 필드 verdict/notes/policies/identity/refs.
        """
        core_v1, _ = self._get_clients()
        net_v1 = self._get_networking_client()
        custom_api = client.CustomObjectsApi(self._api_client())
        analyzer = CiliumPolicyAnalyzer(core=core_v1, net=net_v1, custom=custom_api)
        cilium_cfg = analyzer.get_cilium_config()

        def cfg_note() -> list[str]:
            notes = []
            kpr = cilium_cfg.get("kube-proxy-replacement")
            if kpr and kpr.lower() in ("strict", "true", "enabled"):
                notes.append("Cilium kpr(kubeProxyReplacement) 활성 — kube-proxy 건너뜀")
            lb_mode = cilium_cfg.get("bpf-lb-mode")
            if lb_mode:
                notes.append(f"bpf-lb-mode={lb_mode}")
            routing = cilium_cfg.get("routing-mode") or cilium_cfg.get("tunnel")
            if routing:
                notes.append(f"routing-mode={routing}")
            return notes

        hops: list[dict] = []

        if req.direction not in ("north-south", "east-west"):
            raise ValueError("direction 은 'north-south' 또는 'east-west' 여야 합니다")

        # ── N-S: External → DNS → Ingress → Service → Pod → Node → Switch
        if req.direction == "north-south":
            # 1. External
            hops.append(self._build_hop_v2(
                entity_type="external", entity_id="external-client",
                name="External Client", interface=req.source or "internet",
                verdict="info", notes=["외부 네트워크 진입점"],
            ))

            host_like = ("." in req.destination and "/" not in req.destination) \
                        or (req.destination.startswith(req.source) if req.source else False)
            dest_kind = self._dest_kind(req.destination, has_ingress_host_hint=host_like)

            # 2. Ingress host 기반: DNS → Ingress pod → Ingress resource → Service → Pod
            if dest_kind == "ingress-host" or "." in (req.destination.split("/", 1)[0] if "/" in req.destination else req.destination):
                host = req.destination.split("/", 1)[0]
                path = req.path or "/"
                hops.append(self._build_hop_v2(
                    entity_type="dns", entity_id=host, name=host,
                    interface=f"DNS → A/AAAA", verdict="info",
                ))
                try:
                    ing, backend, ing_ns = self._find_ingress_for_host(host, path)
                except Exception:
                    ing, backend, ing_ns = None, None, None

                ctrl_pod = self._find_ingress_controller_pod(ing) if ing else None
                if ctrl_pod:
                    pol = analyzer.analyze_for_pod(ctrl_pod)
                    hops.append(self._build_hop_v2(
                        entity_type="ingress_controller",
                        entity_id=ctrl_pod.metadata.uid,
                        name=f"{ctrl_pod.metadata.namespace}/{ctrl_pod.metadata.name}",
                        interface=ctrl_pod.status.pod_ip if ctrl_pod.status else None,
                        latency_ms=self._safe_latency_ms(ctrl_pod, None),
                        error_count=self._safe_error_count(ctrl_pod, None),
                        verdict="allow",
                        notes=cfg_note(),
                        policies=pol["ingress_policies"],
                        identity=pol["identity"],
                        refs=[{"kind": "Pod",
                               "name": f"{ctrl_pod.metadata.namespace}/{ctrl_pod.metadata.name}"}],
                    ))
                if ing:
                    hops.append(self._build_hop_v2(
                        entity_type="ingress", entity_id=ing.metadata.uid,
                        name=f"{ing_ns}/{ing.metadata.name}",
                        interface=f"{host}{path}", verdict="info",
                        refs=[{"kind": "Ingress", "name": f"{ing_ns}/{ing.metadata.name}"}],
                    ))
                if backend and backend.service:
                    try:
                        svc = self._get_service(ing_ns, backend.service.name)
                        entry_label, ext = self._service_entry_info(svc)
                        port = backend.service.port.number if backend.service.port else None
                        iface = f"{svc.spec.cluster_ip}:{port}" if port else svc.spec.cluster_ip
                        hops.append(self._build_hop_v2(
                            entity_type="service", entity_id=svc.metadata.uid,
                            name=f"{ing_ns}/{svc.metadata.name} ({entry_label})",
                            interface=ext or iface, verdict="info",
                            notes=cfg_note(),
                            refs=[{"kind": "Service", "name": f"{ing_ns}/{svc.metadata.name}"}],
                        ))
                        pod = self._get_service_backend_pod(ing_ns, svc.metadata.name)
                        self._append_pod_and_node(hops, pod, analyzer)
                    except Exception as e:
                        hops.append(self._build_hop_v2(
                            entity_type="error", entity_id="trace-error",
                            name="백엔드 추적 실패", interface=str(e)[:120],
                            verdict="warn",
                        ))
                return hops

            # 대상이 service 또는 pod (ns/xxx 형식)
            ns, name, dst_port = self._parse_ns_target(req.destination)
            port = req.port or dst_port
            if dest_kind == "service":
                svc = self._get_service(ns, name)
                entry_label, ext = self._service_entry_info(svc)
                iface = f"{svc.spec.cluster_ip}:{port}" if port else svc.spec.cluster_ip
                hops.append(self._build_hop_v2(
                    entity_type="service", entity_id=svc.metadata.uid,
                    name=f"{ns}/{svc.metadata.name} ({entry_label})",
                    interface=ext or iface, verdict="info",
                    notes=cfg_note() + [f"ServiceType={svc.spec.type}"],
                    refs=[{"kind": "Service", "name": f"{ns}/{svc.metadata.name}"}],
                ))
                pod = self._get_service_backend_pod(ns, name)
            else:
                pod = self._resolve_pod(ns, name)
            self._append_pod_and_node(hops, pod, analyzer)
            return hops

        # ── E-W: Source pod → Cilium agent(src) → [Service?] → Cilium agent(dst) → Dest pod
        src_ns, src_name, _ = self._parse_ns_target(req.source)
        src_pod = self._resolve_pod(src_ns, src_name)
        src_pol = analyzer.analyze_for_pod(src_pod)

        hops.append(self._build_hop_v2(
            entity_type="pod", entity_id=src_pod.metadata.uid,
            name=f"{src_ns}/{src_pod.metadata.name}",
            interface=src_pod.status.pod_ip if src_pod.status else None,
            verdict="allow" if not src_pol["egress_deny_by_default"] else "warn",
            notes=["Source pod"] + cfg_note(),
            policies=src_pol["egress_policies"],
            identity=src_pol["identity"],
            refs=[{"kind": "Pod", "name": f"{src_ns}/{src_pod.metadata.name}"}],
        ))

        dest_kind = self._dest_kind(req.destination, has_ingress_host_hint=False)
        if dest_kind == "service":
            ns, name, dst_port = self._parse_ns_target(req.destination)
            port = req.port or dst_port
            svc = self._get_service(ns, name)
            iface = f"{svc.spec.cluster_ip}:{port}" if port else svc.spec.cluster_ip
            hops.append(self._build_hop_v2(
                entity_type="service", entity_id=svc.metadata.uid,
                name=f"{ns}/{svc.metadata.name}",
                interface=iface, verdict="info",
                notes=["ClusterIP"] + cfg_note(),
                refs=[{"kind": "Service", "name": f"{ns}/{svc.metadata.name}"}],
            ))
            dst_pod = self._get_service_backend_pod(ns, name)
        else:
            ns, name, _ = self._parse_ns_target(req.destination)
            dst_pod = self._resolve_pod(ns, name)

        dst_pol = analyzer.analyze_for_pod(dst_pod)
        hops.append(self._build_hop_v2(
            entity_type="pod", entity_id=dst_pod.metadata.uid,
            name=f"{dst_pod.metadata.namespace}/{dst_pod.metadata.name}",
            interface=dst_pod.status.pod_ip if dst_pod.status else None,
            verdict="allow" if not dst_pol["ingress_deny_by_default"] else "warn",
            notes=["Destination pod"],
            policies=dst_pol["ingress_policies"],
            identity=dst_pol["identity"],
            refs=[{"kind": "Pod",
                   "name": f"{dst_pod.metadata.namespace}/{dst_pod.metadata.name}"}],
        ))

        # 마지막 홉: dest pod 가 올라가 있는 node + switch 정보
        if dst_pod.spec and dst_pod.spec.node_name:
            self._append_node_switch(hops, dst_pod)

        return hops

    # ── v2 공통 — pod + node + switch 추가 ────────────────────────────────────

    def _append_pod_and_node(
        self,
        hops: list[dict],
        pod: client.V1Pod,
        analyzer: CiliumPolicyAnalyzer,
    ) -> None:
        pol = analyzer.analyze_for_pod(pod)
        hops.append(self._build_hop_v2(
            entity_type="pod", entity_id=pod.metadata.uid,
            name=f"{pod.metadata.namespace}/{pod.metadata.name}",
            interface=pod.status.pod_ip if pod.status else None,
            latency_ms=self._safe_latency_ms(pod, None),
            error_count=self._safe_error_count(pod, None),
            verdict="allow" if not pol["ingress_deny_by_default"] else "warn",
            notes=["Backend pod"],
            policies=pol["ingress_policies"],
            identity=pol["identity"],
            refs=[{"kind": "Pod",
                   "name": f"{pod.metadata.namespace}/{pod.metadata.name}"}],
        ))
        if pod.spec and pod.spec.node_name:
            self._append_node_switch(hops, pod)

    def _append_node_switch(self, hops: list[dict], pod: client.V1Pod) -> None:
        core_v1, _ = self._get_clients()
        try:
            node = core_v1.read_node(name=pod.spec.node_name)
        except Exception:
            return
        infra = self.db.query(InfraNode).filter(
            InfraNode.cluster_id == self.cluster.id,
            InfraNode.hostname == node.metadata.name,
        ).first()
        iface = self._resolve_interface(node, infra)
        hops.append(self._build_hop_v2(
            entity_type="node", entity_id=node.metadata.uid,
            name=node.metadata.name, interface=iface,
            latency_ms=self._safe_latency_ms(None, node),
            error_count=self._safe_error_count(None, node),
            verdict="info",
            refs=[{"kind": "Node", "name": node.metadata.name}],
        ))
        sw_name = infra.switch_name if infra and infra.switch_name else "unknown-switch"
        hops.append(self._build_hop_v2(
            entity_type="switch", entity_id=sw_name,
            name=sw_name, interface=iface, verdict="info",
            notes=["ToR(Top-of-Rack) 스위치"],
        ))


def map_k8s_or_trace_error(e: Exception) -> tuple[int, str]:
    if isinstance(e, ValueError):
        return 400, str(e)

    if isinstance(e, ApiException):
        if e.status == 404:
            return 404, "Kubernetes 리소스를 찾지 못했습니다"
        if e.status in (401, 403):
            return e.status, "Kubernetes API 권한이 부족합니다"
        return 502, e.reason or "Kubernetes API 호출에 실패했습니다"

    return 500, str(e) or "Topology trace 계산에 실패했습니다"
