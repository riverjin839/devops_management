# 서비스 토폴로지 (서비스 디스커버리) 사용 가이드

> 메뉴: **네트워크 → 서비스 토폴로지** (`/service-topology`)
> 목적: 선택한 클러스터·네임스페이스의 워크로드/서비스/설정 리소스를 **자동 발견**해
> 노드·엣지 그래프로 그리고, 실제 네트워크 트래픽과 수동 연계까지 한 화면에서 본다.

---

## 1. 이 기능이 하는 일

PEP의 "서비스 디스커버리"는 **서비스 토폴로지** 화면입니다. (cluster, namespace) 단위로
다음을 자동으로 모아 관계 그래프를 그립니다.

- **워크로드 발견**: Deployment / StatefulSet / DaemonSet / Job / CronJob
- **Pod 흡수(collapse)**: Pod 는 소유 워크로드로 합쳐 표시(ownerRef 체인 해석:
  Pod→ReplicaSet→Deployment, Pod→Job→CronJob). 컨트롤러 없는 독립 Pod 만 별도 노드.
- **연결(엣지) 자동 추론**:
  - `Service → 워크로드` (selector 가 실제 Pod 라벨과 매칭) — `routes`
  - `Ingress → Service` (백엔드 라우팅) — `exposes`
  - `워크로드 → ConfigMap / Secret / PVC` (참조 시에만 노드 생성) — `uses_config` / `uses_secret` / `mounts_pvc`
  - `CronJob → Job` — `owns`
- **리소스 메트릭 오버레이**: Pod spec 의 requests/limits 를 직접 파싱하고,
  Prometheus 가 있으면 실제 usage(CPU/메모리)를 워크로드 노드에 합산해 표시.
- **실트래픽 오버레이**: Hubble → conntrack → (불가 시) 미표시 **3단 폴백**으로
  Pod 간 실제 통신 흐름을 엣지로 덧그림.
- **수동 보강**: 자동 발견에 안 잡히는 관계는 **수동 링크**로 직접 그리고,
  외부 DB/API/큐 같은 **외부 노드**를 추가할 수 있다.

> 자동 그래프는 매 조회 시 클러스터에서 새로 생성(영속화 안 함)되고, **수동 링크/외부 노드만**
> DB(`service_topology_links`, `service_topology_external_nodes`)에 저장됩니다.

---

## 2. 사전 준비 (Prerequisites)

| 항목 | 필요 여부 | 없을 때 동작 |
|---|---|---|
| 클러스터 등록 + **kubeconfig** | 필수 | kubeconfig 없으면 `422` — "kubeconfig 가 등록되지 않은 클러스터입니다." |
| kubeconfig 의 **읽기 RBAC** (deployments/pods/services/ingresses/configmaps/secrets/pvc/jobs 등 list) | 필수 | 권한 없는 종류는 부분 그래프 + 상단 `warnings` 에 "○○ 조회 실패" |
| **metrics-server / Prometheus** | 선택 | usage 미표시(requests/limits 만), `warnings` 에 "Prometheus 오프라인" |
| **Cilium Hubble** | 선택(트래픽용) | conntrack 폴백 → 그것도 불가면 트래픽 `unavailable` |

클러스터 등록·kubeconfig 업로드는 **클러스터 관리**(`/cluster-manage`)에서 합니다.

---

## 3. 사용 방법 (UI)

1. 좌측 사이드바 **네트워크 → 서비스 토폴로지** 진입.
2. **클러스터 선택** (좌측 아이콘 레일) → **네임스페이스 선택**.
3. 그래프가 자동으로 그려집니다. 노드 색은 상태를 나타냅니다:
   - 초록 `healthy` · 노랑 `warning`(일부 Ready / 재시작 과다 / ghost) · 빨강 `critical`(Ready 0).
4. 보기 토글:
   - **Pod 표시**(`include_pods`): 워크로드 아래 개별 Pod 노드까지 펼침.
   - **고아 리소스 표시**(`include_orphans`): 아무도 참조하지 않는 ConfigMap/Secret/PVC 도 노드로.
   - **트래픽 오버레이**: 실제 통신 흐름(flow 수/드롭/포트)을 엣지로 표시.
5. **수동 편집 모드**:
   - 노드 사이를 이어 **수동 링크** 생성(예: 코드상 안 드러나는 의존성).
   - **외부 노드** 추가(외부 DB / 외부 API / 메시지 큐 등) 후 워크로드와 연결.
   - 자동 발견에서 사라진 수동 링크 대상은 **ghost 노드**(점선/경고)로 남아 정리 대상임을 표시.

> 노드가 많은 대형 네임스페이스는 **최대 400개**까지만 렌더하고 `truncated` 로 알립니다.

---

## 4. API 레퍼런스

베이스: `/api/v1/service-topology`

