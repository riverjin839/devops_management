# calendar-registration-ux Planning Document

> **Summary**: 달력 등록 UX 개선 — WorkCalendar QucikAddModal 제거·직접 이동, WorkItemCalendar 슬라이드 오버 등록, startedAt 쿼리 파라미터 지원
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/calendar-registration-ux
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 홈 달력에서 업무 등록 경로가 3중으로 중복(셀 + 버튼, 팝오버 버튼 2개)되어 혼란스러우며, 업무관리 달력에는 등록 진입점 자체가 없음 |
| **Solution** | 홈 달력은 QuickAddTaskModal을 제거하고 `/tasks-mgmt/new?startedAt=DATE`로 직접 이동; 업무관리 달력은 날짜 클릭 시 슬라이드 오버 패널로 즉시 등록 |
| **Function/UX Effect** | 등록 경로 단일화로 인지 부하 감소, 업무관리 달력에서 폼 페이지 이탈 없이 빠른 등록 가능 |
| **Core Value** | 운영자가 달력에서 날짜를 클릭해 불필요한 UI 레이어 없이 바로 업무를 등록·이동할 수 있는 일관된 흐름 제공 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 달력 등록 경로 중복(홈 3중) + 업무관리 달력 진입점 부재 → 운영자 혼란 |
| **WHO** | PEP를 사용하는 모든 로그인 운영자 |
| **RISK** | QuickAddTaskModal 제거 시 간단 입력 옵션 소멸 → 전체 폼 이동으로 대체(인터뷰 후 결정) |
| **SUCCESS** | 홈 달력 셀 클릭 → 단일 등록 경로, 업무관리 달력 날짜 클릭 → 슬라이드 오버 동작 |
| **SCOPE** | WorkCalendar.tsx / WorkItemCalendar.tsx / WorkItemFormPage.tsx 3개 파일 변경 |

---

## 1. Overview

### 1.1 Purpose

달력에서 업무를 등록하는 경로를 일관되게 단순화한다.

- **홈 WorkCalendar**: 셀 `+` 버튼, 팝오버 "일정" 버튼, 팝오버 빈 상태 "업무 등록" 버튼 세 개 모두 `QuickAddTaskModal` 대신 `/tasks-mgmt/new?startedAt=DATE` 로 이동
- **업무관리 WorkItemCalendar**: 날짜 셀 클릭 시 오른쪽에 슬라이드 오버 패널 → 날짜 자동 채움 + 업무 등록 폼
- **WorkItemFormPage**: URL `?startedAt=YYYY-MM-DDThh:mm` 파라미터를 폼 초기값으로 수신

### 1.2 Background

- `WorkCalendar` (홈): 날짜 클릭 → `DayDetailPopover` → "일정" 버튼 → `QuickAddTaskModal`; 셀 `+` 버튼도 같은 모달로 직결. 두 경로가 동일 결과를 유발.
- `WorkItemCalendar` (업무관리 달력 탭): 날짜 클릭 이벤트 없음, 업무 조회만 가능.
- `WorkItemFormPage`: `?type=` 파라미터는 지원하지만 `?startedAt=` 파라미터 미지원.

### 1.3 Related Documents

- `docs/01-plan/features/home-weekly-work-table.plan.md` — 홈 주간 업무 표 탭 (달력 탭 병존)

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | 홈 WorkCalendar 날짜 셀 `+` 버튼 클릭 시 `/tasks-mgmt/new?startedAt=DATE` 로 navigate | Must |
| FR-02 | 홈 WorkCalendar DayDetailPopover 의 "일정" 버튼 클릭 시 동일 이동 | Must |
| FR-03 | 홈 WorkCalendar DayDetailPopover 빈 날짜 "업무 등록" 버튼 클릭 시 동일 이동 | Must |
| FR-04 | `QuickAddTaskModal` 컴포넌트를 `WorkCalendar`에서 제거 (파일은 별도 삭제 여부 후 결정) | Must |
| FR-05 | 업무관리 WorkItemCalendar 날짜 셀 클릭 시 우측 슬라이드 오버 패널 열기 | Must |
| FR-06 | 슬라이드 오버 패널에 `WorkItemForm`을 embedded 모드로 렌더, `startedAt` 해당 날짜 자동 채움 | Must |
| FR-07 | 슬라이드 오버 패널 저장 완료 시 달력 데이터 갱신 + 패널 닫기 | Must |
| FR-08 | `WorkItemFormPage` `?startedAt=YYYY-MM-DDTHH:mm` URL 파라미터로 초기 날짜·시간 채움 | Must |

### 2.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | ESLint 0 warnings — `--max-warnings 0` CI 통과 |
| NFR-02 | TypeScript strict — `any` 금지 |
| NFR-03 | navigate 이동 시 페이지 히스토리 유지 (뒤로가기 정상 동작) |

