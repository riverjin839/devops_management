"""check_versions 단위 테스트 — 의존성 없는 unittest (CI docs-sync job 에서 실행).

    python3 -m unittest discover -s scripts/release -p 'test_*.py' -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_versions import check  # noqa: E402

PKG = '{\n  "name": "x",\n  "private": true,\n  "version": "1.2.3",\n  "devDependencies": {\n    "a": "1.0.0"\n  }\n}\n'
MAIN = (
    'app = FastAPI(\n    title="x",\n    version="1.2.3",\n)\n\n'
    'def root():\n    return {\n        "name": "x",\n        "version": "1.2.3",\n    }\n'
)
CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n1.2.3 이후 …\n\n## [1.2.3] - 2026-10-21\n\n### Fixed\n- a\n\n## [1.2.2] - 2026-10-20\n"


class CheckVersionsTest(unittest.TestCase):
    def test_consistent(self):
        self.assertEqual(check(PKG, MAIN, CHANGELOG), [])

    def test_nested_dependency_version_is_not_counted(self):
        pkg = PKG.replace('"a": "1.0.0"', '"version": "9.9.9"')
        self.assertEqual(check(pkg, MAIN, CHANGELOG), [])

    def test_conflict_resolution_keeping_both_sides(self):
        # 1.64.2/1.66.0 사례 — 충돌을 "양쪽 다 남기기"로 풀었을 때
        pkg = PKG.replace('  "version": "1.2.3",\n', '  "version": "1.2.2",\n  "version": "1.2.3",\n')
        main = MAIN.replace('    version="1.2.3",\n', '    version="1.2.2",\n    version="1.2.3",\n')
        errors = check(pkg, main, CHANGELOG)
        self.assertTrue(any("package.json" in e and "2개" in e for e in errors), errors)
        self.assertTrue(any("FastAPI" in e and "2개" in e for e in errors), errors)

    def test_stale_root_version(self):
        main = MAIN.replace('        "version": "1.2.3",\n', '        "version": "1.2.3",\n        "version": "1.8.2",\n')
        self.assertTrue(any("root()" in e for e in check(PKG, main, CHANGELOG)))

    def test_mismatch_with_changelog(self):
        changelog = CHANGELOG.replace("## [1.2.3] - 2026-10-21", "## [1.2.4] - 2026-10-21")
        errors = check(PKG, MAIN, changelog)
        self.assertTrue(any("서로 다름" in e for e in errors), errors)

    def test_stale_release_section_above_newer(self):
        changelog = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [1.2.1] - 2026-10-21\n")
        self.assertTrue(any("서로 다름" in e for e in check(PKG, MAIN, changelog)))


if __name__ == "__main__":
    unittest.main()
