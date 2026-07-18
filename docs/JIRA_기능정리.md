# DevOps Management — Jira 등록용 주요 기능 정리

> 작성일: 2026-05-12 (**시점 스냅샷** — v1.0 이전 기준. 이후 라우트/구조가 다수 변경됐다.
> Epic/Story 뼈대 참고용으로만 쓰고, 최신 화면/API 는 [SCREENS.md](SCREENS.md) ·
> [CODE_MAP.md](../CODE_MAP.md) 를 신뢰할 것 — 예: 아래 EPIC 2의 `/issues`·`/work-summary`
> 는 현재 `WorkItem` 단일 모델(`/tasks-mgmt`)로 통합됐고, 점검 스케줄은 09/13/18 고정이
> 아니라 check-matrix cron 디스패처로 대체됐다.)
> 대상: Jira Epic/Story 등록을 위한 현행 기능 목록
> 범위: 작성 시점 기준 (총 43개 라우트 / 36개 라우터 / 27개 모델). **v1.6.0 현재는
> 라우터 62개 / 모델 49개 / 페이지 63개** — CLAUDE.md 참고.
>
> ℹ️ 이 문서는 **PEP 자체 기능을 Jira 티켓으로 등록**하기 위한 카탈로그이며, PEP 의
> **Jira 연동(외부 시스템 통합) 기능**을 다루지 않는다. Jira 연동 기능은 문서 하단
> "PEP ↔ Jira 연동 기능" 절 참고.

---

## 사용법

본 문서는 Jira 등록 시 **Epic → Story** 구조로 그대로 옮길 수 있도록 작성되었습니다.

- **Epic** = 사이드바 그룹 또는 기능군 (예: "클러스터 관리")
- **Story** = 개별 페이지/기능 단위
- 각 Story 는 한 줄 요약 + 주요 동작 + 관련 API/엔드포인트 + 우선순위 라벨을 포함
- 라벨: `[P0]` 핵심, `[P1]` 주요, `[P2]` 보조, `[NEW]` 최근 추가

---

## EPIC 1. 대시보드 & 모니터링

핵심 운영 현황을 한눈에 보여주는 진입 페이지군.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 메인 대시보드 | 클러스터 상태 요약, PromQL 메트릭 카드, 작업/이슈 현황, 최근 점검 이력 | `/` | `/clusters`, `/daily-check/summary`, `/promql/query/all` | P0 |
| 오늘의 할일 (Todo Today) | 사용자별 오늘자 작업 체크리스트와 우선순위 | `/todo-today` | `/tasks?dueDate=today` | P1 |
| 업무 요약 (Work Summary) | 멤버/주차별 작업 완료 통계와 워크로드 | `/work-summary` | `/tasks/summary` | P1 |
| 매일 점검 결과 | API server / components / nodes / system-pods 점검 결과 (09:00 / 13:00 / 18:00 KST Celery Beat) | 대시보드 임베드 | `/daily-check/results/{cluster_id}` | P0 |
| PromQL 메트릭 카드 | 사용자 정의 PromQL 쿼리 카드 (value/gauge/list 표시, threshold 기반 색상) | 대시보드 임베드 | `/promql/cards`, `/promql/query/{card_id}` | P0 |

---

## EPIC 2. 작업 / 이슈 관리

운영 이슈와 작업 티켓을 추적·할당하는 게시판군.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 이슈 관리 게시판 (테이블 + 칸반) | 이슈 등록/조회/삭제, 셀 단위 인라인 편집, CSV 추출, 정렬/필터/드래그 정렬 | `/issues`, `/issues/new`, `/issues/:id`, `/issues/:id/edit` | `/issues`, `/issues/export/csv` | P0 `[NEW]` 인라인 편집 |
| 작업 게시판 (Task Board) | 칸반/테이블 토글, 상태(backlog/todo/in_progress/review_test/done), 모듈별 분류 | `/tasks`, `/tasks/new`, `/tasks/:id` | `/tasks` | P0 |
| 멤버별 업무 (Member Board) | 담당자별 할당 작업/이슈 집계 및 워크로드 시각화 | `/members` | `/tasks?assignee=`, `/issues?assignee=` | P1 |
| Playbook 보드 | 클러스터별 Ansible Playbook 실행/이력 (대시보드 노출 토글) | `/playbooks` | `/playbooks`, `/playbooks/{id}/run` | P1 |

