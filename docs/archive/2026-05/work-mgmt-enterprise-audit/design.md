# Design — 업무관리 메인메뉴 Enterprise 점검 (Reverse-Engineered, As-Is)

> 작성일: 2026-05-21
> Plan: `docs/01-plan/features/work-mgmt-enterprise-audit.plan.md` (v2 — 7 surface scope)
> 다음: `docs/03-analysis/work-mgmt-enterprise-audit.analysis.md`

## Context Anchor (Plan 복사본)

| Key | Value |
|---|---|
| **WHY** | 4 메인메뉴 + 백엔드의 Enterprise 기준 충족도 명시화. 초기 발견된 즉시 위험: 인증 누락 + 페이지네이션 누락 |
| **WHO** | DevOps/SRE 팀, admin/operator/viewer 3 role |
| **RISK** | 큰 범위 → Critical 우선, UX/장기 carry-over |
| **SUCCESS** | Match Rate ≥ 80% + Critical 식별/픽스 |
| **SCOPE** | 7 surface: 4 메인 페이지 + work_items 라우터 + 모델 + (3 sub-page Form/Detail 포함) |

## 1. Overview — As-Is 구조

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     Frontend (4 메인메뉴 페이지)                          │
│   /tasks-mgmt  ──┬─ WorkItemBoardPage (519줄)                             │
│                  ├─ WorkItemFormPage (93줄)                               │
│                  └─ WorkItemDetailPage (112줄)                            │
│   /todo-today    ── TodoTodayPage (440줄)                                 │
│   /work-summary  ── WorkSummaryPage (57줄)                                │
│   /members       ── MemberBoardPage (352줄)                               │
│        │                                                                  │
│        ▼ (TanStack Query hooks via services/api.ts:workItemsApi)         │
└───────────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────────┐
│              Backend — routers/work_items.py (396줄)                      │
│                                                                           │
│   ┌────────────── GET endpoints (인증 0건) ────────────────┐              │
│   │  GET    /work-items                  ← list_work_items │              │
│   │  GET    /work-items/export/csv       ← export_csv      │              │
│   │  GET    /work-items/today/summary    ← today_summary   │              │
│   │  GET    /work-items/{id}             ← get_work_item   │              │
│   └────────────────────────────────────────────────────────┘              │
│   ┌────────────── Mutating endpoints (require_operator) ──┐              │
│   │  POST   /work-items                   ← create ✅      │              │
│   │  PUT    /work-items/{id}              ← update ✅      │              │
│   │  PATCH  /work-items/{id}/status       ← patch_status ✅│              │
│   │  DELETE /work-items/{id}              ← delete ✅      │              │
│   └────────────────────────────────────────────────────────┘              │
│                          │                                                │
│                          ▼                                                │
└───────────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────────┐
│   models/work_item.py — WorkItem (26 컬럼)                                │
│   - type 디스크리미네이터 (task/issue/meeting/training/etc)               │
│   - 자기 참조 2개: parent_id (CASCADE) + related_work_item_id (SET NULL)  │
│   - assignee/primary_assignee/secondary_assignee — 모두 자유 텍스트       │
│   - cluster_id FK (nullable) + cluster_name 중복 저장 (denormalized)      │
│   - 인덱스: type, service, component 만 (assignee/kanban_status 없음)     │
└───────────────────────────────────────────────────────────────────────────┘
```

## 2. As-Is API Matrix

| Endpoint | Verb | 인증 | Ownership | 페이지네이션 | Audit |
|---|---|:---:|:---:|:---:|:---:|
| `/work-items` (list) | GET | ❌ | N/A | ❌ `.all()` | ❌ |
| `/work-items/export/csv` | GET | ❌ | N/A | N/A (전체) | ❌ |
| `/work-items/today/summary` | GET | ❌ | N/A | N/A | ❌ |
| `/work-items/{id}` | GET | ❌ | ❌ (UUID 알면 OK) | N/A | ❌ |
| `/work-items` | POST | ✅ require_operator | N/A | N/A | ❌ |
| `/work-items/{id}` | PUT | ✅ require_operator | ❌ (operator 면 누구 것이든) | N/A | ❌ |
| `/work-items/{id}/status` | PATCH | ✅ require_operator | ❌ | N/A | ❌ |
| `/work-items/{id}` | DELETE | ✅ require_operator | ❌ | N/A | ❌ |

→ 4/8 endpoint 인증 없음 + 8/8 audit 없음 + 4/4 mutating 이 ownership 없음.

## 3. As-Is Data Model — WorkItem 핵심

```python
# 26 컬럼 요약
id (UUID PK)
type (str, index)                              ← 디스크리미네이터
assignee, primary_assignee, secondary_assignee ← 모두 자유텍스트, FK 아님
cluster_id (FK Cluster), cluster_name          ← denormalized (정합성 책임 코드에)
category, content, resolution                  ← 통일된 의미명
started_at, closed_at, remarks
service (index), component (index)             ← Phase B 에서 추가
detail_content                                 ← issue 전용
priority, kanban_status, module, type_label, effort_hours, done_condition  ← task 전용
parent_id (FK self, CASCADE), related_work_item_id (FK self, SET NULL)
created_at, updated_at                         ← server_default 없음
```

**인덱스 명시된 것**: `type`, `service`, `component` (3개)
**인덱스 누락 후보**: `kanban_status`, `assignee`, `started_at`, `closed_at`, `cluster_id`, `type+kanban_status` 복합

**자기 참조 cascade 정책**:
- `parent_id` → CASCADE (parent 삭제 시 sub-task 도 삭제)
- `related_work_item_id` → SET NULL (related 삭제 시 link 만 제거)

## 4. As-Is Frontend Surface

| Page | LoC | 핵심 hook / API | 비고 |
|---|---:|---|---|
| WorkItemBoardPage | 519 | useWorkItems, useCreateWorkItem, useDeleteWorkItem | table/calendar/kanban 3 view mode + DnD |
| WorkItemFormPage | 93 | useCreateWorkItem | 신규 작성 |
| WorkItemDetailPage | 112 | useWorkItem, useUpdateWorkItem | 상세 + 인라인 수정 |
| TodoTodayPage | 440 | (today filter on work_items) | 오늘 할일 |
| WorkSummaryPage | 57 | (집계 API) | 짧음 — placeholder 가능성 |
| MemberBoardPage | 352 | (work_items + users join) | 멤버별 |

총 frontend LoC: ~1,573줄

## 5. 4-Axis Evaluation Rubric

### Axis A — Architecture + Data Model

| 평가 항목 | 만족 (✅) | 미달 (❌) | 가중치 |
|---|---|---|:---:|
| Cascade 정책 명시 | parent CASCADE + related SET NULL 일관 | 명시 없음 또는 불일치 | 0.15 |
| 핵심 인덱스 존재 | kanban_status + assignee + started_at | 누락 | 0.25 |
| Referential integrity | assignee 가 User FK 또는 강한 참조 | 자유 텍스트 | 0.20 |
| N+1 query 회피 | joinedload/selectinload 사용 | 단순 .all() loop | 0.20 |
| Denormalized 정합성 | cluster_name 동기화 로직 | 수동 동기화 누락 | 0.20 |

### Axis B — API Consistency + Design

| 평가 항목 | 만족 (✅) | 미달 (❌) | 가중치 |
|---|---|---|:---:|
| 페이지네이션 + 진짜 total | offset/limit + db.count() | `.all()` + `len()` | 0.30 |
| 응답 shape 통일 | data/total/error/fieldErrors | inconsistent | 0.20 |
| Verb 정확 | GET/POST/PUT/PATCH/DELETE 명확 | mixed | 0.10 |
| OpenAPI 정확 | Query 정의 명세화 | undocumented | 0.10 |
| Error shape 일관 | HTTPException detail 일관 | mixed | 0.15 |
| URL 일관 | resource 명 일관 | mismatch | 0.15 |

### Axis C — Security + RBAC + Audit

| 평가 항목 | 만족 (✅) | 미달 (❌) | 가중치 |
|---|---|---|:---:|
| Mutating 인증 | 모든 POST/PUT/PATCH/DELETE 에 Depends(require_*) | 누락 | 0.20 |
| Read 인증 (Enterprise 기준) | 모든 GET 에도 require_* | 누락 | 0.20 |
| Ownership / RBAC | 다른 사람 work-item 수정 차단 | role 만 보고 통과 | 0.20 |
| Audit log | create/update/delete/status 변경 audit_logger 호출 | 0건 | 0.15 |
| XSS 방어 | react-markdown / DOMPurify | dangerouslySetInnerHTML | 0.10 |
| IDOR 방어 | UUID + ownership 체크 | UUID 만 알면 접근 | 0.15 |

### Axis D — UX Consistency + Accessibility

| 평가 항목 | 만족 (✅) | 미달 (❌) | 가중치 |
|---|---|---|:---:|
| MacCard wrapper | MacCard 사용 | 직접 div+border | 0.15 |
| ClusterSidebar (다중 클러스터 페이지) | iconOnly 사용 | 없거나 wide form | 0.15 |
| rounded-2xl + mac-shadow | 일관 | inconsistent | 0.10 |
| Dark mode 지원 | hsl(var(--*)) | hex literal | 0.15 |
| 빈/로딩/에러 상태 | 모두 처리 | 일부 누락 | 0.15 |
| Mobile responsive | 768px 까지 OK | 부서짐 | 0.10 |
| ARIA + keyboard nav | aria-label + tab order | 누락 | 0.10 |
| Empty state 친화적 안내 | guidance + CTA | 무미건조 | 0.10 |

## 6. Module Map (Analyze 시 subagent 분배)

| Module | 담당 axis | 분석 대상 | Subagent dispatch hint |
|---|---|---|---|
| **M1. Backend Architecture** | A | `models/work_item.py`, `models/cluster.py` 의 FK, `_run_migrations`, schemas/work_item.py | Explore "WorkItem 모델 + cluster relationship + migration 패턴 + index 정의" |
| **M2. Backend API** | B + C | `routers/work_items.py` 전체 endpoint 별 인증/페이지네이션/응답 shape | Explore "work_items 라우터의 각 endpoint 인증/페이지네이션/audit_logger 호출 여부" |
| **M3. Frontend UX** | D | 4 페이지의 MacCard/ClusterSidebar/dark/responsive/state 패턴 | Explore "WorkItemBoardPage/TodoTodayPage/WorkSummaryPage/MemberBoardPage 의 UI 패턴 일관성" |
| **M4. Security Cross-cut** | C | XSS 방어, audit log 사용처, ownership 로직 | Explore "audit_logger 호출 + ownership/role 체크 + XSS 위험 (dangerouslySetInnerHTML)" |

각 subagent 가 2-3분 분석 → finding 5-10개 반환 → 메인이 통합 + 우선순위.

## 7. Match Rate Formula

```
정적 only (이번 사이클):
  Overall = Axis_A × 0.25 + Axis_B × 0.25 + Axis_C × 0.30 + Axis_D × 0.20

각 Axis 는 §5 의 가중치 평균으로 0~1.0 산정.
Critical finding 1개 = Axis 점수 -0.20 페널티 (Enterprise 점검 특성)
```

가중치 근거: 사용자가 "ENTERPRISE 관점" 명시 → 보안(C) 최고, 아키텍처/API 동등, UX 가장 가벼움.

## 8. 다음 단계

Phase 3 (Analyze) — Explore subagent 4개 병렬 dispatch (M1~M4). 결과 통합 → analysis.md.
