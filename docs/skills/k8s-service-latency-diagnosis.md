# K8s 내부 서비스 간 통신 지연 진단 & 개선

> **시나리오:** 프론트엔드 ↔ 백엔드 등 K8s 클러스터 내부 서비스 간 통신이 느리다는 제보가 들어왔을 때의 진단 순서와, 기존 도구로 부족할 때의 개선 방안.

---

## 전체 진단 흐름

```
통신 느림 신고 (fr ↔ bk)
  │
  ├─ STEP 1: 패킷 드롭 여부 확인   → Hubble Flows / cni_flow Deep Check
  ├─ STEP 2: 경로 + 정책 확인      → Packet Flow v2 (East-West)
  ├─ STEP 3: TCP 연결 지연 측정    → pod_to_pod Deep Check
  ├─ STEP 4: HTTP 응답 지연 측정   → external_to_pod Deep Check
  └─ STEP 5: Raw 패킷 분석         → tcpdump 패널
```

---

## STEP 1 — 패킷 드롭 여부 확인

**도구:** CiliumTracePage → *Hubble Flows* 탭  
**API:** `GET /api/v1/cilium/{cluster_id}/hubble/stream` (SSE)

드롭이 있으면 latency 문제가 아닌 CNI 정책/설정 문제다.

```
필터 예시
  from-namespace: frontend
  to-namespace:   backend
  verdict:        DROPPED        ← 이게 보이면 정책 문제
```

**또는** Deep Check `cni_flow` 실행:
```
POST /api/v1/deep-check/run/{cluster_id}
→ DeepCheckDefinition.check_type = "cni_flow"
→ thresholds: { warning_pct: 2, critical_pct: 5 }
```

- drop_pct > 0 이면 STEP 2로 이동해 정책 확인
- drop 없으면 STEP 3(latency 측정)으로 이동

**코드 위치:** `backend/app/services/deep_checkers/cni_flow_checker.py`

---

## STEP 2 — 경로 + 정책 확인

**도구:** PacketFlowPage → *Path Graph* 탭 (Packet Flow v2)  
**API:** `POST /api/v1/topology-trace/packet-flow-v2`

East-West(클러스터 내부) 모드로 fr → bk 경로를 추적한다.

```json
{
  "direction": "east-west",
  "source_pod": "frontend-xxx",
  "source_namespace": "frontend",
  "destination_service": "backend-svc",
  "destination_namespace": "backend",
  "protocol": "TCP",
  "port": 8080
}
```

확인 포인트:
- 각 hop의 `verdict` — DENY면 CiliumNetworkPolicy 또는 KubernetesNetworkPolicy 차단
- 각 hop의 `latency_ms` — 노드에 `monitoring.k8s.io/latency-ms` annotation이 있으면 표시
- `notes` 필드 — Cilium kpr, bpf-lb-mode 등 설정 메모

**코드 위치:** `backend/app/services/topology_trace_service.py`

> **한계:** hop latency는 노드 annotation 값을 읽는 것으로, 실측값이 아님.  
> annotation이 없으면 `null` 표시 → STEP 3으로 실측 필요.

---

## STEP 3 — TCP 연결 지연 측정

**도구:** Deep Check `pod_to_pod`  
**API:** `POST /api/v1/deep-check/run/{cluster_id}`

busybox 임시 파드를 생성해 타겟 파드들에 `nc -z` TCP 연결 지연을 측정한다.

```json
DeepCheckDefinition 설정 예시:
{
  "check_type": "pod_to_pod",
  "thresholds": { "warning_failure_pct": 10, "critical_failure_pct": 30 },
  "params": {
    "sample_count": 8,
    "probe_namespace": "default",
    "target_namespaces": ["backend"]
  }
}
```

결과 데이터:
```json
{
  "probed": 8,
  "success": 7,
  "failure_pct": 12.5,
  "targets": [
    { "target": "backend/pod-xxx/10.0.1.5:8080", "latency_ms": 23, "ok": true },
    { "target": "backend/pod-yyy/10.0.1.6:8080", "latency_ms": 180, "ok": true }
  ]
}
```

- `latency_ms` 가 특정 파드에서만 높으면 → 해당 노드 문제
- 전반적으로 높으면 → CNI 오버헤드 또는 네트워크 포화

