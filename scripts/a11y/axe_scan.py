#!/usr/bin/env python3
"""axe-core 접근성 스캔 — 주요 화면을 Playwright 로 열어 WCAG 2.1 A/AA 위반을 집계한다.

로컬 측정 도구다(CI 에 넣지 않는다). 실행 중인 프론트(vite)·백엔드(uvicorn)를 대상으로 한다.

    python3 scripts/a11y/axe_scan.py --out /tmp/a11y            # light·dark 두 번
    python3 scripts/a11y/axe_scan.py --themes dark --only /alerts,/docs --fail-on serious

동작
  1. ``POST {api}/auth/login`` 으로 토큰을 받는다(계정은 ``--username``/``--password`` 또는
     ``A11Y_USERNAME``/``A11Y_PASSWORD``). ``must_change_password`` 계정이면 중단한다 — 모든 화면이
     비밀번호 변경 화면으로 바뀌어 측정이 무의미해진다.
  2. 테마마다 ``PUT /me/home-prefs {theme}`` 로 서버 테마를 맞춘다(로그인 후엔 서버 값이 이긴다) —
     끝나면 원래 테마로 되돌린다. localStorage ``k8s:theme`` 도 같이 심는다.
  3. ``routes.json`` 의 각 라우트를 연다. ``auth: true`` 는 localStorage 에 토큰·사용자를 주입하고,
     ``auth: false`` (로그인 화면) 는 빈 저장소로 연다.
  4. ``frontend/node_modules/axe-core/axe.min.js`` 를 inject 하고
     ``axe.run(document, {runOnly: {type: 'tag', values: [wcag2a, wcag2aa, wcag21a, wcag21aa]}})``.
  5. 위반 노드마다 랜드마크 경로(``header`` / ``aside > nav[메인 네비게이션]`` / ``main`` / ``div[role=dialog]``)
     를 계산해 ``routes.json`` 의 ``regions`` 표로 소스 파일을 추정한다. 여러 라우트에 같은
     (rule, selector) 가 나오면 공용 컴포넌트 후보로 묶는다.

산출물 (``--out``)
  - ``axe-<theme>.json`` : 라우트별 원본(축약) 결과
  - ``summary.json``     : 테마별 rule·라우트·영향도 집계 + 공용 후보 + 대비 색쌍
  - ``summary.md``       : 사람이 읽는 요약

종료 코드: 0 = 정상(또는 ``--fail-on none``), 1 = ``--fail-on`` 이상 영향도의 위반 존재,
2 = 실행 실패(로그인·브라우저·axe 로드 등, 또는 ``--fail-on`` 이 none 이 아닐 때 측정하지 못한
라우트 — 앱이 마운트되지 않은 로딩 화면은 측정하지 않고 실패로 센다).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
IMPACTS = ["minor", "moderate", "serious", "critical"]
DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

# 브라우저 안에서 axe 를 돌리고 결과를 축약한다(노드 html/요약은 잘라 JSON 크기를 제한).
AXE_RUN_JS = r"""
async (opts) => {
  const LANDMARK_TAGS = new Set(['header', 'nav', 'aside', 'main', 'footer', 'dialog', 'form']);
  const LANDMARK_ROLES = new Set(['dialog', 'alertdialog', 'navigation', 'banner', 'main',
    'complementary', 'contentinfo', 'menu', 'listbox', 'tablist', 'tabpanel', 'toolbar']);
  const landmark = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && e.nodeType === 1; e = e.parentElement) {
      const tag = e.tagName.toLowerCase();
      const role = e.getAttribute('role');
      if (LANDMARK_TAGS.has(tag) || (role && LANDMARK_ROLES.has(role))) {
        const label = e.getAttribute('aria-label');
        parts.unshift(tag + (role ? `[role=${role}]` : '') + (label ? `[${label.slice(0, 40)}]` : ''));
      }
    }
    return parts.join(' > ') || '(body)';
  };
  const resolve = (target) => {
    try {
      const t = Array.isArray(target) ? target[target.length - 1] : target;
      return typeof t === 'string' ? document.querySelector(t) : null;
    } catch (e) { return null; }
  };
  const res = await window.axe.run(document, opts);
  const slim = (v) => ({
    id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
    tags: v.tags.filter((t) => t.startsWith('wcag')),
    nodes: v.nodes.map((n) => {
      const el = resolve(n.target);
      const out = {
        target: n.target.map((t) => Array.isArray(t) ? t.join(' >>> ') : t).join(' | '),
        html: (n.html || '').slice(0, 300),
        impact: n.impact,
        failureSummary: (n.failureSummary || '').slice(0, 400),
        landmark: el ? landmark(el) : '(unresolved)',
        text: el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) : '',
      };
      const cc = [...(n.any || []), ...(n.all || [])].find((c) => c.id === 'color-contrast' && c.data);
      if (cc && cc.data && cc.data.fgColor) {
        out.contrast = { fg: cc.data.fgColor, bg: cc.data.bgColor, ratio: cc.data.contrastRatio,
          expected: cc.data.expectedContrastRatio, fontSize: cc.data.fontSize, fontWeight: cc.data.fontWeight };
      }
      return out;
    }),
  });
  return {
    url: location.pathname + location.search,
    htmlClass: document.documentElement.className,
    axeVersion: window.axe.version,
    violations: res.violations.map(slim),
    incomplete: res.incomplete.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })),
    passes: res.passes.length,
  };
}
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def api_call(api: str, method: str, path: str, token: str | None = None, body: Any = None) -> Any:
    headers = {"content-type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        api.rstrip("/") + path, method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def login(api: str, username: str, password: str) -> tuple[str, dict]:
    try:
        d = api_call(api, "POST", "/auth/login", body={"username": username, "password": password})
    except urllib.error.HTTPError as e:
        raise SystemExit(f"[axe_scan] 로그인 실패: HTTP {e.code} — 계정/비밀번호 확인 (--username/--password)") from None
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"[axe_scan] API 에 연결할 수 없음({api}): {e}") from None
    u = d.get("user") or {}
    if u.get("must_change_password"):
        raise SystemExit("[axe_scan] 이 계정은 must_change_password=True — 모든 화면이 비밀번호 변경 화면이 된다. "
                         "비밀번호를 바꾸거나 플래그를 해제한 뒤 다시 실행.")
    user = {
        "id": str(u.get("id", "")), "username": u.get("username", username), "role": u.get("role", "viewer"),
        "displayName": u.get("display_name"), "isActive": True, "mustChangePassword": False,
        "createdAt": u.get("created_at", ""),
    }
    return d["access_token"], user


