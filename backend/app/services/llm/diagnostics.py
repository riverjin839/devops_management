"""LLM 프로필 연결 진단 — Settings → AI/LLM 의 "연결 진단" 실행 버튼 백엔드.

"챗봇이 안 된다" 는 증상 하나에 원인은 여럿이다(Service 이름 오타, 파드 미기동, 이미지에
모델 미포함, 모델 태그 불일치, DB 저장 설정이 env 를 덮음, CPU 콜드 로딩 타임아웃 …).
단순 1회 호출 테스트(``POST /llm/test``)는 "실패: connect_error" 한 줄만 남기므로, 여기서는
계층을 아래에서 위로 하나씩 확인하며 단계·로그를 SSE 로 흘리고 단계마다 조치 힌트를 남긴다.

절대 raise 하지 않는다 — 각 단계는 ok|warn|fail 로 끝나고 마지막에 요약 결과를 돌려준다.
"""
from __future__ import annotations

import asyncio
import socket
import ssl
import time
import urllib.request
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.services.llm.base import LLMProfile
from app.services.llm.ollama_provider import pick_ollama_model
from app.services.sse import Emit, log_evt, step_evt

_DIAG_PROMPT = "한 단어로만 답하라: 정상"


class _Diag:
    """단계 기록기 — 단계 칩·로그·결과 행을 한 번에 남긴다."""

    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self.checks: list[dict] = []

    def start(self, name: str, label: str) -> float:
        step_evt(self.emit, name, label, "running")
        return time.monotonic()

    def finish(self, name: str, label: str, status: str, detail: str, *,
               hint: str = "", t0: Optional[float] = None) -> None:
        ms = int((time.monotonic() - t0) * 1000) if t0 is not None else None
        step_evt(self.emit, name, label, "failed" if status == "fail" else "done")
        level = {"ok": "info", "warn": "warn", "fail": "error"}[status]
        suffix = f" ({ms}ms)" if ms is not None else ""
        log_evt(self.emit, level, f"[{label}] {detail}{suffix}")
        if hint:
            log_evt(self.emit, level if status == "fail" else "warn", f"  └ 조치: {hint}")
        self.checks.append({"name": name, "label": label, "status": status,
                            "detail": detail, "hint": hint, "elapsed_ms": ms})

    def info(self, message: str) -> None:
        log_evt(self.emit, "info", message)


