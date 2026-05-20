# 2026-05 Archive Index

| Feature | Phase | Match Rate (range) | Carry Items | Documents |
|---|---|---|---|---|
| [knowledge-workitem-linkage](./knowledge-workitem-linkage/) | A (cross-view) | 100% / 62.5% (overall) | Phase B (component 모델) · Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage/plan.md) · [design](./knowledge-workitem-linkage/design.md) · [analysis](./knowledge-workitem-linkage/analysis.md) · [report](./knowledge-workitem-linkage/report.md) |
| [knowledge-workitem-linkage-phase-b](./knowledge-workitem-linkage-phase-b/) | B (component 모델) | 100% (코드 레벨) | Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage-phase-b/plan.md) · [design](./knowledge-workitem-linkage-phase-b/design.md) · [analysis](./knowledge-workitem-linkage-phase-b/analysis.md) · [report](./knowledge-workitem-linkage-phase-b/report.md) |

## Carry-over Reference (별도 PDCA 사이클로 이어짐)

- **knowledge-services-coherence** — 직전 분석 보고서 (`docs/03-analysis/knowledge-services-coherence.analysis.md`). knowledge-workitem-linkage 의 upstream 으로 보존.
- **knowledge-workitem-linkage-phase-b** — Plan §7 Carry: WorkItem.component 컬럼 + COMPONENT_BY_SERVICE constant + 마이그레이션.
- **knowledge-workitem-linkage-phase-c** — Plan §7 Carry: KnowledgeHub/WorkItemBoard 의 service/component/typeLabel chip 도입.
