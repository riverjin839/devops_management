# home-weekly-work-table Design Document

> **Summary**: 홈 work 모드 우측 패널에 주간 업무 표를 기본 탭으로 추가, 달력 탭으로 전환 가능
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/home-v2
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft
> **Planning Doc**: [home-weekly-work-table.plan.md](../../01-plan/features/home-weekly-work-table.plan.md)

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 홈 달력(월 단위)은 이번 주 업무를 한 눈에 보기 어려움 |
| **WHO** | PEP 홈 work 모드를 사용하는 모든 로그인 사용자 |
| **RISK** | WorkCalendar 완전 제거 시 기존 달력 기능 손실 → 탭으로 병존 |
| **SUCCESS** | 홈 진입 시 이번 주 업무 목록 즉시 노출, 전주/다음 주 네비게이션 동작 |
| **SCOPE** | Phase 1: WeeklyWorkTable 신규. Phase 2: HomePage 탭 UI 적용 |

---

## 1. Overview

### 1.1 Design Goals

- `WeeklyWorkTable` 컴포넌트: 이번 주(월~일) 업무를 날짜별 행으로 표시, self-contained
- `HomePage`: 탭 UI로 주간 표(기본) ↔ 달력 전환
- 신규 API 없이 기존 `useWorkItems()` 데이터 재사용
- 기존 `MemberTodayTodos`의 날짜 네비게이션 UX 패턴 참고

### 1.2 Design Principles

- Self-contained: WeeklyWorkTable이 모든 상태(주 커서, 데이터 필터링)를 내부 관리
- 기존 패턴 재사용: `WorkCalendar`의 `parseDate`, `toDateKey` 헬퍼 참고
- Tailwind only + cn() — 신규 CSS 없음

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Self-contained | Option B: Hook 분리 | Option C: HomePage 통합 |
|----------|:-:|:-:|:-:|
| **Approach** | WeeklyWorkTable 자체 상태 | useWeekRange 커스텀 훅 | 상태를 HomePage로 올림 |
| **New Files** | 1 | 2 | 1 |
| **Modified Files** | 2 | 2 | 2 |
| **Complexity** | Low | Low-Medium | Medium |
| **Maintainability** | Medium | High | Low |
| **Effort** | Low | Low | Low |
| **Recommendation** | **선택** | 주 범위 재사용 시 | - |

**Selected**: **Option A — Self-contained**
**Rationale**: 주 범위 로직을 재사용할 다른 컴포넌트 없음. 단순·빠름.

### 2.1 Component Diagram

```
HomePage (work 모드)
├── [좌측 4/10] MemberTodayTodos     — 변경 없음
└── [우측 6/10] 탭 패널
      ├── Tab: "주간" (기본)
      │     └── WeeklyWorkTable       — 신규
      │           ├── useWorkItems()
      │           ├── useState(weekOffset)
      │           └── 주간 필터링 로직
      └── Tab: "달력"
            └── WorkCalendar          — 변경 없음 (재사용)
```

### 2.2 Data Flow