**공통 동작**
- 이슈/작업 모두 `정/부 담당자`, 클러스터/서비스 태그 지원
- 리치 텍스트(이슈/조치 내용), 이미지 첨부 (localStorage 기반)
- 로컬 드래그 정렬 순서 저장 (`k8s:order:*` 키)

---

## EPIC 3. 클러스터 관리

다중 Kubernetes 클러스터의 메타데이터/네트워크/노드 운영을 통합 관리.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 클러스터 등록/관리 | CRUD, kubeconfig 업로드, 노드 IP / NIC 자동 수집, 운영레벨/이모지 표시 | `/cluster-manage` | `/clusters` | P0 `[NEW]` 운영레벨 이모지 |
| 노드 서버 스펙 | CPU/메모리/디스크/모델별 노드 인벤토리 (사용자 정의 컬럼 지원) | `/node-specs` | `/node-specs` | P1 |
| 버전 / 설정 추적 | 클러스터별 k8s / Cilium / Addon 버전 그래프 + diff | `/versions`, `/versions/:clusterId/graph` | `/clusters/{id}`, `/config-snapshots` | P1 |
| 노드 라벨 관리 | k8s label 일괄 적용/조회 | `/node-labels` | `/node-labels` | P2 |
| 노드 이미지 인벤토리 | 노드별 컨테이너 이미지 사용 현황 | `/node-images` | `/node-images` | P2 |
| 클러스터 링크 | 클러스터별 빠른 링크 모음 (ArgoCD / Grafana / Confluence 등) | `/links` | `/ui-settings/cluster-links` | P2 |
| CIDR 계산기 | IP/CIDR 분할/겹침 검사, 클러스터간 CIDR 충돌 감지 | `/cidr` | (frontend only) | P2 |

---

## EPIC 4. 인프라 운영 도구

SSH/etcd/Job 등 운영자 도구 모음. 작업 효율성을 위한 콘솔/터미널형 페이지군.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 인프라 토폴로지 | 클러스터 노드 네트워크 토폴로지 시각화 (감사 로그 포함) | `/infra-topology` | `/infra-nodes`, `/topology-trace` | P1 |
| 노드 일괄 실행 (Bulk Exec) | 다수 노드에 SSH 명령 동시 실행 (출력 스트리밍/취소 지원) | `/bulk-exec` | `/bulk-exec/run` | P1 |
| etcdctl 콘솔 | etcd 키/값 조회·쓰기, snapshot, 리더 확인 | `/etcdctl` | `/etcdctl` | P1 |
| Batch Jobs | Kubernetes Job 이력/재실행/스케줄 등록 | `/batch-jobs` | `/batch-jobs` | P1 `[NEW]` 등록·스케줄 |
| mc 클라이언트 (MinIO) | S3 호환 객체저장 ls/cp/rm 등 | `/mc` | `/mc-client` | P2 |
| 커널 파라미터 튜닝 | sysctl 값 조회/적용 (노드별) | `/kernel-params` | (bulk-exec 활용) | P2 |

---

## EPIC 5. AI 분석

LLM 기반(로컬 Ollama / Claude) 운영 데이터 분석/요약 페이지군.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 장애 로그 분석 (Incident Analysis) | 로그 첨부 → 원인/조치/관련 이슈 자동 분석 | `/incident-analysis` | `/analyze/incident`, `/agent/chat` | P0 |
| 패킷 흐름 분석 | tcpdump/pcap 흐름 분석, 노드간 traffic 추적 | `/packet-flow` | `/topology-trace` | P1 |
| Cilium BPF Trace | eBPF 패킷 trace 시각화 | `/cilium-trace` | `/cilium_trace` | P1 |
| 온톨로지 그래프 | 운영 지식 그래프 (엔티티/관계) | `/ontology` | `/ontology` | P2 |
| 기술 동향 (Trends) | RSS/뉴스 기반 LLM 요약 다이제스트 | `/trends` | `/trends` | P2 |
| AI Agent 사이드바 | 컨텍스트(cluster_name/status/logs) 기반 대화형 도우미 (fail-safe) | 전역 컴포넌트 | `/agent/chat`, `/agent/health` | P0 |

---

## EPIC 6. 지식 / 문서 허브

