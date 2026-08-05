# CODE_MAP.md

빠른 탐색용 맵. 자세한 아키텍처는 [CLAUDE.md](./CLAUDE.md), 화면별 명세는 [docs/SCREENS.md](docs/SCREENS.md) 참고.

AI 어시스턴트 + 사람 개발자용 — 기능 → 파일 경로와 자주 하는 작업 레시피만 간결히.

> **동기화 검사**: CI 의 `docs-sync` job 이 `scripts/docs/check_docs_sync.py` 로
> 모든 라우터(`backend/app/routers/*.py`)와 페이지(`frontend/src/pages/*.tsx`)가
> 이 파일에 기재되어 있는지 검사한다. 파일 추가 시 해당 도메인 표에 한 줄 추가할 것.

---

## 📍 Feature → Files (핵심 매핑)

### 클러스터 관리
| 기능 | 백엔드 | 프론트엔드 |
|---|---|---|
| CRUD + 연결검증 + kubeconfig | `backend/app/routers/clusters.py` | `frontend/src/pages/ClusterManagePage.tsx` · `frontend/src/components/cluster-manage/` |
| 수정 페이지 (탭: 노드/CIDR/기타) | — | `frontend/src/pages/ClusterMetaFormPage.tsx` |
| kubeconfig 뷰/편집 모달 | `GET/PUT /clusters/{id}/kubeconfig` | `frontend/src/components/dashboard/KubeconfigEditModal.tsx` |
| 자동 업데이트 (k8s API) | `POST /clusters/{id}/auto-update` (clusters.py) | `clustersApi.autoUpdate` in `api.ts` |
| 버전/설정 스냅샷 수집 + 히스토리 | `backend/app/routers/versions.py` · model: `backend/app/models/config_snapshot.py` | `frontend/src/pages/VersionsPage.tsx` |
| 컴포넌트 관계 3D 그래프 | `GET /clusters/{id}/versions/graph` | `frontend/src/pages/VersionGraphPage.tsx` |
| 노드 일괄 SSH/SCP 실행 | `backend/app/routers/bulk_exec.py` + `backend/app/services/ssh_runner.py` (paramiko) + `services/script_wrap.py`(python 스크립트 → heredoc 래핑) | `frontend/src/pages/BulkExecPage.tsx` |
| 클러스터 노드 목록 조회 (선택용) | `GET /clusters/{id}/node-list` in `bulk_exec.py` | `bulkExecApi.nodeList` |
| 사용자별 저장 스크립트 (bulk-exec 재사용) | `backend/app/routers/saved_scripts.py` + `models/saved_script.py`(`SavedScript`, `username` 소유권) | `components/bulk-exec/{SavedScriptPanel,SavedScriptEditorModal}` + `hooks/useSavedScripts.ts` |
| etcdctl 원격 실행 + journal 로그 | `backend/app/routers/etcdctl.py` (SSH 경유, `/etc/etcd.env` source) | `frontend/src/pages/EtcdCtlPage.tsx` |
| mc (MinIO) 원격 실행 | `backend/app/routers/mc_client.py` | `frontend/src/pages/McClientPage.tsx` |
| OS / 커널 파라미터 조회 | bulk-exec 재사용 + 프리셋 라이브러리 | `frontend/src/pages/KernelParamsPage.tsx` |
| 공용 UI: 클러스터 좌측 사이드바 | — | `frontend/src/components/common/ClusterSidebar.tsx` |
| 공용 UI: 실행 확인 모달 | — | `frontend/src/components/common/ConfirmDialog.tsx` |
| 공용 UI: 로그 뷰어 (JSON/journal/table 자동감지) | — | `frontend/src/components/common/LogViewer.tsx` |
| 연결 검증 + status 반영 | `POST /clusters/{id}/verify` (clusters.py) | `clustersApi.verify` |
| Cilium 설정 조회 | `GET /clusters/{id}/cilium-config` | `CiliumConfigModal.tsx` |
| 클러스터 등록 위저드 (3-step) | — | `frontend/src/components/dashboard/AddClusterModal.tsx` |
| 클러스터 삭제 시 연관 데이터 정리 | `backend/app/services/cluster_purge.py` (cluster_id 보유 테이블 전수 탐색 — 삭제/보존 정책) | `SettingsPage.tsx` 삭제 버튼 |
| Cluster 모델 (ORM) | `backend/app/models/cluster.py` | `frontend/src/types/index.ts` (Cluster interface) |
| 경량 마이그레이션 | `_run_migrations()` in `backend/app/main.py` | — |

