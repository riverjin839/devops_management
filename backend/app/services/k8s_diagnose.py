"""K8s 연결/인증 실패 원인 진단 헬퍼 (공용).

"연결돼 있는 클러스터인데 에러"라는 오진을 줄이기 위한 두 가지 순수 함수:

- :func:`diagnose_connect_error` — 네트워크 예외(urllib3 MaxRetryError 등)를
  운영자가 다음 행동을 정할 수 있는 한국어 원인 설명으로 변환.
  (원래 ``routers/clusters.py`` 의 ``_diagnose_max_retries`` — 배치잡 실행기와
  라우터가 함께 쓰도록 서비스 계층으로 이동)
- :func:`classify_kubectl_failure` — kubectl 비정상 종료의 stderr 를 읽어
  ``connect_error`` / ``auth_error`` / ``error`` 로 분류하고, stderr 첫 유의미
  라인 + 힌트를 headline 으로 만든다. 배치잡의 모든 kubectl 실패가 구분 없는
  빨간 "에러"로 뭉개지던 문제를 해소한다.

둘 다 DB/네트워크 의존이 없는 순수 함수 — 단위 테스트는 tests/test_k8s_diagnose.py.
"""
from __future__ import annotations


def diagnose_connect_error(host: str, exc_or_text: Exception | str) -> str:
    """네트워크 계열 예외를 사람이 읽을 수 있는 원인 설명으로.

    흔한 시나리오:
    - server URL 이 private IP (예: 10.x / 192.168.x / cluster.local) 인데
      백엔드/워커 컨테이너 네트워크에서 라우팅 안 됨 → "대상 호스트 도달 불가"
    - DNS 실패 (FQDN 이 backend resolver 에서 안 풀림)
    - TLS/인증서 문제 (self-signed CA 가 kubeconfig 에 없거나 잘못)
    - 방화벽/보안 그룹 차단 (6443 포트 막힘)
    """
    msg = str(exc_or_text).lower()
    hints: list[str] = []
    if (
        "name or service not known" in msg
        or "nodename nor servname" in msg
        or "temporary failure in name resolution" in msg
        or "no such host" in msg
    ):
        hints.append("DNS 해석 실패 — server URL 의 도메인을 backend/워커 컨테이너가 resolve 할 수 있는지 확인")
    if "connection refused" in msg:
        hints.append("접속 거부 — 대상 호스트의 API 서버 포트(보통 6443)가 살아있는지, 방화벽이 열려있는지 확인")
    if "no route to host" in msg or "network is unreachable" in msg:
        hints.append(
            "라우팅 불가 — server 가 internal IP(10.x/192.168.x/cluster.local)인 경우, "
            "backend/워커 컨테이너는 기본적으로 그 네트워크에 접근 못 함. 공용 endpoint 또는 jump host 경유 필요"
        )
    if "timed out" in msg or "timeout" in msg:
        hints.append("타임아웃 — 네트워크 경로가 느리거나 중간에 패킷이 버려짐")
    if "certificate verify failed" in msg or "ssl:" in msg or "x509" in msg:
        hints.append("TLS/CA 검증 실패 — kubeconfig 의 certificate-authority-data 가 실제 서버 인증서와 매칭되는지 확인")
    if "max retries exceeded" in msg and not hints:
        hints.append("urllib3 재시도 소진 — 네트워크 또는 TLS 설정 점검 필요")

    base = f"서버({host}) 에 연결할 수 없습니다."
    if hints:
        return base + " 가능한 원인: " + " / ".join(hints)
    return base + f" 원문: {str(exc_or_text)[:200]}"


# kubectl stderr 패턴 → (status, 힌트). 위에서부터 먼저 매칭되는 것이 이긴다.
_KUBECTL_PATTERNS: list[tuple[tuple[str, ...], str, str]] = [
    # 인증/권한 계열 — 연결은 됐는데 자격이 문제
    (
        ("unauthorized", "you must be logged in", "token has expired", "provide credentials"),
        "auth_error",
        "인증 실패 — kubeconfig 의 토큰/인증서가 만료됐거나 잘못됨. 클러스터 관리 화면에서 kubeconfig 를 갱신하세요.",
    ),
    (
        ("forbidden", "cannot list resource", "cannot get resource", "cannot delete resource"),
        "auth_error",
        "권한 부족(RBAC) — 이 kubeconfig 의 계정에 해당 리소스 권한이 없습니다.",
    ),
    (
        ("x509", "certificate signed by unknown authority", "certificate has expired"),
        "auth_error",
        "인증서 문제 — kubeconfig 의 CA/클라이언트 인증서가 서버와 맞지 않거나 만료됨.",
    ),
    (
        ("exec plugin", "getting credentials", "executable", "not found in $path"),
        "auth_error",
        "kubeconfig 이 외부 인증 플러그인(exec)을 요구하는데 컨테이너에 해당 바이너리가 없습니다 — 토큰 방식 kubeconfig 로 교체하세요.",
    ),
    # 연결 계열 — 서버까지 못 감
    (
        ("dial tcp", "connection refused", "no route to host", "i/o timeout",
         "no such host", "network is unreachable", "unable to connect to the server",
         "connection timed out", "tls handshake timeout"),
        "connect_error",
        "",  # 힌트는 diagnose_connect_error 로 상세화
    ),
    # kubeconfig 자체가 깨짐
    (
        ("error loading config file", "invalid configuration", "no configuration has been provided",
         "unable to read client-cert", "unable to read certificate-authority"),
        "error",
        "kubeconfig 파일이 손상됐거나 형식이 잘못됨 — 클러스터 관리 화면에서 kubeconfig 를 다시 등록하세요.",
    ),
]


def classify_kubectl_failure(stderr: str, *, host: str = "") -> tuple[str, str]:
    """kubectl 비정상 종료의 stderr → (status, headline).

    status: "connect_error" | "auth_error" | "error"
    headline: stderr 첫 유의미 라인(최대 300자) + 한국어 힌트.
    stderr 가 비어 있으면 ("error", 일반 메시지).
    """
    text = (stderr or "").strip()
    first_line = ""
    for line in text.splitlines():
        line = line.strip()
        if line:
            first_line = line[:300]
            break

    if not first_line:
        return "error", "kubectl 실행 실패 (stderr 없음) — exit code 를 확인하세요."

    lowered = text.lower()
    for needles, status_, hint in _KUBECTL_PATTERNS:
        if any(n in lowered for n in needles):
            if status_ == "connect_error":
                hint = diagnose_connect_error(host or "API 서버", text)
            return status_, f"{first_line} — {hint}" if hint else first_line

    return "error", first_line
