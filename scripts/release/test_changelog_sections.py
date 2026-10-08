"""changelog_sections / check_changelog_sections 단위 테스트 — 의존성 없는 unittest.

    python3 -m unittest discover -s scripts/release -p 'test_*.py' -v

핵심 시나리오(test_git_merge_*)는 실제 git 3-way 머지로 "릴리스가 끼어든 뒤 PR 머지" 를 재현한다.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from changelog_sections import (  # noqa: E402
    find_intrusions,
    is_exempt_title,
    parse_sections,
    rescue,
    section_changes,
)

HEAD = "# Changelog\n\n설명.\n\n"

BEFORE_RELEASE = HEAD + """## [Unreleased]

1.41.1 이후 main 에 병합된 변경 (다음 릴리스 후보).

### Added
- **롤링 갱신**: 대형 클러스터 NS 를 오래된 순으로 다시 모은다.

## [1.41.1] - 2026-09-30

### Fixed
- **토폴로지 게이팅**: viewer 는 변경 불가.
"""

# auto-release(bump_version) 가 만드는 결과와 같은 모양.
AFTER_RELEASE = HEAD + """## [Unreleased]

1.41.2 이후 main 에 병합된 변경 (다음 릴리스 후보).

## [1.41.2] - 2026-09-30

### Added
- **롤링 갱신**: 대형 클러스터 NS 를 오래된 순으로 다시 모은다.

## [1.41.1] - 2026-09-30