### Health Check / Addons
| 기능 | 위치 |
|---|---|
| 체커 인프라 (base + registry) | `backend/app/services/checkers/base.py` |
| 노드 체커 (전체 node 이름 반환) | `backend/app/services/checkers/node_checker.py` |
| 기타 체커 (etcd/control_plane/system_pod/nexus/jenkins/keycloak/argocd) | `backend/app/services/checkers/*_checker.py` |
| 체커 디스패처 + 상태 집계 | `backend/app/services/health_checker.py` |
| Addon CRUD + 수동 트리거 | `backend/app/routers/health.py` |
| Addon 카드 (dashboard) | `frontend/src/components/dashboard/AddonCard.tsx` |
| 새 체커 추가 레시피 | 아래 "Recipes" 섹션 참고 |

### 업무 관리 게시판 (이슈·작업 통합)
> 1.0 이후 기존 issues/tasks 가 **work_items 단일 모델로 통합**됨 (`WorkItem.type = task|issue|meeting|training|etc`).
> 레거시 `issues.py`/`tasks.py` 라우터·페이지는 제거됨.

| 기능 | 백엔드 | 프론트엔드 |
|---|---|---|
| 업무 CRUD + 상태/우선순위 + 서브업무 + CSV | `backend/app/routers/work_items.py` (`/work-items`) | 게시판: `frontend/src/pages/WorkItemBoardPage.tsx`, 등록: `tasks-mgmt/new` → `WorkItemFormPage.tsx`(`WorkItemForm.tsx`), 상세/수정: `WorkItemDetailPage.tsx` (`:id/edit` 는 상세 `?edit=1` 로 redirect) |
| 표 행(인라인 편집·시간옵션) / 칸반 / 캘린더 | — | `components/work-items/WorkItemTableRow.tsx` · `WorkItemKanban.tsx` · `WorkItemCalendar.tsx` |
| 상세 보기 / 댓글·활동 | — | `WorkItemReadView.tsx` · `CommentThread.tsx` · `ActivityTimeline.tsx` |
| 저장된 뷰(필터·정렬·보기 스냅샷, localStorage) | — | `components/work-items/SavedViews.tsx` |
| 사용자 정의 필드(custom_values) | `backend/app/routers/work_item_custom_fields.py` | `WorkItemCustomFieldsManager.tsx` |
| Jira 가져오기/양방향 반영 | `backend/app/routers/jira.py` (`/jira`) | `JiraImportModal.tsx` · `frontend/src/pages/JiraExcelImportPage.tsx` |
| Jira 원본 항목 매핑(Epic·Sub-task·component·label·상태) + 보존 규칙 | `services/jira_service.py` `map_jira_issue()`/`extract_epic_parts()`/`extract_confluence_url()` · `routers/jira.py` `_jira_sync_values()`/`_apply_jira_fields()` | `components/work-items/workItemColumns.ts` · `WorkItemTableRow.tsx` · `JiraIssueChip.tsx` · `DocLinkChip.tsx`(제목 옆 Confluence 링크 박스, 인라인 편집) |
| 업무 → Jira 이슈 + Confluence 문서 연계 생성 (Epic/Sub-task, 사용자별 조건 프리셋) | `routers/jira.py` `GET/POST /jira/provision*` (`user_settings` key=`jira_provision_preset`) | `components/work-items/JiraProvisionModal.tsx` |
| Jira+Confluence SSO 자동 로그인 / Confluence API | `backend/app/services/jira_sso_http.py`(다중 제품 폼 SSO) · `services/confluence_service.py` · `routers/jira.py` `/jira/sso/*`·`/jira/confluence/*` (401 자동 재로그인 포함) | `components/settings/JiraIntegrationPanel.tsx` |
| 주간보고 (월~금 집계 → 3개 표 → Confluence 게시) | `backend/app/services/weekly_report_service.py` · `routers/jira.py` `/jira/weekly-report/{preview,publish,settings}` · Celery `dispatch_weekly_report` | `frontend/src/pages/WeeklyReportPage.tsx` (`/weekly-report`) |
| Confluence 문서 가져오기/내보내기 + 문서 관리 대시보드 | `backend/app/routers/confluence.py` (`/confluence/docs/*` — dry-run import·export·pull·설정) · `services/confluence_storage.py`(storage↔에디터 HTML 변환) · `services/knowledge_search.py`(시맨틱 검색, `GET /work-guides/search`) | `frontend/src/pages/DocumentsPage.tsx` (`/documents`) · `components/documents/`(`ConfluenceImportModal`·`ConfluenceExportDialog`·`SyncStatusBadge`·설정 다이얼로그) · `hooks/useConfluenceDocs.ts` |
| PEP → Jira 신규 생성 / 삭제 | `routers/jira.py` `POST /jira/create` · `DELETE /jira/issue/{key}` · `services/jira_service.py` `create_issue()`/`delete_issue()` | `hooks/useJira.ts` |
| Jira 연결 복구 (해제·다른 이슈로 변경·죽은 링크 점검) | `routers/jira.py` `POST /jira/{unlink,relink,verify-links}/…` · `_clear_jira_link()`/`_parse_issue_key()` · `services/jira_service.py` `get_issue()` 404 `missing` 플래그 | `components/work-items/JiraLinkDialog.tsx` · `JiraImportModal.tsx`(연결 점검 탭) |
| 오늘 할일 / 멤버별 업무 | `work_items` 재사용 | `frontend/src/pages/TodoTodayPage.tsx` · `MemberBoardPage.tsx` |
| 스프린트 / 프로젝트 | `routers/sprint.py` (`/sprints`) · `routers/projects.py` (`/projects`) | `SprintsPage.tsx` 등 |
| 워크플로우 보드 / WBS·간트 | `backend/app/routers/workflows.py` | `frontend/src/pages/WorkflowBoardPage.tsx` · `WbsFlowPage.tsx` |
| 데이터 훅 | — | `frontend/src/hooks/useWorkItems.ts` · `useWorkItemCustomFields.ts` |

