# Cilium Connectivity Test — 기능 참고

> **목적:** 향후 Deep Check 체커 또는 별도 검증 기능으로 통합할 때 참조.  
> 현재 프로젝트에는 **미구현** (Hubble observe 기반 `cni_flow` 체커만 존재).

---

## 개요

`cilium connectivity test`는 전용 네임스페이스(`cilium-test`)에 테스트 파드/서비스를 자동 배포하고 32+ 시나리오를 실행하여 Cilium 네트워킹 기능을 **end-to-end 검증**하는 `cilium-cli` 도구다.

```
✅ All 32 tests (263 actions) successful, 2 tests skipped, 1 scenarios skipped
```

---

## Hubble observe와의 차이

| | `connectivity test` | `hubble observe` |
|---|---|---|
| 방식 | 능동 — 테스트 파드를 직접 배포 | 수동 — 기존 트래픽을 관찰 |
| 목적 | 기능 정합성·회귀 검증 | 실시간 트래픽 디버깅 |
| 주요 용도 | 배포 후 검증, 업그레이드 회귀 탐지 | 장애 분석, 패킷 흐름 추적 |
| 출력 | PASS/FAIL 결과 | 플로우 로그 (pod, policy, verdict) |
| 실행 시간 | 수 분 (전체 스위트) | 지속 스트리밍 |

실무 패턴: `connectivity test`로 이상 탐지 → `hubble observe`로 원인 분석.

---

## 전제 조건

### 필수
- `cilium-cli` 설치 (`cilium` 바이너리)
- Cilium DaemonSet 정상 실행 중
- kubectl 접근 권한

### RBAC (최소 권한)
```yaml
rules:
- apiGroups: [""]
  resources: ["namespaces", "pods", "pods/logs", "services", "serviceaccounts"]
  verbs: ["create", "delete", "get", "list"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["create", "delete", "get", "list"]
- apiGroups: ["cilium.io"]
  resources: ["ciliumnetworkpolicies", "ciliumclusterwidenetworkpolicies"]
  verbs: ["create", "delete", "get", "list"]
```

> 간단하게는 cluster-admin 역할로 실행.

---

## 주요 명령어 & 플래그

```bash
# 전체 실행
cilium connectivity test

# 특정 테스트만 (정규식 매칭)
cilium connectivity test --test '/pod-to-pod'
cilium connectivity test --test '/pod-to-service'
cilium connectivity test --test '/network-policy'
cilium connectivity test --test '/dns'

# 특정 테스트 제외 (! 접두어)
cilium connectivity test --test '!performance'

# 여러 패턴 조합
cilium connectivity test --test '/pod-to-pod' --test '/service'

# 성능 튜닝
cilium connectivity test --timeout 30s --test-concurrency 4

# 구조화 출력 (파싱용)
cilium connectivity test --json-summary results.json
cilium connectivity test --junit-file results.xml   # CI용

# 상세 출력
cilium connectivity test --verbose

# 커스텀 네임스페이스
cilium connectivity test --test-namespace my-cilium-test
```

---

## 테스트 카테고리

| 카테고리 | 검증 내용 |
|---|---|
| `pod-to-pod` | 동일 노드 / 다른 노드 파드 간 직접 통신 |
| `pod-to-service` | ClusterIP 서비스 → 엔드포인트 도달, DNS 해석 |
| `network-policy` | allow/deny 규칙 정합성 (허용 트래픽 통과, 차단 트래픽 드롭) |
| `dns` | DNS 해석, DNS 전용 정책, FQDN 기반 정책 |
| `l7-policy` | HTTP/HTTPS, gRPC 애플리케이션 레이어 정책 |
| `egress` | SNAT 정책, Egress Gateway |
| `encryption` | IPSec / WireGuard 파드-파드 암호화 경로 |
| `node-to-pod` | HostNetwork 파드, 노드 레벨 통신 |
| `performance` | 처리량·지연 시간 벤치마크 (오래 걸림, 주로 제외) |

---

## 출력 형식

### JSON Summary (`--json-summary`)
```json
{
  "stats": {
    "total": 32,
    "passed": 30,
    "failed": 1,
    "skipped": 2,
    "duration_ms": 45000
  },
  "tests": [
    {
      "name": "pod-to-pod-same-node",
      "status": "PASS",
      "duration_ms": 1230
    },
    {
      "name": "network-policy-ingress",
      "status": "FAIL",
      "error": "Connection refused",
      "duration_ms": 5000
    }
  ]
}
```