| Method | Path | 설명 |
|---|---|---|
| GET | `/{cluster_id}/graph?namespace=<ns>` | 자동 그래프(+수동 엣지/외부 노드 병합). 옵션: `include_pods`, `include_orphans`, `with_metrics` |
| GET | `/{cluster_id}/traffic?namespace=<ns>` | 실트래픽 엣지. 옵션: `since_seconds`(1~3600), `limit`(1~10000) |
| GET | `/{cluster_id}/links?namespace=<ns>` | 수동 링크 목록 |
| POST | `/{cluster_id}/links` | 수동 링크 생성 |
| PATCH | `/links/{link_id}` | 수동 링크 수정 |
| DELETE | `/links/{link_id}` | 수동 링크 삭제 |
| POST | `/{cluster_id}/external-nodes` | 외부 노드 생성 |
| DELETE | `/external-nodes/{node_id}` | 외부 노드 삭제 |

### graph 응답 핵심 필드
```jsonc
{
  "nodes": [{ "id": "Deployment/default/web", "kind": "Deployment", "status": "healthy",
              "pod_count": 3, "ready_count": 3,
              "metrics": { "cpu": { "usage": 0.42, "request": 0.5, "limit": 1.0 }, "mem": {…} } }],
  "edges": [{ "source": "Service/default/web", "target": "Deployment/default/web", "type": "routes" }],
  "metrics_status": "ok",        // ok | offline | unknown
  "truncated": false,
  "warnings": []                 // 부분 실패/오프라인 사유
}
```

### CLI 확인 예시
```bash
# 자동 그래프 — 노드/엣지 수, 경고 확인
curl -s "http://<host>:8000/api/v1/service-topology/<cluster_id>/graph?namespace=<ns>" \
  | jq '{nodes: (.nodes|length), edges: (.edges|length), metrics: .metrics_status, warnings}'

# 실트래픽 — status(ok|unavailable|error), source(hubble|conntrack)
curl -s "http://<host>:8000/api/v1/service-topology/<cluster_id>/traffic?namespace=<ns>" \
  | jq '{status, source, reason, edges: (.edges|length)}'

# 수동 링크 생성 (코드에 안 드러나는 의존성 표현)
curl -s -X POST "http://<host>:8000/api/v1/service-topology/<cluster_id>/links" \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"default","source_kind":"Deployment","source_name":"web",
       "target_kind":"External","target_name":"payments-db","link_type":"depends_on"}'
```

---

## 5. 그래프 읽는 법

- **노드 kind**: Deployment/StatefulSet/DaemonSet/Job/CronJob/Pod/Service/Ingress/ConfigMap/Secret/PersistentVolumeClaim/External.
- **엣지 type**: `routes`(Service→워크로드) · `exposes`(Ingress→Service) · `uses_config` · `uses_secret` · `mounts_pvc` · `owns`(CronJob→Job, 워크로드→Pod) · `manual`(수동) · 트래픽 엣지(flow/포트/드롭).
- **ghost 노드**: 실제 클러스터엔 없지만 (수동 링크 대상이거나 미존재 참조라서) 표시되는 노드 → 정리 대상.
- **metrics_status = offline**: Prometheus 미연결 → usage 빈 값, requests/limits 만.

---

## 6. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `422 kubeconfig 가 등록되지 않은…` | 클러스터에 kubeconfig 미등록 → `/cluster-manage` 에서 업로드 |
| 그래프는 나오는데 일부 종류 누락 + `warnings` | kubeconfig RBAC 에 해당 리소스 list 권한 없음 → 클러스터 RBAC 확인 |
| usage 가 전부 빈 값 / "Prometheus 오프라인" | `PROMETHEUS_URL` 도달 불가 → 환경변수/네트워크 확인(없어도 그래프 자체는 동작) |
| 트래픽 `unavailable` | Hubble Relay 없음 + conntrack 스냅샷도 수집 불가 → Hubble 설치 시 흐름 표시 |
| `502 / 504 토폴로지 수집 실패` | apiserver 연결 오류/타임아웃 → 엔드포인트·네트워크·인증서 확인 |
| Service 에 엣지가 안 붙음 | selector 가 비었거나(headless 등) Pod 라벨과 불일치 — Pod 0개면 워크로드 selector 로 폴백 |
| 노드가 잘림(`truncated`) | 네임스페이스 리소스 400개 초과 — 더 좁은 네임스페이스로 보기 |

---

## 7. 참고 (구현 위치)

- 백엔드 발견 로직: `backend/app/services/service_topology_service.py` (`collect_topology`)
- 백엔드 라우터: `backend/app/routers/service_topology.py`
- 프론트 페이지: `frontend/src/pages/ServiceTopologyPage.tsx` (`/service-topology`)
- 트래픽 소스: `backend/app/services/hubble_client.py`, `cilium_trace_service.py`(conntrack)