### PromQL / 메트릭 / AI Agent / 장애 분석
| 기능 | 위치 |
|---|---|
| PromQL 카드 CRUD + 쿼리 | `backend/app/routers/promql.py`, `backend/app/services/prometheus_service.py` |
| Prometheus 서비스 (fail-safe) | `backend/app/services/prometheus_service.py` |
| 메트릭 추이 | `backend/app/routers/metric_trend.py` · `cluster_trends.py` → `frontend/src/pages/ClusterTrendsPage.tsx` |
| **LLM 게이트웨이 (프로필 × 용도 라우팅)** | `backend/app/services/llm/` (`service.py` 게이트웨이 · `ollama_provider.py` · `openai_provider.py` · `prompts.py` 한국어 시스템 프롬프트 · `masking.py` 시크릿 마스킹) — 모든 LLM 호출의 단일 진입점, 사내 OpenAI-호환 LLM + 인클러스터 Ollama 병행 운용 |
| 무실행(No-Execution) 회귀 가드 | `backend/tests/test_no_execution_guard.py` — LLM 계열 ↔ 실행 계열(SSH/exec/playbook) 모듈 상호 import 금지 AST 검사 + `AnalysisResult` 필드 계약 |
| LLM 설정 (Settings → AI/LLM 탭) | `backend/app/routers/llm_settings.py` (AppSetting `llm_settings`) · `backend/app/models/llm_credential.py` (API 키 암호화 저장) → `frontend/src/components/settings/LlmSettingsTab.tsx` + `frontend/src/hooks/useLlmSettings.ts` |
| AI Agent (fail-safe, 게이트웨이 파사드) | `backend/app/routers/agent.py`, `backend/app/services/agent_service.py` |
| Agent 챗봇 UI (한국어·멀티턴·인용·정보요청·SSE 스트리밍) | `frontend/src/components/agent/AgentChat.tsx`(`streamChat` — 인증 fetch+reader SSE 소비, 실패 시 비스트리밍 폴백) · `InfoRequestChips.tsx` · `frontend/src/components/common/CitationList.tsx` |
| 챗 스트리밍 백엔드 | `POST /agent/chat/stream`(`routers/agent.py`) → `llm_service.chat_stream_for_purpose`(`services/llm/service.py`) → provider별 `chat_stream`(`ollama_provider.py` NDJSON, `openai_provider.py` SSE) |
| 챗 대화 지속성 | `backend/app/models/agent_conversation.py` + `routers/agent.py` `/agent/conversations*` |
| RAG 근거 인용 (사내 지식 pgvector 검색) | `backend/app/services/rag_service.py` (`GET /llm/rag-search`, `POST /llm/backfill-embeddings`) — work_guides/work_items/ops_notes/ontology_events(`compute_ontology_event_embedding`, `routers/ontology.py` 커밋 직후 큐잉) 임베딩 |
| LLM 정보요청 파서 (need_more_info) | `backend/app/services/llm/response_parser.py` |
| 알람/K8s 이벤트 AI 자동 분석 (scope·디바운스·llm 큐) | `backend/app/services/observability/analysis_hook.py`(`sources` 로 알람/K8s 이벤트 규칙 적용 범위 선택, 공유 디바운스 키) + `services/incident_context_builder.py` + `models/incident_analysis.py` + `celery_app.run_auto_incident_analysis`/`run_auto_incident_analysis_k8s_event`(전용 `llm` 큐, `k8s/base/celery/worker-llm-deployment.yaml`) → 공용 `frontend/src/components/common/IncidentAnalysisPanel.tsx`(래퍼: `components/observability/AlertAnalysisPanel.tsx`, `components/k8s/K8sEventAnalysisPanel.tsx`) |
| AI 장애 분석 (분석 전용) | `backend/app/routers/analyze.py` + `backend/app/services/analyzers/` (claude/local_llm/rule_based — 백엔드 선택은 `llm_settings.analyzer_backend`) → `frontend/src/pages/IncidentAnalysisPage.tsx` |
| 파드 로그 스트리밍 (SSE) | `analyze.py` 의 `/logs/stream` → `frontend/src/pages/K8sLogsPage.tsx` |
| 임베딩 (WorkItem/WorkGuide 유사 검색) | `backend/app/services/embedding_service.py` (pgvector, llm 게이트웨이 위임) |

