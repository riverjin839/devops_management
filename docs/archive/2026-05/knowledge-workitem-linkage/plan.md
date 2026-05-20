# knowledge-workitem-linkage Planning Document

> **Summary**: 지식허브 + 업무관리 게시판을 `service → component → typeLabel` 3단계 공유 계층으로 통합하고 양방향 cross-view 로 연계.
>
> **Project**: devops_management
> **Branch**: feature/home-v2
> **Author**: riverjin839
> **Date**: 2026-05-20
> **Status**: Draft (사용자 Q1~Q3 확정 후 작성)
> **Upstream**: `docs/03-analysis/knowledge-services-coherence.analysis.md` (Match Rate 25/100, Gap G1~G10)

---

## Executive Summary

| Perspective | Content |
|---|---|
| **Problem** | 같은 서비스(예: k8s)의 업무 이력이 4개 페이지(`/tasks-mgmt` · `/services/:s` · `/ops-notes` · `/docs`) 로 분산되어 한 자리에 모이지 않고, "어느 component(api-server/scheduler/etcd 등)에서 발생/작업했는지" 정밀 분류가 없어 재발 방지 학습이 어려움. |
| **Solution** | (1) WorkItem 에 신규 `component` 컬럼 + service 별 enum 도입, (2) 지식허브가 service drill-down → component drill-down 으로 동작, (3) 업무관리 보드에 service+component 필터 + 관련 ServiceEntry sidebar, (4) WorkItem 과 ServiceEntry 양방향 cross-link. |
| **Function/UX Effect** | `/docs` 에서 service 1번 클릭으로 그 서비스의 모든 이력(WorkItem + ServiceEntry + OpsNote) 통합 + component 으로 좁히기 + typeLabel(개선/버그/문서/보안) chip 필터. `/tasks-mgmt` 에서 service+component 로 필터링 + 우측 sidebar 에 관련 service entry. |
| **Core Value** | "한 서비스에서 우리 팀이 한 모든 일과 그 component 별 맥락을 한 화면에서 본다" — 운영자 의도서의 3 목적(서비스별 이력 / 공유 전파 / 장애 재발 방지) 중 1·3 직접 충족. |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | service · WorkItem · ServiceEntry · OpsNote 가 4개 화면으로 분산되어 운영자가 한 서비스의 전체 그림을 한 자리에서 볼 수 없음. component 분류 부재로 재발 방지 학습 곤란. |
| **WHO** | DevOps 파트원(운영 멤버). 1차 페르소나는 k8s 운영자(가장 많은 component 를 다룸). |
| **RISK** | (1) 기존 work_items 의 module/category 를 service+component 로 자동 변환하는 데이터 마이그레이션 — 자동 매핑 실패 케이스의 보존 정책. (2) ServiceEntry 와 WorkItem 두 모델을 모두 유지하면서 중복 등록되는 케이스의 사용자 UX. (3) component enum 이 service 마다 다른 동적 schema — frontend dropdown 의 진동(staleness). |
| **SUCCESS** | (A) `/docs` 에서 service chip 1번 클릭으로 그 서비스의 모든 이력 통합 표시. (B) k8s 선택 시 component chip 5종(api-server / scheduler / etcd / controller-manager / kubelet) 노출 + 클릭 시 필터. (C) `/tasks-mgmt` 에 service+component 필터 + 관련 ServiceEntry sidebar 동작. (D) WorkItemDetailPage → 관련 ServiceEntry 1-클릭 이동, ServiceHubPage 의 entry → 관련 WorkItem 1-클릭 이동. (E) 데이터 마이그레이션이 기존 work_items 100% 보존(자동 매핑 실패 케이스는 component=null 로). |
| **SCOPE** | Phase A(Critical, ~1주): ServiceHub 에 WorkItem 표시 + 양방향 cross-link. Phase B(Foundation, 1-2주): WorkItem.component 컬럼 + service별 enum + 마이그레이션. Phase C(Integration, 1-2주): KnowledgeHub 의 service/component drill-down + WorkItemBoard 의 service+component 필터. |

