# project-wbs Planning Document

> **Summary**: 프로젝트 단위 WBS — projects 테이블 신설, WorkItem에 project_id 연결, WBS 페이지를 프로젝트 헤더 + 하위 간트로 재구성
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: feature/project-wbs
> **Author**: riverjin839
> **Date**: 2026-06-01
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 현재 WBS는 담당자 그리드/개인 간트만 있어 프로젝트 단위 업무 묶음과 목표달성률 추적이 불가 |
| **Solution** | `projects` 테이블 신설 + `work_items.project_id` 연결 + WBS 페이지를 프로젝트 헤더(기간·목표·달성률) + 하위 간트 구조로 재설계 |
| **Function/UX Effect** | 개별 업무와 프로젝트 단위 업무를 동시에 관리, 프로젝트별 진행 상황을 한눈에 파악 |
| **Core Value** | 운영팀이 분기 단위 인프라 고도화·마이그레이션 같은 멀티 업무 프로젝트를 가시화하고 목표달성률을 자동 추적 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 개별 업무(task/issue)와 프로젝트 업무가 공존 — 프로젝트 단위 구조·달성률 추적 필요 |
| **WHO** | PEP 운영팀 전원 (팀장: 프로젝트 생성·목표 설정 / 팀원: 업무 소속 프로젝트 선택) |
| **RISK** | 기존 WorkItem 다수가 project_id 없음 → nullable + "미분류" 표시로 backward compat 유지 |
| **SUCCESS** | 프로젝트 생성 후 업무 소속 가능, WBS 페이지에서 프로젝트별 달성률 자동 표시 |
| **SCOPE** | Backend: projects 테이블 + work_items.project_id. Frontend: WBS 페이지 재설계 + WorkItemForm 프로젝트 선택 |

---

## 1. Overview

### 1.1 Purpose

프로젝트 단위로 업무를 묶고 WBS를 가시화한다.

- **Projects**: 기간(start~end)·목표·담당자 목록을 갖는 업무 묶음 단위
- **WorkItem ↔ Project**: `project_id` FK로 연결 (nullable — 미분류 업무 허용)
- **WBS 페이지 재설계**: 프로젝트 헤더 섹션 + 소속 업무 간트 행, 기존 ViewModeBar(1주/2주/1달) 유지
- **달성률**: `done` 업무 수 / 프로젝트 전체 업무 수 자동 계산, 프로젝트 헤더에 진행바로 표시

### 1.2 Background

- 현재 `WbsFlowPage`는 담당자 그리드와 개인별 간트만 제공
- 프로젝트 단위(Q3 인프라 고도화 등) 업무 묶음 가시화 수단 없음
- 개별 업무 + 프로젝트 업무 공존 → `project_id` nullable로 backward compat 유지

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | `projects` 테이블 신설 (id/name/description/goal/start_date/end_date/status/color) | Must |
| FR-02 | `work_items.project_id` FK 컬럼 추가 (nullable) | Must |
| FR-03 | 프로젝트 CRUD API (`/api/v1/projects`) | Must |
| FR-04 | WBS 페이지 상단에 프로젝트 목록 탭/선택기 추가 | Must |
| FR-05 | 선택한 프로젝트의 헤더 카드: 이름·기간·목표·담당자 목록·달성률 진행바 | Must |
| FR-06 | 프로젝트 헤더 아래 소속 업무 간트 (기존 PersonalGanttView 재활용) | Must |
| FR-07 | 달성률 = done 업무 수 / 전체 업무 수 (자동 계산, 백분율) | Must |
| FR-08 | "미분류" 섹션: project_id=null 인 업무 묶음 (기존 뷰 동작과 동일) | Must |
| FR-09 | WorkItemForm에 프로젝트 선택 드롭다운 추가 | Must |
| FR-10 | 프로젝트 생성/편집 모달 (이름·기간·목표·색상) | Must |
| FR-11 | 일/주/2주/월 ViewModeBar 기존과 동일하게 유지 | Must |
| FR-12 | 담당자 필터 + 진행중만 필터 기존 유지 | Should |

### 2.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | ESLint 0 warnings, TypeScript strict |
| NFR-02 | 기존 project_id 없는 WorkItem 부팅 시 정상 표시 |
| NFR-03 | 프로젝트가 없을 때 → "미분류" 전체 뷰로 폴백 |

---

## 3. Scope

### 3.1 In Scope

**Backend:**
- `backend/app/models/project.py` — Project ORM 모델 신규
- `backend/app/schemas/project.py` — ProjectCreate / ProjectResponse 스키마
- `backend/app/routers/projects.py` — CRUD 라우터 (`/api/v1/projects`)
- `backend/app/main.py` — `_safe_add_column("work_items", "project_id", "UUID")` 마이그레이션
- `backend/app/models/work_item.py` — `project_id` FK 추가
- `backend/app/schemas/work_item.py` — `project_id` 필드 추가
- `backend/app/routers/__init__.py` — projects_router 등록

