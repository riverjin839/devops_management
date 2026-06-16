# K8S 운영 점검 항목 (Ops Checklist)

> **목적** — PEP 의 K8s 운영 점검을 체계적으로 고도화하기 위한 **단일 카탈로그**.
> 현재 구현된 점검(딥체크 / 일일점검 / 리소스 스냅샷)과, 아직 없는 **고도화 대상 항목**을
> 한 곳에 모아 두고, 이 문서를 기준으로 점검 항목을 단계적으로 추가한다.
>
> **사용법** — 새 점검을 추가할 때는 이 문서의 "미구현" 항목 중 하나를 골라
> `add-deep-checker` 스킬(`backend/app/services/deep_checkers/`)로 구현하고,
> 상태를 `✅ 구현됨` 으로 갱신한다. 이미 있는 항목은 `check_type` 컬럼으로
> 기존 체커를 식별할 수 있다.

## 상태 범례

| 표기 | 의미 |
|---|---|
| ✅ | 구현됨 — 자동 점검(딥체크/일일점검/스냅샷)으로 수집 |
| 🟡 | 부분 구현 — 메타데이터만 수집 / 수동(PromQL·임의명령) 가능 / 일부 조건부 |
| ⬜ | 미구현 — **고도화 대상** |

## 기존 구현 자산 (참조)

- **딥체크 레지스트리**: `backend/app/services/deep_checkers/registry.py` (`REGISTRY`, `STEP_PLANS`)
- **일일점검**: `backend/app/services/daily_checker.py` (`_check_api_server` / `_check_components` / `_check_nodes` / `_check_system_pods`)
- **리소스 수 스냅샷**: `backend/app/services/resource_count_service.py` + `metric_checklist_items`
- **PromQL 메트릭 카드**: `backend/app/routers/promql.py` (임의 PromQL 카드 CRUD)
- **노드 스펙/런타임**: `backend/app/routers/node_server_specs.py`, `backend/app/routers/k8s_resources.py` (rich nodes)

---

## 1. Control Plane (`category: k8s`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| API Server 헬스 | `/healthz`·`/livez`·`/readyz` 응답 + 응답시간 | 200 OK, < 1s | ✅ | 일일점검 `_check_api_server` |
| ComponentStatuses | scheduler / controller-manager / etcd 컴포넌트 상태 | 모두 Healthy | ✅ | 일일점검 `_check_components` |
| etcd 단편화 / 알람 | `etcdctl endpoint status` + `alarm list` | 단편화 warn 30% / crit 50% | ✅ | `etcd_defrag` |
| 인증서 만료 | `kubeadm certs check-expiration` 잔여일 | warn 30d / crit 7d | ✅ | `cert_expiry` |
| etcd 백업 존재/신선도 | 최근 etcd 스냅샷 백업 시각·크기 | 최근 24h 이내 | ⬜ | (신규) `etcd_backup` |
| API Server 감사로그 활성 | audit-policy ConfigMap 존재 | 존재 | 🟡 | `audit_rbac` (정책 존재만) |
| 컨트롤플레인 HA | API/etcd 노드 수, leader 분포 | ≥3 홀수 | ⬜ | (신규) `controlplane_ha` |

## 2. Nodes / OS (`category: os` / `k8s`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| 노드 Ready | NotReady 노드 수 | 0 | ✅ | 일일점검 `_check_nodes` |
| 노드 Pressure | Disk/Memory/PID Pressure, NetworkUnavailable | warn 1 / crit 3 노드 | ✅ | `node_pressure` |
| OS 커널 파라미터 드리프트 | sysctl 스냅샷 연속 비교 | 변경 warn 1 / crit 20 | ✅ | `kernel_param_drift` (기본 off) |
| 컨테이너 런타임 버전 | `containerRuntimeVersion` 수집·표시 | — | 🟡 | `node_server_specs` (메타만) |
| **containerd 사용률** | containerd 데몬 CPU/메모리/디스크, `crictl stats` | 노드당 임계 | ⬜ | (신규) `containerd_usage` |
| containerd health | `crictl info` / `ctr` 응답, 좀비 컨테이너 | 응답 OK | ⬜ | (신규) `containerd_health` |
| 노드 디스크 사용률 | `/`, `/var/lib/{kubelet,containerd}` 사용률 | warn 80% / crit 90% | ⬜ | (신규) `node_disk_usage` |
| kubelet health | kubelet `/healthz`, 버전 스큐 | OK, ±1 minor | 🟡 | rich nodes(버전만) |
| 노드 시각 동기화(NTP) | chrony/ntp drift | < 1s | ⬜ | (신규) `node_time_sync` |
| 노드 CPU/메모리 사용률 | metrics-server 노드 usage | warn 80% / crit 90% | 🟡 | rich nodes (조건부) |

