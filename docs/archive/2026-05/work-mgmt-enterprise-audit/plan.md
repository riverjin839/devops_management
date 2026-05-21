# Plan — 업무관리 메인메뉴 Enterprise 관점 점검 (Reverse-Engineered)

> 작성일: 2026-05-21
> 모드: 리버스 PDCA — 기존 4개 메인메뉴 + 인접 16개 surface 에 대한 사후 감사
> 다음 단계: `docs/02-design/features/work-mgmt-enterprise-audit.design.md` → `docs/03-analysis/...`
> 직전 사이클: cluster-detail-monitoring (94%, archived)

---

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | "업무관리" 메인메뉴 4개 페이지 + Dashboard 위젯 5개 + 인접 4개 페이지가 Enterprise 운영 기준 (아키텍처 정합성·API 일관성·보안/RBAC·UX 표준) 을 어느 수준에서 충족하는지 명시화 되지 않음. 초기 발견된 즉시 위험: work_items 라우터에 **인증 없음**, **페이지네이션 없음**, **total fake** — 데이터 양 증가 시 메모리 폭발 + 무인가 접근. |
| **Solution** | 16개 surface 를 **4 차원 × 페이지 그룹 matrix** 로 정적 분석. Critical/Important/UX 별 우선순위로 finding 분류 → 즉시/단기/중기 이관. cluster-detail-monitoring 사이클과 동일 패턴 (리버스 plan→design→analyze→iterate). |
| **Function UX Effect** | 운영자가 업무관리 화면을 신뢰하고 사용. 데이터 증가에도 페이지가 안 죽고, 다른 사람 work-item 을 임의 수정 못 하고, audit log 가 누구/언제/무엇 을 추적 가능. |
| **Core Value** | "Enterprise 운영 환경에서 업무관리 도구가 단순 prototype 이 아니라 **production 신뢰 가능 시스템**" — 데이터/권한/UX 기준선 확보. |

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | 4개 핵심 페이지 + 인접 surface 가 prototype 수준일 가능성. 초기 발견된 인증 누락 + 페이지네이션 누락이 사실이면 **production blocker**. 한 PDCA 사이클로 baseline 확보. |
| **WHO** | DevOps/SRE 팀의 일상 업무관리 사용자 (PM/개발/운영 혼합). admin/operator/viewer role 분리 존재하나 실제 강제 여부 불명. |
| **RISK** | 범위가 너무 커서 surface-level 만 보면 진짜 risk 누락. 16개 × 4차원 = 64 평가 axis 라 한 사이클로 모두 깊이 못 봄 → **Critical/Important 만 우선**, UX/장기는 carry-over. |
| **SUCCESS** | (1) 16개 surface 모두 4차원 평가 1회 완료. (2) Critical 식별 + 즉시 픽스. (3) Match Rate ≥ 80% (보다 낮은 목표 — 큰 범위 반영). (4) 잔여는 별도 PDCA 로 명확히 분리. |
| **SCOPE** | (in, **v2 축소**) 4 메인메뉴 페이지 + 백엔드 `work_items` 라우터 + `WorkItem` 모델 = **7 surface**. (out) Dashboard 위젯 5개 + 인접 5 페이지(ops-notes/wbs/mindmap/incident-analysis/workflow) → 모두 **차기 PDCA carry-over**. infrastructure/monitoring 영역 (직전 PDCA 가 처리), 외부 통합, Alembic 도입 |

## 1. 점검 대상 (v2 = 7 surface)

### 1.1 메인메뉴 4 페이지 (Sidebar GROUPS 'work') — **IN SCOPE**
| 경로 | 컴포넌트 | 백엔드 |
|---|---|---|
| `/tasks-mgmt` | WorkItemBoardPage + WorkItemFormPage + WorkItemDetailPage | `routers/work_items.py` + `models/work_item.py` |
| `/todo-today` | TodoTodayPage | (today filter on work_items 추정) |
| `/work-summary` | WorkSummaryPage | (집계 API 추정) |
| `/members` | MemberBoardPage | (work_items + users join 추정) |

→ frontend surface 6개 (Board/Form/Detail/Today/Summary/Members) + backend surface 1개 (work_items router+model) = **7 surface**

