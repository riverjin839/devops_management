"""Jira SSO 세션 자동 캡처 — Playwright 로 브라우저 SSO 로그인을 대신 수행.

참고 프로젝트(lake-task-manager, `app/auth/sso_session.py`)의 "Playwright SSO 세션 재사용"
아이디어를 PEP 에 맞게 구현한다. PAT 발급이 막힌 폐쇄망 SSO 환경에서 **사용자가 토큰/쿠키를
수동으로 복사하지 않도록**, 백엔드가 브라우저를 띄워 평소처럼 SSO 로그인만 하면 그 세션
쿠키를 자동으로 캡처한다. 캡처한 쿠키는 기존 `auth_type='cookie'/'sso'` REST 경로(가져오기·
되쓰기)가 그대로 재사용한다 — 즉 여기서 하는 일은 "쿠키를 자동으로 얻기"뿐이다.

설계 메모:
 - Playwright **sync** API 를 쓰되, FastAPI async 핸들러에서는 `asyncio.to_thread` 로 감싸
   블로킹 로그인을 별도 스레드에서 1회성으로 실행한다(Playwright 객체를 스레드 간 공유하지
   않으므로 참조 레포의 영속 워커 스레드 machinery 는 불필요).
 - **헤디드(headless=False)** 브라우저로 띄운다 — SSO 는 사내 IdP 리다이렉트/인증서 선택 등
   상호작용이 필요하다. 따라서 백엔드 호스트에 조작 가능한 디스플레이가 있어야 한다(헤드리스
   K8s 라면 Xvfb 등 가상 디스플레이 필요). `JIRA_SSO_HEADLESS=1` 로 강제 헤드리스 가능(테스트용).
 - 로그인 성공 판정은 상태명이 아니라 `/rest/api/2/myself` 200 응답으로 한다(SSO 완료 신호).
 - **절대 raise 하지 않고** 구조화된 `{"status": "ok|error", ...}` dict 를 반환한다
   (Playwright 미설치·디스플레이 없음·타임아웃 모두 사유를 담아 돌려줌).
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# 로그인 완료를 기다리는 최대 시간(초) — SSO 클릭스루에 넉넉히.
DEFAULT_LOGIN_TIMEOUT = int(os.getenv("JIRA_SSO_LOGIN_TIMEOUT", "180"))
# myself 폴링 간격(초).
_POLL_INTERVAL = 2.0


def _cookie_host(base_url: str) -> str:
    try:
        return (urlparse(base_url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""


def _build_cookie_header(cookies: list[dict], host: str) -> str:
    """Playwright context.cookies() → Jira 로 보낼 `Cookie` 헤더 문자열.

    SSO 과정에서 IdP 등 여러 도메인의 쿠키가 섞이므로 Jira 호스트에 해당하는 것만 추린다
    (도메인이 host 의 접미사이거나 그 반대). 추린 게 없으면(도메인 매칭 애매) 전체를 사용."""
    def _match(dom: str) -> bool:
        d = (dom or "").lstrip(".").lower()
        return bool(d) and (host == d or host.endswith("." + d) or d.endswith("." + host))

    scoped = [c for c in cookies if _match(c.get("domain", ""))]
    use = scoped or cookies
    seen: set[str] = set()
    parts: list[str] = []
    for c in use:
        name = c.get("name")
        if not name or name in seen:
            continue
        seen.add(name)
        parts.append(f"{name}={c.get('value', '')}")
    return "; ".join(parts)


def capture_sso_session(
    base_url: str,
    *,
    verify_tls: bool = True,
    timeout: int = DEFAULT_LOGIN_TIMEOUT,
) -> dict:
    """헤디드 브라우저를 띄워 SSO 로그인을 기다린 뒤 세션 쿠키를 캡처한다(블로킹).

    반환:
      성공 → {"status":"ok", "cookie_header": str, "account": str, "display_name": str}
      실패 → {"status":"error", "detail": str}
    """
    base_url = (base_url or "").rstrip("/")
    if not base_url:
        return {"status": "error", "detail": "Jira Base URL 이 설정되지 않았습니다."}

    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        return {
            "status": "error",
            "detail": "백엔드에 Playwright 가 설치되지 않았습니다. "
                      "'pip install playwright && playwright install chromium' 후 다시 시도하세요.",
        }

    headless = os.getenv("JIRA_SSO_HEADLESS", "").strip() in ("1", "true", "yes")
    host = _cookie_host(base_url)
    myself_url = f"{base_url}/rest/api/2/myself"
    deadline = time.monotonic() + max(30, timeout)

    # 진단값 — 어디서 멈췄는지 사용자/로그에 노출.
    diag = {"attempts": 0, "last_ctx_status": None, "last_page_status": None,
            "cookie_count": 0, "host": host}

    def _extract_account(data: dict) -> Optional[tuple]:
        acct = data.get("name") or data.get("key") or ""
        disp = data.get("displayName") or acct
        return (acct, disp) if (acct or disp) else None

    def _probe_ctx(context) -> Optional[tuple]:
        """서버사이드 APIRequestContext — context 쿠키를 공유하지만 일부 httpOnly/SameSite
        조합에서 세션이 안 실릴 수 있어 보조 신호로만 신뢰한다."""
        try:
            resp = context.request.get(myself_url, timeout=10_000)
            diag["last_ctx_status"] = resp.status
            if resp.status == 200:
                return _extract_account(resp.json())
        except Exception as exc:  # noqa: BLE001
            diag["last_ctx_status"] = f"err:{str(exc)[:50]}"
        return None

    def _probe_page(page) -> Optional[tuple]:
        """브라우저 페이지 자체의 fetch — 사용자가 보는 실제 세션(httpOnly 쿠키 포함)으로
        호출하는 ground truth. 페이지가 Jira 오리진일 때만 same-origin 으로 동작한다."""
        try:
            if _cookie_host(page.url) != host:
                return None
            res = page.evaluate(
                "async (u) => { try { const r = await fetch(u, {credentials:'include'});"
                " return {s: r.status, b: r.status === 200 ? await r.text() : ''}; }"
                " catch (e) { return {s: -1, b: ''}; } }",
                myself_url,
            )
            diag["last_page_status"] = res.get("s")
            if res.get("s") == 200 and res.get("b"):
                return _extract_account(json.loads(res["b"]))
        except Exception as exc:  # noqa: BLE001
            diag["last_page_status"] = f"err:{str(exc)[:50]}"
        return None

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=headless)
            except Exception as exc:  # noqa: BLE001 - 디스플레이 없음/브라우저 미설치 등
                logger.warning("Jira SSO browser launch failed: %s", exc)
                return {
                    "status": "error",
                    "detail": "브라우저를 띄울 수 없습니다. 백엔드 호스트에 Chromium 과 "
                              "표시 가능한 디스플레이가 필요합니다(헤드리스 서버면 Xvfb 등). "
                              f"원인: {str(exc)[:160]}",
                }
            try:
                context = browser.new_context(ignore_https_errors=not verify_tls)
                page = context.new_page()
                try:
                    page.goto(base_url, wait_until="domcontentloaded", timeout=30_000)
                except Exception:  # noqa: BLE001 - 초기 진입 실패해도 폴링은 계속
                    logger.info("Jira SSO initial goto slow/failed — 폴링 계속")

                # 로그인 완료까지 폴링 — 페이지 fetch(우선) + APIRequestContext(보조).
                while time.monotonic() < deadline:
                    diag["attempts"] += 1
                    hit = _probe_page(page) or _probe_ctx(context)
                    if hit:
                        acct, display = hit
                        cookies = context.cookies()
                        diag["cookie_count"] = len(cookies)
                        header = _build_cookie_header(cookies, host)
                        if not header:
                            return {
                                "status": "error",
                                "detail": f"로그인은 감지됐지만 세션 쿠키를 추출하지 못했습니다 "
                                          f"(쿠키 {len(cookies)}개, host={host}).",
                                "diag": diag,
                            }
                        logger.info("Jira SSO captured: acct=%s cookies=%d attempts=%d",
                                    acct, len(cookies), diag["attempts"])
                        return {
                            "status": "ok", "cookie_header": header,
                            "account": acct, "display_name": display, "diag": diag,
                        }
                    time.sleep(_POLL_INTERVAL)

                logger.warning("Jira SSO timeout — diag=%s", diag)
                return {
                    "status": "error",
                    "detail": (
                        f"제한 시간({timeout}s) 안에 로그인이 감지되지 않았습니다 "
                        f"(시도 {diag['attempts']}회 · myself[ctx]={diag['last_ctx_status']} · "
                        f"myself[page]={diag['last_page_status']}). ▸ 팝업된 그 브라우저 창에서 "
                        "로그인을 끝까지(마지막에 Jira 화면이 뜰 때까지) 마쳤는지, 자체서명 인증서면 "
                        "공통설정의 'TLS 인증서 검증'을 꺼야 하는지 확인하세요."
                    ),
                    "diag": diag,
                }
            finally:
                try:
                    browser.close()
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        logger.exception("Jira SSO capture error: %s", exc)
        return {"status": "error", "detail": f"SSO 캡처 중 오류: {str(exc)[:180]}", "diag": diag}