**Frontend:**
- `frontend/src/types/index.ts` — `Project`, `ProjectCreate` 인터페이스 추가, `WorkItem.projectId?` 추가
- `frontend/src/services/api.ts` — `projectsApi` 추가
- `frontend/src/hooks/useProjects.ts` — TanStack Query hooks (useProjects, useCreateProject, …)
- `frontend/src/pages/WbsFlowPage.tsx` — 전체 재설계 (프로젝트 헤더 + 간트)
- `frontend/src/components/work-items/WorkItemForm.tsx` — 프로젝트 선택 드롭다운 추가
- `frontend/src/components/wbs/ProjectFormModal.tsx` — 프로젝트 생성/편집 모달 (신규)
- `frontend/src/components/wbs/ProjectHeader.tsx` — 프로젝트 헤더 카드 (신규)

### 3.2 Out of Scope

- 프로젝트 간 의존관계 (화살표 연결)
- 마일스톤 / 스프린트 개념
- 외부 캘린더 연동 (Google Calendar 등)

---

## 4. Data Model

### 4.1 projects 테이블

```sql
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  goal        TEXT,                        -- 목표 텍스트
  color       VARCHAR(20) DEFAULT 'blue', -- 헤더 색상 식별자
  start_date  DATE,
  end_date    DATE,
  status      VARCHAR(20) NOT NULL DEFAULT 'active', -- active/completed/paused
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);
```

### 4.2 work_items.project_id

```sql
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
```

---

## 5. API Design

### 5.1 Projects CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects` | 프로젝트 목록 (status 필터) |
| POST | `/api/v1/projects` | 프로젝트 생성 |
| GET | `/api/v1/projects/{id}` | 프로젝트 상세 |
| PUT | `/api/v1/projects/{id}` | 프로젝트 수정 |
| DELETE | `/api/v1/projects/{id}` | 프로젝트 삭제 |
| GET | `/api/v1/projects/{id}/stats` | 달성률·담당자 통계 |

---

## 6. UX Flow

### 6.1 WBS 페이지 새 구조

```
WBS 작업 흐름
  ┌─ 툴바 ──────────────────────────────────────────────────────────┐
  │  [프로젝트 선택 드롭다운]  [+ 새 프로젝트]  [1주|2주|1달]  [날짜 이동]│
  └─────────────────────────────────────────────────────────────────┘

  ┌─ ProjectHeader 카드 ────────────────────────────────────────────┐
  │  ● Q3 인프라 고도화          2026-07-01 ~ 2026-09-30           │
  │  목표: 클러스터 3개 k8s 1.30 업그레이드 완료                     │
  │  담당: 김운영 박엔지 이담당  달성률: ██████░░░░ 62% (8/13)       │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ 업무 간트 (프로젝트 소속 업무) ──────────────────────────────────┐
  │  작업/이슈        6/01  6/02  6/03  6/04  6/05  ...             │
  │  ├ master1 업그레이드   ████  ████                              │
  │  │  └ etcd 백업 확인         ██                                  │
  │  └ 노드 drain 작업                 ████  ████                   │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ 미분류 (project_id=null) ──────────────────────────────────────┐
  │  ... 기존 담당자 그리드 뷰 ...                                    │
  └─────────────────────────────────────────────────────────────────┘
```

### 6.2 업무 등록 시 프로젝트 선택

```
WorkItemForm
  └→ 프로젝트: [드롭다운 — 전체 프로젝트 목록 + "미분류"]
       선택 시 project_id 전달
```

---

## 7. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| 기존 WorkItem에 project_id 없음 | High | Low | nullable + "미분류" 섹션으로 처리 |
| WBS 페이지 대규모 재작성 | High | Medium | 기존 PersonalGanttView 컴포넌트 재활용 |
| projects 테이블 없는 구버전 DB | Low | Medium | `_safe_add_column` + IF NOT EXISTS CREATE TABLE |

---

## 8. Success Criteria

- [ ] 프로젝트 생성 → 이름/기간/목표 저장 확인
- [ ] WorkItemForm에서 프로젝트 선택 후 저장 → work_items.project_id 반영
- [ ] WBS 페이지에서 프로젝트 선택 → 헤더 카드 + 소속 업무 간트 표시
- [ ] 달성률 = done 업무 / 전체 업무 자동 계산 및 표시
- [ ] project_id=null 업무 → "미분류" 섹션에 표시
- [ ] 1주/2주/1달 ViewModeBar 정상 동작
- [ ] `npm run lint` 0 warnings
- [ ] `npx tsc --noEmit` 오류 없음