### 1.2 차기 PDCA carry-over (점검 안 함)
- **Dashboard 위젯 5개**: KanbanSummaryCharts, MemberTodayTodos, YesterdayChanges, QuickAddTaskModal, WorkCalendar → `work-mgmt-dashboard-widgets` 신규 PDCA 권장
- **인접 5 페이지**: `/ops-notes` (+ Form/Detail) → `routers/ops_note.py`, `/wbs`, `/mindmap`, `/incident-analysis`, `/workflow` (`routers/workflows.py`) → 각각 별도 PDCA 또는 `work-mgmt-adjacent-pages` 통합 PDCA 권장

## 2. Requirements

### FR — Functional (현재 동작하는 기능, baseline)
- FR-1. WorkItem CRUD (type=task/issue/meeting/training/etc 통합 모델)
- FR-2. Kanban 보드 (kanban_status=todo/in-progress/blocked/done) + WIP_LIMIT
- FR-3. 필터 (assignee/category/priority/kanban_status/module/cluster/date/closed)
- FR-4. CSV export
- FR-5. parent/subtask + related work item (자기 참조 관계 2개)
- FR-6. Workflow board (단계별 status)
- FR-7. Today/Member/Summary 집계 화면
- FR-8. Dashboard widget 으로 빠른 진입

### NFR — Non-Functional (Enterprise 기준선)
- NFR-1. **인증**: 모든 mutating endpoint 는 인증 필수 (현재 require_operator decorator 존재하나 적용 누락 의심)
- NFR-2. **권한**: ownership 또는 role-based — 다른 사람 work item 수정 차단 (admin 제외)
- NFR-3. **페이지네이션**: 리스트 API 는 offset/limit + 진짜 total count (현재 `.all()` + `len()` 추정)
- NFR-4. **인덱스**: 자주 필터되는 컬럼(assignee, kanban_status, started_at, type+kanban_status 복합) 인덱스 존재
- NFR-5. **Audit log**: 생성/수정/삭제/상태 변경이 audit_logs 테이블에 기록
- NFR-6. **UX 일관성**: ClusterSidebar iconOnly (다중 클러스터 페이지), MacCard, rounded-2xl, dark mode 지원
- NFR-7. **Mobile responsive**: 최소 768px 까지 부서지지 않음 (table 가로 스크롤 OK)
- NFR-8. **Error shape 통일**: HTTPException detail 일관 + 400/401/403/404 정확한 구분

## 3. 4-Axis Success Criteria

### Axis A — Architecture + Data Model
| # | Criterion | 측정 |
|---|---|---|
| A-SC-1 | WorkItem 의 자기 참조 관계(parent/related) cascade 정책이 명시적이고 일관됨 | 모델 inspect — CASCADE/SET NULL 명시 |
| A-SC-2 | 자주 필터되는 컬럼 인덱스 존재 | `\d work_items` 에 assignee/kanban_status/started_at 인덱스 |
| A-SC-3 | assignee 가 User FK 또는 강한 참조로 거버넌스 가능 | 모델 검토 (현재 자유 텍스트 의심) |
| A-SC-4 | N+1 query 패턴 없음 | `joinedload`/`selectinload` 사용 여부 |
| A-SC-5 | Workflow/OpsNote 모델도 동일 cascade/index 패턴 일관 | cross-model 검토 |

### Axis B — API Consistency + Design
| # | Criterion | 측정 |
|---|---|---|
| B-SC-1 | 모든 리스트 API 페이지네이션 (offset/limit) + 진짜 total count | router 별 검토 |
| B-SC-2 | 응답 shape 통일 (data/total/error/fieldErrors) | schemas/ 일관성 |
| B-SC-3 | URL/리소스 명 일관 (`/work-items` vs `/tasks-mgmt` mismatch?) | router prefix 검토 |
| B-SC-4 | Sort/Filter 파라미터 명세 OpenAPI 에 정확 | FastAPI Query 정의 |
| B-SC-5 | 비파괴 endpoint 와 mutating endpoint 의 HTTP verb 정확 | GET/POST/PUT/PATCH/DELETE |

### Axis C — Security + RBAC + Audit
| # | Criterion | 측정 |
|---|---|---|
| C-SC-1 | 모든 mutating endpoint 에 `Depends(require_*)` 적용 | router 별 endpoint 검사 |
| C-SC-2 | Ownership 또는 role 기반 권한 (다른 사람 work-item 수정 차단) | router 로직 검토 |
| C-SC-3 | Audit log 가 work_items / workflows 의 변경을 기록 | audit_logger 호출 위치 |
| C-SC-4 | XSS 방어 (frontend 가 사용자 입력을 escape) | DOMPurify / react-markdown 사용 여부 |
| C-SC-5 | IDOR 방어 (UUID 만 알면 누구나 접근 가능?) | endpoint 별 ownership 체크 |
| C-SC-6 | Sensitive field 마스킹 (없으면 N/A) | 사용자 PII 노출 검토 |