def set_server_theme(api: str, token: str, theme: str | None) -> bool:
    try:
        api_call(api, "PUT", "/me/home-prefs", token, {"theme": theme})
        return True
    except Exception as e:  # noqa: BLE001 — 측정 도구: 경고만
        log(f"  ! 서버 테마 설정 실패({theme}): {e} — localStorage 테마만 적용됨")
        return False


_UNKNOWN = object()  # 조회 실패 — 원래 값을 모르므로 복원하지 않는다


def get_server_theme(api: str, token: str) -> object:
    """서버 테마. 저장된 적 없으면 None(복원 시 None 으로 되돌린다), 조회 실패면 ``_UNKNOWN``."""
    try:
        return (api_call(api, "GET", "/me/home-prefs", token) or {}).get("theme")
    except Exception:  # noqa: BLE001
        return _UNKNOWN


def init_script(theme: str, token: str | None, user: dict | None) -> str:
    lines = [
        "try {",
        f"localStorage.setItem('k8s:theme', {json.dumps(theme)});",
        "localStorage.setItem('k8s:theme-migrated-light-default', '1');",
    ]
    if token and user:
        lines += [
            f"localStorage.setItem('k8s:auth:token', {json.dumps(token)});",
            f"localStorage.setItem('k8s:auth:user', {json.dumps(json.dumps(user))});",
            f"localStorage.setItem('pep:profile-owner', {json.dumps(user['id'])});",
        ]
    lines.append("} catch (e) {}")
    return "\n".join(lines)


def region_source(landmark: str, page: str, regions: list[dict]) -> str:
    for r in regions:
        if r["match"] in landmark:
            return page if r["source"] == "@page" else r["source"]
    return page