**코드 위치:** `backend/app/services/deep_checkers/pod_to_pod_checker.py`

> **한계:** TCP 3-way handshake만 측정. HTTP 응답 시간(애플리케이션 레이어)은 STEP 4로.

---

## STEP 4 — 서비스 HTTP 응답 시간 측정

**도구:** Deep Check `external_to_pod`  
**API:** `POST /api/v1/deep-check/run/{cluster_id}`

관리 백엔드에서 직접 HTTP GET을 보내 응답 시간을 측정한다.

```json
DeepCheckDefinition 설정 예시:
{
  "check_type": "external_to_pod",
  "thresholds": { "warning_ms": 500, "critical_ms": 2000 },
  "params": {
    "endpoints": [
      "http://backend-svc.backend.svc.cluster.local:8080/health",
      "http://10.96.0.50:8080/api/status"
    ],
    "timeout_seconds": 10,
    "retries": 2,
    "verify_tls": false
  }
}
```

결과 데이터:
```json
{
  "results": [
    { "kind": "http", "ok": true, "status_code": 200, "latency_ms": 145 },
    { "kind": "http", "ok": true, "status_code": 200, "latency_ms": 1850 }
  ]
}
```

**코드 위치:** `backend/app/services/deep_checkers/external_to_pod_checker.py`

> **한계:** 관리 백엔드 → 서비스 경로 측정. fr 파드 → bk 파드 내부 경로와 다를 수 있음.

---

## STEP 5 — Raw 패킷 캡처 (최후 수단)

**도구:** PacketFlowPage → *tcpdump* 패널  
**API:** `POST /api/v1/topology-trace/tcpdump`

fr 파드가 있는 노드에서 raw 패킷을 캡처해 SYN-ACK 타임스탬프로 RTT를 계산한다.

```json
{
  "host": "node-ip-or-hostname",
  "interface": "eth0",
  "filter": "host 10.0.1.5 and port 8080",
  "duration_seconds": 30,
  "ssh_user": "ubuntu",
  "ssh_key_path": "/path/to/key"
}
```

캡처 후 분석:
```bash
# SYN → SYN-ACK 타임스탬프 차이 = TCP handshake RTT
tcpdump -r capture.pcap -tt 'tcp[tcpflags] & (tcp-syn|tcp-ack) != 0'
```

**코드 위치:** `backend/app/routers/topology_trace.py` (`/tcpdump` 엔드포인트)

---

## 기존 도구로 진단 불가한 경우 — 개선 방안

### 개선 1: Hubble L7 HTTP 지연 수집

Cilium L7 visibility가 활성화된 경우 Hubble이 HTTP 메타데이터(메서드, 상태코드, 응답시간)를 기록한다.

```bash
# L7 visibility 활성화 확인
kubectl get ciliumnetworkpolicies -A

# L7 response_time 포함 flow 조회
hubble observe --protocol http --output json | jq '.flow.l7.http.latency_ns'
```

**이 프로젝트 적용:** `cilium_trace_service.py`의 Hubble 스트리밍 파서에 `l7.http.latency_ns` 필드 추출 추가.

---

### 개선 2: Prometheus Latency Metric Card 추가

`backend/app/main.py`의 `_seed_default_metric_cards()`에 아래 카드 추가:

```python
# HTTP 요청 지연 p95 (Cilium Hubble metrics or Istio)
MetricCard(
    title="HTTP 응답 지연 p95",
    promql="histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, source_app, destination_app))",
    unit="s", display_type="gauge",
    thresholds="warning:0.5,critical:2.0",
    category="network",
)

# TCP 재전송률 (네트워크 품질 지표)
MetricCard(
    title="TCP 재전송률",
    promql="rate(node_netstat_Tcp_RetransSegs[5m]) / rate(node_netstat_Tcp_OutSegs[5m])",
    unit="%", display_type="gauge",
    thresholds="warning:0.01,critical:0.05",
    category="network",
)

# 컨테이너 네트워크 에러
MetricCard(
    title="컨테이너 네트워크 에러",
    promql="sum(rate(container_network_transmit_errors_total[5m])) by (pod)",
    unit="err/s", display_type="list",
    category="network",
)
```

---

