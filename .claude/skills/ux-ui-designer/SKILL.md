---
name: ux-ui-designer
description: UX/UI 디자인 운영 절차 — DESIGN.md 를 현행화하고 디자인 감사(audit)·개선포인트 백로그·고도화 로드맵을 운영할 때 사용. "디자인 감사", "UX/UI 점검", "DESIGN.md 현행화/갱신", "디자인 개선포인트 정리", 화면 디자인 리뷰 요청이 오면 이 스킬을 따른다.
---

# UX/UI 디자이너 운영 절차 (DESIGN.md)

전담 페르소나는 `.claude/agents/ux-ui-designer.md`. 판단 기준은
`DESIGN_SYSTEM.md`(토큰 원천) + `CLAUDE.md` UI 섹션(레이아웃 표준) + `docs/SCREENS.md`(화면 명세).
**모든 결과는 루트 `DESIGN.md` 에 기록한다** — 이 문서가 디자인 운영의 단일 관리 지점이다.

## DESIGN.md 구조 (고정 — 섹션 추가는 자유, 삭제 금지)

1. **현행화 (Current State)** — 디자인 시스템 요약 + 정량 준수 지표 스냅샷(감사일 명시)
2. **개선포인트 백로그 (Backlog)** — `D-###` ID 테이블: 영역/문제/사용자 영향/심각도/상태
3. **고도화 로드맵 (Roadmap)** — 테마 단위 중장기 과제 (접근성, 다크모드 정합성, 컴포넌트 통합 등)
4. **점검 이력 (Audit Log)** — 감사 실행 기록 (일자/범위/신규·해결 건수/커밋)

## 절차 A — 정기 감사 (현행화)

1. 정량 스캔 (`frontend/src` 대상, 결과 건수를 현행화 섹션 지표 테이블에 기록):
   ```bash
   cd frontend/src
   # raw hex 색상 (JSX/상수)
   grep -rEn '#[0-9A-Fa-f]{6}' --include='*.tsx' pages components | grep -v '// *allowed' | wc -l
   # 인라인 스타일
   grep -rn 'style={{' --include='*.tsx' pages components | wc -l
   # 고정 팔레트 (테마 토큰 미사용)
   grep -rEn 'text-white|bg-white|text-black|text-gray-|bg-gray-' --include='*.tsx' pages components | wc -l
   # 컨벤션 외 라운딩 (rounded-md/sm 카드·버튼)
   grep -rEn 'rounded-(md|sm)\b' --include='*.tsx' pages components | wc -l
   ```
2. 정성 리뷰: 감사 대상 화면 2~3개를 골라 `docs/SCREENS.md` 해당 섹션을 읽고 코드와 대조
   (레이아웃 표준·MacCard·ClusterSidebar iconOnly·접근성).
3. 발견 사항을 백로그에 **신규 `D-###` 로 추가** (기존 항목과 중복 검사 먼저).
4. 현행화 섹션의 지표 스냅샷·감사일 갱신, 점검 이력에 1행 추가.

## 절차 B — 개선포인트 처리 (고도화)

1. 백로그에서 항목 선택 → 상태를 `진행중` 으로.
2. 구현은 frontend-page 스킬 컨벤션 준수. 검증 게이트:
   `npm run lint` (max-warnings 0) · `npx tsc --noEmit` · `npm run build`.
3. 완료 시 상태 `완료` + 처리 커밋/PR 기록. 화면 구조가 바뀌면 `docs/SCREENS.md` 도 갱신.
4. 사용자 노출 변화면 `CHANGELOG.md` `[Unreleased]` 에 항목 추가 (docs-sync 규칙).

## 규칙

- 백로그 ID 는 재사용 금지(완료돼도 행 유지, 상태만 변경). 심각도: `높음`(사용성/접근성 실질 저해) /
  `중간`(일관성 훼손) / `낮음`(cosmetic).
- 백로그에 없는 디자인 변경을 임의로 하지 않는다 — 등재 → 처리 → 상태 갱신 순서.
- 감사에서 **의도된 예외**(차트 라이브러리 색 prop, portal 위치 계산 인라인 스타일 등)는
  위반으로 세지 말고 현행화 섹션의 "허용 예외" 목록에 사유와 함께 기록한다.
- DESIGN_SYSTEM.md(규격)와 DESIGN.md(운영)는 역할이 다르다 — 토큰/규격 변경은 DESIGN_SYSTEM.md 에,
  점검·백로그·이력은 DESIGN.md 에.
