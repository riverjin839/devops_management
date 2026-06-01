# home-weekly-work-table Planning Document

> **Summary**: 홈 work 모드의 달력을 주간 업무 표로 교체 — 탭으로 주간 표 ↔ 월 달력 전환
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/home-v2
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 홈 달력은 월 단위 뷰라 이번 주 업무 현황을 한 눈에 파악하기 어렵고, 날짜 클릭 없이는 상세 확인 불가 |
| **Solution** | 이번 주(월~일) 업무를 행으로 나열한 표를 기본 탭으로 제공, 달력은 탭 전환으로 유지 |
| **Function/UX Effect** | 페이지 진입 즉시 이번 주 전체 업무 스냅샷 확인, 주 네비게이션으로 전주/다음 주 조회 가능 |
| **Core Value** | 운영자가 매일 홈 화면에서 이번 주 일감을 즉시 파악해 우선순위 판단 시간 단축 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 홈 달력(월 단위)은 이번 주 업무를 한 눈에 보기 어려움 |
| **WHO** | PEP 홈 work 모드를 사용하는 모든 로그인 사용자 |
| **RISK** | WorkCalendar 완전 제거 시 기존 달력 기능 손실 → 탭으로 병존 |
| **SUCCESS** | 홈 진입 시 이번 주 업무 목록 즉시 노출, 전주/다음 주 네비게이션 동작 |
| **SCOPE** | Phase 1: WeeklyWorkTable 컴포넌트 신규. Phase 2: HomePage 탭 UI 적용 |

---

## 1. Overview

### 1.1 Purpose

홈 화면 work 모드 우측 패널(현재 `WorkCalendar`)을 주간 업무 표 + 달력 탭 구조로 개선하여,
운영자가 매일 홈 화면에서 이번 주 전체 업무를 즉시 파악할 수 있게 한다.

### 1.2 Background

- 현재 `WorkCalendar`는 월 단위 그리드로, 오늘 외에는 날짜 클릭 없이 업무 확인 불가
- 팀 운영자는 매일 아침 "이번 주 무슨 일이 있나?"를 확인하는 패턴 보유
- `MemberTodayTodos`(좌측 패널)는 일 단위 네비게이션으로 특정일 현황을 보여줌 — 주간 뷰와 상호보완적

### 1.3 Related Documents

- Design: `docs/02-design/features/home-weekly-work-table.design.md`

---

## 2. Scope

### 2.1 In Scope

- [x] `WeeklyWorkTable` 신규 컴포넌트 — 이번 주 업무를 날짜별 행으로 표시
- [x] 전주 / 다음 주 네비게이션 (ChevronLeft / ChevronRight)
- [x] 표 컬럼: 날짜(요일), 담당자, 분류/타입, 업무 내용, 상태
- [x] HomePage 우측 패널에 탭 UI (`주간 표` | `월 달력`) 적용
- [x] 기본 탭: 주간 표

### 2.2 Out of Scope

- 백엔드 API 변경 없음 — 기존 `useWorkItems()` 훅 재사용
- WorkCalendar 컴포넌트 내부 수정 없음 (탭 안에 그대로 사용)
- 주간 표 내 인라인 편집 (클릭 시 상세 페이지 이동만)
- 필터/검색 기능

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 이번 주 월~일 업무(startedAt 기준) 를 날짜별 행으로 표시 | High | Pending |
| FR-02 | 전주 / 다음 주 네비게이션 버튼 | High | Pending |
| FR-03 | 각 행 클릭 시 업무 상세 페이지 이동 | High | Pending |
| FR-04 | 탭 UI — 주간 표(기본) / 월 달력 전환 | High | Pending |
| FR-05 | 상태별 색상 dot (backlog/todo/in_progress/review_test/done) | Medium | Pending |
| FR-06 | 업무 없는 날은 빈 행 표시 (날짜 유지) | Medium | Pending |
| FR-07 | 오늘 날짜 행 강조 (bg-primary/5 등) | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 주간 데이터 렌더 < 100ms | 브라우저 Performance 탭 |
| Accessibility | 표 thead/tbody 시맨틱 마크업 | 코드 리뷰 |
| Lint | ESLint 0 warnings | `npm run lint` |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [x] `WeeklyWorkTable` 컴포넌트 구현 완료
- [x] HomePage 탭 UI 적용 — 주간 표 기본, 달력 탭 전환 정상
- [x] 전주 / 다음 주 네비게이션 동작
- [x] `npm run lint` — 0 warnings
- [x] `npx tsc --noEmit` — 0 errors
- [x] `npm run build` — 빌드 성공

### 4.2 Quality Criteria

- [x] Zero lint errors
- [x] Build succeeds
- [x] 기존 WorkCalendar 기능 탭에서 유지

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| WorkCalendar 제거로 기존 사용자 달력 기능 상실 | Medium | Low | 탭으로 달력 병존 유지 |
| 주간 표 데이터가 많을 경우 스크롤 UX 저하 | Low | Medium | 패널 flex-1 + overflow-y-auto 기존 패턴 유지 |
| `useWorkItems()` 데이터 로딩 지연 | Low | Low | 기존 로딩 스피너 패턴 재사용 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `HomePage.tsx` | Frontend Component | work 모드 우측 패널에 탭 UI + WeeklyWorkTable 추가 |
| `WorkCalendar.tsx` | Frontend Component | 수정 없음 (탭 안에서 재사용) |
| `WeeklyWorkTable.tsx` (신규) | Frontend Component | 이번 주 업무 표 컴포넌트 |
| `dashboard/index.ts` | Barrel export | WeeklyWorkTable export 추가 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `WorkCalendar` | READ | `HomePage.tsx` line 191 | 탭 내부로 이동, 기능 유지 |
| `useWorkItems()` | READ | `WorkCalendar.tsx` 내부 | WeeklyWorkTable도 동일 훅 사용 |

### 6.3 Verification

- [x] WorkCalendar 탭 전환 후 달력 렌더 정상 확인
- [x] useWorkItems 데이터 공유로 중복 API 호출 없음

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

Dynamic (기존 프로젝트 레벨 유지)

### 7.2 Key Architectural Decisions

| Decision | Selected | Rationale |
|----------|----------|-----------|
| 상태(탭 선택) | useState (로컬) | 페이지 새로고침 시 주간 표 기본이 자연스러움, persist 불필요 |
| 데이터 소스 | `useWorkItems()` 재사용 | 추가 API 없이 클라이언트 필터링으로 충분 |
| 주간 범위 계산 | 클라이언트 Date 연산 | 서버 의존 없이 `startedAt` 기준 필터링 |
| 스타일 | 기존 Tailwind + shadcn/ui 패턴 | 기존 코드베이스와 일관성 |

---

## 8. Convention Prerequisites

기존 프로젝트 컨벤션 준수:
- 컴포넌트: `src/components/dashboard/WeeklyWorkTable.tsx`
- barrel export: `src/components/dashboard/index.ts` 에 추가
- Tailwind only, cn() 헬퍼 사용
- lucide-react 아이콘
- 기존 `MemberTodayTodos` 의 날짜 네비게이션 패턴 참고

---

## 9. Next Steps

1. [ ] Design 문서 작성 (`home-weekly-work-table.design.md`)
2. [ ] `WeeklyWorkTable` 컴포넌트 구현
3. [ ] `HomePage.tsx` 탭 UI 적용

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-01 | Initial draft | riverjin839 |
