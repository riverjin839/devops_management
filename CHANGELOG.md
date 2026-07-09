# Changelog

이 프로젝트의 주요 변경을 기록한다. 형식은 [Keep a Changelog], 버전은 [SemVer] 를 따른다.
브랜치·태그·릴리스 절차는 `docs/branch-tag-strategy.md` 참고.

[Keep a Changelog]: https://keepachangelog.com/ko/1.1.0/
[SemVer]: https://semver.org/lang/ko/

## [Unreleased]

1.0.0 이후 main 에 병합된 변경 (다음 마이너 릴리스 후보).

### Added
- **Jira Excel 가져오기 — 레거시 `.xls` 지원**: 기존 `.xlsx`/`.xlsm` 뿐 아니라 Excel 97-2003
  바이너리 형식(`.xls`)도 업로드 가능. 신규 라이브러리 `xlrd` 를 확장자 기준으로 분기 사용하고,
  헤더 매칭·담당자 매칭 등 파싱 이후 로직은 `.xlsx` 경로와 완전히 공유(행을 동일한 값-튜플
  형태로 정규화).
  - Backend: `xlrd==2.0.1` 추가, `routers/jira.py` `_read_xls_rows()`(날짜 셀→`datetime` 변환
    포함) + `import_excel` 확장자 분기.
- **담당자별 진행 현황 — "전체" 카드 + 표시 개수 옵션**(홈 대시보드 `MemberTodayTodos`):
  전체 참석(`allAttendees=true`, 파트 회의 등) 업무를 담당자 그룹과 별개로 모아 "전체" 카드로
  0순위(맨 앞) 노출, 그다음 로그인 사용자 본인 카드가 1순위. 카드 그리드를 1열→2열
  (`lg:grid-cols-2`, "전체" 카드는 전체 폭)로 바꾸고 인당 표시 개수를 기본 5개(옵션: 3/5/8/10,
  localStorage 저장)로 조정 가능하게 해 스크롤 없이 더 많은 인원이 한 화면에 보이도록 개선.
- **업무 등록 — 팝업 모달**: 업무현황(`/tasks-mgmt`)의 "업무 등록"/"하위 업무 등록" 버튼이 별도
  페이지(`/tasks-mgmt/new`)로 이동하지 않고 팝업(`WorkItemFormModal`)으로 바로 뜬다. 목록/보드
  화면 컨텍스트를 잃지 않고 등록 가능.
- **서비스 모듈 관계도(`/architecture`)**: RAG 파이프라인 인포그래픽처럼 노드 사이를 점이 흐르는
  애니메이션 플로우 다이어그램. 탭 2개 — ① PEP 아키텍처(브라우저→Backend API→PostgreSQL/Redis/
  Celery Beat·Worker/Prometheus/Ollama/K8s 클러스터)와 ② 클러스터 토폴로지(선택한 클러스터의
  애드온을 hub-spoke 로 표시). 엣지·노드 색상과 흐름 속도가 실제 헬스체크 상태(정상/경고/위험)를
  반영하며, 라이브 상태 신호가 없는 구성요소(Redis/Celery)는 점선·회색으로 "구조만 표시" 처리해
  실제 상태인 것처럼 오인되지 않게 함. React Flow 등 신규 라이브러리 없이 SVG `animateMotion` 기반
  전용 컴포넌트(`FlowDiagram`)로 구현해 번들 크기 영향 없음.
  - Frontend: `components/architecture/*`(FlowDiagram, pepArchitecture 레이아웃), `hooks/useArchitecture.ts`
    (기존 `/health/summary`, `/health/addons`, `/agent/health`, `/promql/health` 재사용, 신규 백엔드 변경 없음),
    `pages/ArchitecturePage.tsx`, 사이드바 네트워크 그룹에 메뉴 추가.
- **K8s 클러스터 추이(Cluster Trends)** — 신규 메뉴 `/cluster-trends`. per-node CPU/Memory/Disk/DiskIO/Network/NetworkErr
  시계열을 시간창(30m/1h/6h/24h/7d)별로 조회. 300+ 노드 과수집 방지(노드 명시 선택 + 상한 기본 30,
  시간창별 step 자동조정, 지표당 range query 1회). 데이터 소스는 클러스터별 Prometheus URL(미설정/비활성 시 offline).
  - Backend: `PrometheusService.query_range()`(fail-safe), `Cluster.prometheus_url/prometheus_enabled` 컬럼,
    `cluster_trends` 라우터, config `PROMETHEUS_NODE_LABEL`(기본 instance)·`TRENDS_MAX_NODES`(기본 30).
