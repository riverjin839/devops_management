"""DB-free unit tests for services/k8s_diagnose.py.

"연결돼 있는 클러스터인데 에러" 오진 해소의 핵심 순수함수 2개:
  - diagnose_connect_error: 네트워크 예외 → 한국어 원인 힌트
  - classify_kubectl_failure: kubectl stderr → connect_error/auth_error/error 분류
"""
from app.services.k8s_diagnose import classify_kubectl_failure, diagnose_connect_error


class TestDiagnoseConnectError:
    def test_dns_failure_hint(self):
        msg = diagnose_connect_error("api.example.com", "Name or service not known")
        assert "DNS 해석 실패" in msg
        assert "api.example.com" in msg

    def test_connection_refused_hint(self):
        msg = diagnose_connect_error("10.0.0.1", Exception("connection refused"))
        assert "접속 거부" in msg

    def test_no_route_hint_mentions_private_ip(self):
        msg = diagnose_connect_error("192.168.0.10", "No route to host")
        assert "라우팅 불가" in msg

    def test_tls_hint(self):
        msg = diagnose_connect_error("h", "certificate verify failed: self signed")
        assert "TLS/CA 검증 실패" in msg

    def test_unknown_falls_back_to_raw_text(self):
        msg = diagnose_connect_error("h", "완전히 알 수 없는 오류")
        assert "원문:" in msg


class TestClassifyKubectlFailure:
    def test_dial_tcp_is_connect_error(self):
        status, headline = classify_kubectl_failure(
            "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused",
            host="prod-cluster",
        )
        assert status == "connect_error"
        assert "Unable to connect" in headline
        assert "접속 거부" in headline  # diagnose 힌트가 이어붙음

    def test_unauthorized_is_auth_error(self):
        status, headline = classify_kubectl_failure("error: You must be logged in to the server (Unauthorized)")
        assert status == "auth_error"
        assert "인증 실패" in headline

    def test_forbidden_is_auth_error(self):
        status, _ = classify_kubectl_failure(
            'Error from server (Forbidden): jobs.batch is forbidden: User "x" cannot list resource "jobs"'
        )
        assert status == "auth_error"

    def test_x509_is_auth_error(self):
        status, headline = classify_kubectl_failure(
            "Unable to connect to the server: x509: certificate signed by unknown authority"
        )
        # x509 는 인증서 계열로 분류 (dial tcp 미포함)
        assert status == "auth_error"
        assert "인증서" in headline

    def test_broken_kubeconfig_is_plain_error_with_hint(self):
        status, headline = classify_kubectl_failure("error loading config file: yaml: line 3: mapping values")
        assert status == "error"
        assert "kubeconfig" in headline

    def test_unknown_stderr_keeps_first_line(self):
        status, headline = classify_kubectl_failure("some totally new failure mode\nsecond line")
        assert status == "error"
        assert headline.startswith("some totally new failure mode")

    def test_empty_stderr(self):
        status, headline = classify_kubectl_failure("")
        assert status == "error"
        assert "stderr 없음" in headline

    def test_io_timeout_is_connect_error(self):
        status, _ = classify_kubectl_failure(
            "Unable to connect to the server: dial tcp 10.1.2.3:6443: i/o timeout"
        )
        assert status == "connect_error"