### 모니터링 / 점검
| 기능 | 위치 |
|---|---|
| 홈(플랫폼 현황) + check-matrix | `backend/app/routers/check_matrix.py` + `services/check_matrix_service.py`(그리드/실행/수행로그) · `services/check_matrix_runbook.py`(셀별 실행 계획 — 실제 나가는 명령) + `models/check_matrix.py`(`CheckMatrixRun` 수행 로그 포함) → `frontend/src/pages/HomePage.tsx` + `components/platform-status/` (매뉴얼: `docs/CHECK_MATRIX_GUIDE.md`) |
| 클러스터 대시보드 | `backend/app/routers/daily_check.py` · `history.py` → `frontend/src/pages/Dashboard.tsx` (`/cluster-overview`) |
| 일일 점검 리뷰 | `daily_check.py` → `frontend/src/pages/DailyCheckReview.tsx` |
| Deep Check 정의/실행/수집 | `backend/app/routers/deep_check.py` · `deep_check_definitions.py`(정의별 이력/run/duplicate/preview) + `backend/app/services/deep_checkers/`(UI 정의형 `custom_http`·`custom_kubectl`·`custom_promql` 포함) → `frontend/src/pages/DeepCheckSettings.tsx` (+ `components/daily-check/DeepCheckRunHistory.tsx`) |
| 운영 점검 콘솔 | `backend/app/routers/ops_check.py` + `services/ops_check_service.py` → `frontend/src/pages/OpsCheckConsolePage.tsx` |
| K8s 실시간 이벤트 (kubewatch) | `backend/app/routers/k8s_events.py`(수신 직후 `analysis_hook.maybe_enqueue_analysis_for_k8s_event` 훅 + `/{id}/analysis`,`/analyze`) + `services/k8s_event_classifier.py` → `frontend/src/pages/K8sEventsPage.tsx` |
| Observability 지표 대시보드 (kube-prometheus-stack) | `backend/app/routers/observability.py` + `services/observability/catalog_seed.py` · `services/alertmanager_service.py` · `services/prometheus_service.py`(rules/targets/status) + `models/observability.py` → `frontend/src/pages/ObservabilityPage.tsx` + `components/observability/` |
| 인시던트 알람 수신 / 인박스 | `backend/app/routers/observability.py`(`ingest_router`) + `services/observability/alert_ingest.py`(Alertmanager v4 · generic 파서) · `alert_router.py`(라우팅·중복억제) + `models/alert_event.py` · `models/alert_notify_rule.py` → `frontend/src/pages/AlertInboxPage.tsx` |
| Pod 병목 진단 | `backend/app/routers/bottleneck.py` + `services/bottleneck_probes/` → `frontend/src/pages/PodBottleneckPage.tsx` · `PodBottleneckDetailPage.tsx` |