운영 노트, 작업 가이드, 명령어 사전 등 팀 지식 자산 관리.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 운영 노트보드 (Ops Notes) | 마크다운 기반 운영 메모/일지 (카테고리·태그·검색) | `/ops-notes`, `/ops-notes/new`, `/ops-notes/:id` | `/ops-notes` | P1 |
| 표준 작업 가이드 (Work Guides) | 팀 SOP 버전 관리, 단계별 체크리스트 | `/work-guides`, `/work-guides/new`, `/work-guides/:id` | `/work-guides` | P1 |
| 주요 명령어 사전 (Commands) | 카테고리별 자주 쓰는 CLI 명령어 (kubectl / cilium / etcdctl …) | `/commands` | `/commands` | P1 |
| 마인드맵 | 자유형 노드/엣지 마인드맵 (자동 저장) | `/mindmap` | `/mindmaps` | P2 |
| WBS 작업흐름 | Work Breakdown Structure 시각화 (간트형) | `/wbs` | `/tasks?wbs=` | P2 |
| 워크플로우 게시판 | 단계별 진행 상태(todo/in-progress/blocked/done/skipped) 추적용 기획 보드 | `/workflow` | `/workflows` | P2 |
| Services Catalog / Hub | 통합 서비스(SOP+링크+담당자) 허브 | `/services`, `/services/:service` | `/service-entries` | P2 |

---

## EPIC 7. 설정 / 관리

전역 설정과 마스터 데이터 관리.

| Story | 요약 | 경로 | API | 우선 |
|---|---|---|---|---|
| 클러스터 마스터 | 클러스터 메타 일괄 편집, 사용자 정의 컬럼 정의 | `/settings` (tab: 클러스터) | `/clusters`, `/clusters/custom-fields` | P1 |
| 관리 서버 (SSH 호스트) | bastion / jump / 운영 서버 등록 및 SSH 키 관리 | `/settings` (tab: 관리서버) | `/management-servers` | P1 |
| 담당자 관리 | 이슈/작업 할당용 멤버 마스터 | `/settings` (tab: 담당자) | `/ui-settings/assignees` | P1 |
| 운영레벨 정의 | 가동/스테이지/개발/테스트/DR 등 레벨 정의 (라벨/색상/이모지 커스터마이즈) | `/settings` (tab: 운영레벨) | `/ui-settings/operation-levels` | P1 `[NEW]` 이모지 |
| 서비스 카탈로그 | 통합지식 service tag (이슈/작업에서 사용) | `/settings` (tab: 서비스) | `/ui-settings/service-catalog` | P2 |
| Debug 페이지 토글 | 디버그/실험 페이지 표시 (Ctrl+D 토글) | `/settings` (tab: Debug) | (frontend only) | P2 |
| 백업 / 복구 | DB 스냅샷 생성·다운로드·복원 | `/settings` (tab: 백업) | `/backup` | P1 |

---

## EPIC 8. 자동화 / 스케줄

Celery 기반 백그라운드 자동화.

| Story | 요약 | 트리거 | 우선 |
|---|---|---|---|
| 일일 헬스 체크 스케줄 | 09:00 / 13:00 / 18:00 KST (Celery Beat) — API서버/Components/Nodes/SystemPods | crontab | P0 |
| Playbook 실행 큐 | 사용자 트리거 Ansible 실행을 Celery worker 로 비동기 처리 | API | P1 |
| Batch Job 스케줄 | 정해진 주기에 Kubernetes Job 등록·실행 | API | P1 `[NEW]` |
| Trend 디지에스트 수집 | RSS/뉴스 수집 후 LLM 요약 | scheduled | P2 |

---

## EPIC 9. 배포 / 운영 (인프라)

서비스 운영에 사용되는 배포 산출물 — Jira에는 "Operations" 또는 "DevOps" 라벨로 등록.

| Story | 요약 | 산출물 | 우선 |
|---|---|---|---|
| Docker Compose 로컬 개발 | postgres + redis + backend + frontend + celery 한 번에 기동 | `docker-compose.yml`, `Makefile` | P0 |
| Kubernetes Kustomize 배포 | base + overlays/{dev,prod,airgap,kind} | `k8s/`, `scripts/kind-setup.sh` | P0 |
| Helm 차트 | values-{dev,prod,airgap}.yaml 분리된 프로덕션 차트 | `helm/k8s-daily-monitor/` | P1 |
| Skaffold 핫리로드 | dev 모드 watch/rebuild | `skaffold.yaml` | P2 |
| 폐쇄망(airgap) 배포 | 사설 레지스트리 미러링 + 대화형 설치 스크립트 | `scripts/deploy-airgap.sh`, overlays/airgap | P1 |
| GitOps (ArgoCD) | Application/Project 매니페스트 | `argocd/` | P1 |
| CI/CD | GitHub Actions: lint/type/build (CI), GHCR 푸시 + Kustomize 적용 (CD), Jenkins 파이프라인(P3) | `.github/workflows/`, `Jenkinsfile` | P1 |