def scan_theme(pw, args, theme: str, routes: list[dict], token: str, user: dict, axe_src: str) -> list[dict]:
    launch: dict[str, Any] = {"headless": True}
    if args.chromium:
        launch["executable_path"] = args.chromium
    browser = pw.chromium.launch(**launch)
    w, h = (int(x) for x in args.viewport.lower().split("x"))
    results: list[dict] = []
    try:
        for auth in (False, True):
            group = [r for r in routes if bool(r.get("auth", True)) == auth]
            if not group:
                continue
            ctx = browser.new_context(viewport={"width": w, "height": h},
                                      color_scheme="dark" if theme == "dark" else "light")
            ctx.add_init_script(init_script(theme, token if auth else None, user if auth else None))
            page = ctx.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda e: page_errors.append(str(e)[:200]))
            for r in group:
                page_errors.clear()
                url = args.base_url.rstrip("/") + r["path"]
                entry: dict[str, Any] = {"id": r["id"], "path": r["path"], "label": r.get("label", ""),
                                         "page": r.get("page", ""), "theme": theme}
                try:
                    page.goto(url, wait_until="load", timeout=args.timeout)
                    try:
                        page.wait_for_load_state("networkidle", timeout=min(args.timeout, 8000))
                    except Exception:  # noqa: BLE001 — 폴링하는 화면은 idle 이 안 온다
                        pass
                    # 앱이 마운트될 때까지(index.html 의 #app-loader 가 사라질 때까지) 기다린다 — vite 콜드
                    # 스타트에 첫 라우트가 로딩 화면(또는 10초 뒤 "불러오지 못했다" 안내)으로 측정되지 않게.
                    try:
                        page.wait_for_function("() => !document.getElementById('app-loader')",
                                               timeout=args.timeout)
                    except Exception:  # noqa: BLE001
                        raise RuntimeError("앱이 마운트되지 않았다(#app-loader 잔존) — 로딩 화면은 측정하지 않는다")
                    page.wait_for_timeout(args.settle)
                    if not page.evaluate("() => !!window.axe"):
                        page.add_script_tag(content=axe_src)
                    opts = {"runOnly": {"type": "tag", "values": args.tags}, "resultTypes": ["violations", "incomplete"]}
                    data = page.evaluate(AXE_RUN_JS, opts)
                    entry.update(data)
                    if args.screenshots:
                        shot = Path(args.out) / "shots" / f"{r['id']}-{theme}.png"
                        shot.parent.mkdir(parents=True, exist_ok=True)
                        page.screenshot(path=str(shot))
                except Exception as e:  # noqa: BLE001 — 라우트 하나 실패해도 계속
                    entry["error"] = str(e)[:500]
                entry["pageErrors"] = list(page_errors[:5])
                nv = sum(len(v["nodes"]) for v in entry.get("violations", []))
                log(f"  [{theme}] {r['id']:<20} {entry.get('url', '-'):<22} 위반 rule {len(entry.get('violations', []))}, "
                    f"노드 {nv}" + (f"  ERROR {entry['error'][:80]}" if "error" in entry else ""))
                results.append(entry)
            ctx.close()
    finally:
        browser.close()
    order = {r["id"]: i for i, r in enumerate(routes)}
    return sorted(results, key=lambda e: order.get(e["id"], 0))


