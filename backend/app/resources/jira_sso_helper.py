#!/usr/bin/env python3
"""PEP Jira SSO 로컬 로그인 도우미.

백엔드가 K8s/컨테이너로 배포되면 파드 안에서 브라우저를 띄울 수 없으므로
(화면이 없어 사용자가 SSO 로그인을 완료할 방법이 없음), **이 스크립트를 본인 PC 에서
실행**해 브라우저 로그인을 대신한다 — 참고 프로젝트(lake-task-manager)의 "사용자 PC 에서
소스 실행 + Playwright SSO 세션 캡처" 패턴을 PEP 의 K8s 배포에 맞게 클라이언트 쪽으로
옮긴 것이다. 흐름:

  1. PEP 계정으로 로그인 (또는 --pep-token 으로 기존 토큰 사용)
  2. PEP 에 저장된 Jira URL 조회
  3. 내 PC 에 Playwright Chromium 창을 띄움 → 평소처럼 사내 SSO 로그인
  4. 로그인 완료를 자동 감지(/rest/api/2/myself 폴링) 후 세션 쿠키 캡처
  5. 캡처한 쿠키를 PEP 의 기존 자격증명 API 로 자동 등록 + 연결 테스트

사용법 (최초 1회 준비):
    pip install playwright
    playwright install chromium

실행:
    python jira_sso_helper.py --pep-url https://<PEP 주소>
    # 사내 자체서명 인증서 환경이면:
    python jira_sso_helper.py --pep-url https://<PEP 주소> --insecure

이 파일은 PEP 백엔드 이미지에 동봉되어 설정 ▸ Jira 연동 화면에서 내려받는다.
표준 라이브러리 + playwright 만 사용한다 (requests 등 추가 설치 불필요).
"""
from __future__ import annotations

import argparse
import getpass
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

LOGIN_TIMEOUT_DEFAULT = 300  # SSO 클릭스루 대기(초)
POLL_INTERVAL = 2.0


def _die(msg: str) -> None:
    print(f"\n[실패] {msg}")
    sys.exit(1)


# ── PEP API (표준 라이브러리 urllib 만 사용) ──────────────────────────────────────
class PepClient:
    def __init__(self, base_url: str, insecure: bool = False):
        self.base = base_url.rstrip("/")
        self.token: str | None = None
        self.ctx = ssl._create_unverified_context() if insecure else None  # noqa: S323

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base}/api/v1{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=30, context=self.ctx) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode("utf-8")).get("detail", "")
            except Exception:  # noqa: BLE001
                detail = ""
            _die(f"PEP API {method} {path} 실패 (HTTP {e.code}): {detail or e.reason}")
        except urllib.error.URLError as e:
            _die(
                f"PEP 서버({self.base})에 연결할 수 없습니다: {e.reason}\n"
                "  - --pep-url 주소가 맞는지, 사내망/VPN 에 연결돼 있는지 확인하세요.\n"
                "  - 자체서명 인증서 환경이면 --insecure 를 붙여 다시 실행하세요."
            )

    def login(self, username: str, password: str) -> None:
        res = self._call("POST", "/auth/login", {"username": username, "password": password})
        self.token = res.get("access_token") or _die("PEP 로그인 응답에 토큰이 없습니다.")


