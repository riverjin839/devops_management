# 브랜치 · 태그 · 릴리스 전략 (v1.0.0+)

PEP 는 **v1.0.0 정식 오픈** 이후 **trunk 기반 + SemVer 태그**로 운영한다.
복잡한 GitFlow 대신 `main` 단일 트렁크 + 릴리스 태그로 단순·안전하게 간다.

## 버전 (Semantic Versioning)
`vMAJOR.MINOR.PATCH`
- **MAJOR**: 하위호환 깨지는 변경(대규모 아키텍처/스키마 비호환). 드물게.
- **MINOR**: 하위호환 기능 추가(`feat:`). 평상시 기능 릴리스.
- **PATCH**: 하위호환 버그/문서/소규모(`fix:`, `docs:`, `chore:`).
- 버전 소스: `frontend/package.json` `version` + `backend/app/main.py` FastAPI `version`/root.

## 브랜치
- **`main`** — 항상 배포 가능한 트렁크. 직접 push 금지, PR 로만 병합.
- **작업 브랜치** (PR → squash merge → main):
  - `feat/<짧은설명>` 기능, `fix/<설명>` 버그, `docs/`, `chore/`, `refactor/`.
  - Claude 세션 브랜치 `claude/<...>` 도 동일하게 PR 로 병합.
- **`hotfix/<설명>`** — 운영 긴급 패치. main 에서 분기 → PR → main → 즉시 PATCH 태그.
- (선택) **`release/x.y`** — 과거 버전 유지보수가 필요할 때만 생성(내부 단일배포면 보통 불필요).

## 커밋 컨벤션 (Conventional Commits)
`feat: …` `fix: …` `docs: …` `refactor: …` `chore: …` (기존 관례 유지).
→ MINOR/PATCH 판단과 CHANGELOG 작성의 근거가 된다.

## 릴리스 절차 — 완전 자동 (기본)
`feat:`/`fix:`/`docs:`/`chore:`/`refactor:` prefix PR 이 `main` 에 머지되면
`.github/workflows/auto-release.yml` 이 **사람 개입 없이** 전체 절차를 수행한다:

1. 머지된 PR 제목에서 bump 종류 판단(`feat:` → MINOR, 그 외 → PATCH). 인식 불가/`chore(release):`
   자신의 머지는 스킵.
2. `scripts/release/bump_version.py` 로 버전 3곳(`frontend/package.json`,
   `backend/app/main.py` ×2) + `CHANGELOG.md` `[Unreleased]` → `## [X.Y.Z] - <date>` 확정
   (Unreleased 에 실제 항목이 없으면 전체를 스킵).
3. `chore(release): vX.Y.Z` PR 을 열고 즉시 병합.
4. 병합 커밋에 annotated 태그 `vX.Y.Z` 를 push → 아래 `release.yml` 자동 트리거.

> ⚠️ **설정 필요**: 태그 push 가 `release.yml` 을 실제로 트리거하려면 repo+workflow 스코프
> PAT 를 `RELEASE_PAT` 시크릿으로 등록해야 한다(Settings ▸ Secrets and variables ▸ Actions).
> 기본 `GITHUB_TOKEN` 으로 push 된 태그는 GitHub 정책상 다른 워크플로우를 트리거하지 못할
> 수 있다 — 이 경우 `auto-release.yml` 실행 로그에 경고가 남고, GitHub UI 에서
> "Draft a release from tag"(Target=main)로 수동 트리거해야 한다.

## 릴리스 절차 — 수동 (hotfix/자동화 실패 시 fallback)
1. 기능/수정 PR 들을 `main` 에 병합. 프론트 `lint/tsc/build` + 백엔드 `pytest` 그린 확인.
2. 버전 올림: `frontend/package.json` + `backend/app/main.py`(2곳) 을 새 `vX.Y.Z` 로.
   (`python3 scripts/release/bump_version.py <minor|patch>` 로 2~3 을 한 번에 처리 가능.)
3. `CHANGELOG.md` 상단에 새 버전 섹션 추가(Added/Changed/Fixed). 날짜 포함.
4. 위 2~3 을 `chore(release): vX.Y.Z` PR 로 main 병합.
5. 병합된 main 커밋에 **annotated 태그**:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
6. **여기까지만 하면 끝.** 태그 push 후 나머지는 `release.yml` 이 자동 처리한다(아래 자동화).

## 자동화 (`release.yml`)
`v*` 태그가 push 되면 `.github/workflows/release.yml` 이 자동 실행한다(수동/자동 절차 공통):
- **GHCR 이미지 빌드 + 버전 태깅**: backend/frontend 를 `:X.Y.Z`, `:X.Y`, `:latest`(정식 릴리스만; `-rc` 등 pre-release 는 `latest` 제외)로 push.
- **GitHub Release 생성**: `CHANGELOG.md` 의 `## [X.Y.Z]` 섹션을 본문으로 자동 생성(섹션이 없으면 `--generate-notes` fallback). 이미 있으면 노트만 갱신.

## 릴리즈 노트 프론트 표시
`backend/app/routers/release_notes.py` 가 `CHANGELOG.md` 를 파싱해 `/api/v1/release-notes`
로 제공하고, 사이드바 "릴리즈 노트" 패널이 이를 테이블(버전/날짜/요약, 클릭 시 섹션별 상세
펼침)로 렌더한다. `Unreleased` 섹션은 노출하지 않음 — 실제 릴리즈된 버전만 표시된다.
CHANGELOG.md 는 backend 이미지 build context 밖(저장소 루트)에 있어 `cd.yml`/`release.yml`
이 빌드 직전에 `backend/CHANGELOG.md` 로 복사해 넣는다.

## 태그 규칙
- 모든 릴리스는 **`main` 커밋**에만 태그(작업 브랜치 태그 금지).
- 태그명 `vX.Y.Z`(접두사 `v`). pre-release 는 `vX.Y.Z-rc.1` 형식.

## 추가 자동화(선택, 후속)
- `release-please` 등으로 버전업/CHANGELOG/태그 PR 까지 자동 생성하면 수동 단계가 더 줄어든다.
