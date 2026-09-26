# 대상 K8s apiserver 보호 가이드

PEP 는 등록된 여러 클러스터의 apiserver 를 조회한다. 화면 조회, 점검 매트릭스, 효율화 수집, 리소스 카운트가 같은 분에 같은 클러스터로 몰릴 수 있다. 이 문서는 **PEP 때문에 대상 클러스터가 느려지거나 장애가 번지는 일을 막는 장치**를 정리한다. 장치는 두 층이다.

- **PEP 쪽 (코드)**: 기본 켜짐. 환경변수로 조정한다.
- **대상 클러스터 쪽 (APF)**: 운영자가 매니페스트를 적용해야 한다.

---

## 1. PEP 쪽 — 요청을 덜, 짧게, 줄 세워 보낸다

| 장치 | 위치 | 효과 | 조정 |
|---|---|---|---|
| 공용 클라이언트 풀 | `services/k8s_client_pool.py` | 클러스터별 keep-alive 연결 재사용. 요청마다 하던 TLS 핸드셰이크와 exec 인증 플러그인 실행이 사라진다 | `K8S_CLIENT_CACHE_TTL` · `K8S_CLIENT_POOL_MAXSIZE` |
| 기본 타임아웃 | 동일 | `_request_timeout` 을 빠뜨린 호출도 무한 대기하지 않는다 | `K8S_API_TIMEOUT` · `K8S_API_CONNECT_TIMEOUT` |
| read 재시도 0 | 동일 | 느린 apiserver 에 같은 LIST 를 다시 보내지 않는다. urllib3 기본값은 최대 4회 | — |
| **클러스터당 동시 호출 상한** | `services/k8s_concurrency.py` | PEP 전체(API replica + Celery 워커)가 한 apiserver 로 동시에 보내는 요청 수를 Redis 세마포어로 제한한다. 초과분은 PEP 가 기다린다 | `K8S_CLUSTER_MAX_INFLIGHT` · `K8S_CLUSTER_SLOT_WAIT` |
| 목록 캐시 (SWR) | `services/swr_cache.py` · `services/k8s_list_cache.py` | 같은 목록·객체 이벤트를 여러 사용자가 열어도 LIST 는 1회로 합쳐진다. PEP 어디서든 일어난 쓰기(풀 클라이언트 POST/PUT/PATCH/DELETE, 배치잡 kubectl 삭제)가 그 apiserver 캐시를 자동 무효화한다 | `K8S_LIST_CACHE_FRESH` · `K8S_LIST_CACHE_STALE` |
| 상세 이벤트 폴링 완화 | `K8sManagePage` `DetailDrawer` | 이벤트 탭 갱신 15초 → 30초, 브라우저 탭이 숨겨지면 중지. events field selector(인덱스 없음) 조회 빈도를 절반 이하로 | — |
| watch cache 읽기 (RV=0) | `routers/k8s_resources.py` | 노드·네임스페이스 등 작은 cluster-scoped 목록을 etcd quorum read 없이 apiserver 메모리에서 읽는다 | — (종류 목록은 `_WATCH_CACHE_KINDS`) |
| 페이지 조회 | 동일 (`/k8s/{id}/pods?limit=&continue=`) | 파드 목록을 200건씩 받는다. 첫 화면이 빨라지고 한 번에 받는 응답 크기가 줄어든다 | — |
| 디스패처 지터 | `celery_app.py` | 같은 분에 due 인 점검·수집을 0~N초 흩어 보낸다 | `K8S_DISPATCH_JITTER_SECONDS` |

### 동시 호출 상한 동작

- 키는 apiserver 주소(`configuration.host`)다. 같은 클러스터를 가리키는 kubeconfig 가 여러 개여도 한 몫으로 센다.
- 슬롯은 요청을 보내고 **응답 헤더를 받을 때까지** 잡는다. watch 나 로그 follow 같은 스트리밍이 슬롯을 오래 쥐지 않는다.
- PEP 프로세스가 죽어 슬롯을 반납하지 못하면, 만료 시각(요청 타임아웃 + 15초)이 지나 자동으로 회수된다.
- 대기가 `K8S_CLUSTER_SLOT_WAIT` 초를 넘으면 요청을 포기한다. 목록 API 는 **503** 과 함께 사유(상한 N건, 대기 시간)를 반환한다.
- Redis 가 없으면 프로세스 단위 상한으로 폴백하고 경고 로그를 한 번 남긴다. 이 경우 replica 끼리 합산 보장은 없다.
- `K8S_CLUSTER_MAX_INFLIGHT=0` 이면 상한을 끈다.

**값 정하기**: 기본 8 은 "화면 몇 개 + 백그라운드 수집 1~2개"를 소화하는 수준이다. 503 이 자주 보이면 먼저 대상 apiserver 가 실제로 느린지 확인한다. 느리다면 상한을 올리지 말고 원인(etcd, apiserver 리소스)을 본다. 느리지 않은데 사용자가 많다면 상한을 올린다.

