# CODE_MAP.md

빠른 탐색용 맵. 자세한 아키텍처는 [CLAUDE.md](./CLAUDE.md) 참고.

AI 어시스턴트 + 사람 개발자용 — 기능 → 파일 경로와 자주 하는 작업 레시피만 간결히.

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
| 노드 일괄 SSH/SCP 실행 | `backend/app/routers/bulk_exec.py` + `backend/app/services/ssh_runner.py` (paramiko) | `frontend/src/pages/BulkExecPage.tsx` |
| 클러스터 노드 목록 조회 (선택용) | `GET /clusters/{id}/node-list` in `bulk_exec.py` | `bulkExecApi.nodeList` |
| etcdctl 원격 실행 + journal 로그 | `backend/app/routers/etcdctl.py` (SSH 경유, `/etc/etcd.env` source) | `frontend/src/pages/EtcdCtlPage.tsx` |
| mc (MinIO) 원격 실행 | `backend/app/routers/mc_client.py` | `frontend/src/pages/McClientPage.tsx` |
| OS / 커널 파라미터 조회 | bulk-exec 재사용 + 프리셋 라이브러리 | `frontend/src/pages/KernelParamsPage.tsx` |
| 공용 UI: 클러스터 좌측 사이드바 | — | `frontend/src/components/common/ClusterSidebar.tsx` |
| 공용 UI: 실행 확인 모달 | — | `frontend/src/components/common/ConfirmDialog.tsx` |
| 공용 UI: 로그 뷰어 (JSON/journal/table 자동감지) | — | `frontend/src/components/common/LogViewer.tsx` |
| 연결 검증 + status 반영 | `POST /clusters/{id}/verify` (clusters.py) | `clustersApi.verify` |
| Cilium 설정 조회 | `GET /clusters/{id}/cilium-config` | `CiliumConfigModal.tsx` |
| 클러스터 등록 위저드 (3-step) | — | `frontend/src/components/dashboard/AddClusterModal.tsx` |
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
| 업무 CRUD + 상태/우선순위 + 서브업무 + CSV | `backend/app/routers/work_items.py` (`/work-items`) | 게시판: `frontend/src/pages/WorkItemBoardPage.tsx`, 등록/수정: `tasks-mgmt/new\|:id/edit` → `WorkItemForm.tsx` |
| 표 행(인라인 편집·시간옵션) / 칸반 / 캘린더 | — | `components/work-items/WorkItemTableRow.tsx` · `WorkItemKanban.tsx` · `WorkItemCalendar.tsx` |
| 상세 보기 / 댓글·활동 | — | `WorkItemReadView.tsx` · `CommentThread.tsx` · `ActivityTimeline.tsx` |
| 저장된 뷰(필터·정렬·보기 스냅샷, localStorage) | — | `components/work-items/SavedViews.tsx` |
| 사용자 정의 필드(custom_values) | `backend/app/routers/work_item_custom_fields.py` | `WorkItemCustomFieldsManager.tsx` |
| Jira 가져오기 | `backend/app/routers/jira.py` (`/jira`) | `JiraImportModal.tsx` |
| 오늘 할일 / 멤버별 업무 | `work_items` 재사용 | `frontend/src/pages/TodoTodayPage.tsx` · `MemberBoardPage.tsx` |
| 스프린트 / 프로젝트 | `routers/sprint.py` (`/sprints`) · `routers/projects.py` (`/projects`) | `SprintsPage.tsx` 등 |
| 데이터 훅 | — | `frontend/src/hooks/useWorkItems.ts` · `useWorkItemCustomFields.ts` |

### PromQL / 메트릭 / AI Agent
| 기능 | 위치 |
|---|---|
| PromQL 카드 CRUD + 쿼리 | `backend/app/routers/promql.py`, `backend/app/services/prometheus_service.py` |
| Prometheus 서비스 (fail-safe) | `backend/app/services/prometheus_service.py` |
| Ollama AI Agent (fail-safe) | `backend/app/routers/agent.py`, `backend/app/services/agent_service.py` |
| Agent 사이드바 UI | `frontend/src/components/agent/AgentChat.tsx` |

### Playbook / Ansible / 기타
| 기능 | 위치 |
|---|---|
| 플레이북 CRUD + 실행 | `backend/app/routers/playbooks.py`, `backend/app/services/playbook_executor.py` |
| 플레이북 페이지 | `frontend/src/pages/PlaybooksPage.tsx`, `frontend/src/components/playbooks/` |
| Ansible 플레이북 소스 | `ansible/playbooks/` |
| 일일 점검 (Celery) | `backend/app/services/daily_checker.py`, `backend/app/celery_app.py` |
| 트렌드 다이제스트 | `backend/app/services/trend_service.py`, `frontend/src/pages/TrendDigestPage.tsx` |
| 온톨로지 그래프 | `backend/app/routers/ontology.py` 외, `frontend/src/pages/OntologyPage.tsx` |

### 공통 UI / 인프라
| 기능 | 위치 |
|---|---|
| 테마 / CSS 변수 | `frontend/src/index.css` (`:root`, `html.light`, `html.dark`) |
| MacCard 공통 컴포넌트 | `frontend/src/components/ui/MacCard.tsx` |
| Sidebar + 네비 설정 | `frontend/src/components/layout/Sidebar.tsx` |
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
3. Sidebar 메뉴 필요 시 `frontend/src/components/layout/Sidebar.tsx`의 NAV_MAP 업데이트
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