### K8s 운영 / 리소스
| 기능 | 위치 |
|---|---|
| 리소스 탐색(읽기전용, YAML/Secret 마스킹) | `backend/app/routers/k8s_resources.py` · `k8s_helm.py` · `k8s_exec.py` → `frontend/src/pages/K8sManagePage.tsx` |
| K8S 자원 관리(req/lim/use 랭킹) | `backend/app/routers/k8s_allocation.py` → `frontend/src/pages/K8sAllocationPage.tsx` |
| k9s 콘솔(control-plane SSH → 내장 k9s TUI 웹 스트리밍) | `backend/app/routers/k9s_ssh.py` (WebSocket) → `frontend/src/pages/K9sPage.tsx` · `frontend/src/pages/K9sPopupPage.tsx`(별도 창) · `frontend/src/components/k8s/K9sTerminal.tsx` · `frontend/src/lib/k9sPopout.ts`(창 간 handoff) |
| 노드 SSH 터미널(개별 노드 로그인 셸 웹 터미널) | `backend/app/routers/node_ssh.py` (WebSocket `/node-ssh/session` + REST `/node-ssh/test`) → `frontend/src/pages/NodeSshPage.tsx` · `frontend/src/pages/NodeSshPopupPage.tsx`(별도 창) · `frontend/src/components/k8s/NodeSshTerminal.tsx` · `frontend/src/lib/nodeSshPopout.ts` |
| ↑ 두 SSH 콘솔 공용 base 툴 | `backend/app/services/ssh_pty.py`(WS↔paramiko PTY 브리지·init 프레임·토큰 검증) + `ssh_runner.py`(TOFU 연결) → `frontend/src/components/k8s/SshTerminalWindow.tsx`(xterm 창) · `frontend/src/lib/terminalPopout.ts`(창 간 handoff) · `hooks/useTerminalAppearance.ts`(`useXtermTheme`) |
| 노드 라벨 / 노드 이미지 | `backend/app/routers/node_labels.py` · `node_images.py` → `frontend/src/pages/NodeLabelsPage.tsx` · `NodeImagesPage.tsx` |
| 주요 명령어 모음 | `backend/app/routers/commands.py` → `frontend/src/pages/CommandsPage.tsx` · `CommandFormPage.tsx` |
| Batch Jobs (cron) | `backend/app/routers/batch_jobs.py` + `services/batch_jobs/`(SSH: `etcdctl_defrag`/`shell_command`, non-SSH kubectl: `k8s_job_cleanup`; base.py 에 단계 trace `_step`/`_record_command`/`step_plan`) + `services/k8s_diagnose.py`(kubectl 실패 분류·연결 원인 힌트) → `frontend/src/pages/BatchJobsPage.tsx` |
| Ansible 자산 (파일/인벤토리) | `backend/app/routers/ansible_assets.py` |

