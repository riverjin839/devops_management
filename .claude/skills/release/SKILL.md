---
name: release
description: 새 버전을 릴리스할 때(마이너 기능 추가/패치) 사용. SemVer 버전업, CHANGELOG 갱신, main 병합 후 vX.Y.Z 태그·GitHub Release 까지 trunk 기반 절차를 따른다.
---

# 릴리스 (SemVer + trunk 기반)

전략 상세: `docs/branch-tag-strategy.md`. `main` 단일 트렁크 + `vX.Y.Z` 태그.

## 버전 결정
- `feat:` 포함 → **MINOR**(x.Y.0). `fix:`/`docs:`/`chore:` 만 → **PATCH**(x.y.Z).
  하위호환 깨짐 → **MAJOR**.

## 절차
1. 대상 PR 들을 `main` 에 squash 병합. 게이트 그린 확인:
   - frontend: `cd frontend && npm run lint && npx tsc --noEmit && npm run build`
   - backend: CI `pytest`(Postgres/Redis 서비스 컨테이너).
2. **버전 3곳** 동시 수정 → 새 `X.Y.Z`:
   - `frontend/package.json` `"version"`
   - `backend/app/main.py` FastAPI `version="..."`
   - `backend/app/main.py` `root()` 응답 `"version": "..."`
3. `CHANGELOG.md` 최상단에 새 섹션(`## [X.Y.Z] - YYYY-MM-DD`) + Added/Changed/Fixed + 하단 링크.
4. `chore(release): vX.Y.Z` 커밋 → PR → main 병합.
5. 병합된 main 에 annotated 태그 push — **여기까지가 수동 마지막 단계**:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
6. (자동) 태그 push 시 `.github/workflows/release.yml` 이 **GitHub Release 생성**(본문 = CHANGELOG `## [X.Y.Z]` 섹션) + **GHCR 이미지 `:X.Y.Z`/`:X.Y`/`:latest` 태깅**을 수행한다. 손으로 Release 를 만들거나 이미지를 태깅하지 않는다.

> 환경 제약: 격리된 실행 환경에서는 태그 ref push 가 막혀 있을 수 있다(403). 그 경우 5단계는 push 권한 있는 곳에서 수행하거나 GitHub UI "Draft a release from tag(Target=main)" 로 태그를 만들면 `release.yml` 이 동일하게 동작한다.

## 규칙
- 태그는 **main 커밋에만**(작업 브랜치 금지). 접두사 `v`. pre-release `vX.Y.Z-rc.N`.
- 커밋은 Conventional Commits 유지(`feat`/`fix`/`docs`/`refactor`/`chore`).
- 핫픽스: `hotfix/<설명>` → PR → main → PATCH 태그.
