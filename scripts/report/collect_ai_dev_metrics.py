"""AI 개발 리포트 원천 데이터 집계 — git 이력만 읽어 data.json 을 만든다.

사용: python3 -I scripts/report/collect_ai_dev_metrics.py <repo_dir> <out_json> [rev=origin/main]
날짜는 커밋의 committer 날짜(작성자 시간대, 대부분 KST)를 쓴다.
정의 (PPT 리포트에서 확정한 기준):
  - AI 커밋 = 작성자 Claude 또는 'Co-Authored-By: Claude' 트레일러 (github-actions 봇 제외)
  - PR = 'Merge pull request' 병합만 (브랜치 동기화 병합 제외)
  - 모델 세대 = PR 안 커밋 트레일러 모델의 다수결
"""
import collections
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys

REPO, OUT = sys.argv[1], sys.argv[2]
REV = sys.argv[3] if len(sys.argv) > 3 else "origin/main"
HERE = pathlib.Path(__file__).resolve().parent
NARR = json.loads((HERE / "ai_dev_report_narrative.json").read_text(encoding="utf-8"))
MODULES = [(m["key"], re.compile(m["pattern"])) for m in NARR.get("modules", [])]
HUB_FILES = re.compile(r"(frontend/src/(services/api\.ts|types/index\.ts|App\.tsx|components/layout/navConfig\.ts)|backend/app/(main\.py|routers/__init__\.py|models/__init__\.py|schemas/__init__\.py))$")
SKIP_FILE = re.compile(r"(lock|\.pptx|\.svg|\.drawio|\.png|\.jpg|CHANGELOG)")
TRAILER = re.compile(r"Co-Authored-By: Claude ([A-Za-z]+ [0-9.]+)")
HARNESS = [
    ("CLAUDE.md", "CLAUDE.md 도입"),
    ("CODE_MAP.md", "CODE_MAP.md"),
    ("DESIGN_SYSTEM.md", "DESIGN_SYSTEM.md"),
    (".claude/skills", "스킬 + CHANGELOG"),
    (".github/workflows/auto-release.yml", "자동 릴리스"),
    ("docs/SCREENS.md", "화면 명세 SCREENS.md"),
    ("scripts/docs/check_docs_sync.py", "docs-sync CI"),
    (".claude/agents", "UX 에이전트·DESIGN.md"),
]


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, check=True).stdout


def module_of(path):
    """파일 경로 → 모듈 키 (ai_dev_report_narrative.json 의 modules 순서대로 첫 매치). 문서·잡파일은 None."""
    if path.startswith("docs/") or path.endswith((".md", ".pptx", ".drawio", ".png", ".svg", ".lock")) or "package-lock" in path:
        return None
    if HUB_FILES.search(path):  # 거의 모든 기능이 함께 고치는 공용 허브 — 특정 모듈로 세지 않는다
        return None
    for key, pat in MODULES:
        if pat.search(path):
            return key
    return None


def mods_of(paths):
    return sorted({k for k in (module_of(p) for p in paths) if k})


def ctype(subject):
    m = re.match(r"^([a-z]+)(\([^)]*\))?!?:", subject)
    return m.group(1) if m else "other"


# ── 커밋 (병합 제외) ─────────────────────────────────────────
commits = []
raw = git("log", REV, "--no-merges", "--name-only", "--format=@@@%an|%cd|%s%n%b%n@@FILES", "--date=short")
for blk in raw.split("@@@")[1:]:
    head, _, files = blk.partition("@@FILES")
    first, _, body = head.partition("\n")
    author, date, subject = first.split("|", 2)
    if "github-actions" in author:
        continue
    models = TRAILER.findall(body)
    ai = author == "Claude" or bool(models)
    commits.append([date, int(ai), ctype(subject), models[-1] if models else "",
                    ",".join(mods_of([f for f in files.split("\n") if f.strip()]))])
commits.sort()

# ── PR (Merge pull request 만) ───────────────────────────────
prs = []
for line in git("log", REV, "--merges", "--format=%H|%cd|%s", "--date=short").splitlines():
    sha, date, subject = line.split("|", 2)
    m = re.match(r"Merge pull request #(\d+) from [^/]+/(.+)", subject)
    if not m:
        continue
    num, branch = int(m.group(1)), m.group(2)
    title = git("log", "-1", "--format=%b", sha).strip().split("\n")[0] or branch
    inner = git("log", "--format=%s%n%b@@END", f"{sha}^1..{sha}^2")
    subs = [b.strip().split("\n")[0] for b in inner.split("@@END") if b.strip()]
    models = TRAILER.findall(inner)
    adds = files = 0
    touched = []
    for ln in git("diff", "--numstat", f"{sha}^1", sha).splitlines():
        p = ln.split("\t")
        if len(p) == 3:
            touched.append(p[2])
        if len(p) == 3 and p[0].isdigit() and not SKIP_FILE.search(p[2]):
            adds += int(p[0])
            files += 1
    prs.append({
        "n": num, "d": date, "t": title[:120], "b": branch,
        "ai": int(branch.startswith("claude/") or bool(models)),
        "feat": int(any(s.startswith("feat") for s in subs)),
        "fixonly": int(bool(subs) and all(s.startswith("fix") for s in subs)),
        "files": files, "adds": adds, "mods": mods_of(touched),
        "model": collections.Counter(models).most_common(1)[0][0] if models else "",
    })
prs.sort(key=lambda p: (p["d"], p["n"]))

