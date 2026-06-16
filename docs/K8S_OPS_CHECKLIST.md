# K8S 운영 점검 항목 (Ops Checklist)

> **목적** — PEP 의 K8s 운영 점검을 **고도화**하기 위한 기준 카탈로그.
> 현재 PEP 에 이미 구현된 점검(Deep Check / Daily Check / 메트릭 스냅샷)을 한곳에 모으고,
> 아직 없는 항목을 "고도화 대상"으로 함께 정리한다. 이후 이 문서를 근거로 신규 체커
> (`backend/app/services/deep_checkers/` + `registry.py`) · 메트릭 카드 · 데일리 체크를
> 단계적으로 추가한다.

## 사용 방법 / 갱신 규칙

- 새 점검을 구상하면 먼저 이 문서에 **항목으로 추가**(상태 = ⬜)하고, 구현되면 상태를 올린다.
- `check_type` 컬럼은 Deep Check 레지스트리(`backend/app/services/deep_checkers/registry.py`)의
  키와 1:1 매핑된다. 신규 체커는 `add-deep-checker` 스킬 절차로 추가하면 운영 점검 콘솔과
  cron 에 자동 노출된다.
- 도메인(category) 값: `k8s` · `os` · `storage` · `network` · `app` — 레지스트리 `category` 와 동일.

### 상태 범례

| 상태 | 의미 |
|---|---|
| ✅ | 구현됨 — 자동 점검(Deep Check / Daily Check) 또는 전용 수집기 존재 |
| 🟡 | 부분 — 메타데이터만 수집 / 수동(임의 PromQL·UI) 으로만 가능 / 일부 한정 |
| ⬜ | 미구현 — 고도화 대상 |

---

## 1. Control Plane (category: `k8s`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| API Server 헬스 | `/healthz` `/livez` `/readyz` 응답 + 응답시간 | 200 OK, < 1s | ✅ | Daily Check `_check_api_server` (`services/daily_checker.py`) |
| componentstatuses | scheduler / controller-manager / etcd CS | 모두 Healthy | ✅ | Daily Check `_check_components` |
| K8s 인증서 만료 | kubeadm certs 잔여일 | warn ≤30d, crit ≤7d | ✅ | Deep Check `cert_expiry` |
| etcd 단편화 / 알람 | endpoint status + alarm list | 단편화 warn 30% / crit 50% | ✅ | Deep Check `etcd_defrag` |
| API Server 지연/에러율 | `apiserver_request_duration_seconds`, 5xx 비율 | p99 < 1s, 5xx < 1% | 🟡 | 임의 PromQL 카드(Prometheus 필요) — 전용 체커 ⬜ |
| scheduler / controller-manager leader | leader election 활성·flapping | 안정적 단일 leader | ⬜ | 신규 `controlplane_leader` 제안 |
| etcd 백업 최신성 (DR) | 최근 스냅샷 존재·신선도 | ≤24h | ⬜ | 신규 `etcd_backup_freshness` 제안 |
| 클러스터 버전 skew | control plane vs kubelet 버전 차 | skew ≤ 1 minor | ⬜ | nodeInfo.kubeletVersion 이미 수집 → 비교 로직 추가 |

---

## 2. Nodes / OS (category: `os` · `k8s`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| 노드 Ready | Ready / NotReady 노드 수 | 전 노드 Ready | ✅ | Daily Check `_check_nodes` + `node_checker.py` |
| 노드 Pressure / Condition | Disk/Memory/PID Pressure, NetworkUnavailable | 영향 노드 warn 1 / crit 3 | ✅ | Deep Check `node_pressure` |
| OS 파라미터 드리프트 | sysctl/커널 파라미터 변경 | 최근 변경 warn 1 / crit 20 | ✅ | Deep Check `kernel_param_drift` (기본 비활성) |
| 컨테이너 런타임 버전 | `containerRuntimeVersion` 등 nodeInfo | 정보성 | 🟡 | 메타만 수집 (`node_server_specs.py`, `k8s_resources.py` rich nodes) |
| 노드 CPU/메모리 사용률 | metrics-server 노드 usage | warn 80% / crit 90% | 🟡 | rich nodes best-effort usage — 임계 자동판정 ⬜ |
| **containerd 사용률 / health** | containerd 데몬 CPU/메모리, `crictl stats`, 이미지/스냅샷 디스크 | 데몬 응답·디스크 여유 | ⬜ | **고도화 핵심** — 신규 `containerd_health` 제안 (crictl/cgroup 또는 containerd 메트릭) |
| 노드 디스크 사용률 | `/`, `/var/lib/containerd`, `/var/lib/etcd`, `/var/log` | warn 80% / crit 90% | ⬜ | 신규 `node_disk_usage` (node-exporter PromQL 또는 수집기) |
| inode 사용률 | 파일시스템 inode 고갈 | warn 80% / crit 90% | ⬜ | 신규 (node-exporter `node_filesystem_files*`) |
| 시간 동기화(NTP) | chrony/ntp drift | drift < 100ms | ⬜ | 신규 `node_time_drift` 제안 |
| kubelet health / cert | `/healthz`, kubelet client/server cert 만료 | 200 OK, 만료 여유 | ⬜ | `cert_expiry` 확장 또는 신규 |
| 커널/OS 버전 일관성 | 노드 간 kernel/osImage 편차 | 동일 baseline | ⬜ | nodeInfo 이미 수집 → 비교 추가 |