- **K8s 자원 관리 — 사용률(R/L) 표시**: k9s util 스타일로 모든 탭에 `R=사용/요청`·`L=사용/제한` 노출
  (노드 카드/테이블, 네임스페이스, 워크로드/파드 드릴다운). CSV 에도 사용률 컬럼 추가.
- **K8s 자원 관리 — 노드 카드 "열 수" 선택**(자동/5/10/20) + **네임스페이스·비효율 랭킹 페이징**
  (`PageSizeSelect`/`Pager`/`paginate`). 노드/네임스페이스 **검색 필터** 추가.
- **지식 허브 통합**: 지식/분석 메뉴를 `/docs` 하나로 통합(지식베이스·Q&A·마인드맵·온톨로지·기술동향·작업가이드를
  허브 탭/목록에서 접근). 관리자 '기존 자료 가져오기'(SOP/운영노트 → 지식문서, 중복 skip, 비파괴).
- **오픈소스/CNCF 브랜드 아이콘** 50종(`simple-icons`) — 클러스터·서비스 아이콘 picker 에 추가.
- **업무 게시판**: 시작일/완료일 **시간 표시 옵션**(기본 off=날짜만), **이번주(월~일) 빠른 필터**.
- **지식 허브 필터**: "필터" 타이틀 라인을 제거해 공간을 확보하고, 이번 주/이번 달/이번 분기 및 스프린트
  필터 칩을 추가.
- **업무 상세 페이지 바로 수정**: 우측 상단 "수정" 버튼과 별도 수정 페이지(라우트)를 없애고, 제목 옆
  연필 버튼이나 본문 클릭으로 그 자리에서 바로 편집 모드(기존 폼)로 전환.
- **사용자 메뉴 개편**: 사이드바 사용자 아이콘 클릭 시 작은 팝업 대신 우측 슬라이드 SidePane 으로 전환,
  상단에 본인 담당자 정보(이메일/IP/좌석 위치/정·부 담당역할)를 바로 수정할 수 있는 셀프 서비스 폼 추가,
  하단에 비밀번호 변경 메뉴.
- **담당자 관리**: 좌석 위치(`seatLocation`) 필드 추가, Settings ▸ 담당자 탭에 CSV 내보내기와 마크다운
  표 클립보드 복사 버튼 추가.
- **K8s 노드 이미지 CSV 내보내기**: 노드 순서/용량 기준/라인 수 기준 정렬 옵션을 지원하는 CSV 다운로드
  추가 (`/clusters/{id}/node-images/export.csv`).
- **Jira Excel 가져오기**: Jira 에서 추출한 이슈 목록 `.xlsx` 를 업로드하면 Key/Summary/Issue Type/
  Status/Assignee/Created/Resolved/Due Date/Environment/Description 을 테이블로 미리보기(저장 없음).
  Assignee 셀("이름 회사")에서 이름을 추출해 등록된 담당자와 자동 매핑. 신규 페이지 `/jira-import`.
  - Backend: `POST /jira/import/excel` (openpyxl).
- **mc 클라이언트 레이아웃**: 타겟/프리셋/결과 카드를 2:3:5 비율로 한 행에 배치, 결과 카드는 항상 같은
  위치에 고정되고 세로 스크롤만 허용(가로 스크롤 없음).
- **`scripts/redeploy.sh`**: 이미지 태그만 교체하는 빠른 재배포 스크립트. kustomize/helm 전체 apply
  없이 `kubectl set image` + `rollout restart` 로 지정한 Deployment 컨테이너 이미지를 바꾸고 롤아웃
  완료까지 대기. `-n <namespace>`(생략 시 현재 kubectl context 네임스페이스) + 전체 이미지 참조 +
  `<deployment>:<container>` 목록을 직접 받는 단순한 인터페이스(이후 git remote 자동 추론 방식에서
  변경, 아래 Fixed 참고).