## 3. Workloads (`category: k8s`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| kube-system 파드 | 시스템 파드 Ready/Running | 모두 정상 | ✅ | 일일점검 `_check_system_pods` |
| ImagePull / CrashLoop | ImagePullBackOff·ErrImagePull·CrashLoopBackOff | warn 1 / crit 5 | ✅ | `image_pull` |
| OOM / Evicted 이벤트 | 최근 N시간 OOMKilling·Evicted·SystemOOM | warn 1 / crit 5 | ✅ | `oom_events` |
| Stuck Terminating | Terminating N분 이상 잔존 파드 | warn 5m / crit 30m | ✅ | `stuck_terminating` |
| 리소스 수 추세 | pods/deploy/ds/sts/rs/svc/ingress/cm/secret/pvc/job/cronjob/node/ns 일별 스냅샷 | 추세 비교 | ✅ | 리소스 스냅샷 |
| Pending 파드 | 스케줄 안 된 파드(미스케줄 사유) | 0 | ⬜ | (신규) `pending_pods` |
| 복제본 불일치 | Deployment/STS desired≠ready 지속 | 0 | ⬜ | (신규) `replica_mismatch` |
| HPA 포화 | HPA가 max 에 장시간 붙어있음 | — | ⬜ | (신규) `hpa_saturation` |
| 리소스 requests/limits 미설정 | requests/limits 없는 워크로드 비율 | — | ⬜ | (신규) `missing_limits` |

## 4. Network (`category: network`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| CoreDNS 상태 | kube-dns Ready 비율 + 로그 에러율 | warn 1% / crit 5% | ✅ | `coredns_health` |
| Cilium Hubble flow | DROPPED/ERROR 비율 | warn 2% / crit 5% | ✅ | `cni_flow` |
| Pod-to-pod 연결성 | busybox nc TCP probe 실패율 | warn 10% / crit 30% | ✅ | `pod_to_pod` |
| 외부 → 내부 Pod | 외부 노출 endpoint 호출 실패율 | warn 10% / crit 30% | ✅ | `external_to_pod` |
| kube-proxy / iptables·eBPF | kube-proxy Ready, 룰 동기화 | OK | ⬜ | (신규) `kubeproxy_health` |
| Ingress / LB 헬스 | ingress controller, LB endpoint 응답 | OK | ⬜ | (신규) `ingress_health` |
| Service endpoint 비어있음 | Endpoints 0개 Service 검출 | 0 | ⬜ | (신규) `empty_endpoints` |
| NetworkPolicy 커버리지 | NP 없는 namespace | — | ⬜ | (신규) `netpol_coverage` |

## 5. Storage (`category: storage`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| PVC / PV 상태 | Pending/Lost PVC, orphan PV | warn 1 / crit 5 | ✅ | `pvc_health` |
| MinIO health | cluster/live health 엔드포인트 | warn 1% / crit 50% | ✅ | `minio_health` (기본 off) |
| **MinIO(AIStor) S3 호출/응답시간** | S3 API 호출 정상 여부(ListBuckets/HeadBucket/Get·PutObject) + 왕복 응답시간 | 호출 성공, 응답시간 warn 500ms / crit 2s | ⬜ | (신규) `minio_s3_latency` — health 엔드포인트만 보는 `minio_health` 와 분리된 데이터경로 SLO 점검. 파라미터: `endpoints`(S3 base URL)·`access_key`/`secret_key`(민감→백업 마스킹)·`region`·`bucket`/`object_key`(선택)·`http_timeout_seconds`·`verify_tls` |
| PV 사용률 | 볼륨 used/capacity (kubelet volume stats) | warn 80% / crit 90% | ⬜ | (신규) `pv_usage` |
| StorageClass / CSI | default SC 존재, CSI 드라이버 Ready | OK | ⬜ | (신규) `csi_health` |
| VolumeSnapshot 상태 | 스냅샷 readyToUse 실패 | 0 | ⬜ | (신규) `volsnap_health` |

