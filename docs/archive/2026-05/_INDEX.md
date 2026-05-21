# 2026-05 Archive Index

| Feature | Phase | Match Rate (range) | Carry Items | Documents |
|---|---|---|---|---|
| [knowledge-workitem-linkage](./knowledge-workitem-linkage/) | A (cross-view) | 100% / 62.5% (overall) | Phase B (component 모델) · Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage/plan.md) · [design](./knowledge-workitem-linkage/design.md) · [analysis](./knowledge-workitem-linkage/analysis.md) · [report](./knowledge-workitem-linkage/report.md) |
| [knowledge-workitem-linkage-phase-b](./knowledge-workitem-linkage-phase-b/) | B (component 모델) | 100% (코드 레벨) | Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage-phase-b/plan.md) · [design](./knowledge-workitem-linkage-phase-b/design.md) · [analysis](./knowledge-workitem-linkage-phase-b/analysis.md) · [report](./knowledge-workitem-linkage-phase-b/report.md) |
| [cluster-detail-monitoring](./cluster-detail-monitoring/) | Reverse PDCA + Iterate-1 | 81% → 94% (정적), QA_SKIP (환경 미충족) | G-4 · G-8 · U-6 · U-7 · U-8 (별도 PDCA 권장) | [plan](./cluster-detail-monitoring/plan.md) · [design](./cluster-detail-monitoring/design.md) · [analysis](./cluster-detail-monitoring/analysis.md) · [report](./cluster-detail-monitoring/report.md) · [qa-report](./cluster-detail-monitoring/qa-report.md) |

## Carry-over Reference (별도 PDCA 사이클로 이어짐)

- **knowledge-services-coherence** — 직전 분석 보고서 (`docs/03-analysis/knowledge-services-coherence.analysis.md`). knowledge-workitem-linkage 의 upstream 으로 보존.
- **knowledge-workitem-linkage-phase-b** — Plan §7 Carry: WorkItem.component 컬럼 + COMPONENT_BY_SERVICE constant + 마이그레이션.
- **knowledge-workitem-linkage-phase-c** — Plan §7 Carry: KnowledgeHub/WorkItemBoard 의 service/component/typeLabel chip 도입.
- **resource-summary-disposition** — cluster-detail-monitoring G-4 carry: `DailyCheckLog.resource_summary` dead column 활용 or 제거 결정.
- **deep-check-log-matching** — cluster-detail-monitoring G-8 carry: deep check 가 stale daily log 와 묶이는 race 정책 (오늘 + 같은 schedule_type 만 후보).
- **monitoring-information-architecture** — cluster-detail-monitoring U-6 carry: Dashboard 카드 ↔ 리뷰 페이지 IA 재설계.
- **realtime-progress-feedback** — cluster-detail-monitoring U-7 carry: Deep/Daily Check 진행률 SSE/WebSocket.
- **notification-scope-clarification** — cluster-detail-monitoring U-8 carry: NotificationSettingsPanel 글로벌/클러스터 라벨링.