```
[페이지 진입]
1. tab = 'week' (기본)
2. WeeklyWorkTable: useWorkItems() → 전체 WorkItem[]
3. 이번 주 월~일 범위 계산 (weekOffset=0 기준)
4. startedAt 기준으로 필터 → 날짜별 그룹화
5. 표 렌더링

[주 네비게이션]
6. ← / → 클릭 → weekOffset ±1
7. 새 범위로 필터링 → 표 업데이트

[탭 전환]
8. "달력" 탭 클릭 → WorkCalendar 렌더
9. "주간" 탭 클릭 → WeeklyWorkTable 렌더 (주 커서 유지)
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| WeeklyWorkTable | useWorkItems | 업무 데이터 조회 |
| WeeklyWorkTable | lucide-react (ChevronLeft/Right, RotateCcw) | 네비게이션 아이콘 |
| WeeklyWorkTable | react-router-dom (Link) | 업무 상세 이동 |
| WeeklyWorkTable | cn() | 조건부 클래스 |
| HomePage | WeeklyWorkTable, WorkCalendar | 탭 안에서 렌더 |

---

## 3. Data Model

### 3.1 주간 범위 계산

```typescript
// WeeklyWorkTable 내부 유틸
function getWeekRange(offsetWeeks: number): { start: Date; end: Date } {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=일 ... 6=토
  // 월요일 기준 주 시작
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7) + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
```

### 3.2 주간 행 데이터 구조

```typescript
interface WeekDay {
  dateKey: string;   // 'YYYY-MM-DD'
  date: Date;
  label: string;     // '월 6/2', '화 6/3', ...
  items: WorkItem[]; // startedAt 기준 필터된 업무
  isToday: boolean;
}
```

---

## 4. API Specification

**신규 API 없음** — 기존 `GET /api/v1/work-items` (useWorkItems 훅) 재사용.

클라이언트 사이드 필터링:
- `item.startedAt`이 해당 주 월~일 범위 내인 것만 표시
- `type` 무관 (task/issue/meeting/training/etc 모두)
- `selectedClusterId` prop: `null`로 고정 (홈 화면은 전체)

---

## 5. UI/UX Design

### 5.1 탭 패널 레이아웃

```
┌─────────────────────────────────────────────────────────────┐
│  flex-none 헤더 바                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  이번 달 일정   [ 주간 ★ ] [ 달력 ]                  │   │ ← 탭 버튼
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  flex-1 min-h-0 overflow-y-auto                             │
│                                                             │
│  ▼ tab='week' 일 때                                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ← 이전 주   2026-06-01 ~ 06-07   이번 주 →         │   │ ← 네비게이션
│  ├──────────────────────────────────────────────────────┤   │
│  │  날짜   담당자   타입   업무 내용   상태              │   │ ← thead
│  ├──────────────────────────────────────────────────────┤   │
│  │  월 6/2  홍길동  작업   K8s 점검   ● 진행 중         │   │
│  │  화 6/3  —      (업무 없음)                          │   │ ← 빈 날
│  │  수 6/4★ 김영희  이슈   Node 경고  ● 할일            │   │ ← 오늘
│  │  ...                                                  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 네비게이션 바 스펙

```tsx
// 주간 네비게이션 바
<div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/20">
  <button onClick={goPrev}>
    <ChevronLeft className="w-3.5 h-3.5" />
  </button>
  <span className="text-[11px] font-medium tabular-nums">
    {formatWeekRange(weekStart, weekEnd)}  {/* '06/02 (월) ~ 06/08 (일)' */}
  </span>
  <div className="flex items-center gap-1">
    {weekOffset !== 0 && (
      <button onClick={goToday} title="이번 주">
        <RotateCcw className="w-3 h-3" />
      </button>
    )}
    <button onClick={goNext}>
      <ChevronRight className="w-3.5 h-3.5" />
    </button>
  </div>
</div>
```

### 5.3 표 스펙