async def diagnose_profile(
    profile: LLMProfile,
    emit: Emit,
    *,
    settings_stored: bool,
    api_key: Optional[str] = None,
) -> dict:
    d = _Diag(emit)
    resolved_model: Optional[str] = None
    available: list[str] = []

    # 1) 설정 원천 — DB 저장값이 있으면 env(OLLAMA_MODEL 등) 변경이 반영되지 않는다.
    t0 = d.start("config", "설정 확인")
    d.info(f"프로필 '{profile.name}' · provider={profile.provider} · base_url={profile.base_url} "
           f"· model={profile.model or '(비어 있음)'} · timeout={profile.timeout_seconds}s")
    _log_request_plan(profile, d)
    if not profile.enabled:
        d.finish("config", "설정 확인", "fail", "프로필이 비활성화돼 있다 — 연결 확인은 계속 진행한다.",
                 hint="프로필 편집에서 '활성' 을 켠다.", t0=t0)
    elif not profile.model:
        # 모델명이 비어도 연결 단계는 계속 본다 — 서버 모델 목록을 얻으면 그 이름으로 응답을 시험하고
        # 화면의 '모델명 저장' 으로 바로 채울 수 있다(모델 목록 조회가 막혀 이름을 못 고르는 막다른 길 방지).
        d.finish("config", "설정 확인", "warn",
                 "모델명이 비어 있다 — 서버 모델 목록에서 찾아 시험한다.",
                 hint="진단이 찾은 모델명을 '모델명 저장' 으로 프로필에 저장하거나, 서버 모델명을 직접 입력한다.",
                 t0=t0)
    elif settings_stored and profile.provider == "ollama" and profile.model != settings.ollama_model:
        d.finish(
            "config", "설정 확인", "warn",
            f"DB 저장 설정(model={profile.model})이 환경변수 OLLAMA_MODEL={settings.ollama_model} 을 덮고 있다.",
            hint="ConfigMap 의 OLLAMA_MODEL 을 바꿔도 반영되지 않는다 — 이 화면에서 프로필 모델명을 직접 고친다.",
            t0=t0,
        )
    elif profile.provider == "openai_compat" and _looks_like_full_endpoint(profile.base_url):
        d.finish(
            "config", "설정 확인", "warn",
            f"base_url 이 API 경로까지 포함한 것 같다: {profile.base_url}",
            hint="엔드포인트 URL 에는 게이트웨이 주소(+모델 경로 prefix)까지만 적는다 — "
                 "'/chat/completions'·'/models' 는 PEP 가 붙인다.",
            t0=t0,
        )
    else:
        source = "DB 저장 설정(Settings → AI/LLM)" if settings_stored else "환경변수 기본값(OLLAMA_URL/OLLAMA_MODEL)"
        d.finish("config", "설정 확인", "ok", f"설정 원천: {source}", t0=t0)

    parsed = urlparse(profile.base_url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    # 2) DNS — 파드 안에서 Service 이름이 풀리는지.
    t0 = d.start("dns", "DNS 조회")
    if not host:
        d.finish("dns", "DNS 조회", "fail", f"base_url 에서 호스트를 읽지 못했다: {profile.base_url}",
                 hint="http://<service>.<namespace>.svc:11434 형식으로 입력한다.", t0=t0)
        return _summary(profile, d, resolved_model, available)
    try:
        loop = asyncio.get_running_loop()
        infos = await asyncio.wait_for(
            loop.run_in_executor(None, socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM),
            timeout=5,
        )
        addrs = sorted({i[4][0] for i in infos})
        d.finish("dns", "DNS 조회", "ok", f"{host} → {', '.join(addrs)}", t0=t0)
    except Exception as exc:  # noqa: BLE001
        d.finish(
            "dns", "DNS 조회", "fail", f"{host} 를 해석하지 못했다: {exc}",
            hint=("Ollama 를 Deployment 만 띄우고 Service 를 만들지 않았거나 이름이 다르다. "
                  "`kubectl get svc -A | grep -i ollama` 로 확인하고, 다른 네임스페이스면 "
                  "http://<svc>.<ns>.svc.cluster.local:11434 로 적는다."),
            t0=t0,
        )
        return _summary(profile, d, resolved_model, available)

    # 3) TCP — Service 뒤에 Ready 엔드포인트가 있는지 / NetworkPolicy 차단 여부.
    t0 = d.start("tcp", "포트 연결")
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        d.finish("tcp", "포트 연결", "ok", f"{host}:{port} 연결 성공", t0=t0)
    except Exception as exc:  # noqa: BLE001
        d.finish(
            "tcp", "포트 연결", "fail", f"{host}:{port} 연결 실패: {type(exc).__name__} {exc}",
            hint=("`kubectl get endpoints <svc> -n <ns>` 가 비어 있으면 Service selector 가 파드 라벨과 "
                  "다르거나 파드가 Ready 가 아니다. 파드가 Pending(Insufficient cpu/memory)이면 노드 자원이 "
                  "없는 것이다 — 작은 모델(3b)로 requests 를 낮추거나, Ollama 를 빼고(deploy/k8s/components/no-ollama) "
                  "사내 LLM 프로필로 라우팅한다. 포트(11434)·NetworkPolicy·OLLAMA_HOST=0.0.0.0 도 확인한다."),
            t0=t0,
        )
        return _summary(profile, d, resolved_model, available)

    # 4) 프록시 — TCP 는 직접 연결로 확인했지만 HTTP 클라이언트는 HTTP(S)_PROXY 를 탈 수 있다.
    _check_proxy(profile, d, parsed.scheme or "http", host)

    headers = profile.request_headers(api_key)
    if profile.provider == "ollama":
        resolved_model, available = await _diagnose_ollama(profile, d, headers)
    else:
        resolved_model, available = await _diagnose_openai(profile, d, headers)
    return _summary(profile, d, resolved_model, available)


def _log_request_plan(profile: LLMProfile, d: _Diag) -> None:
    """실제로 호출할 URL·HTTP 옵션을 로그로 — 화면에서 경로 조합을 눈으로 확인할 수 있게."""
    if profile.provider == "openai_compat":
        d.info(f"  호출 URL: 모델 목록 GET {profile.api_url('/models')} · "
               f"응답 POST {profile.api_url('/chat/completions')}")
        if profile.base_has_api_path():
            d.info(f"  base_url 이 이미 '{profile.api_path}' 로 끝나 API 경로를 중복으로 붙이지 않는다.")
    else:
        d.info(f"  호출 URL: GET {profile.base_url}/api/tags · POST {profile.base_url}/api/generate")
    tls = "검증 안 함" if not profile.tls_verify else (f"CA {profile.ca_bundle}" if profile.ca_bundle else "기본 CA 로 검증")
    opts = [f"TLS={tls}", f"환경 프록시={'사용' if profile.use_env_proxy else '사용 안 함'}"]
    if profile.host_header:
        opts.append(f"Host 헤더={profile.host_header}")
    opts.append(f"인증 헤더={profile.auth_header}" + (f" ({profile.auth_scheme} …)" if profile.auth_scheme else ""))
    if profile.extra_headers:
        opts.append(f"추가 헤더={', '.join(profile.extra_headers)}")
    d.info("  HTTP 옵션: " + " · ".join(opts))


def _looks_like_full_endpoint(base_url: str) -> bool:
    tail = base_url.rstrip("/").lower()
    return tail.endswith("/chat/completions") or tail.endswith("/completions") or tail.endswith("/models")


def _check_proxy(profile: LLMProfile, d: _Diag, scheme: str, host: str) -> None:
    t0 = d.start("proxy", "프록시 경로")
    if not profile.use_env_proxy:
        d.finish("proxy", "프록시 경로", "ok", "환경 프록시 사용 안 함 — 직접 연결한다.", t0=t0)
        return
    try:
        proxies = urllib.request.getproxies_environment()
        proxy = proxies.get(scheme) or proxies.get("all")
        bypass = bool(urllib.request.proxy_bypass_environment(host, proxies)) if proxy else True
    except Exception as exc:  # noqa: BLE001
        d.finish("proxy", "프록시 경로", "ok", f"프록시 환경변수 해석 생략: {exc}", t0=t0)
        return
    if not proxy or bypass:
        d.finish("proxy", "프록시 경로", "ok",
                 "프록시를 거치지 않고 직접 연결한다" + (" (NO_PROXY 에 포함)" if proxy else ""), t0=t0)
        return
    d.finish(
        "proxy", "프록시 경로", "warn",
        f"HTTP 요청은 {scheme.upper()}_PROXY({_mask_proxy(proxy)})를 거친다 — 위 포트 연결 확인(직접 연결)과 경로가 다르다.",
        hint=("사내 GPU 클러스터 게이트웨이가 프록시 밖이라면 프로필 편집 → 고급의 '환경 프록시 사용' 을 끄거나, "
              f"backend/celery 의 NO_PROXY 에 '{host}' (또는 상위 도메인)를 추가한다."),
        t0=t0,
    )


def _mask_proxy(url: str) -> str:
    p = urlparse(url)
    if p.username or p.password:
        return f"{p.scheme}://***@{p.hostname}{':' + str(p.port) if p.port else ''}"
    return url


def _exc_hint(exc: Exception, profile: LLMProfile) -> str:
    """HTTP 요청 예외 → 조치 힌트 (TLS·프록시·http/https 혼동)."""
    text = f"{type(exc).__name__} {exc}".lower()
    if isinstance(exc, ssl.SSLError) or "certificate" in text or "ssl" in text or "tls" in text:
        if "wrong version number" in text or "record layer" in text:
            return ("https 로 붙었지만 상대가 평문 HTTP 다 — base_url 을 http:// 로 바꾸거나 "
                    "Gateway 리스너(HTTP/HTTPS) 포트를 확인한다.")
        return ("게이트웨이 인증서를 검증하지 못했다(사내 CA). 프로필 편집 → 고급에서 'CA 번들 경로' 에 "
                "파드 안 CA 파일(예: /etc/ssl/certs/corp-ca.pem — Secret/ConfigMap 마운트)을 지정하거나, "
                "임시로 'TLS 검증' 을 끈다.")
    if "proxy" in text or "407" in text:
        return ("프록시 경유가 실패했다 — '프록시 경로' 단계를 확인하고, 내부 게이트웨이면 고급의 "
                "'환경 프록시 사용' 을 끄거나 NO_PROXY 에 호스트를 넣는다.")
    if isinstance(exc, httpx.TimeoutException):
        return (f"{profile.timeout_seconds}s 안에 응답이 없다 — 게이트웨이 timeout(HTTPRoute "
                "timeouts.request) 이나 모델 콜드 로딩 시간을 확인하고 프로필 타임아웃을 늘린다.")
    if isinstance(exc, httpx.RemoteProtocolError):
        return "연결은 됐지만 HTTP 응답이 깨졌다 — http/https 스킴과 게이트웨이 리스너 프로토콜을 확인한다."
    return ""


def _response_hint(resp: httpx.Response, profile: LLMProfile) -> str:
    """HTTP 상태 코드 + 응답 헤더로 게이트웨이(HTTPRoute) 단계의 원인을 추정한다."""
    code = resp.status_code
    server = (resp.headers.get("server") or "").lower()
    body = resp.text[:300].lower()
    via_gateway = "envoy" in server or "istio" in server or any(h.startswith("x-envoy") for h in resp.headers)
    gw = f"게이트웨이({resp.headers.get('server')})" if via_gateway else "게이트웨이/서버"
    path_prefix = urlparse(profile.base_url).path.rstrip("/")
    if profile.base_has_api_path():
        path_prefix = path_prefix[: -len(profile.api_path)]
    if code == 404:
        hint = (f"{gw} 가 이 요청에 맞는 라우트를 찾지 못했다. ① HTTPRoute `hostnames` 와 base_url 의 호스트가 "
                "같은지 — IP 나 다른 이름으로 붙는다면 고급의 'Host 헤더' 에 HTTPRoute 호스트명을 넣는다. "
                "② `rules.matches.path` 와 실제 경로가 맞는지")
        if path_prefix:
            hint += (f" — base_url 경로 '{path_prefix}' 가 모델 서버까지 그대로 전달되면 404 가 난다: HTTPRoute 에 "
                     f"URLRewrite(ReplacePrefixMatch '{path_prefix}' → '/')가 있는지 확인한다")
        hint += ". ③ 게이트웨이가 이미 '/v1' 을 붙인다면 고급의 'API 경로' 를 비운다."
        if "model" in body and ("not found" in body or "does not exist" in body):
            hint = "서버는 응답했지만 모델명이 없다 — '모델 확인' 단계의 서버 모델 목록 이름과 맞춘다."
        return hint
    if code in (401, 403):
        return ("인증 거부. API 키 참조가 맞는지, 게이트웨이가 요구하는 헤더 형태(Authorization: Bearer / api-key / "
                "X-API-Key)와 고급의 '인증 헤더'·'스킴' 설정이 같은지 확인한다. 게이트웨이 AuthorizationPolicy·"
                "IP 허용 목록도 본다.")
    if code == 407:
        return "프록시 인증 요구 — 내부 게이트웨이면 고급의 '환경 프록시 사용' 을 끄거나 NO_PROXY 에 호스트를 넣는다."
    if code == 400 and "plain http request was sent to https" in body:
        return "HTTPS 포트에 http:// 로 붙었다 — base_url 을 https:// 로 바꾼다."
    if code in (502, 503, 504):
        return (f"{gw} 는 받았지만 뒤의 모델 서버로 전달하지 못했다(HTTP {code}). HTTPRoute backendRefs 의 "
                "Service 이름·포트, 모델 파드 Ready 상태(GPU 스케줄·모델 로딩 중), ReferenceGrant(다른 네임스페이스) "
                "를 확인한다. `kubectl get httproute -A -o yaml` 의 status.parents.conditions 에 사유가 나온다.")
    if code == 405:
        return "메서드가 허용되지 않았다 — 경로가 OpenAI 호환 API 가 아닌 다른 서비스를 가리키는지 확인한다."
    return ""


async def _diagnose_ollama(profile: LLMProfile, d: _Diag, headers: dict) -> tuple[Optional[str], list[str]]:
    base = profile.base_url
    available: list[str] = []
    async with httpx.AsyncClient(**profile.client_kwargs(10), headers=headers) as client:
        # 5) 서버 응답
        t0 = d.start("server", "Ollama 서버")
        try:
            r = await client.get(f"{base}/")
            v = await client.get(f"{base}/api/version")
            version = v.json().get("version", "?") if v.status_code == 200 else "?"
            if r.status_code != 200:
                d.finish("server", "Ollama 서버", "fail", f"GET / → HTTP {r.status_code}",
                         hint=_response_hint(r, profile)
                         or "base_url 이 Ollama 가 아닌 다른 서비스를 가리키는지 확인한다.", t0=t0)
                return None, available
            d.finish("server", "Ollama 서버", "ok", f"{r.text.strip()[:60]} · version {version}", t0=t0)
        except Exception as exc:  # noqa: BLE001
            d.finish("server", "Ollama 서버", "fail", f"HTTP 요청 실패: {type(exc).__name__} {exc}",
                     hint=_exc_hint(exc, profile)
                     or "포트는 열렸지만 HTTP 응답이 없다 — 프록시/사이드카나 TLS(https) 여부를 확인한다.", t0=t0)
            return None, available

        # 6) 모델 목록 + 이름 해석
        t0 = d.start("models", "모델 확인")
        try:
            tags = await client.get(f"{base}/api/tags")
            available = [m.get("name", "") for m in tags.json().get("models", [])] if tags.status_code == 200 else []
        except Exception as exc:  # noqa: BLE001
            d.finish("models", "모델 확인", "fail", f"/api/tags 조회 실패: {exc}", t0=t0)
            return None, available
        d.info(f"서버 모델 {len(available)}개: {', '.join(available) or '없음'}")
        resolved = pick_ollama_model(profile.model, available)
        if not available:
            d.finish(
                "models", "모델 확인", "fail", "서버에 모델이 하나도 없다.",
                hint=("이미지에 모델이 구워지지 않았다(구 ghcr.io/riverjin839/ollama-qwen2.5-coder 이미지가 "
                      "이 상태였다). ghcr.io/riverjin839/devops_management/ollama-qwen2.5-coder:7b 로 바꾸거나, "
                      "인터넷이 되면 'Settings → 모델 pull' 로 받는다. /root/.ollama 에 emptyDir 를 마운트하면 "
                      "구운 모델이 가려진다."),
                t0=t0,
            )
            return None, available
        if resolved is None:
            d.finish(
                "models", "모델 확인", "fail", f"설정 모델 '{profile.model}' 이 서버에 없다.",
                hint=f"프로필 모델명을 서버 모델 중 하나({', '.join(available[:5])})로 바꾼다. "
                     "이미지 태그(:5b 등)와 모델 태그는 다를 수 있다 — 기준은 `ollama list` 출력이다.",
                t0=t0,
            )
            return None, available
        if resolved != profile.model:
            d.finish("models", "모델 확인", "warn",
                     f"설정 '{profile.model}' 은 정확히 없지만 '{resolved}' 로 자동 해석된다.",
                     hint=f"프로필 모델명을 '{resolved}' 로 고쳐 두면 재시도 없이 바로 호출된다.", t0=t0)
        else:
            d.finish("models", "모델 확인", "ok", f"모델 '{resolved}' 확인", t0=t0)

        # 7) 모델 정보 — 파라미터 크기·양자화·컨텍스트·시스템 프롬프트 내장 여부
        t0 = d.start("show", "모델 정보")
        try:
            sr = await client.post(f"{base}/api/show", json={"model": resolved})
            info = sr.json() if sr.status_code == 200 else {}
            det = info.get("details") or {}
            ctx = _context_length(info)
            has_system = "SYSTEM" in (info.get("modelfile") or "")
            parts = [
                f"family={det.get('family', '?')}",
                f"size={det.get('parameter_size', '?')}",
                f"quant={det.get('quantization_level', '?')}",
                f"context={ctx or '?'}",
                f"num_ctx={_param(info, 'num_ctx') or '기본(2048)'}",
                f"내장 시스템 프롬프트={'있음' if has_system else '없음'}",
            ]
            status, hint = "ok", ""
            if not _param(info, "num_ctx"):
                status = "warn"
                hint = ("num_ctx 가 기본값(2048)이면 긴 로그·점검 결과가 잘린다 — K8s 운영 전용 모델"
                        "(pep-k8s-ops, docs/LLM_CHATBOT_SETUP.md)처럼 Modelfile 에 num_ctx 8192 를 준다.")
            d.finish("show", "모델 정보", status, " · ".join(parts), hint=hint, t0=t0)
        except Exception as exc:  # noqa: BLE001
            d.finish("show", "모델 정보", "warn", f"/api/show 실패(진단 계속): {exc}", t0=t0)

    # 8) 실제 생성 — 콜드 로딩 시간(load_duration)과 생성 속도를 잰다.
    t0 = d.start("generate", "응답 테스트")
    d.info(f"짧은 프롬프트로 생성 테스트 — 첫 호출은 모델을 메모리에 올리느라 오래 걸릴 수 있다"
           f"(최대 {profile.timeout_seconds}s 대기)")
    try:
        async with httpx.AsyncClient(**profile.client_kwargs(profile.timeout_seconds), headers=headers) as client:
            gr = await client.post(f"{base}/api/generate", json={
                "model": resolved, "prompt": _DIAG_PROMPT, "stream": False,
                "options": {"num_predict": 16},
            })
        if gr.status_code != 200:
            d.finish("generate", "응답 테스트", "fail", f"HTTP {gr.status_code}: {gr.text[:200]}",
                     hint=_http_hint(gr.status_code, gr.text), t0=t0)
            return resolved, available
        g = gr.json()
        load_s = (g.get("load_duration") or 0) / 1e9
        eval_n = g.get("eval_count") or 0
        eval_s = (g.get("eval_duration") or 0) / 1e9
        tps = f"{eval_n / eval_s:.1f} tok/s" if eval_s > 0 else "?"
        detail = (f"응답 \"{(g.get('response') or '').strip()[:40]}\" · 모델 로딩 {load_s:.1f}s · "
                  f"생성 {eval_n} 토큰 {tps}")
        hint = ""
        status = "ok"
        if load_s > profile.timeout_seconds * 0.5:
            status, hint = "warn", (f"모델 로딩이 타임아웃({profile.timeout_seconds}s)의 절반을 넘는다 — "
                                    "프로필 타임아웃을 늘리거나 OLLAMA_KEEP_ALIVE=24h 로 모델을 메모리에 상주시킨다.")
        elif eval_s > 0 and eval_n / eval_s < 3:
            status, hint = "warn", ("생성 속도가 3 tok/s 미만이다 — CPU limit 을 늘리거나 더 작은 모델"
                                    "(qwen2.5-coder:3b)·더 강한 양자화(q4_K_M)를 쓴다.")
        d.finish("generate", "응답 테스트", status, detail, hint=hint, t0=t0)
    except httpx.TimeoutException:
        d.finish("generate", "응답 테스트", "fail", f"{profile.timeout_seconds}s 안에 응답이 없다.",
                 hint=("CPU 노드에서 7B 모델 첫 로딩은 수십 초~수 분 걸린다. 프로필 타임아웃을 300s 로 늘리고, "
                       "OLLAMA_KEEP_ALIVE=24h·메모리 limit(≥8Gi)을 확인한다. OOMKilled 이력은 "
                       "`kubectl describe pod -l app=ollama` 로 본다."),
                 t0=t0)
    except Exception as exc:  # noqa: BLE001
        d.finish("generate", "응답 테스트", "fail", f"생성 요청 실패: {exc}", t0=t0)
    return resolved, available


async def _diagnose_openai(profile: LLMProfile, d: _Diag, headers: dict) -> tuple[Optional[str], list[str]]:
    available: list[str] = []
    models_url = profile.api_url("/models")

    # 5) 게이트웨이 응답 + 모델 목록 — HTTPRoute 매칭·TLS·인증이 여기서 드러난다.
    t0 = d.start("models", "모델 확인")
    try:
        async with httpx.AsyncClient(**profile.client_kwargs(10)) as client:
            r = await client.get(models_url, headers=headers)
    except Exception as exc:  # noqa: BLE001
        d.finish("models", "모델 확인", "fail", f"GET {models_url} 실패: {type(exc).__name__} {exc}",
                 hint=_exc_hint(exc, profile) or "포트는 열렸지만 HTTP 요청이 실패했다.", t0=t0)
        return None, available
    _log_response(d, r)
    if r.status_code in (401, 403, 407):
        d.finish("models", "모델 확인", "fail", f"GET {models_url} → HTTP {r.status_code}",
                 hint=_response_hint(r, profile), t0=t0)
        return None, available
    if r.status_code != 200:
        # /v1/models 를 막아 둔 게이트웨이도 있어 응답 테스트는 계속한다.
        d.finish("models", "모델 확인", "warn", f"GET {models_url} → HTTP {r.status_code} (응답 테스트는 계속)",
                 hint=_response_hint(r, profile), t0=t0)
    else:
        try:
            available = [m.get("id", "") for m in (r.json().get("data") or []) if isinstance(m, dict) and m.get("id")]
        except ValueError:
            d.finish("models", "모델 확인", "warn", "HTTP 200 이지만 JSON 이 아니다 — 로그인 페이지나 다른 웹 서비스일 수 있다.",
                     hint="base_url 경로가 모델 서버(OpenAI 호환 API)로 라우팅되는지 확인한다.", t0=t0)
            available = []
        else:
            d.info(f"서버 모델 {len(available)}개: {', '.join(available) or '없음'}")
            if not profile.model and available:
                d.finish("models", "모델 확인", "warn",
                         f"모델명이 비어 있어 서버 모델 '{available[0]}' 로 응답을 시험한다.",
                         hint=f"'모델명 저장' 으로 '{available[0]}' 을 저장하거나 목록({', '.join(available[:5])})에서 고른다.",
                         t0=t0)
            elif profile.model and available and profile.model not in available:
                d.finish("models", "모델 확인", "warn", f"설정 모델 '{profile.model}' 이 서버 목록에 없다.",
                         hint=f"서버 모델: {', '.join(available[:5])} — 대소문자·경로(org/model)까지 정확히 맞춘다.",
                         t0=t0)
            else:
                d.finish("models", "모델 확인", "ok",
                         f"서버 모델 {len(available)}개" if available else "모델 목록이 비어 있다(응답 테스트는 계속)",
                         t0=t0)

    model = profile.model or (available[0] if available else "")
    resolved = model or None

    # 6) 실제 생성 — 프로덕션 호출과 같은 URL·헤더·옵션으로 직접 보내 상세 사유를 남긴다.
    t0 = d.start("generate", "응답 테스트")
    if not model:
        d.finish("generate", "응답 테스트", "fail", "시험할 모델명이 없다(설정도 비었고 서버 목록도 못 받았다).",
                 hint="서버 모델명을 프로필에 직접 입력한 뒤 다시 진단한다.", t0=t0)
        return None, available
    chat_url = profile.api_url("/chat/completions")
    payload = {"model": model, "messages": [{"role": "user", "content": _DIAG_PROMPT}],
               "stream": False, "max_tokens": 16}
    d.info(f"POST {chat_url} (model={model}, 최대 {profile.timeout_seconds}s 대기)")
    try:
        async with httpx.AsyncClient(**profile.client_kwargs(profile.timeout_seconds)) as client:
            gr = await client.post(chat_url, json=payload, headers={**headers, "Content-Type": "application/json"})
    except Exception as exc:  # noqa: BLE001
        d.finish("generate", "응답 테스트", "fail", f"생성 요청 실패: {type(exc).__name__} {exc}",
                 hint=_exc_hint(exc, profile), t0=t0)
        return resolved, available
    if gr.status_code != 200:
        _log_response(d, gr)
        d.finish("generate", "응답 테스트", "fail", f"HTTP {gr.status_code}: {gr.text.strip()[:200]}",
                 hint=_response_hint(gr, profile) or _http_hint(gr.status_code, gr.text), t0=t0)
        return resolved, available
    try:
        data = gr.json()
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    except Exception:  # noqa: BLE001
        content = ""
    if not content:
        d.finish("generate", "응답 테스트", "fail", f"HTTP 200 이지만 응답 형식이 OpenAI 호환이 아니다: {gr.text.strip()[:200]}",
                 hint="경로가 OpenAI 호환 API(vLLM/TGI/LiteLLM 등)로 라우팅되는지, 'API 경로' 설정이 맞는지 확인한다.",
                 t0=t0)
        return resolved, available
    d.finish("generate", "응답 테스트", "ok", f"응답 \"{content.strip()[:40]}\" · model={data.get('model', model)}",
             t0=t0)
    return resolved, available


def _log_response(d: _Diag, r: httpx.Response) -> None:
    keep = [f"{k}={v}" for k, v in r.headers.items()
            if k.lower() in ("server", "content-type", "x-envoy-upstream-service-time", "via", "x-request-id")]
    d.info(f"  응답 HTTP {r.status_code} · {' · '.join(keep) or '헤더 없음'}")
    if r.status_code != 200:
        d.info(f"  본문: {r.text.strip()[:200] or '(비어 있음)'}")


def _summary(profile: LLMProfile, d: _Diag, resolved: Optional[str], available: list[str]) -> dict:
    failed = [c for c in d.checks if c["status"] == "fail"]
    warned = [c for c in d.checks if c["status"] == "warn"]
    if failed and all(c["name"] == "config" for c in failed):
        log_evt(d.emit, "error", "진단 결과: 연결·응답은 확인했지만 '설정 확인' 항목(프로필 활성 여부)을 고쳐야 한다.")
    elif failed:
        log_evt(d.emit, "error", f"진단 결과: 실패 — '{failed[0]['label']}' 단계부터 막혀 있다.")
    elif warned:
        log_evt(d.emit, "warn", f"진단 결과: 동작은 하지만 확인할 항목 {len(warned)}건")
    else:
        log_evt(d.emit, "info", "진단 결과: 정상 — 챗봇이 이 프로필로 응답할 수 있다.")
    return {
        "profile": profile.name,
        "provider": profile.provider,
        "base_url": profile.base_url,
        "model": profile.model,
        "resolved_model": resolved,
        "available_models": available,
        "ok": not failed,
        "checks": d.checks,
    }


def _context_length(info: dict) -> Optional[int]:
    for k, v in (info.get("model_info") or {}).items():
        if k.endswith(".context_length"):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
    return None


def _param(info: dict, name: str) -> Optional[str]:
    for line in (info.get("parameters") or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == name:
            return parts[1]
    return None


def _http_hint(code: int, text: Any) -> str:
    t = str(text).lower()
    if code == 404 or "not found" in t:
        return "모델명이 서버에 없다 — '모델 확인' 단계의 서버 모델 목록과 맞춘다."
    if code in (401, 403) or "auth" in t:
        return "API 키를 확인한다."
    if code == 500 and ("memory" in t or "oom" in t):
        return "모델을 올릴 메모리가 부족하다 — Ollama 파드 memory limit 을 늘린다."
    return ""
