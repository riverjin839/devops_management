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
import time
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
    if not profile.enabled:
        d.finish("config", "설정 확인", "fail", "프로필이 비활성화돼 있다.",
                 hint="프로필 편집에서 '활성' 을 켠다.", t0=t0)
    elif not profile.model:
        d.finish("config", "설정 확인", "fail", "모델명이 비어 있다.",
                 hint="프로필 편집에서 서버에 있는 모델명을 고른다(모델 목록 버튼).", t0=t0)
    elif settings_stored and profile.provider == "ollama" and profile.model != settings.ollama_model:
        d.finish(
            "config", "설정 확인", "warn",
            f"DB 저장 설정(model={profile.model})이 환경변수 OLLAMA_MODEL={settings.ollama_model} 을 덮고 있다.",
            hint="ConfigMap 의 OLLAMA_MODEL 을 바꿔도 반영되지 않는다 — 이 화면에서 프로필 모델명을 직접 고친다.",
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
                  "없는 것이다 — 작은 모델(3b)로 requests 를 낮추거나, Ollama 를 빼고(k8s/components/no-ollama) "
                  "사내 LLM 프로필로 라우팅한다. 포트(11434)·NetworkPolicy·OLLAMA_HOST=0.0.0.0 도 확인한다."),
            t0=t0,
        )
        return _summary(profile, d, resolved_model, available)

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    if profile.provider == "ollama":
        resolved_model, available = await _diagnose_ollama(profile, d)
    else:
        resolved_model, available = await _diagnose_openai(profile, d, headers)
    return _summary(profile, d, resolved_model, available)


async def _diagnose_ollama(profile: LLMProfile, d: _Diag) -> tuple[Optional[str], list[str]]:
    base = profile.base_url
    available: list[str] = []
    async with httpx.AsyncClient(timeout=10) as client:
        # 4) 서버 응답
        t0 = d.start("server", "Ollama 서버")
        try:
            r = await client.get(f"{base}/")
            v = await client.get(f"{base}/api/version")
            version = v.json().get("version", "?") if v.status_code == 200 else "?"
            if r.status_code != 200:
                d.finish("server", "Ollama 서버", "fail", f"GET / → HTTP {r.status_code}",
                         hint="base_url 이 Ollama 가 아닌 다른 서비스를 가리키는지 확인한다.", t0=t0)
                return None, available
            d.finish("server", "Ollama 서버", "ok", f"{r.text.strip()[:60]} · version {version}", t0=t0)
        except Exception as exc:  # noqa: BLE001
            d.finish("server", "Ollama 서버", "fail", f"HTTP 요청 실패: {exc}",
                     hint="포트는 열렸지만 HTTP 응답이 없다 — 프록시/사이드카나 TLS(https) 여부를 확인한다.", t0=t0)
            return None, available

        # 5) 모델 목록 + 이름 해석
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

        # 6) 모델 정보 — 파라미터 크기·양자화·컨텍스트·시스템 프롬프트 내장 여부
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

    # 7) 실제 생성 — 콜드 로딩 시간(load_duration)과 생성 속도를 잰다.
    t0 = d.start("generate", "응답 테스트")
    d.info(f"짧은 프롬프트로 생성 테스트 — 첫 호출은 모델을 메모리에 올리느라 오래 걸릴 수 있다"
           f"(최대 {profile.timeout_seconds}s 대기)")
    try:
        async with httpx.AsyncClient(timeout=profile.timeout_seconds) as client:
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
    from app.services.llm.service import llm_service  # 지연 import — 순환 방지

    available: list[str] = []
    t0 = d.start("models", "모델 확인")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{profile.base_url}/v1/models", headers=headers)
        if r.status_code in (401, 403):
            d.finish("models", "모델 확인", "fail", f"/v1/models → HTTP {r.status_code}",
                     hint="API 키 참조(api_key_ref)가 맞는지, 키가 만료되지 않았는지 확인한다.", t0=t0)
            return None, available
        available = [m.get("id", "") for m in (r.json().get("data") or [])] if r.status_code == 200 else []
        if profile.model and available and profile.model not in available:
            d.finish("models", "모델 확인", "warn", f"설정 모델 '{profile.model}' 이 /v1/models 목록에 없다.",
                     hint=f"서버 모델: {', '.join(available[:5])}", t0=t0)
        else:
            d.finish("models", "모델 확인", "ok",
                     f"서버 모델 {len(available)}개" if available else "/v1/models 미지원(진단 계속)", t0=t0)
    except Exception as exc:  # noqa: BLE001
        d.finish("models", "모델 확인", "warn", f"/v1/models 조회 실패(진단 계속): {exc}", t0=t0)

    t0 = d.start("generate", "응답 테스트")
    result = await llm_service.build_provider(profile).chat(_DIAG_PROMPT)
    if result.status == "ok":
        d.finish("generate", "응답 테스트", "ok",
                 f"응답 \"{result.text.strip()[:40]}\" · {result.latency_ms}ms", t0=t0)
    else:
        d.finish("generate", "응답 테스트", "fail", f"{result.status}: {result.error}",
                 hint=_http_hint(0, result.error or ""), t0=t0)
    return profile.model, available


def _summary(profile: LLMProfile, d: _Diag, resolved: Optional[str], available: list[str]) -> dict:
    failed = [c for c in d.checks if c["status"] == "fail"]
    warned = [c for c in d.checks if c["status"] == "warn"]
    if failed:
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