def aggregate(results: list[dict], regions: list[dict], shared_min: int) -> dict:
    rules: dict[str, dict] = {}
    by_route: dict[str, Counter] = {}
    sel_routes: dict[tuple[str, str], set] = defaultdict(set)
    sel_meta: dict[tuple[str, str], dict] = {}
    contrast_pairs: Counter = Counter()
    contrast_meta: dict[tuple, dict] = {}
    impact_totals: Counter = Counter()
    for e in results:
        c = by_route.setdefault(e["id"], Counter())
        for v in e.get("violations", []):
            rid = v["id"]
            r = rules.setdefault(rid, {"id": rid, "impact": v["impact"], "help": v["help"], "helpUrl": v["helpUrl"],
                                       "tags": v["tags"], "nodes": 0, "routes": set(), "selectors": Counter(),
                                       "landmarks": Counter(), "sources": Counter(), "samples": []})
            for n in v["nodes"]:
                imp = n.get("impact") or v["impact"] or "minor"
                r["nodes"] += 1
                r["routes"].add(e["id"])
                r["selectors"][n["target"]] += 1
                r["landmarks"][n["landmark"]] += 1
                src = region_source(n["landmark"], e.get("page", ""), regions)
                r["sources"][src] += 1
                if len(r["samples"]) < 4 and n["html"] not in {s["html"] for s in r["samples"]}:
                    r["samples"].append({"route": e["id"], "target": n["target"], "html": n["html"][:200],
                                         "text": n.get("text", ""), "landmark": n["landmark"]})
                c[imp] += 1
                impact_totals[imp] += 1
                # 같은 컴포넌트라도 라우트마다 nth-child selector 가 달라지므로 html 앞부분으로 묶는다.
                key = (rid, n["html"][:160])
                sel_routes[key].add(e["id"])
                sel_meta.setdefault(key, {"target": n["target"], "landmark": n["landmark"], "html": n["html"][:200],
                                          "text": n.get("text", ""), "source": src, "impact": imp})
                if n.get("contrast"):
                    cc = n["contrast"]
                    ck = (cc["fg"], cc["bg"])
                    contrast_pairs[ck] += 1
                    m = contrast_meta.setdefault(ck, {"ratio": cc["ratio"], "expected": cc["expected"],
                                                      "routes": set(), "sample": n.get("text") or n["target"],
                                                      "sources": Counter()})
                    m["routes"].add(e["id"])
                    m["sources"][src] += 1
    n_routes = len([e for e in results if "error" not in e])
    threshold = max(2, min(shared_min, n_routes))
    shared = [
        {"rule": k[0], "routes": sorted(rs), "routeCount": len(rs), **sel_meta[k]}
        for k, rs in sel_routes.items() if len(rs) >= threshold
    ]
    shared.sort(key=lambda s: (-s["routeCount"], -IMPACTS.index(s["impact"]) if s["impact"] in IMPACTS else 0))
    rule_list = []
    for r in rules.values():
        rule_list.append({
            **{k: r[k] for k in ("id", "impact", "help", "helpUrl", "tags", "nodes", "samples")},
            "routes": sorted(r["routes"]), "routeCount": len(r["routes"]),
            "topSelectors": r["selectors"].most_common(6),
            "landmarks": r["landmarks"].most_common(6),
            "sources": r["sources"].most_common(6),
        })
    rule_list.sort(key=lambda r: (-(IMPACTS.index(r["impact"]) if r["impact"] in IMPACTS else 0), -r["nodes"]))
    contrast = [
        {"fg": fg, "bg": bg, "count": cnt, "ratio": contrast_meta[(fg, bg)]["ratio"],
         "expected": contrast_meta[(fg, bg)]["expected"], "routeCount": len(contrast_meta[(fg, bg)]["routes"]),
         "sample": contrast_meta[(fg, bg)]["sample"], "sources": contrast_meta[(fg, bg)]["sources"].most_common(3)}
        for (fg, bg), cnt in contrast_pairs.most_common(25)
    ]
    return {
        "routesScanned": len(results), "routesErrored": [e["id"] for e in results if "error" in e],
        "totals": {"nodes": sum(impact_totals.values()), "rules": len(rules),
                   "byImpact": {i: impact_totals.get(i, 0) for i in IMPACTS},
                   "routesWithViolations": sum(1 for c in by_route.values() if sum(c.values()))},
        "byRoute": {rid: {i: c.get(i, 0) for i in IMPACTS} | {"total": sum(c.values())} for rid, c in by_route.items()},
        "rules": rule_list, "sharedCandidates": shared[:40], "sharedThreshold": threshold, "contrastPairs": contrast,
    }