## 6. Add-ons / Application (`category: app`)

> 기존 `addons` 모델 + `services/checkers/*` (argocd / jenkins / keycloak / nexus) 가
> 애드온 health 를 일부 수집한다. 딥체크로의 통합/확장 여지.

| 항목 | 점검 내용 | 상태 | 출처 |
|---|---|---|---|
| ArgoCD | 앱 Sync/Health 상태 | 🟡 | `checkers/argocd_checker.py` |
| Jenkins | 응답/큐 상태 | 🟡 | `checkers/jenkins_checker.py` |
| Keycloak | 응답/realm 상태 | 🟡 | `checkers/keycloak_checker.py` |
| Nexus | 응답/저장소 상태 | 🟡 | `checkers/nexus_checker.py` |
| Prometheus / Grafana | 타깃 up, 룰/alert 상태 | ⬜ | (신규) `monitoring_stack` |
| 인증서(앱 TLS) 만료 | Ingress/secret TLS 인증서 잔여일 | ⬜ | (신규) `app_cert_expiry` |

## 7. Security / RBAC (`category: k8s`)

| 항목 | 점검 내용 | 기준(예시) | 상태 | check_type / 출처 |
|---|---|---|---|---|
| RBAC sprawl | cluster-admin 바인딩 수 | warn 5 / crit 15 | ✅ | `audit_rbac` |
| Audit 정책 존재 | audit-policy ConfigMap | 존재 | 🟡 | `audit_rbac` |
| 위험 RBAC 바인딩 | wildcard verb/resource, anonymous 권한 | 0 | ⬜ | (신규) `rbac_risky` |
| Secret 노출/만료 | 만료 임박 TLS, 평문 노출 | — | ⬜ | (신규) `secret_hygiene` |
| Pod 보안 | privileged / hostPath / hostNetwork 파드 | — | ⬜ | (신규) `pod_security` |

## 8. Capacity / Cost (`category: k8s`)

| 항목 | 점검 내용 | 상태 | 출처 |
|---|---|---|---|
| 리소스 수 추세 | 일/주/월 추세 비교 | ✅ | 리소스 스냅샷 |
| 노드 할당률 | requests vs allocatable | ⬜ | (신규) `node_allocatable` |
| 네임스페이스 쿼터 | ResourceQuota 초과 임박 | ⬜ | (신규) `quota_pressure` |

---

## 고도화 진행 메모

- **신규 항목 구현 절차**: `add-deep-checker` 스킬 → `deep_checkers/<name>_checker.py` 작성 →
  `registry.py` 의 `REGISTRY` + `STEP_PLANS` 등록(도메인 `category` 선언) → 운영 점검 콘솔/크론에 자동 노출.
- **containerd 사용률**(2번 표)은 우선순위 후보. 두 갈래:
  1. **PromQL 우회(즉시)** — 대상 Prometheus 가 cAdvisor/containerd 메트릭을 스크랩하면
     PromQL 메트릭 카드로 표시 가능(클러스터 구성 의존).
  2. **딥체커(본격)** — 노드에서 `crictl stats` / cgroup 조회를 수행하는 `containerd_usage` 체커 신규.
- 임계값은 `default_thresholds` 로 등록하되 운영자가 클러스터별로 조정 가능하게 한다(기존 패턴).
- 무겁거나 위험한 점검은 `default_enabled=False` 로 등록만 해 두고 운영자가 켠다
  (예: `kernel_param_drift`, `minio_health`).