---

## 1. Overview

### 1.1 Purpose

운영자가 "k8s api-server" 같은 정밀한 좌표를 1번 클릭으로 잡고 그 좌표에 묶인 모든 운영 자산 — 과거 이슈 · 작업 · 회의 노트 · 트러블슈팅 · 변경 이력 · 운영 가이드 · OpsNote — 을 한 화면에서 본다. component 별 학습이 쌓여 재발 방지 자산화가 자동으로 일어난다.

### 1.2 Background

- `docs/03-analysis/knowledge-services-coherence.analysis.md` (2026-05-20) 에서 식별된 Critical 2건 + Important 5건을 **하나의 일관된 feature** 로 묶어 해결.
- 사용자 요구 직접 인용 (2026-05-20):
  - "지식허브 하위에 k8s 서비스 기준으로 게시판 기능 개선 — k8s 하위에는 core component 가 존재 api-server, scheduler …"
  - "업무 관리 게시판과 지식허브가 연계 되어야함"
- Q1~Q3 합의 (2026-05-20):
  - 3단계 계층(service → component → typeLabel) 도입
  - 신규 `WorkItem.component` 컬럼 + service별 enum (대안: category 재활용 — 거절)
  - 공유 모델 + cross-view (대안: 모델 통합 — 거절, 기존 데이터 보존 우선)

### 1.3 Related Documents

- 직전 분석: `docs/03-analysis/knowledge-services-coherence.analysis.md`
- 데이터 모델 출처: `frontend/src/types/index.ts` L278-322 (WorkItem), L1596-1614 (ServiceEntry), L554-567 (OpsNote)
- 서비스 카탈로그: `frontend/src/components/services/serviceCatalog.ts` L24-38 (12 service)
- 분류 상수: `frontend/src/components/work-items/workItemKanbanUtils.ts` L10-98 (TYPE / MODULE / TYPE_LABEL)
- 백엔드 모델/라우터: `backend/app/models/work_item.py`, `backend/app/routers/work_items.py`, `backend/app/routers/service_entries.py`

---

## 2. Scope

### 2.1 In Scope

#### Phase A — Cross-view (Critical, ~1주)
- [ ] **A1**: ServiceHubPage (`/services/:service`) 가 같은 `service` 의 WorkItem 을 별도 섹션으로 표시 (kind chip 옆에 "관련 업무" 영역).
- [ ] **A2**: ServiceHubPage 에 같은 service 의 OpsNote 도 inline 노출 (또는 링크 sidebar).
- [ ] **A3**: WorkItemDetailPage (`/tasks-mgmt/:id`) 에 우측 sidebar "관련 service entry" — 같은 `service` (또는 `service+component`) 의 ServiceEntry 5건.
- [ ] **A4**: ServiceEntry 카드 → "관련 업무로 연결" 액션 (이 entry 를 work_item 의 `relatedWorkItemId` 또는 신규 join 으로 묶기).

#### Phase B — Component model (Foundation, 1-2주)
- [ ] **B1**: `backend/app/models/work_item.py` 에 `component: String(64) | null` 컬럼 추가.
- [ ] **B2**: `_run_migrations()` 에 `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS component VARCHAR(64)` 추가.
- [ ] **B3**: 백엔드 `WorkItem` 스키마/CRUD 라우터에 component 필드 노출.
- [ ] **B4**: 프런트엔드 `frontend/src/components/services/serviceCatalog.ts` 에 `COMPONENT_BY_SERVICE` constant 추가. 초기 매핑:
  - `k8s` → [`api-server`, `scheduler`, `etcd`, `controller-manager`, `kubelet`, `kube-proxy`]
  - `keycloak` → [`realm`, `client`, `identity-provider`, `mapper`, `theme`]
  - `nexus` → [`repository`, `routing-rule`, `cleanup-policy`, `task`, `user`]
  - `jenkins` → [`pipeline`, `agent`, `credential`, `plugin`]
  - `argocd` → [`application`, `project`, `repo`, `sync-wave`]
  - `cilium` → [`agent`, `operator`, `hubble`, `policy`, `bgp`]
  - `prometheus` → [`server`, `alertmanager`, `exporter`, `rule`]
  - `grafana` → [`dashboard`, `datasource`, `alert`, `plugin`]
  - `etcd` → [`leader`, `member`, `snapshot`, `defrag`]
  - `hubble`/`ingress`/`storage`/`other` → 각각 4-6개 (초기안, 운영 중 확장)