def md_escape(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ").replace("`", "'")


def render_md(summary: dict) -> str:
    out = [f"# axe 접근성 스캔 요약 — {summary['generatedAt']}", "",
           f"- 대상: {summary['baseUrl']} · axe-core {summary.get('axeVersion', '?')} · 태그 {', '.join(summary['tags'])}",
           f"- 라우트 {summary['routeCount']}개 × 테마 {', '.join(summary['themes'])}", ""]
    out += ["## 테마별 합계", "", "| 테마 | 위반 노드 | rule 수 | critical | serious | moderate | minor | 위반 있는 라우트 |",
            "|---|---|---|---|---|---|---|---|"]
    for th, agg in summary["byTheme"].items():
        t = agg["totals"]
        b = t["byImpact"]
        out.append(f"| {th} | {t['nodes']} | {t['rules']} | {b['critical']} | {b['serious']} | {b['moderate']} | "
                   f"{b['minor']} | {t['routesWithViolations']}/{agg['routesScanned']} |")
    out.append("")
    for th, agg in summary["byTheme"].items():
        out += [f"## {th} — rule 별", "",
                "| rule | 영향 | 노드 | 라우트 | 대표 selector | 위치(랜드마크) | 소스 추정 |", "|---|---|---|---|---|---|---|"]
        for r in agg["rules"]:
            sel = md_escape(r["topSelectors"][0][0])[:70] if r["topSelectors"] else ""
            lm = "; ".join(f"{md_escape(k)} ×{v}" for k, v in r["landmarks"][:2])
            src = "; ".join(f"{md_escape(k).replace('frontend/src/', '')} ×{v}" for k, v in r["sources"][:3])
            out.append(f"| `{r['id']}` | {r['impact']} | {r['nodes']} | {r['routeCount']} | `{sel}` | {lm} | {src} |")
        out.append("")
        out += [f"### {th} — 라우트 별", "", "| 라우트 | 합계 | critical | serious | moderate | minor |", "|---|---|---|---|---|---|"]
        for rid, c in agg["byRoute"].items():
            out.append(f"| {rid} | {c['total']} | {c['critical']} | {c['serious']} | {c['moderate']} | {c['minor']} |")
        if agg["routesErrored"]:
            out.append(f"\n실패한 라우트: {', '.join(agg['routesErrored'])}")
        out.append("")
        if agg["sharedCandidates"]:
            out += [f"### {th} — 공용 컴포넌트 후보 (같은 요소(html)가 {agg['sharedThreshold']}개 이상 라우트)", "",
                    "| rule | 라우트 수 | selector | 랜드마크 | 소스 추정 | 텍스트/HTML |", "|---|---|---|---|---|---|"]
            for s in agg["sharedCandidates"][:25]:
                hint = md_escape(s["text"] or s["html"])[:80]
                out.append(f"| `{s['rule']}` | {s['routeCount']} | `{md_escape(s['target'])[:70]}` | {md_escape(s['landmark'])} | "
                           f"{md_escape(s['source']).replace('frontend/src/', '')} | {hint} |")
            out.append("")
        if agg["contrastPairs"]:
            out += [f"### {th} — 대비 부족 색쌍 (전경/배경)", "", "| 전경 | 배경 | 대비 | 기준 | 노드 | 라우트 | 예시 | 소스 |",
                    "|---|---|---|---|---|---|---|---|"]
            for c in agg["contrastPairs"][:15]:
                src = "; ".join(md_escape(k).replace("frontend/src/", "") for k, _ in c["sources"])
                out.append(f"| {c['fg']} | {c['bg']} | {c['ratio']} | {c['expected']} | {c['count']} | {c['routeCount']} | "
                           f"{md_escape(c['sample'])[:40]} | {src} |")
            out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="axe-core 접근성 스캔 (로컬 측정 도구)")
    ap.add_argument("--base-url", default=os.getenv("A11Y_BASE_URL", "http://localhost:5173"))
    ap.add_argument("--api-url", default=os.getenv("A11Y_API_URL", "http://localhost:8000/api/v1"))
    ap.add_argument("--username", default=os.getenv("A11Y_USERNAME", "admin"))
    ap.add_argument("--password", default=os.getenv("A11Y_PASSWORD", "admin"))
    ap.add_argument("--themes", default="light,dark", help="쉼표 구분 (예: light,dark,high-contrast)")
    ap.add_argument("--routes", default=str(HERE / "routes.json"))
    ap.add_argument("--only", default="", help="라우트 id 또는 path 쉼표 구분 필터")
    ap.add_argument("--chromium", default=os.getenv("A11Y_CHROMIUM", DEFAULT_CHROMIUM if Path(DEFAULT_CHROMIUM).exists() else ""),
                    help="Chromium 실행 파일 경로(비우면 Playwright 기본 브라우저)")
    ap.add_argument("--axe", default=str(REPO / "frontend/node_modules/axe-core/axe.min.js"))
    ap.add_argument("--tags", default=",".join(DEFAULT_TAGS))
    ap.add_argument("--viewport", default="1440x900")
    ap.add_argument("--settle", type=int, default=2500, help="로드 후 대기(ms) — 데이터·애니메이션 안정화")
    ap.add_argument("--timeout", type=int, default=30000, help="페이지 로드 타임아웃(ms)")
    ap.add_argument("--shared-min", type=int, default=3, help="공용 후보로 볼 최소 라우트 수")
    ap.add_argument("--screenshots", action="store_true", help="라우트별 스크린샷도 저장")
    ap.add_argument("--out", default="a11y-report")
    ap.add_argument("--fail-on", default="none", choices=["none", *IMPACTS],
                    help="이 영향도 이상 위반이 하나라도 있으면 종료 코드 1")
    args = ap.parse_args()
    args.tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log("[axe_scan] playwright 가 없다 — pip install playwright (브라우저는 --chromium 로 지정 가능)")
        return 2
    axe_path = Path(args.axe)
    if not axe_path.exists():
        log(f"[axe_scan] axe-core 없음: {axe_path} — cd frontend && npm ci")
        return 2
    axe_src = axe_path.read_text(encoding="utf-8")
    cfg = json.loads(Path(args.routes).read_text(encoding="utf-8"))
    routes, regions = cfg["routes"], cfg.get("regions", [])
    if args.only:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        routes = [r for r in routes if r["id"] in want or r["path"] in want]
    if not routes:
        log("[axe_scan] 대상 라우트가 없다")
        return 2
    themes = [t.strip() for t in args.themes.split(",") if t.strip()]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        token, user = login(args.api_url, args.username, args.password)
    except SystemExit as e:
        log(str(e))
        return 2
    original_theme = get_server_theme(args.api_url, token)
    summary: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "baseUrl": args.base_url,
        "tags": args.tags, "themes": themes, "routeCount": len(routes), "byTheme": {},
    }
    try:
        with sync_playwright() as pw:
            for theme in themes:
                log(f"== theme {theme}")
                set_server_theme(args.api_url, token, theme)
                results = scan_theme(pw, args, theme, routes, token, user, axe_src)
                (out_dir / f"axe-{theme}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
                summary["byTheme"][theme] = aggregate(results, regions, args.shared_min)
                for e in results:
                    if e.get("axeVersion"):
                        summary["axeVersion"] = e["axeVersion"]
                        break
                mismatched = [e["id"] for e in results if e.get("htmlClass") is not None
                              and theme not in e["htmlClass"].split()]
                if mismatched:
                    log(f"  ! <html> 클래스에 '{theme}' 가 없는 라우트: {', '.join(mismatched)} — 테마 미적용 의심")
    except Exception as e:  # noqa: BLE001
        log(f"[axe_scan] 실행 실패: {e}")
        return 2
    finally:
        # 원래 비어 있던 사용자도 비운 상태로 되돌린다 — 그러지 않으면 마지막 측정 테마가 남는다.
        if original_theme is not _UNKNOWN:
            set_server_theme(args.api_url, token, original_theme)  # type: ignore[arg-type]

    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=list), encoding="utf-8")
    (out_dir / "summary.md").write_text(render_md(summary), encoding="utf-8")
    log(f"== 저장: {out_dir}/summary.md, summary.json, axe-<theme>.json")
    for th, agg in summary["byTheme"].items():
        t = agg["totals"]
        log(f"  {th}: 위반 노드 {t['nodes']} (rule {t['rules']}) — " +
            ", ".join(f"{k} {v}" for k, v in t["byImpact"].items()))

    if args.fail_on != "none":
        # 측정하지 못한 라우트(마운트 실패·타임아웃)는 "위반 0" 으로 통과시키지 않는다.
        errored = sorted({rid for agg in summary["byTheme"].values() for rid in agg.get("routesErrored", [])})
        if errored:
            log(f"[axe_scan] 측정 실패 라우트 {len(errored)}개: {', '.join(errored)}")
            return 2
        floor = IMPACTS.index(args.fail_on)
        hit = sum(n for agg in summary["byTheme"].values()
                  for imp, n in agg["totals"]["byImpact"].items() if IMPACTS.index(imp) >= floor)
        if hit:
            log(f"[axe_scan] --fail-on {args.fail_on}: 해당 영향도 이상 위반 노드 {hit}건")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