---

## 3. Workloads (category: `k8s`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| system pods (kube-system) | kube-system 파드 상태 | 모두 Running/Ready | ✅ | Daily Check `_check_system_pods` |
| ImagePull / CrashLoop | ImagePullBackOff/ErrImagePull/CrashLoopBackOff | warn 1 / crit 5 | ✅ | Deep Check `image_pull` |
| OOM / Evicted 이벤트 | 최근 N시간 OOMKilling/Evicted/SystemOOM | warn 1 / crit 5 | ✅ | Deep Check `oom_events` |
| Stuck Terminating Pods | Terminating N분 이상 지연 | warn 5m / crit 30m | ✅ | Deep Check `stuck_terminating` |
| 리소스 개수 추세 | pods/deploy/ds/sts/rs/svc/ingress/cm/secret/pvc/jobs/cronjobs/nodes/ns 수 추이 | 급증/급감 감지 | ✅ | 메트릭 스냅샷/추세 (`resource_count_service.py`, `/daily-check/review`) |
| Pending 파드 | 스케줄 불가 파드 지속 | warn 1 / crit 5 | ⬜ | 신규 `pending_pods` 제안 |
| 재시작 급증 | 컨테이너 restartCount 증가율 | 임계 초과 시 경고 | ⬜ | 신규 또는 PromQL 카드 |
| HPA 포화 | HPA current==max 지속 | 포화 경보 | ⬜ | 신규 `hpa_saturation` 제안 |
| PDB 위반 | disruptionsAllowed=0 | drain 차단 위험 | ⬜ | 신규 `pdb_violation` 제안 |
| ResourceQuota 임박 | quota 사용률 | warn 80% / crit 95% | ⬜ | 신규 `resourcequota_usage` 제안 |
| Job/CronJob 실패 | 최근 실패 Job/CronJob | 실패 0 | ⬜ | 신규 제안 |

---

## 4. Network (category: `network`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| CoreDNS 상태 | 파드 Ready 비율 + 로그 error율 | err warn 1% / crit 5% | ✅ | Deep Check `coredns_health` |
| Cilium Hubble flow drop | 최근 N초 DROPPED/ERROR 비율 | drop warn 2% / crit 5% | ✅ | Deep Check `cni_flow` |
| 외부 → 내부 Pod 호출 | 외부 노출 endpoint 도달성 | 실패율 warn 10% / crit 30% | ✅ | Deep Check `external_to_pod` |
| Pod-to-pod 연결성 | busybox nc TCP probe 실패율 | warn 10% / crit 30% | ✅ | Deep Check `pod_to_pod` |
| BPF/flow 인스펙터(수동) | bpf 맵·monitor·Hubble flow 실시간 조회 | 수동 진단 | ✅ | Cilium BPF Trace 페이지 (`CiliumTracePage.tsx`) |
| Service endpoints 0 | 셀렉터 미스매치로 endpoints 없음 | endpoints ≥1 | ⬜ | 신규 `empty_endpoints` 제안 |
| Ingress TLS 만료 | ingress 인증서 잔여일 | warn 30d / crit 7d | ⬜ | 신규 `ingress_cert_expiry` 제안 |
| NetworkPolicy 커버리지 | 정책 없는 네임스페이스 | 정책 적용 권장 | ⬜ | 신규 제안 |
| kube-proxy / Cilium agent health | 데몬셋 Ready 비율 | 전 노드 Ready | ⬜ | 신규 또는 `node_pressure` 확장 |
| 외부 DNS resolve | 클러스터 외부 도메인 해석 | 성공 | ⬜ | `coredns_health` 확장 |

---

