"""시크릿 마스킹 — LLM 프롬프트로 나가기 전 자격증명류 패턴 제거.

로그/describe/설정 덤프에는 토큰·비밀번호·키가 섞여 들어올 수 있다. 프롬프트는
사내 LLM 서비스로도 전송되므로(폐쇄망이라도 팀 경계를 넘는다), 게이트웨이 진입점
(``llm_service.chat_for_purpose``)에서 일괄 마스킹한다 — 호출부가 늘어나도 누락되지
않는 위치다 (docs/AIRGAP_LLM_ARCHITECTURE.md §3.2 네 번째 방어층).

과잉 마스킹 주의: 일반 로그 본문(타임스탬프, UUID, 해시 등)은 훼손하지 않아야
분석 품질이 유지된다 — 패턴은 명확한 자격증명 형태로 한정한다.
"""
from __future__ import annotations

import re

MASK = "***MASKED***"

_PATTERNS: list[tuple[re.Pattern, str]] = [
    # Authorization 헤더 (Bearer/Basic 토큰)
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}"),
     rf"\1{MASK}"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}"), f"Bearer {MASK}"),
    # password=/passwd:/PASSWORD: 값 (공백/따옴표 전까지)
    (re.compile(r"(?i)\b(password|passwd|pwd)(\s*[:=]\s*)[\"']?[^\s\"',;]{4,}[\"']?"),
     rf"\1\2{MASK}"),
    # token=/api_key=/secret= 류 (긴 값만 — 짧은 값은 플래그일 수 있음)
    (re.compile(r"(?i)\b(token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)"
                r"(\s*[:=]\s*)[\"']?[A-Za-z0-9\-._~+/]{16,}={0,2}[\"']?"),
     rf"\1\2{MASK}"),
    # AWS Access Key ID / Secret
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), MASK),
    (re.compile(r"(?i)\b(aws_secret_access_key)(\s*[:=]\s*)\S{30,}"), rf"\1\2{MASK}"),
    # PEM 블록 (개인키/인증서 키)
    (re.compile(r"-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?"
                r"-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----"),
     MASK),
    # URL userinfo (http://user:pass@host)
    (re.compile(r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@"), rf"\1{MASK}@"),
    # kubeconfig/JWT 류 장문 base64 연속열 (60자+ — 일반 해시(sha256=64자 hex)와
    # 구분되도록 base64 특수문자 포함 요구)
    (re.compile(r"\beyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{10,}\b"), MASK),
]


def mask_secrets(text: str) -> str:
    """자격증명류 패턴을 마스킹한 텍스트 반환. 절대 raise 하지 않는다."""
    if not text:
        return text
    try:
        out = text
        for pattern, repl in _PATTERNS:
            out = pattern.sub(repl, out)
        return out
    except Exception:  # noqa: BLE001
        return text
