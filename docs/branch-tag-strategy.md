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

## 릴리스 절차 (마이너/패치 공통)
1. 기능/수정 PR 들을 `main` 에 병합(squash). 프론트 `lint/tsc/build` + 백엔드 `pytest` 그린 확인.
2. 버전 올림: `frontend/package.json` + `backend/app/main.py`(2곳) 을 새 `vX.Y.Z` 로.
3. `CHANGELOG.md` 상단에 새 버전 섹션 추가(Added/Changed/Fixed). 날짜 포함.
4. 위 2~3 을 `chore(release): vX.Y.Z` PR 로 main 병합.
5. 병합된 main 커밋에 **annotated 태그**:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
6. GitHub Release 생성(태그 vX.Y.Z, 본문 = CHANGELOG 해당 섹션).
7. CD(`cd.yml`)가 이미지 빌드/배포. 이미지 태그에 버전 반영 권장.

## 태그 규칙
- 모든 릴리스는 **`main` 커밋**에만 태그(작업 브랜치 태그 금지).
- 태그명 `vX.Y.Z`(접두사 `v`). pre-release 는 `vX.Y.Z-rc.1` 형식.

## 자동화(권장, 후속)
- `release-please` 또는 커밋 기반 CHANGELOG 자동화 → 버전업/CHANGELOG/태그 PR 자동 생성.
- CI 에 태그 push 시 GitHub Release + GHCR 이미지 `:vX.Y.Z` 태깅 잡 추가.
