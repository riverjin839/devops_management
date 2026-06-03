# Agent Skills (`.claude/skills/`)

이 폴더는 **Claude Code Agent Skills** 규칙을 따른다. 요즘 권장되는 정리 방식이며,
프로젝트의 재사용 가능한 작업 절차(playbook)를 **구조화·모듈화**해 담는다.

## 규칙 (맞는 형식)
- 한 스킬 = 한 폴더: `.claude/skills/<skill-name>/SKILL.md`
- `SKILL.md` 상단에 **YAML frontmatter**:
  ```yaml
  ---
  name: skill-name              # 소문자-하이픈
  description: 언제 이 스킬을 써야 하는지 (트리거 포함). 모델이 이걸 보고 자동 선택.
  ---
  ```
- 본문은 마크다운 절차/체크리스트. 같은 폴더에 보조 파일(스크립트·템플릿)을 둘 수 있고
  SKILL.md 에서 상대경로로 참조한다.
- 개인용은 `~/.claude/skills/`, 프로젝트 공유용은 이 저장소의 `.claude/skills/` (← 이쪽).
- 전역 컨벤션·아키텍처 설명은 `CLAUDE.md` 에, **"X 하는 법" 작업 절차**는 여기 스킬에.

## 수록 스킬
| 스킬 | 언제 쓰나 |
|---|---|
| `add-deep-checker` | 새 점검 항목(인증서·OS·스토리지·네트워크 등)을 추가할 때 |
| `backend-feature` | 새 모델/라우터/마이그레이션(FastAPI)을 추가할 때 |
| `frontend-page` | 새 React 페이지(클러스터 선택형 포함)를 만들 때 |
| `editor-docs` | 리치텍스트 에디터·문서 템플릿·이미지/렌더 관련 작업을 할 때 |

> 참고: 운영 점검(Ops Checks) 콘솔 아키텍처와 점검 소스 추가는 `add-deep-checker` 에 정리.