### 네트워크 / 토폴로지 / 스토리지
| 기능 | 위치 |
|---|---|
| Cilium BPF Trace | `backend/app/routers/cilium_trace.py` + `services/cilium_trace_service.py` · `hubble_client.py` → `frontend/src/pages/CiliumTracePage.tsx` |
| 패킷 흐름 분석 | `backend/app/routers/topology_trace.py` + `services/tcpdump_runner.py` → `frontend/src/pages/PacketFlowPage.tsx` |
| 서비스 토폴로지 | `backend/app/routers/service_topology.py` → `frontend/src/pages/ServiceTopologyPage.tsx` |
| 서비스 아키텍처 문서 (자동생성·현행화) | `backend/app/routers/architecture_docs.py` + `services/architecture_doc_service.py` + `models/service_arch_doc.py` → `frontend/src/pages/ServiceArchitecturePage.tsx` + `components/serviceArch/` + `hooks/useArchDoc.ts` |
| 서비스 모듈 관계도 | — → `frontend/src/pages/ArchitecturePage.tsx` |
| 인프라 물리 토폴로지 | `backend/app/routers/infra_nodes.py` → `frontend/src/pages/InfraTopologyPage.tsx` |
| 노드 서버스펙 자산 대장 | `backend/app/routers/node_server_specs.py` → `frontend/src/pages/NodeSpecPage.tsx` |
| 관리 서버 대장 | `backend/app/routers/management_servers.py` |
| Isilon NFS 모니터링 | `backend/app/routers/isilon_nfs.py` + `services/isilon_service.py` → `frontend/src/pages/IsilonNfsPage.tsx` |
| CIDR 계산기 / 주요 링크 | — → `frontend/src/pages/CidrCalculatorPage.tsx` · `ClusterLinksPage.tsx` |

### 서비스 카탈로그 (LAKE / PEP / APP)
| 기능 | 위치 |
|---|---|
| LAKE 서비스 + 타입 | `backend/app/routers/lake_services.py` · `lake_service_types.py` + `services/lake_checkers/` → `frontend/src/pages/LakeServicesPage.tsx` · `LakeServiceDetailPage.tsx` |
| 서비스 카탈로그/허브 | `backend/app/routers/service_entries.py` · `service_categories.py` → `frontend/src/pages/ServicesCatalogPage.tsx` · `ServiceHubPage.tsx` · 아이콘/색상 출처는 PEP 서비스 타입(`hooks/useServiceCatalog.ts`) |
| PEP / APP 서비스 | `cluster_items` 등 재사용 → `frontend/src/pages/PepServicesPage.tsx` · `AppServicesPage.tsx` |
| 관리 서비스 설정 (admin) | Settings `?tab=mgmt-service` → `frontend/src/components/settings/ServiceCategoryManager.tsx`(카테고리) · `LakeServiceTypeManager.tsx`(서비스 타입), 둘 다 `domain` prop |
| 클러스터 아이템/커스텀 필드 | `backend/app/routers/cluster_items.py` · `cluster_custom_fields.py` |

### 지식 / 소통
| 기능 | 위치 |
|---|---|
| 지식 허브 | `backend/app/routers/work_guide.py` → `frontend/src/pages/KnowledgeHubPage.tsx` · `WorkGuidePage.tsx` |
| DevOps Q&A / 업무 메모 | `backend/app/routers/ops_note.py` → `frontend/src/pages/OpsNotesPage.tsx` · `OpsNoteDetailPage.tsx` · `OpsNoteFormPage.tsx` |
| 마인드맵 / 온톨로지 | `backend/app/routers/mindmap.py` · `ontology.py` → `frontend/src/pages/MindMapPage.tsx` · `OntologyPage.tsx` |
| 트렌드 다이제스트 | `backend/app/routers/trends.py` + `backend/app/services/trends/` (github/rss 수집 + summarizer) → `frontend/src/pages/TrendDigestPage.tsx` |
| 사용자 VOC 게시판 | `backend/app/routers/voc.py` → `VocBoardPanel` (사이드바 SidePane) |
| 공감(리액션) | `backend/app/routers/reactions.py` → `ReactionBar` |
| 릴리즈 노트 패널 | `backend/app/routers/release_notes.py` (CHANGELOG.md 파싱) → `ReleaseNotesPanel` |

