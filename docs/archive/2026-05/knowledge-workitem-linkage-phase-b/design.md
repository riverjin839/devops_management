# knowledge-workitem-linkage-phase-b Design Document

> **Summary**: WorkItem.component 컬럼 + service별 enum + cascade. Pragmatic option 자율 선택.
>
> **Date**: 2026-05-20
> **Planning Doc**: [phase-b.plan.md](../../01-plan/features/knowledge-workitem-linkage-phase-b.plan.md)

---

## Context Anchor (Plan copy)

| Key | Value |
|---|---|
| **WHY** | service 단위는 광범위 — k8s 만 해도 6+ core component, "어디서 발생했는지" 즉시 못 봄 |
| **WHO** | k8s/cilium 등 대형 service 의 component 별 운영자 |
| **RISK** | module→service 자동 매핑 실패 / enum 부족 / backfill 중복 적용 |
| **SUCCESS** | component 컬럼 + index / Form cascade / idempotent backfill / 회귀 0 |
| **SCOPE** | B1-B8 |

---

## 1. Architecture Options

| Option | 접근 | 변경 파일 | 평가 |
|---|---|---|---|
| **A — Minimal** | model 컬럼만 추가 + 직접 입력 input (dropdown 없음) | 3 (model + migration + types) | Form UX 빈약, 자율 enum 활용 불가 |
| **B — Clean** | 신규 hooks `useComponentsByService` + 신규 컴포넌트 `ComponentSelect` + ui_settings 화 | 8 | Phase B 수준에 과투자 (Phase C 도 안 했는데 미리 추상화) |
| **C — Pragmatic** ✅ | model + migration + COMPONENT_BY_SERVICE constant + WorkItemForm 인라인 cascade (분리 컴포넌트 없음) + backfill 1회성 함수 | 6 | Phase B 의 정확한 fit. enum 은 frontend constant 로 시작, 향후 ui_settings 화 |

**Decision (자율)**: Option C.

---

## 2. Module Map

| Module | Files | LoC |
|---|---|---|
| M1 — Backend model | `backend/app/models/work_item.py` (+1 line) | +1 |
| M2 — Backend migration | `backend/app/main.py` (_run_migrations + _backfill_work_items_service_from_module) | +25 |
| M3 — Backend schema/router | `backend/app/schemas/work_item.py` + `backend/app/routers/work_items.py` (CSV 포함) | +5 |
| M4 — Frontend constant | `frontend/src/components/services/serviceCatalog.ts` (+COMPONENT_BY_SERVICE) | +45 |
| M5 — Frontend type | `frontend/src/types/index.ts` (WorkItem/Create/Update) | +3 |
| M6 — Frontend Form | `frontend/src/components/work-items/WorkItemForm.tsx` (cascade) | +30 |

---

## 3. COMPONENT_BY_SERVICE (확정 enum)

```ts
export const COMPONENT_BY_SERVICE: Record<string, readonly string[]> = {
  k8s:        ['api-server', 'scheduler', 'etcd', 'controller-manager', 'kubelet', 'kube-proxy', 'coredns'],
  keycloak:   ['realm', 'client', 'identity-provider', 'mapper', 'theme', 'event'],
  nexus:      ['repository', 'routing-rule', 'cleanup-policy', 'task', 'user', 'role'],
  jenkins:    ['pipeline', 'agent', 'credential', 'plugin', 'job'],
  argocd:     ['application', 'project', 'repo', 'sync-wave', 'notification'],
  cilium:     ['agent', 'operator', 'hubble', 'policy', 'bgp', 'ipam'],
  prometheus: ['server', 'alertmanager', 'exporter', 'rule', 'target'],
  grafana:    ['dashboard', 'datasource', 'alert', 'plugin', 'org'],
  etcd:       ['leader', 'member', 'snapshot', 'defrag', 'compaction'],
  hubble:     ['relay', 'ui', 'flow', 'metric'],
  ingress:    ['controller', 'rule', 'tls', 'rate-limit'],
  storage:    ['pv', 'pvc', 'storage-class', 'snapshot'],
  other:      [],
};
```

---

## 4. Backfill 매핑 (확정)

```sql
-- Idempotent: 이미 service 가 있는 행은 건드리지 않음.
UPDATE work_items
SET service =
  CASE module
    WHEN 'monitoring' THEN 'prometheus'
    WHEN 'infra'      THEN 'etcd'
    WHEN 'backend'    THEN NULL  -- skip (서비스 아님)
    WHEN 'frontend'   THEN NULL  -- skip
    ELSE module
  END
WHERE service IS NULL
  AND module IS NOT NULL
  AND module NOT IN ('backend', 'frontend');
```

Python 함수 형태로 main.py 의 startup 에서 1회 호출. 로깅: `[backfill] {N} rows: module → service`.

---

## 5. WorkItemForm cascade (의사 코드)

```tsx
const [service, setService] = useState(initial?.service ?? '');
const [component, setComponent] = useState(initial?.component ?? '');

const components = service ? COMPONENT_BY_SERVICE[service] ?? [] : [];

// service 변경 시 component reset
const handleServiceChange = (next: string) => {
  setService(next);
  setComponent(''); // cascade reset (FR-3)
};

// dropdown 렌더링
<select value={service} onChange={(e) => handleServiceChange(e.target.value)}>
  <option value="">서비스 선택...</option>
  {SERVICE_CATALOG.map(...)}
</select>

{service && (
  <select value={component} onChange={(e) => setComponent(e.target.value)}>
    <option value="">— component 선택 (선택) —</option>
    {components.map(c => <option key={c} value={c}>{c}</option>)}
    <option value="__custom__">직접 입력...</option>
  </select>
)}

{component === '__custom__' && (
  <input type="text" placeholder="component 이름" onChange={...} />
)}
```

---

## 6. Architecture Decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | `String(64)` + nullable + index | service 와 동일 정책, FR-1 |
| AD-2 | COMPONENT_BY_SERVICE 는 frontend constant | Plan FR-2, 향후 ui_settings 이전 여지 |
| AD-3 | "직접 입력" escape hatch 제공 | R-3 mitigation |
| AD-4 | backfill 은 main.py startup 에서 1회 호출, idempotent | FR-5, NFR-2 |
| AD-5 | module 컬럼 보존 + Form 에 "(legacy)" | Q4 합의, R 없음 |
| AD-6 | Phase A 의 cross-view 컴포넌트는 그대로 — component 필터링은 Phase C 외 | scope 명확화 |

---

## 7. Test Plan

- L1 API: `POST /work-items {service: 'k8s', component: 'api-server', ...}` → 201 + DB 확인.
- L1 API: `GET /work-items/:id` → response 에 component 필드 포함.
- L1 API: backend 재시작 후 `SELECT count(*) FROM work_items WHERE service IS NOT NULL` 가 backfill 전후 증가.
- L1 API: backend 재기동 ×2 후 카운트 동일 (idempotent).
- L2 UI: WorkItemForm 에서 service='k8s' 선택 → component dropdown 에 7개 옵션 노출.
- L2 UI: service 'k8s' → 'keycloak' 변경 시 component 가 ''로 reset.
- L2 UI: component='__custom__' 선택 시 input 노출, 입력 가능.
- 회귀: MemberBoardPage 의 `bucket.tasks` 정상, WorkflowBoardPage 의 task/issue 분기 정상.
