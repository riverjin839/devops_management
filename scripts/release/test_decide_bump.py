"""decide_bump 단위 테스트 — 의존성 없는 unittest (CI docs-sync job 에서 실행).

    python3 -m unittest discover -s scripts/release -p 'test_*.py' -v
"""
import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from decide_bump import decide_bump, main  # noqa: E402


class DecideBumpTest(unittest.TestCase):
    def assertBump(self, title, expected):
        bump, reason = decide_bump(title)
        self.assertEqual(bump, expected, f"{title!r} → {bump} ({reason})")

    # ── 예전에도 인식하던 형태 — 동작이 바뀌면 안 된다 ────────────────────────
    def test_unscoped_types_unchanged(self):
        self.assertBump("feat: 새 기능", "minor")
        for t in ("fix", "docs", "chore", "refactor"):
            self.assertBump(f"{t}: 무언가", "patch")

    def test_release_pr_is_skipped(self):
        self.assertBump("chore(release): v1.36.1", "none")

    # ── 이번 수정의 핵심: scope 가 붙은 제목 ─────────────────────────────────
    def test_scoped_titles_seen_in_this_repo(self):
        # 실제로 스킵됐던 제목들 (#709, #715, feat(ui) 테마 시리즈)
        self.assertBump("feat(k8s-allocation): 노드/NS 클릭 리소스 상세 + 요약 압축으로 자원 탭 전면 배치", "minor")
        self.assertBump("fix(k8s-allocation): 노드 상세에서 NS 가 많은 운영 노드의 사용량이 비던 문제", "patch")
        self.assertBump("feat(ui): 그림 팔레트 테마 8종", "minor")

    def test_scoped_patch_types(self):
        for t in ("fix", "docs", "chore", "refactor"):
            self.assertBump(f"{t}(scope-x): 무언가", "patch")

    def test_breaking_marker_is_recognised_by_type(self):
        self.assertBump("feat!: 호환 깨짐", "minor")
        self.assertBump("feat(api)!: 호환 깨짐", "minor")
        self.assertBump("fix(api)!: 호환 깨짐", "patch")

    def test_chore_with_other_scope_still_releases(self):
        self.assertBump("chore(deps): bump axios", "patch")

    # ── 릴리스 대상이 아니거나 형식이 아닌 것 ────────────────────────────────
    def test_non_release_types(self):
        for t in ("perf", "test", "ci", "build", "style"):
            self.assertBump(f"{t}: 무언가", "none")
            self.assertBump(f"{t}(x): 무언가", "none")

    def test_malformed_titles(self):
        for title in ("", "   ", "노드 상세 개선", "Feat: 대문자", "feat : 공백",
                      "feat(ui 닫는괄호없음: x", "docs+fix: 두 타입", 'Revert "feat: x"',
                      "[skip-docs] fix: 앞에 태그"):
            self.assertBump(title, "none")

    def test_leading_whitespace_is_tolerated(self):
        self.assertBump("  fix(x): 앞 공백", "patch")

    # ── CLI 계약: stdout 은 GITHUB_OUTPUT 에 그대로 붙일 한 줄, 종료 코드는 항상 0 ──
    def test_cli_prints_single_output_line(self):
        for title, expected in (("feat(ui): x", "bump=minor"), ("perf: x", "bump=none")):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                rc = main(["decide_bump.py", title])
            self.assertEqual(rc, 0)
            self.assertEqual(out.getvalue(), expected + "\n")
            self.assertTrue(err.getvalue().strip())

    def test_cli_without_argument(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            rc = main(["decide_bump.py"])
        self.assertEqual((rc, out.getvalue()), (0, "bump=none\n"))


if __name__ == "__main__":
    unittest.main()