- **`docker/postgres-pgvector/`**: GHCR 프록시로만 이미지를 받는 폐쇄망 배포용 Postgres 15(Alpine)
  + pgvector 확장 이미지. `postgres:15-alpine` 베이스(musl libc)를 그대로 유지한 채 pgvector 를
  소스 빌드로 추가 — Docker Hub 공식 `pgvector/pgvector:pg15`(Debian/glibc)로 통째로 바꿀 때 생기는
  컬레이션 호환성 리스크를 피함. `.github/workflows/postgres-pgvector.yml` 이 앱 이미지와 동일한
  GHCR 네임스페이스(`ghcr.io/<owner>/<repo>/postgres-pgvector`)로 빌드/게시.
- **릴리즈 노트 패널**: 사이드바 하단 레일에 "릴리즈 노트" 아이콘 추가(감사 로그가 빠진 자리) —
  클릭 시 우측 슬라이드 SidePane 으로 최근 버전별 변경 요약을 보여줌. `frontend/src/data/releaseNotes.ts`
  에 CHANGELOG.md 의 사용자 관점 요약을 수동 큐레이션(자동 동기화 아님, 사용자용 변경 시 함께 갱신).

### Changed
- **업무 등록 폼 효율화**: 기본 설정 그리드를 정리해 한 줄로 보이도록 축소.
  - **서비스 선택 — 카테고리 기준 조건부 필수**: "Cluster 점검"/"Node 관리"/"Pod 배포" 등 서비스
    운영 카테고리만 서비스 선택을 강제하고, "회의참석"/"교육 / 학습"/"기획 / 검토"/"문서 작업"/
    사용자 정의 카테고리는 서비스 없이도 등록 가능("파트 회의"처럼 특정 서비스에 속하지 않는
    업무 등록 지원). 숨겨져 있던 "기타" 서비스 옵션도 드롭다운에 복원.
  - **업무 시작일 기본값 — 시간 미포함**: 신규 등록 시 시작일 기본값이 더 이상 현재 시각을 포함하지
    않고 날짜만 채워짐(날짜 선택기의 "시간 포함" 토글이 기본 꺼짐).
  - **우선순위 / 보드 상태 / 프로젝트 / 스프린트 필드 제거**: 등록 폼에서 제외(효율화). 우선순위·
    보드 상태는 업무 목록/칸반 보드에서 바로 편집 가능(기존 기능 유지), 프로젝트·스프린트는 기본값
    없이(미분류/미배정) 등록되며 별도 UI 는 제공하지 않음.
- **플랫폼 현황 메뉴 정리**: 사이드바·홈 퀵 액세스에서 "서비스/앱"(LAKE 서비스·애플리케이션 APM) 메뉴
  제거 (라우트/페이지 자체는 유지, 메뉴에서만 제거).
- **감사 로그 위치 이동**: 사이드바 하단 레일의 독립 아이콘(`/settings/audit-logs`)을 없애고
  Settings ▸ 감사 로그 탭으로 이동(`AuditLogManager`). 페이지/라우트 자체는 삭제, 접근 권한은
  `/settings` 라우트의 기존 admin 가드를 그대로 사용.

### Removed
- **OpenClaw AI 알림 에이전트 통합 제거**: K8s 이벤트를 감시해 Telegram/Slack 으로 알림을 보내던
  OpenClaw 연동을 전체 제거. Backend: `openclaw` 라우터(`/api/v1/openclaw/*`)·`OpenClawAlertService`
  삭제, `Settings.telegram_bot_token`/`telegram_chat_id` 제거(OpenClaw 전용, `slack_webhook_url` 은
  기존 알림 채널과 공유되어 유지). Infra: `k8s/base/openclaw/` 모듈과 `openclaw`/`dev-openclaw`/
  `airgap-openclaw` 오버레이, Helm `templates/openclaw.yaml` 및 `values.yaml` 의 `openclaw:` 블록 삭제.

### Fixed
- **업무 게시판 날짜 저장 오류**: 날짜 input 이 빈 값('')으로 전송되면 `started_at`/`closed_at` 가
  `Input should be a valid datetime` 422 로 거부되어 상태를 done 으로 바꾸거나 완료일을 비울 때 저장 실패하던 문제 →
  스키마 `field_validator` 로 빈 문자열/공백을 `None` 으로 강제(WorkItemBase·WorkItemUpdate).