---

## 2. 대상 클러스터 쪽 — APF 로 PEP 몫을 격리

APF(API Priority and Fairness)는 apiserver 가 요청을 **FlowSchema → PriorityLevel** 로 분류해 레벨마다 동시성 몫을 나누는 기능이다. 기본 설정에서 PEP 의 ServiceAccount 요청은 내장 `service-accounts` 스키마로 분류돼 `workload-low` 레벨로 간다. 그러면 **다른 워크로드 SA(오퍼레이터, CI 등)와 같은 몫을 나눠 쓰게 된다.** PEP 가 몰리면 그들도 함께 느려진다.

`k8s/target-cluster/pep-apf.yaml` 은 PEP 전용 레벨(`pep-portal`)을 만들어 PEP 요청을 그 안에 가둔다.

- PEP 가 폭주해도 PEP 요청만 전용 큐에서 기다리거나 거절(429)된다. 컨트롤러·스케줄러·kubelet 은 영향받지 않는다.
- `lendablePercent: 0` / `borrowingLimitPercent: 0` 이면 PEP 몫이 고정된다. 한가한 다른 레벨의 몫을 빌려 쓰지도 않는다.

### 적용

1. PEP 가 대상 클러스터에 쓰는 kubeconfig 의 **주체**를 확인한다.
   ```bash
   kubectl --kubeconfig <pep-kubeconfig> auth whoami     # 1.28+
   ```
   - ServiceAccount 토큰이면 `system:serviceaccount:<ns>:<name>` → 매니페스트의 `serviceAccount.name/namespace` 를 바꾼다.
   - 인증서나 OIDC 사용자면 `subjects` 를 `kind: User` / `user: {name: <CN 또는 username>}` 로 바꾼다.
2. 클러스터 버전에 맞는 `apiVersion` 을 쓴다. 1.29 이상은 `flowcontrol.apiserver.k8s.io/v1`, 1.26~1.28 은 `v1beta3` 이다.
3. 대상 클러스터 관리자 권한으로 적용한다.
   ```bash
   kubectl apply -f k8s/target-cluster/pep-apf.yaml
   kubectl get flowschema pep-portal -o jsonpath='{.status.conditions}'   # Dangling=False 확인
   ```

### 확인

```bash
# PEP 요청이 pep-portal 로 분류되는지 — 응답 헤더 X-Kubernetes-PF-FlowSchema-UID 확인
kubectl --kubeconfig <pep-kubeconfig> get ns -v=8 2>&1 | grep -i 'X-Kubernetes-PF'

# 레벨별 현재 대기·실행 수
kubectl get --raw /debug/api_priority_and_fairness/dump_priority_levels | grep -E 'PriorityLevelName|pep-portal'
```

Prometheus 로 볼 지표:

- `apiserver_flowcontrol_rejected_requests_total{priority_level="pep-portal"}`: 0 이 아니면 PEP 몫이 모자란다. PEP 쪽 상한이나 캐시를 먼저 점검하고, 그다음 `nominalConcurrencyShares` 를 올린다.
- `apiserver_flowcontrol_request_wait_duration_seconds{priority_level="pep-portal"}`: 큐 대기 시간이다.
- `apiserver_flowcontrol_current_inqueue_requests{priority_level="pep-portal"}`: 지금 대기 중인 요청 수다.

### 조정 기준

| 증상 | 조치 |
|---|---|
| PEP 화면에서 429 / "Too many requests" | `rejected_requests_total` 확인 → `nominalConcurrencyShares` 10→20, 또는 `queueLengthLimit` 상향 |
| 다른 워크로드가 PEP 사용 시간대에 느려짐 | 이 매니페스트가 적용됐는지, PEP 요청이 `pep-portal` 로 분류되는지(위 헤더) 확인 |
| PEP 가 503(동시 호출 상한) | PEP 쪽 `K8S_CLUSTER_MAX_INFLIGHT` 문제다. APF 와 별개 — 위 §1 참고 |

---

## 3. 두 층의 관계

```
사용자·점검·수집 ─▶ [PEP] 목록 캐시 ─▶ 클러스터당 동시 호출 상한 ─▶ 타임아웃/재시도 0 ─▶ [대상 apiserver] APF pep-portal 레벨 ─▶ etcd
                        (요청 수↓)          (PEP 가 줄 섬)              (오래 붙잡지 않음)           (클러스터가 PEP 몫을 격리)
```

PEP 쪽 장치만 있어도 PEP 가 보내는 양은 줄어든다. 하지만 PEP 설정이 잘못되거나 replica 가 늘어나는 경우까지 막아 주는 것은 **대상 클러스터의 APF** 다. 운영 클러스터에는 둘 다 적용한다.
