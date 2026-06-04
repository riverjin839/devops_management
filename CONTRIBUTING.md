# 기여 가이드 (CONTRIBUTING)

내부 기여자를 위한 개발·기여 규칙. 아키텍처/컨벤션 상세는 [CLAUDE.md](CLAUDE.md),
재사용 작업 절차는 [`.claude/skills/`](.claude/skills/) 참고.

## 개발 환경
```bash
# 의존성
make install
# 로컬 실행 (backend:8000, frontend:5173)
make dev
# 또는 Docker Compose
docker-compose up -d
```

## 브랜치 전략
- `main` = 항상 배포 가능한 트렁크. 직접 push 금지, **PR 로만 병합**.
- 작업 브랜치: `feat/<설명>`, `fix/<설명>`, `docs/`, `refactor/`, `chore/`, 긴급 `hotfix/<설명>`.
- 상세: [docs/branch-tag-strategy.md](docs/branch-tag-strategy.md).

## 커밋 컨벤션 (Conventional Commits)
`feat:` `fix:` `docs:` `refactor:` `chore:` — SemVer/CHANGELOG 의 근거가 된다.

## 코드 규칙 (요약)
- **Frontend**: TypeScript strict, ESLint **max-warnings 0**, Tailwind only(인라인 스타일 금지),
  서버 상태는 TanStack Query, 클라 상태는 Zustand. 클러스터 페이지는 `ClusterSidebar iconOnly` + `MacCard`.
- **Backend**: Pydantic v2, 외부 호출 fail-safe(구조화 에러 반환), 스키마 변경은 `_safe_*` 마이그레이션 헬퍼,
  백업 서비스 호환 유지. (자격증명 평문 저장 금지 — `secret_box` 사용)

## 커밋 전 필수 게이트
```bash
# frontend
cd frontend && npm run lint && npx tsc --noEmit && npm run build
# backend (DB 필요) — CI 가 Postgres/Redis 서비스 컨테이너로 수행
cd backend && pytest -v
```

## PR
- 템플릿([.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md))의
  **Summary / Changes / Test plan** 을 반드시 채운다. 빈 본문 금지.
- 작은 단위로, 리뷰 가능하게. CI(프론트 lint/tsc/build + 백엔드 pytest) 그린 필수.

## 릴리스
[`.claude/skills/release`](.claude/skills/release/SKILL.md) 플레이북 / [docs/branch-tag-strategy.md](docs/branch-tag-strategy.md) 참고.