## 5. Storage (category: `storage`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| PVC / PV 상태 | Pending/Lost PVC, orphan PV | Pending warn 1 / crit 5 | ✅ | Deep Check `pvc_health` |
| MinIO 스토리지 health | cluster/live health 엔드포인트 | 실패율 warn 1% / crit 50% | ✅ | Deep Check `minio_health` (기본 비활성) |
| **MinIO(AIStor) S3 endpoint 호출/응답시간** | S3 API 엔드포인트 호출 정상 여부(ListBuckets/HeadBucket/Get·PutObject) + 왕복 응답시간 측정 | 호출 성공, 응답시간 warn 500ms / crit 2s (조정) | ⬜ | **신규 `minio_s3_latency` 제안** — `minio_health`(health 엔드포인트만)와 별개. S3 endpoint·region·credential(접근키) 파라미터, 선택 버킷/오브젝트로 RTT 측정. category `storage` |
| PV 용량 임박 | PV 사용률 | warn 80% / crit 90% | ⬜ | 신규 (kubelet volume PromQL) |
| StorageClass 기본값 | default SC 존재·중복 | 기본 SC 정확히 1개 | ⬜ | 신규 제안 |
| CSI 드라이버 health | CSI 파드/노드 플러그인 Ready | Ready | ⬜ | 신규 제안 |
| Ceph/기타 스토리지 health | 외부 스토리지 상태 | Healthy | ⬜ | `minio_health` 패턴 확장 |

---

## 6. Security / RBAC (category: `k8s`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| Audit / RBAC sprawl | audit policy ConfigMap, cluster-admin 수 | admin warn 5 / crit 15 | ✅ | Deep Check `audit_rbac` |
| Privileged / hostPath 파드 | 과도 권한 워크로드 | 최소화 | ⬜ | 신규 `pod_security` 제안 |
| ServiceAccount 토큰 만료 | 만료 임박 토큰/인증 | 사전 갱신 | ⬜ | 신규 제안 |
| 만료 임박 secret/cert | TLS secret 만료 스캔 | warn 30d | ⬜ | 신규 제안 |

---

## 7. Observability / Add-ons (category: `app`)

| 항목 | 점검 내용 | 권장 기준 | 상태 | PEP 매핑 / 수집 방법 |
|---|---|---|---|---|
| Addon health (per-cluster) | Nexus/Keycloak/Jenkins/ArgoCD 등 | Healthy | ✅ | `health_checker.py` + `checkers/*_checker.py` |
| Prometheus 가용성 | PromQL 질의 가능 여부 | 응답 OK | 🟡 | `/promql/health` 프로브 (대시보드 카드는 임의 PromQL) |
| 임의 PromQL 카드 | 사용자 정의 지표 대시보드 | 자유 | ✅ | `promql.py` 카드 CRUD + `/query/test` |
| metrics-server 가용성 | `metrics.k8s.io` 응답 | 응답 OK | 🟡 | rich nodes 에서 best-effort, 전용 점검 ⬜ |
| ArgoCD app sync/health | Application Synced/Healthy | 모두 정상 | ⬜ | 신규 `argocd_app_health` 제안 |
| Alertmanager / 알림 경로 | 알림 파이프라인 동작 | 정상 | ⬜ | 신규 제안 |
| 로그/감사로그 적재 | 로그 파이프라인·디스크 | 정상 | ⬜ | 신규 제안 |

---

## 8. 고도화 우선순위 메모

1. **containerd 사용률 / health** — 사용자 요구. `crictl stats` 또는 containerd 메트릭/cgroup
   기반 신규 deep checker(`containerd_health`, category `os`). Prometheus 의존 없이도 동작하도록
   노드 측 조회 경로 우선 검토.
2. **노드 디스크 / inode 사용률** — etcd·containerd 디스크 압박은 장애 직결. node-exporter PromQL
   카드(즉시) → 임계 자동판정 deep checker(후속).
3. **etcd 백업 최신성 (DR)** — 백업 스냅샷 신선도 점검.
4. **Pending 파드 / HPA 포화 / PDB 위반** — 스케줄·가용성 리스크.
5. **Ingress·Secret TLS 만료** — `cert_expiry` 패턴 확장.
6. **MinIO(AIStor) S3 endpoint 호출/응답시간** — 신규 `minio_s3_latency` 체커. 실제 S3 API
   (ListBuckets/HeadBucket/Get·PutObject)를 호출해 성공 여부 + RTT 를 임계 비교. 기존
   `minio_health`(health 엔드포인트 가용성)와 분리된, 데이터 경로 관점의 SLO 점검.
   파라미터: `endpoints`(S3 base URL) · `access_key`/`secret_key`(민감 → backup 마스킹) ·
   `region` · `bucket`(선택) · `object_key`(선택) · `http_timeout_seconds` · `verify_tls`.

> 신규 체커 추가 시 `add-deep-checker` 스킬 → `registry.py` 의 `REGISTRY` + `STEP_PLANS` 등록 →
> 운영 점검 콘솔/cron 자동 노출. 임계값은 위 "권장 기준"을 `default_thresholds` 초깃값으로 사용.