# ── 월말 스냅샷 ───────────────────────────────────────────────
first_day = dt.date.fromisoformat(commits[0][0])
last_day = dt.date.fromisoformat(max(commits[-1][0], prs[-1]["d"]))
months = []
y, mo = first_day.year, first_day.month
while (y, mo) <= (last_day.year, last_day.month):
    months.append(f"{y:04d}-{mo:02d}")
    y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)


def lines(rev, *paths):
    out = git("grep", "-c", "", rev, "--", *paths) if paths else ""
    return sum(int(l.rsplit(":", 1)[1]) for l in out.splitlines() if l)


def count_files(names, pattern):
    return sum(1 for n in names if re.search(pattern, n))


snapshots = []
for m in months:
    y, mo = map(int, m.split("-"))
    end = dt.date(y + (mo == 12), mo % 12 + 1, 1)
    sha = git("rev-list", "-1", f"--before={end.isoformat()} 00:00", REV).strip()
    if not sha:
        continue
    names = git("ls-tree", "-r", "--name-only", sha).splitlines()
    try:
        tests = len(git("grep", "-h", "def test_", sha, "--", "backend/tests/*.py").splitlines())
    except subprocess.CalledProcessError:
        tests = 0
    snapshots.append({
        "m": m,
        "py": lines(sha, "backend/*.py"),
        "ts": lines(sha, "frontend/src/*.ts", "frontend/src/*.tsx"),
        "routers": count_files(names, r"^backend/app/routers/[a-z].*\.py$"),
        "models": count_files(names, r"^backend/app/models/[a-z].*\.py$"),
        "pages": count_files(names, r"^frontend/src/pages/.*\.tsx$"),
        "md": count_files(names, r"\.md$"),
        "skills": count_files(names, r"^\.claude/skills/.*/SKILL\.md$"),
        "tests": tests,
    })

# ── 모듈 현재 규모 (REV 기준 파일·라인) ───────────────────────
module_size = {k: {"files": 0, "loc": 0} for k, _ in MODULES}
for ln in git("grep", "-c", "", REV, "--", ".").splitlines():
    path, _, n = ln[len(REV) + 1:].rpartition(":")
    k = module_of(path)
    if k:
        module_size[k]["files"] += 1
        module_size[k]["loc"] += int(n)

# ── 의존성 도입 이력 (requirements.txt · package.json) ────────
DEP_FILES = {"py": "backend/requirements.txt", "npm": "frontend/package.json"}
PY_DEP = re.compile(r"^([+-])\s*([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(==|>=|<=|~=|>|<)")
NPM_DEP = re.compile(r'^([+-])\s*"(@?[A-Za-z0-9_./-]+)":\s*"[\^~>=<]*\d')
NPM_SKIP = {"version", "node", "npm"}
deps = {}
for eco, path in DEP_FILES.items():
    log = git("log", REV, "--reverse", "--format=@@@%cd", "--date=short", "-p", "--", path)
    for blk in log.split("@@@")[1:]:
        date = blk.split("\n", 1)[0].strip()
        for line in blk.splitlines():
            if line.startswith(("+++", "---")):
                continue
            m = (PY_DEP if eco == "py" else NPM_DEP).match(line)
            if not m or (eco == "npm" and m.group(2) in NPM_SKIP):
                continue
            name = m.group(2).lower() if eco == "py" else m.group(2)
            if m.group(1) == "+" and (eco, name) not in deps:
                deps[(eco, name)] = date
head_py = {m.group(2).lower() for m in (PY_DEP.match("+" + l) for l in git("show", f"{REV}:backend/requirements.txt").splitlines()) if m}
pkg = json.loads(git("show", f"{REV}:frontend/package.json"))
head_npm = set(pkg.get("dependencies", {})) | set(pkg.get("devDependencies", {}))
dep_list = [{"n": n, "eco": e, "added": d, "present": int(n in (head_py if e == "py" else head_npm))}
            for (e, n), d in sorted(deps.items(), key=lambda x: x[1])]

# ── 경로 기반 기술 도입일 (카탈로그의 paths) ──────────────────
path_added = {}
for t in NARR.get("tech", []):
    for pth in t.get("paths", []):
        d = git("log", REV, "--diff-filter=A", "--format=%cd", "--date=short", "--", pth).split()
        if d:
            path_added[pth] = d[-1]

# ── 릴리스 태그 · 하네스 타임라인 ────────────────────────────
tags = [l.split()[0][:7] for l in git("for-each-ref", "--format=%(creatordate:short) %(refname:short)", "refs/tags/v*").splitlines() if l]
harness = []
for path, label in HARNESS:
    d = git("log", REV, "--diff-filter=A", "--format=%ad", "--date=short", "--", path).split()
    if d:
        harness.append({"d": d[-1], "label": label, "path": path})
harness.sort(key=lambda h: h["d"])
harness.insert(0, {"d": commits[0][0], "label": "첫 AI 커밋·PR #1", "path": ""})

data = {
    "meta": {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "rev": REV, "head": git("rev-parse", "--short", REV).strip(),
        "first": commits[0][0], "last": last_day.isoformat(),
        "repo": "riverjin839/devops_management",
    },
    "months": months,
    "commits": commits,       # [date, ai, type, model, "모듈키,..."]
    "prs": prs,
    "snapshots": snapshots,
    "release_months": dict(collections.Counter(tags)),
    "harness": harness,
    "module_size": module_size,
    "deps": dep_list,
    "path_added": path_added,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
print(f"commits={len(commits)} ai={sum(c[1] for c in commits)} prs={len(prs)} "
      f"months={months[0]}..{months[-1]} tests={snapshots[-1]['tests']} tags={len(tags)}")