---

## 3. Scope

### 3.1 In Scope

- `frontend/src/components/dashboard/WorkCalendar.tsx`
- `frontend/src/components/work-items/WorkItemCalendar.tsx`
- `frontend/src/pages/WorkItemFormPage.tsx`
- `frontend/src/components/work-items/WorkItemForm.tsx` (defaultStartedAt prop 추가)

### 3.2 Out of Scope

- `QuickAddTaskModal.tsx` 파일 자체 삭제 (다른 곳에서 사용 여부 확인 후 별도 결정)
- `DateTimePicker.tsx` UX 수정 (별도 피처)
- 백엔드 변경

---

## 4. User Flow

### 홈 달력 등록 (After)

```
홈 WorkCalendar
  날짜 셀 클릭
    └→ DayDetailPopover 열림
         └→ "일정" 버튼 클릭  ─┐
                               ├→ useNavigate('/tasks-mgmt/new?startedAt=2026-06-05T09:00')
  날짜 셀 + 버튼 클릭          ─┘
  빈 날짜 팝오버 "업무 등록"   ─┘
```

### 업무관리 달력 등록 (After)

```
WorkItemCalendar (달력 탭)
  날짜 셀 클릭
    └→ 슬라이드 오버 패널 열림 (오른쪽 고정)
         startedAt = 클릭한 날짜 T 09:00 자동 채움
         WorkItemForm (embedded=true)
           └→ 저장 → 패널 닫기 + invalidateQueries
           └→ 취소 → 패널 닫기
```

### 직접 URL 이동 (After)

```
/tasks-mgmt/new?startedAt=2026-06-05T09:00
  WorkItemFormPage 진입
    └→ WorkItemForm defaultStartedAt='2026-06-05T09:00'
         startedAt 필드에 해당 날짜·시간 자동 채움
```

---

## 5. Technical Design (Outline)

### 5.1 WorkCalendar 변경

- `useNavigate` hook 추가
- `setQuickAddDate` / `QuickAddTaskModal` 상태 및 렌더 제거
- `DayDetailPopover.onQuickAdd` → `() => { onClose(); navigate(...) }` 로 교체
- 셀 `+` 버튼 → `onClick` 에서 navigate 직접 호출
- `startedAt` 값: `${key}T09:00` (클릭 날짜의 09:00 기본값)

### 5.2 WorkItemCalendar 변경

- `selectedDate: string | null` 상태 추가
- 날짜 셀 `onClick` → `setSelectedDate(dayKey)`
- 슬라이드 오버 패널: `<WorkItemSlideOver>` 인라인 컴포넌트 또는 별도 파일
  - `WorkItemForm` embedded 모드 + `defaultStartedAt` 전달
  - `onSaved` → `invalidateQueries(['work-items'])` + `setSelectedDate(null)`
  - `onCancel` → `setSelectedDate(null)`
- 레이아웃: `<div className="flex gap-3">` 로 달력 + 슬라이드 오버 배치

### 5.3 WorkItemForm / WorkItemFormPage 변경

**WorkItemForm**:
- `defaultStartedAt?: string` prop 추가
- `useState` 초기값: `initial?.startedAt ? toDatetimeLocal(...) : (defaultStartedAt ?? todayDatetimeLocal())`

**WorkItemFormPage**:
- `searchParams.get('startedAt')` 읽어 `WorkItemForm defaultStartedAt` 전달
- `?startedAt=2026-06-05T09:00` 형식 허용

---

## 6. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| QuickAddTaskModal 다른 페이지에서도 사용 중 | Low | Medium | import 검색 후 확인 |
| WorkItemForm prop 추가로 기존 호출부 영향 | Low | Low | 선택적 prop (기본값 있음) |
| 슬라이드 오버 패널 모바일 레이아웃 | Medium | Low | 800px 미만에서 full-width 처리 |

---

## 7. Success Criteria

- [ ] 홈 달력 날짜 셀 `+` 클릭 → `/tasks-mgmt/new?startedAt=...` 이동 확인
- [ ] 홈 달력 팝오버 "일정" 클릭 → 동일 이동 확인
- [ ] 홈 달력 팝오버 빈 날짜 → 동일 이동 확인
- [ ] QuickAddTaskModal이 WorkCalendar에서 더 이상 렌더되지 않음
- [ ] 업무관리 달력 날짜 클릭 → 슬라이드 오버 열림, 날짜 자동 채움
- [ ] 슬라이드 오버 저장 → 달력 갱신 + 패널 닫힘
- [ ] `npm run lint` 0 warnings
- [ ] `npx tsc --noEmit` 오류 없음