```tsx
<table className="w-full text-[11px]">
  <thead>
    <tr className="border-b border-border bg-muted/30">
      <th className="w-20 px-2 py-1.5 text-left font-medium text-muted-foreground">날짜</th>
      <th className="w-20 px-2 py-1.5 text-left font-medium text-muted-foreground">담당자</th>
      <th className="w-14 px-2 py-1.5 text-left font-medium text-muted-foreground">타입</th>
      <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">업무</th>
      <th className="w-16 px-2 py-1.5 text-left font-medium text-muted-foreground">상태</th>
    </tr>
  </thead>
  <tbody>
    {weekDays.map((day) =>
      day.items.length === 0 ? (
        // 빈 날: 날짜 셀 + 회색 텍스트
        <tr key={day.dateKey} className={cn('border-b border-border/50', day.isToday && 'bg-primary/5')}>
          <td className="px-2 py-1.5 font-medium text-muted-foreground">{day.label}</td>
          <td colSpan={4} className="px-2 py-1.5 text-muted-foreground/50 italic text-[10px]">업무 없음</td>
        </tr>
      ) : (
        day.items.map((item, idx) => (
          <Link key={item.id} to={`/tasks-mgmt/${item.id}`} asChild>
            <tr className={cn(
              'border-b border-border/50 hover:bg-secondary/40 cursor-pointer transition-colors',
              day.isToday && 'bg-primary/5',
            )}>
              <td className="px-2 py-1.5 font-medium text-muted-foreground">
                {idx === 0 ? day.label : ''}  {/* 날짜는 첫 행에만 */}
              </td>
              <td className="px-2 py-1.5 truncate max-w-[80px]">{item.primaryAssignee ?? item.assignee ?? '—'}</td>
              <td className="px-2 py-1.5">{TYPE_LABEL[item.type]}</td>
              <td className="px-2 py-1.5 truncate">{stripHtml(item.content).slice(0, 40)}</td>
              <td className="px-2 py-1.5">
                <span className={cn('flex items-center gap-1', STATUS_COLOR[item.kanbanStatus])}>
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {STATUS_LABEL[item.kanbanStatus]}
                </span>
              </td>
            </tr>
          </Link>
        ))
      )
    )}
  </tbody>
</table>
```

### 5.4 탭 버튼 스펙

```tsx
// HomePage 우측 패널 헤더 (tab 상태 추가)
const [tab, setTab] = useState<'week' | 'calendar'>('week');

// 헤더 바에 탭 버튼 삽입
<div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
    이번 달 일정
  </span>
  {/* 탭 버튼 */}
  <div className="ml-auto flex items-center rounded-md border border-border overflow-hidden text-[10px]">
    <button
      onClick={() => setTab('week')}
      className={cn('px-2 py-1 transition-colors',
        tab === 'week' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
      )}
    >주간</button>
    <button
      onClick={() => setTab('calendar')}
      className={cn('px-2 py-1 transition-colors border-l border-border',
        tab === 'calendar' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
      )}
    >달력</button>
  </div>
  <CalendarDays className="w-3.5 h-3.5 text-primary" />
</div>
```

### 5.5 Page UI Checklist

#### HomePage (work 모드, 우측 패널)

- [ ] 탭 버튼: "주간" (기본 활성, bg-primary), "달력" 나란히 표시
- [ ] tab='week' 시 WeeklyWorkTable 렌더
- [ ] tab='calendar' 시 WorkCalendar 렌더 (기존 기능 동일)

#### WeeklyWorkTable

- [ ] 네비게이션 바: ChevronLeft(이전 주) + 주 범위 텍스트 + ChevronRight(다음 주)
- [ ] 이번 주 아닌 경우: RotateCcw(이번 주로) 버튼 표시
- [ ] 표 thead: 날짜 / 담당자 / 타입 / 업무 / 상태 5개 컬럼
- [ ] 오늘 날짜 행: `bg-primary/5` 강조
- [ ] 업무 있는 날: 담당자, 타입(한글), 업무내용(40자), 상태 dot + 텍스트
- [ ] 업무 없는 날: "업무 없음" 회색 이탤릭 표시
- [ ] 같은 날 여러 업무: 날짜 셀은 첫 행에만 표시 (rowspan 패턴)
- [ ] 각 업무 행 클릭: `/tasks-mgmt/{id}` 이동

---

## 6. Error Handling

| 상황 | 처리 |
|------|------|
| `useWorkItems()` 로딩 중 | 기존 로딩 스피너 없음 — 빈 표 그대로 표시 (데이터 없음과 동일) |
| `startedAt` 없는 업무 | 표에서 제외 (null-safe 처리) |
| 주 범위 경계 에러 | `Date` 연산 overflow 없음 (offset 기반) |

---

## 7. Security Considerations

- XSS: `stripHtml()` 사용으로 업무 내용 안전 렌더
- 권한: `useWorkItems()`가 이미 인증된 사용자 데이터만 반환
- 인라인 편집 없음 — read-only 표

---

## 8. Test Plan