### Axis D — UX Consistency + Accessibility
| # | Criterion | 측정 |
|---|---|---|
| D-SC-1 | MacCard 표준 사용 | 4 페이지의 wrapper 패턴 |
| D-SC-2 | ClusterSidebar iconOnly (다중 클러스터 페이지면) | sidebar 사용 여부 |
| D-SC-3 | rounded-2xl + mac-shadow 일관 | 카드 스타일 검토 |
| D-SC-4 | Dark mode 지원 (color hardcoded X) | hex color literals 검사 |
| D-SC-5 | 빈 상태 / 로딩 상태 / 에러 상태 모두 처리 | TanStack Query 패턴 |
| D-SC-6 | Mobile responsive (최소 768px) | grid/flex breakpoint 검토 |
| D-SC-7 | ARIA label / keyboard nav 기본 | semantic HTML 검토 |

## 4. Constraints

- C-1. 정적 분석 only (직전 사이클과 동일, 환경 미가용)
- C-2. 16개 surface 깊이 차등 — 메인 4 페이지 > 위젯 5 > 인접 4
- C-3. UX 차원은 spot check 위주 (런타임 검증 필요한 경우 carry-over)
- C-4. Agent Teams 비활성 — Explore subagent 4개로 병렬 분야별 분석 가능

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 범위가 너무 커서 surface-level 만 → 진짜 risk 누락 | High | 4-axis matrix 로 강제 cover. 깊이는 Critical 우선 |
| Critical 픽스 시 회귀 (특히 페이지네이션/인증 추가) | High | 즉시 + 단기 분리, breaking 변경은 carry-over |
| Sub-task 모델 변경 → 백워드 호환 깨짐 | Med | 마이그레이션 패턴 (`_safe_*`) 준수 |
| 16 surface 중 일부가 deprecated/사용 안 함 | Low | analyze 시 도달 가능성 검사 |

## 6. Out of Scope (v2)

- **Dashboard 위젯 5개** (`work-mgmt-dashboard-widgets` 차기 PDCA 권장)
- **인접 5 페이지** (`work-mgmt-adjacent-pages` 또는 개별 PDCA: `ops-notes-audit`, `workflow-audit`, `wbs-audit`, `mindmap-audit`, `incident-analysis-audit`)
- Infrastructure / 모니터링 (직전 cluster-detail-monitoring PDCA 가 처리)
- 외부 통합 (Slack/Jira/Confluence sync)
- 마이그레이션 자동화 (Alembic 도입은 별도 PDCA)
- i18n (현재 한국어 단일)
- 모바일 native 앱

## 7. 산출물 / Phase 계획

| Phase | 산출물 | 메인 vs subagent | 예상 시간 |
|---|---|---|---|
| 1. **Plan** (현재 단계) | 본 문서 | 메인 | ✅ 완료 |
| 2. **Design** (다음) | As-Is 구조 추출 + 차원별 평가 기준 + Module Map | 메인 | ~5분 |
| 3. **Analyze** | 4-axis matrix finding + Match Rate + 우선순위 | Explore subagent 4개 (병렬 분야 분석) + 메인 통합 | ~10분 |
| 4. **Iterate-1** | Critical + Important + UX 일관성 일괄 픽스 (사용자 선택, 예상 10-15건) | 메인 | ~20분 |
| 5. **Report** | 완료 보고서 + carry-over (UX/장기) | 메인 | ~3분 |
| 6. **QA** | 환경 미가용 시 SKIP + manual 체크리스트 | 메인 | ~3분 |
| 7. **Archive** | docs/archive/2026-05/ + commit + push | 메인 | ~3분 |

## 다음 단계 — Design

Phase 2 (Design) 를 다음 메시지에 진행. 거기서:
1. 16 surface 의 As-Is 구조 (데이터 흐름 / API 매핑 / UI 컴포넌트 위계)
2. 4 차원별 평가 rubric (어떤 기준이 충족 vs 미달)
3. Module Map (analyze 시 subagent 분배 기준)