- [ ] **B5**: 프런트엔드 type 정의 `WorkItem.component?: string` (optional 유지, 기존 행 호환).
- [ ] **B6**: `WorkItemForm` 의 service select 변경 시 component dropdown 동적 활성화.
- [ ] **B7**: 마이그레이션 스크립트(또는 `_run_migrations()` 안의 1회성 backfill): 기존 work_items 의 `module` → `service` 매핑 (k8s↔k8s 동일, monitoring → prometheus 등 — 자동 매핑 실패 케이스는 component=null 유지). 백업 컬럼 `module_legacy` 유지.

#### Phase C — Drill-down + filters (Integration, 1-2주)
- [ ] **C1**: KnowledgeHubPage (`/docs`) 의 필터 chip 행에 service chip 12개(또는 카운트 > 0 만) 추가 — `HubItem.service` 데이터는 이미 있음.
- [ ] **C2**: KnowledgeHubPage 에 service 선택 시 component dropdown 활성화 (선택된 service 의 COMPONENT_BY_SERVICE 만).
- [ ] **C3**: KnowledgeHubPage 에 typeLabel chip 5개 추가 (feature/bug/chore/docs/security) — 단 `kind === 'item'` 일 때만 의미가 있어 item kind 활성 시에만 노출.
- [ ] **C4**: KnowledgeHubPage 의 `if (i.type !== 'issue') continue` 제거 — 모든 WorkItem type 통합 표시.
- [ ] **C5**: KnowledgeHubPage 에 ServiceEntry 6번째 kind 로 추가 (note 와 별개 표시).
- [ ] **C6**: WorkItemBoardPage 에 service 필터 chip 행 추가 + service 선택 시 component dropdown.

### 2.2 Out of Scope

- 자동 알림/멘션/구독 시스템 (Gap G6) — 별도 feature 로.
- IncidentAnalysisPage 결과의 영구 저장 (Gap G2) — 별도 feature `incident-analysis-persist` 로.
- Issue resolution → Troubleshoot 자동 승격 (Gap G7) — 별도 feature 로.
- Troubleshoot 의 symptom/root_cause/resolution/prevention 구조화 (Gap G9) — 별도 feature 로.
- 동일 패턴 재발 자동 감지 (Gap G8) — 별도 feature 로.
- ServiceEntry 와 WorkItem 의 모델 통합 — Q3 합의에 따라 둘 다 유지.

---

## 3. Requirements

### 3.1 Functional Requirements

- **FR-1**: `WorkItem.component` 필드는 nullable(미선택 허용) 이며, service 가 선택되어 있어야 component 가 의미를 가진다. service=null 일 때 component=null 강제.
- **FR-2**: `COMPONENT_BY_SERVICE` 매핑은 frontend constant 로 관리(서버 재배포 없이 PR 한 번으로 추가 가능). 향후 ui_settings 로 옮길 수 있도록 모듈 분리.
- **FR-3**: KnowledgeHubPage 에 service / component / typeLabel 필터가 동시 활성 가능(AND 결합).
- **FR-4**: ServiceHubPage 의 "관련 업무" 영역은 `service` 일치 기준으로 fetch. component 가 있으면 component 일치 우선, 같은 service 의 다른 component 는 펼침으로 추가 노출.
- **FR-5**: WorkItemDetailPage 의 "관련 service entry" sidebar 는 `service` 일치 기준 5건 + 더보기.
- **FR-6**: cross-link 액션은 데이터 양쪽 영구 변경 없이 navigation only (또는 명시적 join 신규 모델 — Design 단계 결정).
- **FR-7**: 기존 work_items 데이터는 무손실 보존. component 가 자동 매핑되지 않은 행은 component=null 로 유지하며 UI 에 "분류 미지정" 으로 표시.