### 인증 / 사용자 / 설정
| 기능 | 위치 |
|---|---|
| 로그인/JWT/사용자 관리 | `backend/app/routers/auth.py` → `frontend/src/pages/LoginPage.tsx` · `UsersPage.tsx` · `ChangePasswordPage.tsx` |
| 시스템 설정 (admin) | `backend/app/routers/ui_settings.py` · `terminal_appearance.py` → `frontend/src/pages/SettingsPage.tsx` |
| 감사 로그 | `backend/app/routers/audit_logs.py` + `services/audit_logger.py` (Settings 탭) |
| 인앱 알림 | `backend/app/routers/notifications.py` + `services/user_notify.py` |
| JSON 백업/복원 | `backend/app/routers/backup.py` + `services/backup_service.py` (Settings 탭) |
| 스키마 점검/복구 (모델↔DB 드리프트) | `backend/app/routers/schema_health.py` + `services/schema_health.py` → `frontend/src/components/settings/SchemaHealthPanel.tsx` (Settings ▸ 스키마 점검 탭). 부팅 안전망은 `main.py` 의 `_sync_missing_model_columns`(누락 컬럼) + `_relax_not_null_drift`(레거시 NOT NULL) |
| Your Island (사용자 커스텀 화면) | `backend/app/routers/island.py` + `models/island.py` → `frontend/src/pages/IslandPage.tsx` · `components/island/` (`panelRegistry.ts` = 임베드 가능 화면 등록부) · `hooks/useIslands.ts` · `hooks/useNavCatalog.ts` · `hooks/useClusterRouteParam.ts` + `lib/islandEmbed.ts` (임베드 시 URL 이동 억제) |

### Playbook / Ansible / 기타
| 기능 | 위치 |
|---|---|
| 플레이북 CRUD + 실행 | `backend/app/routers/playbooks.py`, `backend/app/services/playbook_executor.py` |
| 플레이북 페이지 | `frontend/src/pages/PlaybooksPage.tsx`, `frontend/src/components/playbooks/` |
| Ansible 플레이북 소스 | `ansible/playbooks/` |
| 일일 점검 (Celery) | `backend/app/services/daily_checker.py`, `backend/app/celery_app.py` |
| 트렌드 다이제스트 | `backend/app/services/trends/trend_service.py`, `frontend/src/pages/TrendDigestPage.tsx` |
| 온톨로지 그래프 | `backend/app/routers/ontology.py` 외, `frontend/src/pages/OntologyPage.tsx` |

### 공통 UI / 인프라
| 기능 | 위치 |
|---|---|
| 테마 / CSS 변수 | `frontend/src/index.css` (`:root`, `html.light`, `html.dark`) |
| MacCard 공통 컴포넌트 | `frontend/src/components/ui/MacCard.tsx` |
| Sidebar + 네비 설정 | `frontend/src/components/layout/Sidebar.tsx` (`NAV_MAP`/`GROUPS` 는 `navConfig.ts` 로 분리) |
| 라우팅 | `frontend/src/App.tsx` |
| Axios API 클라이언트 | `frontend/src/services/api.ts` (snake_case→camelCase 자동 변환) |
| TanStack Query 훅 | `frontend/src/hooks/use*.ts` |
| 공유 타입 | `frontend/src/types/index.ts` |

---

## 🍳 Recipes (자주 하는 작업)

### 새 백엔드 엔드포인트 추가
1. `backend/app/routers/<module>.py`에 `APIRouter` 핸들러 작성
2. `backend/app/routers/__init__.py`에서 re-export
3. `backend/app/main.py`에서 `app.include_router(..., prefix="/api/v1")`
4. Pydantic 스키마가 필요하면 `backend/app/schemas/`에 추가