- 컬럼 리사이즈 그립을 평소에도 옅게 노출(`ResizeGrip`) — 컬럼 너비 조정 기능 발견성 개선(모든 테이블 공통).
- **업무 수정 딥링크**: `/tasks-mgmt/:id/edit` 라우트 제거 후 남아있던 구 북마크/딥링크가 캐치올에 걸려
  홈으로 튕기던 문제 → 상세 페이지 편집 모드(`?edit=1`)로 리다이렉트.
- **노드 이미지 CSV 다운로드**: 클러스터명에 한글 등 non-ASCII 문자가 있으면 `Content-Disposition`
  헤더 인코딩 실패로 500 이 나던 문제 → ASCII fallback + RFC 5987 `filename*` 인코딩.
- **파일 업로드 API 인터셉터**: `FormData`/`Blob` 페이로드가 camelCase→snake_case 변환기를 거치며
  빈 객체로 뭉개지던 문제 → multipart 업로드(백업 가져오기 포함) 전반에 영향이 있어 함께 수정.
- **Jira Excel 가져오기 413 에러**: 프론트엔드 nginx 에 `client_max_body_size` 가 없어 기본값(1m)이
  적용돼 수 MB 짜리 xlsx 업로드가 백엔드에 도달하기도 전에 거부되던 문제 → k8s ingress 와 동일하게
  10m 으로 설정(docker-compose/프로덕션 nginx 컨테이너 경로에만 있던 문제, k8s 배포는 영향 없었음).
- **업무(Work to do)/work-items 500 에러**: pgvector 확장이 없는 환경에서 `embedding` 컬럼
  마이그레이션이 조용히 실패(fail-open)했는데도 `WorkItem`/`WorkGuide` ORM 모델이 해당 컬럼을
  무조건 SELECT 하도록 매핑돼 있어, 목록 조회를 포함한 모든 업무 쿼리가
  `column work_items.embedding does not exist` 로 500 되던 문제 → 두 모델의 `embedding` 컬럼을
  `deferred()` 로 지연 로딩해 기본 조회에서 제외(유사도 검색처럼 실제로 그 컬럼을 쓰는 기능만
  영향받도록 격리). `/work-items/{id}/similar` 도 컬럼이 없으면 500 대신 `embedding_available=false` 로
  안전하게 폴백.
- **`scripts/redeploy.sh` — 태그 미변경 시 재배포 안 되던 문제**: `kubectl set image` 는 이미지 문자열이
  이전과 동일하면(예: `latest` 를 연달아 배포) diff 가 없어 새 ReplicaSet 을 만들지 않아, 레지스트리에
  새 이미지가 올라가도 파드가 재시작/재-pull 되지 않던 문제 → `set image` 뒤에 항상
  `kubectl rollout restart` 를 함께 호출하도록 수정.
- **`scripts/redeploy.sh` — git remote 파싱 에러로 실행 자체가 실패하던 문제**: 이미지 레지스트리
  베이스(`ghcr.io/<owner>/<repo>`)를 `git remote` URL 파싱으로 추론하던 로직이 특정 환경(프록시로
  감싼 origin URL 등)에서 깨져 스크립트가 아예 실행되지 않던 문제 → git remote 추론/`dev|prod|kind`
  환경 이름→네임스페이스·리소스 프리픽스 매핑을 모두 제거하고, `-n <namespace>`(생략 시 현재
  kubectl context 네임스페이스) + 전체 이미지 참조 + `<deployment>:<container>` 목록을 직접 받는
  단순한 인터페이스로 재작성.
- **pgvector 확장 생성 시 `duplicate key value violates unique constraint "pg_extension_name_index"`**:
  backend/celery-worker/celery-beat 등 여러 replica 가 동시에 부팅하며 각자 `CREATE EXTENSION IF NOT
  EXISTS vector` 를 실행하면 존재 확인→생성이 원자적이지 않아 두 세션이 동시에 생성을 시도해 충돌하고,
  이 예외가 (실제로는 확장이 정상 설치돼 있어도) "Nexus 로 postgresql-pgvector 패키지 반입 필요" 라는
  오해 소지가 큰 메시지로 뭉뚱그려 로깅되던 문제 → `pg_advisory_xact_lock` 으로 이 구간을 직렬화해
  레이스 자체를 제거.