---

## 부록 A. 백엔드 도메인 모델 (27개)

Jira 에서 "Component" 로 등록할 수 있는 주요 엔티티.

```
Cluster · ClusterCustomField · Addon · CheckLog · DailyCheck · MetricCard
Issue · Task · Playbook · Workflow · WorkGuide · OpsNote · CommandEntry
MindMap · ServiceEntry · TopologyAuditLog · Ontology · Trend
InfraNode · NodeServerSpec · BatchJob · ManagementServer · AnsibleAssets
ConfigSnapshot · AppSetting · User
```

## 부록 B. 사이드바 6 그룹 (현 IA)

| 그룹 | 페이지 수 |
|---|---|
| 모니터링 | 2 |
| 작업관리 | 5 |
| 클러스터 | 13 |
| AI 분석 | 5 |
| 지식 허브 | 8+ (서브카테고리 분기) |
| 시스템 | 1 |

## 부록 C. 최근 추가 기능 (직전 sprint 산출물)

- **이슈 게시판 인라인 셀 편집** — 상태/담당자/클러스터/이슈부분/내용/날짜/비고 단일 클릭 인라인 수정 (팝업 진입 제거)
- **운영레벨 이모지** — 10종 이모지 카탈로그 (🚀🏭✨💻🧪🛡️🔧⚙️📦🌐) + Settings 에서 운영레벨별 지정. 미지정 시 자동 추론(production→🚀, dev→💻 등)
- **Batch Jobs 등록·스케줄링** — Kubernetes Job 정의 등록과 주기 실행 연결

---

## Jira 등록 가이드

1. 위 EPIC 1~9 를 Jira Epic 으로 1:1 생성 (Summary: 위 제목 그대로)
2. 각 Epic 하위에 Story 표의 행을 Story 티켓으로 생성
   - Summary: "Story" 컬럼 값
   - Description: "요약" 컬럼 값 + 경로/API
   - Priority: 우선 컬럼 (`P0=Highest`, `P1=High`, `P2=Medium`)
   - Label: `[NEW]` 표시된 항목은 `recently-shipped` 라벨 부여
3. 부록 A 의 도메인 모델을 Jira Project Component 로 일괄 등록 시 버그/개선 티켓 분류가 쉬워집니다.
4. EPIC 9 는 별도 "DevOps/Platform" 프로젝트로 분리 권장.

---

## PEP ↔ Jira 연동 기능 (v1.6.0 기준, 실제 통합)

위 EPIC 목록과는 별개로, PEP 는 **외부 Jira 시스템과 실제로 연동**한다. 코드 기준:

| 기능 | 설명 | 엔드포인트 / 코드 |
|---|---|---|
| Excel 가져오기 | Jira 에서 내려받은 Excel(xlsx) 을 업로드해 `WorkItem` 으로 일괄 등록 | `POST /jira/import/excel`, `frontend/src/pages/JiraExcelImportPage.tsx` (`/jira-import`) |
| 붙여넣기 가져오기 | 표를 복사-붙여넣기로도 동일하게 가져오기 | `POST /jira/import/paste` |
| 가져오기 결과 저장 | 미리보기 후 확정 저장 | `POST /jira/import/excel/save` |
| 사용자별 Jira 자격증명 | 개인 API 토큰 등록/조회 (암호화 저장) | `routers/jira.py` `/config`, `/credential`, `models/user_jira_credential.py` |
| **양방향 반영(push)** — v1.5.1 추가 | PEP 에서 편집한 업무를 연결된 Jira 이슈에 되쓰기: 칸반 상태 transition + 코멘트 + **제목(summary)·설명(description)·우선순위(priority)** 를 `PUT /rest/api/2/issue/{key}` 로 반영 | `POST /jira/push/{item_id}`, `services/jira_service.py` `update_issue()`, UI `components/work-items/JiraPushDialog.tsx` |
| 동기화 메타데이터 | 연결 상태·최근 동기화 시각을 업무에 저장 | `WorkItem` 컬럼: `jira_issue_id`, `jira_issue_key`, `jira_url`, `jira_status`, `jira_synced_at`, `jira_updated_at`, `jira_watchers` |

상세 흐름·필드 매핑은 `backend/app/services/jira_service.py` 와 `backend/app/routers/jira.py` 를
직접 참고 (본 문서는 아직 이 기능의 전용 설계 절을 갖추지 않음 — 필요 시 별도 절로 확장).