### 새 프론트 페이지 추가
1. `frontend/src/pages/FooPage.tsx` 생성
2. `frontend/src/App.tsx`에 `<Route path="/foo" element={<FooPage />} />` 추가
3. Sidebar 메뉴 필요 시 `frontend/src/components/layout/navConfig.ts`의 NAV_MAP 업데이트
4. 서버 데이터는 `frontend/src/hooks/use*.ts`에 TanStack Query 훅으로, 클라이언트 상태는 `frontend/src/stores/`에 Zustand로

### 새 Cluster 컬럼 추가 (DB 마이그레이션)
1. `backend/app/models/cluster.py`에 `Column(...)` 추가
2. `backend/app/main.py` `_run_migrations()`의 `new_cluster_cols` 리스트에 `(col_name, col_type)` 추가
3. `backend/app/schemas/cluster.py` `ClusterBase` / `ClusterManageUpdate`에 필드 추가
4. 프론트 `frontend/src/types/index.ts` `Cluster`/`ClusterManageUpdate`에 필드 추가
5. 수정 폼 `frontend/src/pages/ClusterMetaFormPage.tsx`에 입력 필드 추가

### 새 Health Checker 추가
1. `backend/app/services/checkers/my_checker.py` — `BaseChecker` 상속, `check()` 구현
2. `backend/app/services/checkers/__init__.py`의 `CHECKER_REGISTRY`에 타입 문자열 매핑
3. 프론트 `frontend/src/components/dashboard/AddonCard.tsx`에서 `AddonDetails`에 `case 'my-type':` 추가
4. 결과 필드가 있으면 `details` JSONB에 추가 (camelCase 변환 자동)

### 모달 대신 페이지 변환 (Issue/Task/Cluster 스타일)
- 기존 모달을 `FooFormPage.tsx`로 이관, `useParams<{ id: string }>()` + `useNavigate()` 사용
- 목록 캐시(`useXxx()`)에서 `id`로 find — 별도 GET 엔드포인트 없이도 edit 모드 가능
- `App.tsx`에 `/foo/new`, `/foo/:id/edit` 라우트 추가
- 목록 페이지에서 모달 trigger를 `navigate('/foo/new')` / `navigate(\`/foo/\${id}/edit\`)`로 교체

---

## 🚦 Status 용어 (일관성)

| StatusEnum | 의미 | Dashboard 라벨 | 색상 |
|---|---|---|---|
| `healthy` | 전체 정상 | 정상 | 초록 |
| `warning` | 일부 경고 | 경고 | 노랑 |
| `critical` | 일부 addon 심각 (연결은 됨) | 위험 | 빨강 |
| `pending` | 아직 연결 미확인 / 연결 실패 | **미연결** | 회색 |

"연결 실패"는 `critical`이 아닌 `pending`으로 씁니다 (verify 엔드포인트에서 설정). `critical`은 API 서버가 살아있지만 내부 addon 중 일부가 심각할 때만.

---

## 🧪 Test / Verify 명령

```bash
# Frontend
cd frontend && npm run lint                      # ESLint (warnings 0 enforced)
cd frontend && node node_modules/typescript/bin/tsc --noEmit
cd frontend && npm run build

# Backend
cd backend && pytest -v                          # 요구: Postgres 실행 중
cd backend && python3 -c "import ast; ast.parse(open('app/routers/clusters.py').read())"  # 빠른 syntax 체크

# Full stack (docker-compose)
docker-compose up -d
# Frontend: http://localhost:5173  Backend: http://localhost:8000/docs
```

---

## 📝 맵 관리 정책

- 이 파일은 **파일 추가/삭제/주요 리네이밍 시** 업데이트.
- 아키텍처/규약 변경은 [CLAUDE.md](./CLAUDE.md)에 기록, 이 파일은 경로 참조만.
- 낡은 정보는 해가 되므로 불확실하면 CLAUDE.md를 신뢰.