# ── Jira 세션 캡처 (backend/app/services/jira_sso_service.py 와 동일 로직) ────────
def _cookie_host(base_url: str) -> str:
    try:
        return (urlparse(base_url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""


def _build_cookie_header(cookies: list[dict], host: str) -> str:
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


def capture_session(jira_url: str, verify_tls: bool, timeout: int) -> tuple[str, str]:
    """헤디드 Chromium 을 띄워 SSO 로그인을 기다렸다가 (쿠키헤더, 표시이름) 을 반환."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        _die(
            "Playwright 가 설치되지 않았습니다. 아래 두 명령을 실행한 뒤 다시 시도하세요:\n"
            "    pip install playwright\n"
            "    playwright install chromium"
        )

    myself_url = f"{jira_url}/rest/api/2/myself"
    deadline = time.monotonic() + max(30, timeout)
    print(f"\n[3/5] 브라우저를 엽니다 — 열린 창에서 평소처럼 SSO 로그인을 완료하세요.")
    print(f"      (로그인이 감지되면 자동으로 다음 단계로 넘어갑니다. 최대 {timeout}초 대기)")

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=False)
        except Exception as exc:  # noqa: BLE001
            _die(
                f"Chromium 실행 실패: {exc}\n"
                "    'playwright install chromium' 을 실행했는지 확인하세요."
            )
        context = browser.new_context(ignore_https_errors=not verify_tls)
        page = context.new_page()
        try:
            page.goto(jira_url, wait_until="domcontentloaded", timeout=60_000)
        except Exception:  # noqa: BLE001 - 초기 진입 실패해도 폴링은 계속
            pass

        while time.monotonic() < deadline:
            try:
                resp = context.request.get(myself_url, timeout=10_000)
                if resp.ok:
                    data = resp.json()
                    account = data.get("name") or data.get("key") or ""
                    display = data.get("displayName") or account
                    cookie_header = _build_cookie_header(context.cookies(), _cookie_host(jira_url))
                    browser.close()
                    if not cookie_header:
                        _die("로그인은 감지됐으나 캡처된 쿠키가 없습니다. 다시 시도해 주세요.")
                    return cookie_header, display
            except Exception:  # noqa: BLE001 - 아직 로그인 전 — 계속 폴링
                pass
            time.sleep(POLL_INTERVAL)

        browser.close()
    _die(f"{timeout}초 안에 SSO 로그인이 감지되지 않았습니다. 다시 실행해 주세요.")
    raise AssertionError  # unreachable


def main() -> None:
    ap = argparse.ArgumentParser(description="PEP Jira SSO 로컬 로그인 도우미")
    ap.add_argument("--pep-url", required=True, help="PEP 주소 (예: https://pep.example.com)")
    ap.add_argument("--pep-token", default=None, help="(선택) PEP JWT — 지정하면 계정 입력 생략")
    ap.add_argument("--jira-url", default=None, help="(선택) Jira 주소 — 미지정 시 PEP 설정값 사용")
    ap.add_argument("--timeout", type=int, default=LOGIN_TIMEOUT_DEFAULT, help="SSO 로그인 대기 초")
    ap.add_argument("--insecure", action="store_true", help="TLS 인증서 검증 생략 (자체서명 환경)")
    args = ap.parse_args()

    pep = PepClient(args.pep_url, insecure=args.insecure)
    if args.pep_token:
        pep.token = args.pep_token
        print("[1/5] PEP 토큰 사용")
    else:
        print("[1/5] PEP 로그인")
        username = input("  PEP 아이디: ").strip()
        password = getpass.getpass("  PEP 비밀번호: ")
        pep.login(username, password)
        print("  → 로그인 성공")

    print("[2/5] PEP 의 Jira 설정 조회")
    cfg = pep._call("GET", "/jira/config")
    jira_url = (args.jira_url or cfg.get("base_url") or "").rstrip("/")
    if not jira_url:
        _die("PEP 에 Jira URL 이 설정되지 않았습니다. 관리자에게 설정을 요청하거나 --jira-url 로 지정하세요.")
    verify_tls = bool(cfg.get("verify_tls", True)) and not args.insecure
    print(f"  → Jira: {jira_url}")

    cookie_header, display = capture_session(jira_url, verify_tls, args.timeout)
    print(f"[4/5] 로그인 감지됨: {display or '(계정명 확인 불가)'} — 세션 쿠키 캡처 완료")

    pep._call("PUT", "/jira/credential", {"token": cookie_header, "auth_type": "sso"})
    print("[5/5] PEP 에 세션 등록 완료 — 연결 테스트 중…")
    test = pep._call("POST", "/jira/test")
    if test.get("ok"):
        who = test.get("display_name") or display
        print(f"\n[성공] Jira 연동 준비 완료{f' ({who})' if who else ''}. PEP 화면에서 바로 가져오기/반영을 사용할 수 있습니다.")
    else:
        print(
            f"\n[주의] 세션은 저장됐지만 PEP 백엔드→Jira 연결 테스트가 실패했습니다: {test.get('detail', '')}\n"
            "  - PEP 백엔드에서 Jira 로의 네트워크가 열려 있는지 확인하세요.\n"
            "  - 자체서명 인증서면 관리자 설정에서 'TLS 인증서 검증'을 해제하세요."
        )


if __name__ == "__main__":
    main()