- **Jira Excel 가져오기 413/220 에러 — k8s 배포에서 재발**: PR #410 에서 `frontend/nginx.conf` 에
  `client_max_body_size 10m` 을 추가했지만, k8s Deployment 는 `k8s/base/frontend/nginx-configmap.yaml`
  ConfigMap 을 `/etc/nginx/conf.d/default.conf` 에 volumeMount 로 덮어써서 이미지에 빌드된
  `nginx.conf` 를 완전히 무시하고 있었다 — 이 ConfigMap 은 별도 파일이라 image 재배포만으로는
  절대 반영되지 않고 `kubectl apply` 로 직접 적용해야 한다는 점도 원인 중 하나였음. ConfigMap 에도
  동일하게 `client_max_body_size 10m` 추가, 두 파일 모두 서로를 참조하는 주석으로 향후 드리프트 방지.

## [1.0.0] - 2026-06-04 — 정식 오픈

플랫폼 엔지니어링 포털(PEP) 첫 정식 릴리스.

### 핵심 기능 (요약)
- **K8s 모니터링**: 일일 점검(3회/일 Celery Beat), 클러스터/노드/시스템 파드 헬스, addon 점검, AI 리뷰.
- **운영 점검(Ops Checks) 콘솔**: 점검 항목 리스트 → 선택 일괄/개별 실행(백그라운드 진행률) → 결과·로그.
  deep checker 다수(인증서/etcd/CNI/PVC/OOM/노드/CoreDNS/외부도달/Pod-to-Pod/**OS 파라미터 변경**/**MinIO health**).
- **이슈→자동 재점검**: alert webhook 수신 시 해당 클러스터 점검 자동 트리거(쿨다운).
- **딥 트러블슈팅**: Cilium/Hubble 라이브 트레이스, 패킷 흐름, AI 장애 분석, Pod 병목 진단.
- **자동화**: Ansible 플레이북/배치 작업(SSH), etcdctl/mc 콘솔, 노드 일괄 실행.
- **설정 변경 히스토리**: ClusterConfigSnapshot(해시 dedup) + diff + 감사 로그.
- **협업/지식**: 업무/이슈 보드(칸반/표/캘린더), 주간 타임라인(간트), WBS, 워크플로우, 마인드맵,
  운영 노트/가이드/서비스 허브.
- **문서 에디터(TipTap)**: 실무 템플릿 5종(작업계획서/이슈대응/운영런북/스터디/명령어표),
  **.md import**, **표 편집(엑셀형)**, **배경색 컬러 피커**, **붙여넣기 이미지 자동 경량화**.
- **OpenLens 차용(읽기전용)**: **파드 로그 스트리밍**(SSE follow), **리소스 탐색기**(11종 + YAML 읽기,
  Secret 마스킹) + **가상화(react-virtuoso)**.
- **운영**: kind/Helm/Kustomize/ArgoCD/Jenkins 배포, JSON 백업/복원(fault-tolerant), RBAC(viewer/operator/admin).

### 문서
- `docs/openlens-architecture-roadmap.md` — 범용 K8s 관리 + 300노드 실시간 로드맵(P0~P5).
- `docs/collab-tooling-borrow-report.md` — AFFiNE/AppFlowy 차용 분석.
- `docs/branch-tag-strategy.md` — 본 릴리스부터의 브랜치·태그 전략.
- `.claude/skills/` — 재사용 작업 플레이북(점검 추가/백엔드/프론트/에디터/릴리스).

### 알려진 보류(post-1.0 백로그)
- 도식(draw.io 벡터 임베드), 협업 Top7(슬래시 메뉴/댓글·이력/백링크/마인드맵 내보내기/커스텀 필드).
- OS 파라미터 변경 **가시화 UI**(이력 테이블은 적재 중).
- Storage Ceph/Isilon health, MinIO drive/capacity, 진짜 외부 vantage 도달성.
- OpenLens P1 확장(Discovery/CRD·Monaco), P2 실시간(WebSocket/Go 사이드카), P4 Runbook 파이프라인,
  P5 admin YAML 편집(설계상 보류).

[1.0.0]: https://github.com/riverjin839/devops_management/releases/tag/v1.0.0