### JUnit XML (`--junit-file`)
```xml
<testsuite name="cilium-connectivity" tests="32" failures="1" skipped="2">
  <testcase name="pod-to-pod-same-node" classname="connectivity" time="1.23"/>
  <testcase name="network-policy-ingress" classname="policy" time="5.00">
    <failure type="ConnectionRefused">Connection refused</failure>
  </testcase>
</testsuite>
```

### 콘솔 상태 기호
- `[=]` 성공/완료 &nbsp; `[!]` 실패 &nbsp; `[.]` 진행 중 &nbsp; `[-]` 섹션 헤더

---

## 프로그래매틱 실행 (Python subprocess)

```python
import subprocess
import json
import tempfile
import os

def run_cilium_connectivity_test(
    kubeconfig: str | None = None,
    tests: list[str] | None = None,
    timeout_per_req: int = 30,
    concurrency: int = 4,
) -> dict:
    """cilium connectivity test를 실행하고 JSON 결과를 반환."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        out_path = f.name

    cmd = ["cilium", "connectivity", "test",
           "--json-summary", out_path,
           "--timeout", f"{timeout_per_req}s",
           "--test-concurrency", str(concurrency)]

    if kubeconfig:
        cmd.extend(["--kubeconfig", kubeconfig])
    for t in (tests or []):
        cmd.extend(["--test", t])

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=600  # 전체 스위트 최대 10분
        )
        with open(out_path) as f:
            return json.load(f)
    finally:
        os.unlink(out_path)
```

---

## 이 프로젝트 적용 방안

### Deep Check 체커로 추가할 경우

**파일 위치:** `backend/app/services/deep_checkers/cilium_connectivity_checker.py`

```python
from .base import DeepCheckerBase, DeepCheckContext, DeepCheckOutcome

class CiliumConnectivityChecker(DeepCheckerBase):
    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        # 1. 실행할 테스트 목록 (params에서 읽기)
        tests = ctx.params.get("tests", [])          # 예: ["/pod-to-pod"]
        skip_perf = ctx.params.get("skip_performance", True)
        if skip_perf:
            tests.append("!performance")

        # 2. subprocess로 cilium connectivity test 실행
        result = run_cilium_connectivity_test(
            kubeconfig=...,          # ctx.cluster에서 추출
            tests=tests,
            timeout_per_req=int(ctx.thresholds.get("timeout_seconds", 30)),
        )

        # 3. 결과 파싱 → DeepCheckOutcome
        stats = result.get("stats", {})
        failed = stats.get("failed", 0)
        if failed > 0:
            return DeepCheckOutcome(status="critical",
                message=f"{failed}개 테스트 실패", details=result)
        return DeepCheckOutcome(status="healthy",
            message=f"전체 {stats.get('total')}개 통과", details=result)
```

**registry.py 등록:**
```python
"cilium_connectivity": (CiliumConnectivityChecker, DeepCheckTypeSpec(
    label="Cilium Connectivity Test",
    description="end-to-end 네트워킹 기능 검증",
    default_thresholds={"timeout_seconds": 30},
    default_params={"tests": [], "skip_performance": True},
)),
```

### 주의사항

| 항목 | 내용 |
|---|---|
| 실행 시간 | 전체 스위트 3~10분. Deep Check timeout을 `300` 이상으로 설정 필요 |
| 네임스페이스 | `cilium-test` 네임스페이스 자동 생성/삭제. 클러스터 권한 필요 |
| 리소스 부하 | 다수의 테스트 파드가 동시에 생성되어 노드 부하 발생 가능 |
| cilium-cli 위치 | 백엔드 컨테이너 또는 super pod에 `cilium` 바이너리 설치 필요 |
| 스케줄 권장 | 매 점검(3회/일)보다 주 1회 또는 업그레이드 후 수동 트리거 권장 |

---

## DevOps 활용 시나리오

1. **Cilium 업그레이드 후 회귀 검증** — 버전 변경 직후 전체 스위트 실행
2. **CI/CD 파이프라인 통합** — JUnit XML 출력 → Kubernetes 배포 전 gate
3. **네트워크 정책 변경 후 검증** — `--test '/network-policy'`만 빠르게 실행
4. **멀티 클러스터 일괄 검증** — 클러스터별 `run_deep_check_all` 태스크 확장

---

## 참고 링크

- [Cilium CLI — connectivity test 공식 문서](https://docs.cilium.io/en/stable/cmdref/cilium_connectivity_test/)
- [End-to-End Connectivity Testing (Cilium 기여자 가이드)](https://docs.cilium.io/en/stable/contributing/testing/e2e/)
- [cilium/cilium-cli GitHub](https://github.com/cilium/cilium-cli)
- 관련 기존 코드: `backend/app/services/deep_checkers/cni_flow_checker.py`