### Fixed
- **토폴로지 게이팅**: viewer 는 변경 불가.
"""

# 릴리스 전 main 에서 분기한 PR — [Unreleased] 끝에 Fixed 를 추가.
PR_BRANCH = BEFORE_RELEASE.replace(
    "다시 모은다.\n\n## [1.41.1]",
    "다시 모은다.\n\n### Fixed\n- **kubeconfig 경로 검증**: 실제 kubeconfig 인지 확인.\n"
    "  Backend: `routers/clusters.py`.\n\n## [1.41.1]",
)


def _section(text, key):
    return next(s for s in parse_sections(text) if s.key == key)


class TitleTest(unittest.TestCase):
    def test_exempt(self):
        self.assertTrue(is_exempt_title("docs(changelog): 위치 정리 [changelog-fix]"))
        self.assertTrue(is_exempt_title("chore(release): v1.42.0"))
        self.assertFalse(is_exempt_title("fix(ui): flyout 잘림"))
        self.assertFalse(is_exempt_title("chore: release 노트 정리"))
        self.assertFalse(is_exempt_title(""))


class SectionChangesTest(unittest.TestCase):
    def test_unreleased_only_change_passes(self):
        head = AFTER_RELEASE.replace(
            "(다음 릴리스 후보).\n\n## [1.41.2]",
            "(다음 릴리스 후보).\n\n### Fixed\n- **새 항목**\n\n## [1.41.2]",
        )
        self.assertEqual(section_changes(AFTER_RELEASE, head), [])

    def test_new_release_section_passes(self):
        # 릴리스 PR 은 새 섹션을 만든다 — base 에 없던 섹션이라 대상이 아니다.
        self.assertEqual(section_changes(BEFORE_RELEASE, AFTER_RELEASE), [])

    def test_body_change_fails(self):
        head = AFTER_RELEASE.replace("viewer 는 변경 불가.", "viewer 는 변경 불가.\n- **끼어든 항목**")
        problems = section_changes(AFTER_RELEASE, head)
        self.assertEqual(len(problems), 1)
        self.assertIn("[1.41.1]", problems[0])
        self.assertIn("+- **끼어든 항목**", problems[0])

    def test_header_change_and_removal_fail(self):
        head = AFTER_RELEASE.replace("## [1.41.1] - 2026-09-30", "## [1.41.1] - 2026-10-01")
        self.assertTrue(any("헤더" in p for p in section_changes(AFTER_RELEASE, head)))
        head2 = AFTER_RELEASE.split("## [1.41.1]")[0]
        self.assertTrue(any("사라졌다" in p for p in section_changes(AFTER_RELEASE, head2)))

    def test_blank_line_only_difference_passes(self):
        head = AFTER_RELEASE.replace("변경 불가.\n", "변경 불가.\n\n\n")
        self.assertEqual(section_changes(AFTER_RELEASE, head), [])


class RescueTest(unittest.TestCase):
    def test_moves_intruded_block_with_subsection(self):
        merged = AFTER_RELEASE.replace(
            "다시 모은다.\n\n## [1.41.1]",
            "다시 모은다.\n\n### Fixed\n- **kubeconfig 경로 검증**: 확인.\n  Backend: x.\n\n## [1.41.1]",
        )
        intr = find_intrusions(AFTER_RELEASE, merged)
        self.assertEqual(len(intr), 1)
        self.assertEqual(intr[0].version, "1.41.2")
        self.assertEqual(intr[0].subsection, "Fixed")

        fixed, moved = rescue(AFTER_RELEASE, merged)
        self.assertEqual(len(moved), 1)
        # 릴리스 섹션은 원상복구, 항목은 [Unreleased] ### Fixed 아래로.
        self.assertEqual(section_changes(AFTER_RELEASE, fixed), [])
        unrel = _section(fixed, "Unreleased").body
        self.assertIn("### Fixed\n- **kubeconfig 경로 검증**: 확인.\n  Backend: x.", unrel)
        self.assertIn("1.41.2 이후 main 에 병합된 변경", unrel)

    def test_bullet_without_own_heading_uses_surrounding_subsection(self):
        merged = AFTER_RELEASE.replace("다시 모은다.\n", "다시 모은다.\n- **두 번째 기능**\n", 1)
        fixed, moved = rescue(AFTER_RELEASE, merged)
        self.assertEqual([m.subsection for m in moved], ["Added"])
        self.assertIn("### Added\n- **두 번째 기능**", _section(fixed, "Unreleased").body)
        self.assertEqual(section_changes(AFTER_RELEASE, fixed), [])

    def test_appends_under_existing_unreleased_subsection(self):
        base = AFTER_RELEASE.replace(
            "(다음 릴리스 후보).\n\n## [1.41.2]",
            "(다음 릴리스 후보).\n\n### Fixed\n- **기존 항목**\n\n### Changed\n- **변경**\n\n## [1.41.2]",
        )
        merged = base.replace("viewer 는 변경 불가.", "viewer 는 변경 불가.\n- **끼어든 수정**")
        fixed, _ = rescue(base, merged)
        unrel = _section(fixed, "Unreleased").body
        self.assertIn("### Fixed\n- **기존 항목**\n- **끼어든 수정**\n\n### Changed", unrel)

    def test_edits_to_existing_lines_are_not_moved(self):
        merged = AFTER_RELEASE.replace("viewer 는 변경 불가.", "viewer 는 변경할 수 없다.")
        fixed, moved = rescue(AFTER_RELEASE, merged)
        self.assertEqual(moved, [])
        self.assertEqual(fixed, merged)

    def test_noop_when_clean(self):
        fixed, moved = rescue(BEFORE_RELEASE, AFTER_RELEASE)
        self.assertEqual(moved, [])
        self.assertEqual(fixed, AFTER_RELEASE)


class GitMergeScenarioTest(unittest.TestCase):
    """실제 git 3-way 머지로 '릴리스가 끼어든 뒤 PR 머지' 를 재현한다."""

    def _git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout

    def test_git_merge_lands_in_release_section_then_guard_and_rescue(self):
        with tempfile.TemporaryDirectory() as d:
            g = lambda *a: self._git(d, *a)  # noqa: E731
            g("init", "-q", "-b", "main")
            g("config", "user.email", "t@example.com")
            g("config", "user.name", "t")
            f = Path(d) / "CHANGELOG.md"
            f.write_text(BEFORE_RELEASE, encoding="utf-8")
            g("add", "."); g("commit", "-qm", "base")
            g("checkout", "-qb", "pr")
            f.write_text(PR_BRANCH, encoding="utf-8")
            g("commit", "-qam", "fix: kubeconfig")
            g("checkout", "-q", "main")
            f.write_text(AFTER_RELEASE, encoding="utf-8")
            g("commit", "-qam", "chore(release): v1.41.2")
            released = g("rev-parse", "HEAD").strip()
            g("merge", "-q", "--no-edit", "pr")  # 충돌 없이 머지된다 — 이게 버그의 원인
            merged = f.read_text(encoding="utf-8")

        # 머지 결과: 항목이 [1.41.2] 안에 들어갔고 [Unreleased] 는 비었다.
        self.assertIn("kubeconfig 경로 검증", _section(merged, "1.41.2").body)
        self.assertNotIn("kubeconfig", _section(merged, "Unreleased").body)
        self.assertTrue(released)

        # 1) PR CI 가드가 잡는다.
        self.assertTrue(section_changes(AFTER_RELEASE, merged))
        # 2) 가드를 비켜 간 경우 auto-release 의 구제가 [Unreleased] 로 되돌린다.
        fixed, moved = rescue(AFTER_RELEASE, merged)
        self.assertEqual(len(moved), 1)
        self.assertEqual(section_changes(AFTER_RELEASE, fixed), [])
        unrel = _section(fixed, "Unreleased").body
        self.assertIn("### Fixed\n- **kubeconfig 경로 검증**", unrel)
        self.assertIn("  Backend: `routers/clusters.py`.", unrel)


if __name__ == "__main__":
    unittest.main()
