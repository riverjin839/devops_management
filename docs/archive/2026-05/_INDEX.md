# 2026-05 Archive Index

| Feature | Phase | Match Rate (range) | Carry Items | Documents |
|---|---|---|---|---|
| [knowledge-workitem-linkage](./knowledge-workitem-linkage/) | A (cross-view) | 100% / 62.5% (overall) | Phase B (component 모델) · Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage/plan.md) · [design](./knowledge-workitem-linkage/design.md) · [analysis](./knowledge-workitem-linkage/analysis.md) · [report](./knowledge-workitem-linkage/report.md) |
| [knowledge-workitem-linkage-phase-b](./knowledge-workitem-linkage-phase-b/) | B (component 모델) | 100% (코드 레벨) | Phase C (drill-down 필터) | [plan](./knowledge-workitem-linkage-phase-b/plan.md) · [design](./knowledge-workitem-linkage-phase-b/design.md) · [analysis](./knowledge-workitem-linkage-phase-b/analysis.md) · [report](./knowledge-workitem-linkage-phase-b/report.md) |
| [cluster-detail-monitoring](./cluster-detail-monitoring/) | Reverse PDCA + Iterate-1 | 81% → 94% (정적), QA_SKIP (환경 미충족) | G-4 · G-8 · U-6 · U-7 · U-8 (별도 PDCA 권장) | [plan](./cluster-detail-monitoring/plan.md) · [design](./cluster-detail-monitoring/design.md) · [analysis](./cluster-detail-monitoring/analysis.md) · [report](./cluster-detail-monitoring/report.md) · [qa-report](./cluster-detail-monitoring/qa-report.md) |
| [work-mgmt-enterprise-audit](./work-mgmt-enterprise-audit/) | Reverse PDCA + Iterate-1 (7 surface, 4-axis) | 51% → 82% (정적), QA_SKIP | CO-1~7 (assignee FK, cluster_name sync, PII, sidebar, widgets, adjacent pages, aria 전수) | [plan](./work-mgmt-enterprise-audit/plan.md) · [design](./work-mgmt-enterprise-audit/design.md) · [analysis](./work-mgmt-enterprise-audit/analysis.md) · [report](./work-mgmt-enterprise-audit/report.md) · [qa-report](./work-mgmt-enterprise-audit/qa-report.md) |
| [lake-service-monitoring](./lake-service-monitoring/) | **Fresh PDCA** (신규 개발) — LAKE OSS 8개 monitoring | 95% (정적 + lint/tsc PASS), QA_SKIP | CO-1~6 (airflow 외 7 deep checker, troubleshoot actions, AI advisor, metrics 시계열, scheduled check, RBAC) | [plan](./lake-service-monitoring/plan.md) · [design](./lake-service-monitoring/design.md) · [report](./lake-service-monitoring/report.md) · [qa-report](./lake-service-monitoring/qa-report.md) |

## Carry-over Reference (별도 PDCA 사이클로 이어짐)

- **knowledge-services-coherence** — 직전 분석 보고서 (`docs/03-analysis/knowledge-services-coherence.analysis.md`). knowledge-workitem-linkage 의 upstream 으로 보존.
- **knowledge-workitem-linkage-phase-b** — Plan §7 Carry: WorkItem.component 컬럼 + COMPONENT_BY_SERVICE constant + 마이그레이션.
- **knowledge-workitem-linkage-phase-c** — Plan §7 Carry: KnowledgeHub/WorkItemBoard 의 service/component/typeLabel chip 도입.
- **resource-summary-disposition** — cluster-detail-monitoring G-4 carry: `DailyCheckLog.resource_summary` dead column 활용 or 제거 결정.
- **deep-check-log-matching** — cluster-detail-monitoring G-8 carry: deep check 가 stale daily log 와 묶이는 race 정책 (오늘 + 같은 schedule_type 만 후보).
- **monitoring-information-architecture** — cluster-detail-monitoring U-6 carry: Dashboard 카드 ↔ 리뷰 페이지 IA 재설계.
- **realtime-progress-feedback** — cluster-detail-monitoring U-7 carry: Deep/Daily Check 진행률 SSE/WebSocket.
- **notification-scope-clarification** — cluster-detail-monitoring U-8 carry: NotificationSettingsPanel 글로벌/클러스터 라벨링.
- **assignee-user-fk-migration** — work-mgmt CO-1: WorkItem.assignee 자유텍스트 → User FK 마이그레이션.
- **denormalized-sync-policy** — work-mgmt CO-2: cluster_name 동기화 (trigger 또는 view).
- **pii-masking-policy** — work-mgmt CO-3: assignee 이름 마스킹 비즈니스 정책 결정.
- **cluster-sidebar-coverage** — work-mgmt CO-4: TodoToday/Detail/Form/Member 의 ClusterSidebar 적용 의도.
- **work-mgmt-dashboard-widgets** — Plan v1→v2 축소 시 분리: KanbanSummaryCharts 등 5 위젯.
- **work-mgmt-adjacent-pages** — 동상: /ops-notes, /wbs, /mindmap, /incident-analysis, /workflow.
- **lake-airflow-deep-check** + **lake-{서비스}-deep-check** — lake-service-monitoring CO-1: airflow 외 7개 서비스 deep checker.
- **lake-troubleshoot-actions** — lake CO-2: 가이드 read-only → 표준 명령 자동 실행.
- **lake-ai-advisor** — lake CO-3: Ollama 기반 next-action 추천.
- **lake-metrics-timeseries** — lake CO-4: Prometheus 통합 시계열.
- **lake-service-scheduled-check** — lake CO-5: Celery Beat 주기 점검.
- **lake-service-rbac** — lake CO-6: viewer/operator/admin 권한 분리.