### 8.1 L2: UI Action Test Scenarios

| # | 컴포넌트 | 액션 | 기대 결과 |
|---|---------|------|---------|
| 1 | HomePage | 진입 | 주간 탭 기본 활성, WeeklyWorkTable 표시 |
| 2 | 탭 버튼 | "달력" 클릭 | WorkCalendar 렌더, 달력 버튼 활성 |
| 3 | 탭 버튼 | "주간" 재클릭 | WeeklyWorkTable 복귀 |
| 4 | WeeklyWorkTable | ← 클릭 | 이전 주 범위로 변경 |
| 5 | WeeklyWorkTable | → 클릭 | 다음 주 범위로 변경 |
| 6 | WeeklyWorkTable | RotateCcw 클릭 | 이번 주로 복귀 |
| 7 | WeeklyWorkTable | 업무 행 클릭 | `/tasks-mgmt/{id}` 이동 |

### 8.2 L3: E2E Scenario

| # | 시나리오 | 스텝 | 성공 기준 |
|---|---------|------|---------|
| 1 | 주간 표 확인 | 홈 진입 → work 모드 → 주간 탭 확인 | 이번 주 업무 표 표시 |
| 2 | 탭 전환 | 홈 → 달력 탭 → 주간 탭 | 전환 시 컴포넌트 정상 교체 |
| 3 | 주 네비게이션 | 이전 주 → 범위 변경 → 이번 주 복귀 | 주 범위 텍스트 정확 |

---

## 9. Clean Architecture — Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| `WeeklyWorkTable` | Presentation | `frontend/src/components/dashboard/WeeklyWorkTable.tsx` |
| `HomePage` (탭 수정) | Presentation | `frontend/src/pages/HomePage.tsx` |
| `dashboard/index.ts` | Presentation | `frontend/src/components/dashboard/index.ts` |

---

## 10. Coding Convention Reference

| Item | Convention |
|------|-----------|
| 컴포넌트명 | `WeeklyWorkTable` (PascalCase) |
| 날짜 포맷 헬퍼 | 로컬 함수 (WorkCalendar 패턴 참고) |
| 조건부 클래스 | `cn()` 헬퍼 |
| 아이콘 | `lucide-react` |
| 링크 | `<Link to={...}>` from react-router-dom |
| 타입 한글 라벨 | `WORK_ITEM_TYPE_CONFIG` from `workItemKanbanUtils` 참고 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
frontend/src/
  components/dashboard/
    WeeklyWorkTable.tsx         ← 신규 (주간 업무 표)
    index.ts                    ← WeeklyWorkTable export 추가
  pages/
    HomePage.tsx                ← 탭 UI 적용 (tab state + 조건부 렌더)
```

**신규 파일: 1개 / 수정 파일: 2개**

### 11.2 Implementation Order

1. [ ] `WeeklyWorkTable.tsx` 구현
   - `getWeekRange(offset)` 헬퍼
   - `useState(weekOffset)`, `useWorkItems()`
   - 7일 WeekDay 배열 생성
   - 네비게이션 바 + 표 렌더링
2. [ ] `dashboard/index.ts` — `WeeklyWorkTable` export 추가
3. [ ] `HomePage.tsx` — `useState(tab)` + 탭 버튼 UI + 조건부 렌더

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | 예상 파일 수 |
|--------|-----------|-------------|:----------:|
| WeeklyWorkTable 컴포넌트 | `module-1` | 신규 컴포넌트 + barrel export | 2개 |
| HomePage 탭 UI | `module-2` | 탭 버튼 + 조건부 렌더 적용 | 1개 |

#### Recommended Session Plan

| Session | Phase | Scope | 예상 소요 |
|---------|-------|-------|:--------:|
| Session 1 (현재) | Plan + Design | 전체 | 완료 |
| Session 2 | Do | `--scope module-1,module-2` | 10-15 turns |
| Session 3 | Check + Report | 전체 | 10-15 turns |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-01 | Initial draft — Option A Self-contained | riverjin839 |