### 3.2 Non-Functional Requirements

- **NFR-1**: KnowledgeHubPage 가 service/component 필터 조합 시 1초 이내 응답 (현재 5개 query 병렬 fetch 패턴 유지).
- **NFR-2**: 데이터 마이그레이션은 백엔드 재시작 시 idempotent — 이미 매핑된 행은 다시 건드리지 않음.
- **NFR-3**: 새 component 컬럼은 인덱스 필요 없음(쿼리는 service 컬럼 기반 + 메모리 필터). 향후 OLAP 필요 시 인덱스 추가.
- **NFR-4**: lint(max-warnings 0) + tsc 통과 — 프로젝트 컨벤션 유지.

### 3.3 Compatibility / Migration

- 기존 라우트 `/work-items`, `/issues`, `/tasks` → `/tasks-mgmt` redirect 유지 (이미 App.tsx 에 있음).
- 기존 `WorkItem.module` 컬럼은 **보존** — 일부 화면(WorkflowBoard, MemberBoard) 이 사용 중이라 제거하면 회귀. 단 component 도입 후 module 의 의미가 약화되므로 향후 별도 정리 PR(`refactor: deprecate WorkItem.module`) 으로 따로 처리.
- `WorkItem.category` 도 보존 — 자유 텍스트라 의미를 잃지 않음.

---

## 4. Success Criteria

| ID | 기준 | 측정 방법 |
|---|---|---|
| SC-1 | `/docs` 에서 service chip 1번 클릭으로 그 서비스의 모든 이력 통합 표시 | 수동 — k8s chip 클릭 후 결과가 WorkItem(k8s) + ServiceEntry(k8s) + OpsNote(k8s) 합산과 일치 |
| SC-2 | k8s 선택 시 component chip 5+ 종 노출, 클릭 시 필터 | 수동 — chip 클릭 시 sorted/filtered 갯수 감소 확인 |
| SC-3 | `/tasks-mgmt` 에서 service+component 필터 동작 | 수동 — filter 적용 시 row 갯수 변화 + URL state 또는 localStorage |
| SC-4 | WorkItemDetailPage 의 관련 ServiceEntry sidebar 클릭 → ServiceHubPage 의 해당 entry 로 이동 | 수동 — 라우팅 확인 |
| SC-5 | ServiceHubPage entry → 관련 WorkItem 1-클릭 이동 | 수동 — 라우팅 확인 |
| SC-6 | 기존 work_items 100% 보존 + component=null 케이스가 UI 에서 "분류 미지정" 으로 표시 | 백엔드 단위 — 마이그레이션 전후 행 갯수 일치, frontend 단위 — null 표시 확인 |
| SC-7 | lint + tsc 통과, 회귀 없음 | CI |
| SC-8 | `MemberBoardPage` / `WorkflowBoardPage` 의 module 기반 동작 보존 | 수동 — 해당 페이지 진입 시 회귀 없음 |

---

## 5. Risks & Mitigations

