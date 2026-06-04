<!-- PR 본문은 비워두지 말 것. 아래 3개 섹션은 필수. -->

## Summary
<!-- 무엇을, 왜 바꿨는지 1~5 bullet. 리뷰어/사용자 관점. -->
-

## Changes
<!-- 영역별(frontend/backend/docs/infra) 구체 변경. 신규/삭제/이름변경 포함. -->
-

## Test plan
<!-- 리뷰어가 검증할 방법. 건너뛴 항목은 명시. -->
- [ ] frontend: `npm run lint` · `npx tsc --noEmit` · `npm run build`
- [ ] backend: `pytest -v` (CI)
- [ ]

## Notes (선택)
<!-- UI 스크린샷, 마이그레이션, 배포 주의(예: celery-worker 재배포), 후속 작업 등 -->