### 개선 3: HTTP curl Latency Deep Checker 추가

`pod_to_pod_checker.py`는 TCP만 측정하므로, HTTP 애플리케이션 레이어 지연을 측정하는 체커를 추가한다.

**신규 파일:** `backend/app/services/deep_checkers/http_latency_checker.py`

```python
class HttpLatencyChecker(DeepCheckerBase):
    """busybox curl로 특정 서비스 URL의 HTTP 응답 지연을 측정."""

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        targets = ctx.params.get("targets", [])
        # {"url": "http://backend-svc:8080/health", "warn_ms": 500, "crit_ms": 2000}
        warning_ms = int(ctx.thresholds.get("warning_ms", 500))
        critical_ms = int(ctx.thresholds.get("critical_ms", 2000))

        results = []
        worst_status = StatusEnum.healthy

        for t in targets:
            url = t["url"]
            proc = self._kubectl(
                ctx,
                "run", f"http-probe-{randrange(10**6):06d}",
                "--rm", "-i", "--restart=Never",
                "--image", "curlimages/curl:8.5.0",
                "--",
                "curl", "-o", "/dev/null", "-s", "-w", "%{time_total}",
                "--connect-timeout", "5", "--max-time", "10",
                url,
                timeout=30,
            )
            latency_ms = int(float(proc.stdout.strip()) * 1000)
            ok = proc.returncode == 0
            status = (
                StatusEnum.critical if latency_ms >= critical_ms else
                StatusEnum.warning  if latency_ms >= warning_ms  else
                StatusEnum.healthy
            )
            results.append({"url": url, "latency_ms": latency_ms, "ok": ok, "status": status})
            if status.value > worst_status.value:
                worst_status = status

        return DeepCheckOutcome(
            status=worst_status,
            message=f"{len(results)}개 엔드포인트 HTTP 지연 측정",
            details={"results": results},
        )
```

`registry.py` 등록:
```python
"http_latency": (HttpLatencyChecker, DeepCheckTypeSpec(
    label="HTTP 응답 지연",
    description="busybox curl로 서비스 URL HTTP 지연 측정",
    default_thresholds={"warning_ms": 500, "critical_ms": 2000},
    default_params={"targets": []},
)),
```

---

### 개선 4: Cilium Connectivity Test (전체 검증)

배포 직후 또는 업그레이드 후 전체 네트워크 기능을 검증할 때 사용.  
→ **`docs/skills/cilium-connectivity-test.md`** 참조

빠른 pod-to-pod 검증만 필요하다면:
```bash
cilium connectivity test --test '/pod-to-pod' --timeout 30s
```

---

## 현재 도구 한계 요약

| 진단 항목 | 현재 가능 여부 | 비고 |
|---|---|---|
| 패킷 드롭 감지 | ✅ | Hubble Flows / cni_flow 체커 |
| 네트워크 정책 차단 확인 | ✅ | Packet Flow v2 |
| TCP handshake 지연 측정 | ✅ | pod_to_pod 체커 |
| 외부 → 서비스 HTTP 지연 | ✅ | external_to_pod 체커 |
| 파드 내부 → 서비스 HTTP 지연 | ⚠️ 부분 | curl 체커 추가 필요 (개선 3) |
| Hop별 latency 실측 | ❌ | annotation 읽기만 (개선 필요) |
| HTTP 지연 시계열 (Prometheus) | ❌ | 카드 추가 필요 (개선 2) |
| 노드 간 RTT 연속 모니터링 | ❌ | DaemonSet 프로브 필요 |
| L7 응답시간 (Hubble HTTP) | ⚠️ 부분 | L7 visibility 활성화 필요 (개선 1) |

---

## 참고

- 관련 기존 코드
  - `backend/app/services/deep_checkers/pod_to_pod_checker.py`
  - `backend/app/services/deep_checkers/external_to_pod_checker.py`
  - `backend/app/services/deep_checkers/cni_flow_checker.py`
  - `backend/app/services/topology_trace_service.py`
  - `backend/app/services/cilium_trace_service.py`
  - `frontend/src/pages/PacketFlowPage.tsx`
  - `frontend/src/pages/CiliumTracePage.tsx`
- `docs/skills/cilium-connectivity-test.md` — cilium connectivity test 상세