| ID | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | 데이터 마이그레이션 시 module → service 매핑 실패 케이스가 많아 component=null 행이 다수 발생 | Medium | High | Phase B6 의 UI 가 component=null 을 "분류 미지정" 으로 노출하고 backfill 사후 UI 도구(`/settings/work-item-migration`) 를 제공할지는 Phase C 결정 사항으로 보류 |
| R-2 | ServiceEntry 와 WorkItem 둘 다 유지하면서 사용자가 같은 항목을 양쪽에 중복 등록 | Medium | Medium | Phase A4 의 "관련 업무로 연결" 액션으로 명시적 묶음을 권장. UI 안내 문구로 "이 service 에는 이미 N개 WorkItem 이 있습니다" 힌트 |
| R-3 | COMPONENT_BY_SERVICE 의 초기 enum 이 운영 현실과 안 맞아 자주 수정 | Low | Medium | frontend constant 로 시작 → 안정화 후 ui_settings(`/settings/service-catalog`) 의 component 편집 UI 로 이전 |
| R-4 | KnowledgeHubPage 의 5개 query 에 추가 service/component 필터가 cascade 되면 성능 저하 | Low | Low | 메모리 필터링이라 데이터 크기가 작은 한 영향 없음. 항목 1만+ 도달 시 서버 필터링 전환 |
| R-5 | typeLabel chip 활성화 조건이 복잡(`kind==='item' 일 때만`) — 사용자 혼란 | Low | Medium | Phase C3 의 chip 을 비활성 시 visible-but-disabled 로 표시 + 툴팁 "이슈/작업 필터링 시 사용" |
| R-6 | `WorkItem.module` 잔존이 운영자에게 두 번의 분류 선택을 강제 | Medium | Medium | Phase B 시점에 WorkItemForm 에서 module 필드를 "(legacy)" 표시 + service 가 입력되면 module 을 자동 추론. 별도 후속 PR 에서 deprecate |

---

## 6. Constraints

- **Constraint-1**: 백엔드 마이그레이션은 Alembic 미사용 — `backend/app/main.py:_run_migrations()` 에 `ALTER TABLE IF EXISTS / ADD COLUMN IF NOT EXISTS` 패턴 사용.
- **Constraint-2**: ESLint `max-warnings 0` 정책 유지.
- **Constraint-3**: 한국어 UI 텍스트 유지 (CLAUDE.md 의 디자인 컨벤션).
- **Constraint-4**: `MemberBoardPage` 에서 `tasks: filter(type==='task')` 의 한국어 라벨 "작업" 유지 (직전 commit `ef55620` 동결 사항).

---

## 7. Timeline (Phase-by-Phase)

| Phase | 작업 | 소요 (estimate) | 의존성 |
|---|---|---|---|
| **A** | A1-A4 (cross-view) | 3-5일 | 없음 — 기존 데이터 모델 그대로 활용 |
| **B** | B1-B7 (component 모델 + 마이그레이션) | 5-7일 | A 완료 권장 (cross-view 가 안정화된 후 컬럼 추가) |
| **C** | C1-C6 (drill-down + 필터) | 5-7일 | B 완료 필수 (component 컬럼 + COMPONENT_BY_SERVICE 가 있어야 UI 가능) |
| **R** | Release (lint+tsc+manual QA) | 1일 | A+B+C |

총 14-20일. 본 PDCA 사이클은 Phase A 만 우선 design/do 로 진행하고, Phase B/C 는 별도 PDCA 사이클(또는 sprint) 로 분리 권장.

---

## 8. Open Questions (Design 단계로 이월)

- **OQ-1**: cross-link 을 명시적 join 모델(`work_item_service_entry_links`) 로 만들지, 단순 `service` 일치 기준 dynamic fetch 로 갈지 — Design Phase 3 에서 결정.
- **OQ-2**: `module` 컬럼 deprecation 시점 — Phase B 이후 별도 PR.
- **OQ-3**: COMPONENT_BY_SERVICE 를 ui_settings 로 옮기는 시점 — Phase C 이후.
- **OQ-4**: WorkItemForm 에서 service 가 nullable 이라 component 도 자동 nullable — UX 적으로 service 를 강제할지 — Design 에서 결정.
- **OQ-5**: KnowledgeHubPage 의 typeLabel chip 5개를 service chip 12개와 같은 행에 놓을지, 별도 행으로 둘지 — Design 에서 결정.

---

## 9. PDCA Next Steps

- `/pdca design knowledge-workitem-linkage` 로 진행 → 3가지 architecture option(Minimal / Clean / Pragmatic) 제시 → Checkpoint 3 선택.
- Phase 분할 권장: design 문서에서 Phase A 만 Module Map 으로 깊이 정의, Phase B/C 는 high-level outline.
- 사용자 동의 시 `/pdca do knowledge-workitem-linkage --scope phase-a` 로 incremental 구현 시작.
