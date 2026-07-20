# Changelog

이 프로젝트의 주요 변경을 기록한다. 형식은 [Keep a Changelog], 버전은 [SemVer] 를 따른다.
브랜치·태그·릴리스 절차는 `docs/branch-tag-strategy.md` 참고.

[Keep a Changelog]: https://keepachangelog.com/ko/1.1.0/
[SemVer]: https://semver.org/lang/ko/

## [Unreleased]

1.7.0 이후 main 에 병합된 변경 (다음 릴리스 후보).

### Fixed
- **상용 출시 전 보안/안정성 점검 후속 조치 (Blocker 7건)**: 상세 코드 감사에서 발견된
  치명 결함을 수정.
  - **인증/인가**: 운영 배포(`DEBUG=false`)에서 `SECRET_KEY` 가 기본값이거나 32자
    미만이면 기동을 거부(fail-fast) — 방치 시 JWT 위조 + 저장된 Jira/Isilon 자격증명
    복호화로 이어질 수 있었다. `docker-compose.yml`/`.env.example` 은 로컬 개발 기본값을
    `DEBUG=true` 로 맞춰(dev/kind/airgap overlay 와 동일) 이 가드에 영향받지 않도록
    조정 — 운영 배포(prod overlay)는 그대로 `DEBUG=false` + `SECRET_KEY` 교체 필수.
    `GET /clusters/{id}/kubeconfig`(cluster-admin 자격증명
    원문 반환) 와 `batch-jobs`/`versions`(SSH 수집)/`mc/run`/`topology-trace`(tcpdump)/
    `node-specs`/`isilon-nfs` 의 실행·쓰기 엔드포인트에 누락돼 있던 operator 권한
    가드를 추가. `versions` 의 `systemctl show {unit}` 원격 명령에 유효하지 않은 unit
    이름을 통한 명령 인젝션 경로를 차단(패턴 검증).
  - **백업 복원 데이터 유실 방지**: 마스킹된(비민감 export) 백업을 merge import 하면
    실제 kubeconfig/비밀번호/토큰이 `NULL` 로 덮어써지던 문제를 센티널 값으로 구분해
    수정 — 마스킹된 컬럼은 이제 갱신 대상에서 제외돼 기존 값이 보존된다. import 를
    테이블 전체 SAVEPOINT 1개로 감싸던 구조를 행/테이블 단위 SAVEPOINT 로 바꿔, 한 행
    실패가 이미 처리된 다른 행까지 롤백시키면서도 성공한 것처럼 응답하던 문제를 수정.
    UUID 기본키 타입 불일치로 백업 미리보기(diff)가 항상 "전부 신규/전체 삭제후보"로
    잘못 표시되던 문제도 함께 수정.
  - **점검 매트릭스 디스패처 유실 방지**: 매분 디스패처가 due 한 모든 클러스터/셀
    점검을 태스크 하나 안에서 직렬 실행해 `task_time_limit`(5분) 초과 시 SIGKILL 당하고
    이후 클러스터 점검이 재시도 없이 유실되던 문제를 수정. 이제 디스패처는 cron 평가와
    큐잉만 하고(수 초 내 종료), 실제 실행은 클러스터/셀 단위 개별 Celery 태스크로
    fan-out 되어 독립된 time_limit 을 갖는다. 큐잉 시 랜덤 countdown(jitter) 을 줘 동일
    분에 due 한 여러 클러스터가 동시에 API 를 두드리는 thundering herd 도 완화.
  - **대형 클러스터 OOM 방지**: `pod_to_pod`/`image_pull`/`stuck_terminating`/
    `oom_events` deep checker 가 `list_pod_for_all_namespaces` 등을 페이지네이션 없이
    한 번에 호출해 5k+ pod 클러스터에서 워커가 OOMKill 될 수 있던 문제를 기존
    `k8s_paging.iter_all` 페이지 스트리밍으로 전환.
  - **오탐 healthy 판정 수정**: kubeconfig 인증 만료/RBAC 회수 등으로 노드·컴포넌트
    조회 자체가 실패해도(`total=0/ready=0`) 클러스터가 healthy 로 보고되던 문제를
    수정 — 조회 실패 시 최소 warning 으로 강등하고 에러 메시지를 노출한다.

## [1.7.0] - 2026-07-19

### Added
- **UX/UI 디자이너 운영 체계 + 차트 색 토큰**: 디자인 감사·백로그를 운영하는 `DESIGN.md`
  문서 체계(ux-ui-designer 에이전트/스킬)를 신설하고 1회차 감사 실행. Frontend: 테마
  추종 categorical 차트 토큰 `--chart-1~8`(3테마) 신설, 주요 차트(칸반 요약·클러스터
  추이·주간 타임라인·버전 그래프)를 hex → 토큰으로 이관해 다크/라이트 전환 시 차트
  대비가 테마를 따라가도록 개선.

- **Deep Checker 고도화 — UI 커스텀 점검 생성 + 정의별 실행 이력/개별 로그**: admin 이
  코드 없이 UI 에서 새 점검을 만드는 커스텀 체커 3종(`custom_http` HTTP/TCP 프로브,
  `custom_kubectl` 읽기전용 kubectl 명령 + 라인/숫자/정규식 파싱, `custom_promql`
  PromQL 임계 판정)을 추가하고, Deep Check 정의 관리 화면(`/daily-check/settings`)을
  admin 전용으로 재구성. 정의별 즉시 실행(이력 기록)·복제·검색/카테고리 필터·최근 실행
  상태 배지와, 실행 회차별 단계(step) 타임라인/상세 JSON 을 펼쳐보는 **실행 이력 패널**을
  신설. Backend: `GET /deep-check/definitions/{id}/results`, `POST …/run`(영속 실행),
  `POST …/duplicate`, `POST /deep-check/definitions/preview`(저장 전 ad-hoc 실행),
  `with_status` 목록 요약, CRUD admin·실행 operator 권한 가드, 미배선이던
  `DeepCheckDefinition.schedule_cron` 을 check-matrix 디스패처에 배선(정의별 단독 cron,
  최소 5분 간격, 글로벌 정의는 전 클러스터 실행).

### Fixed
- **Deep Check 정의 편집 폼 저장값 미표시 수정**: axios 응답 인터셉터가 thresholds/params
  의 snake_case 키를 camelCase 로 바꿔 편집 폼·클러스터 필터·결과 step 타임라인이 조용히
  깨지던 문제를 정규화 로직으로 수정 (definitions 목록 쿼리 파라미터 snake_case 변환,
  `details._steps`→`Steps` camelize fallback 포함).

## [1.6.1] - 2026-07-17

### Changed
- **디자인 컨벤션 정리 (DESIGN.md D-001~D-008)**: Settings/InfraTopology/NodeImages 의
  수제 카드를 MacCard 로 수렴, button `sm` 라운딩을 base(`rounded-xl`)로 통일, 잔존
  고정 팔레트(gray-*)를 status 토큰으로 치환, 아이콘 전용 버튼에 `aria-label` 병행
  표준 적용. CLAUDE.md UI 섹션·DESIGN_SYSTEM.md 헤더를 실제 테마 체계(default/light/
  dark 3종, radius 토큰)로 현행화.
- **3차 문서 감사: infra README·스킬·로드맵 문서**: `k8s/README.md` 의 실제 오류 정정 —
  kind/airgap 오버레이 네임스페이스 오기재(`k8s-monitor-dev/prod` → 실제 `k8s-monitor`),
  airgap 환경 표(레플리카 1·HPA 전체 삭제·`DEBUG=true`·TLS 없음) 정정, observability
  네임스페이스명(`network-observability`), superpod 네임스페이스(`k8s-monitor-agent`+
  `devops`)·배포 절차 정정, `base/secret.yaml`/`configmap.yaml` 이 kustomization 미참조
  고아 파일임을 명시. `.claude/skills/` 4개 스킬 정정: `add-deep-checker`(`STEP_PLANS`
  보강), `backend-feature`(Celery 비동기 브리지 실제 패턴으로 정정), `frontend-page`
  (`Sidebar.tsx` → 실제 `navConfig.ts`), `editor-docs`(폐기된 `whiteBg` → 실제 `defaultBg`
  컬러 프리셋 방식, `linkSearch`/`extraTemplates`/콜아웃·토글 블록 보강). `docs/
  AIRGAP_LLM_NEXUS.md`(사전 적재 이미지라 Nexus 수급 절차가 불필요한 경우 명시, `OLLAMA_MODEL`
  기본값 `llama3` 주의), `docs/openlens-architecture-roadmap.md`(P5 YAML 편집이 "보류"가
  아니라 이미 배포됐고 dry-run 등 안전장치만 미흡함을 정정, 가상화/edit 게이팅 완료 표시),
  `docs/PROJECT_PLAN.md`·`docs/README.md` 색인(최초 기획서 보관용 배너 추가),
  `docs/collab-tooling-borrow-report.md`(Top 7 중 이미 구현된 4.5개 항목을 완료로 갱신).
- **docs/ 가이드 본문 2차 현행화**: 1차(README/CLAUDE.md/CODE_MAP/색인/SCREENS)에 이어 실제
  운영 가이드 본문을 코드와 대조해 정정. `ADMIN_MANUAL.md`(제품명 PEP 전환, Deployment/라벨
  셀렉터 실명 오류 수정, 클러스터 등록 위치를 Settings 로 정정, 09/13/18 고정 스케줄 →
  check-matrix cron 디스패처로 재작성, 내장 백업/복구·사용자 관리/RBAC·감사 로그·VOC·배치잡
  등 누락 관리 기능 보강), `DEPLOY_GUIDE.md`(compose kind 네트워크 선행 생성 안내, airgap
  save 산출물 tar.gz 개수 정정, dev→kind overlay 정정, GitHub Actions 가 기본 CI/CD 임을
  명시), `BACKUP_RESTORE_GUIDE.md`(LOG_TABLES·SENSITIVE_COLUMNS 최신 컬럼 반영),
  `DEEP_CHECKER_GUIDE.md`/`K8S_OPS_CHECKLIST.md`(체커 카탈로그에 누락됐던 `isilon_nfs`·
  `node_health` 반영, in_cluster 배포 산출물 `k8s/superpod/` 명시), `SERVICE_TOPOLOGY_GUIDE.md`
  (`/cluster-graph` 엔드포인트 추가), `KNOWLEDGE_BASE_DESIGN.md`(미채택 설계안임을 명시하는
  구현 결과 노트 추가), `JIRA_기능정리.md`(시점 스냅샷 고지 + 실제 PEP↔Jira 연동 기능인
  Excel/붙여넣기 가져오기·v1.5.1 양방향 push 절 신설 — 기존 문서에 전혀 없던 내용).

### Added
- **Deep Check 참조 가이드 문서**: deep-check 서브시스템의 목적·아키텍처·실행 경로·API·
  체커 카탈로그·확장 방법을 정리한 `docs/DEEP_CHECKER_GUIDE.md` 추가(AI/개발자 참조용).
- **Deep Check 정의 관리 UX 개선**: 정의 목록 검색, 글로벌 정의를 선택 클러스터 전용으로
  복제하는 버튼, 비활성 텍스트 배지, 동적 폼의 boolean 체크박스·list textarea(줄바꿈/콤마)
  위젯을 추가. 운영 점검 콘솔 상세 모달에 실행 단계 타임라인을 노출하고, 실행 시작 실패 시
  toast 로 사유를 표면화.
  - Frontend: `DeepCheckDefinitionForm`/`DeepCheckDefinitionList`/`DeepCheckSettings`/
    `OpsCheckConsolePage` — 잘못된 숫자 입력(NaN)을 null 로 방어, 글로벌 비활성화 시 확인 대화상자.

- **문서-코드 동기화 자동 검사(docs guard)**: 기능 추가 시 문서 갱신이 누락되지 않도록
  `scripts/docs/check_docs_sync.py` 를 추가하고 CI 에 `docs-sync` job 을 신설. App.tsx
  라우트 ↔ `docs/SCREENS.md` 섹션, 라우터/페이지 파일 ↔ `CODE_MAP.md`, `docs/*.md` ↔
  `docs/README.md` 인덱스, frontend/backend 버전 일치를 기계 검사하며, feat/fix PR 이
  앱 코드를 바꾸면서 CHANGELOG/문서를 안 건드리면 실패한다(예외: PR 제목 `[skip-docs]`).
  `.claude/skills/docs-sync` 스킬(변경 유형 → 갱신 문서 매핑)과 PR 템플릿 docs 체크 항목,
  CLAUDE.md "문서 동기화 규칙" 절도 함께 추가.
- **폐쇄망 LLM 아키텍처 문서**: `docs/AIRGAP_LLM_ARCHITECTURE.md` 신설 — 내부 제공
  모델(GLM-5.2)의 vLLM(OpenAI-호환) 서빙 구성, K8s 로그 모니터링–에러 **자동 분석**(조치
  권한 없음, 분석 전용) 파이프라인, PEP 내부 문서(작업 가이드/Q&A/업무 이력) RAG 설계와
  단계별 구현 로드맵/운영 체크리스트를 상세화. `AIRGAP_LLM_NEXUS.md` 와 상호 링크.

### Changed
- **내부 문서 전면 현행화(v1.6.0 기준 감사)**: README(버전 배지 1.0.0→1.6.0, 핵심 기능표에
  VOC/Jira/스프린트/온톨로지/Isilon NFS/Deep Check/서비스 카탈로그/인프라 대장/알림 등
  누락 도메인 보강), CLAUDE.md(저장소 레이아웃·환경변수 표를 config.py 기준 재생성,
  Celery "3회/일" → check-matrix 디스패처 체계로 정정, API/DB 도메인 인덱스 추가),
  CODE_MAP.md(미기재 라우터 47개·페이지 48개 도메인 표 추가, `trends/` 패키지·
  `navConfig.ts` 등 낡은 경로 정정), docs/README.md(누락 색인 6건),
  docs/SCREENS.md(제거된 `/coroot` 섹션 정리, 검증 기준일 헤더 추가).

## [1.6.0] - 2026-07-17

### Added
- **사용자 VOC 게시판 추가**: 사이드바 하단 레일의 "릴리즈 노트" 아이콘 **바로 위**에 "사용자 VOC
  게시판" 아이콘을 추가하고, 클릭하면 릴리즈 노트와 동일한 우측 SidePane 으로 게시판이 열린다.
  사용자가 문의/개선/불만/제안을 남기면 관리자가 답변하고 상태(접수/검토중/완료)를 관리한다.
  전체 공개 board(모두 열람, 수정·삭제는 본인 글 또는 관리자), 👍 공감, 관리자 답변 시 작성자에게
  인앱 알림.
  - Backend: `VocPost` 모델 + `/api/v1/voc` 라우터(CRUD + `POST /{id}/reply` 관리자 답변/상태),
    `user_notify.notify_voc_reply`(작성자 알림), reactions `REACTION_TARGET_TYPES` 에 `voc_post` 추가
    (신규 테이블 자동 생성, 마이그레이션 불필요).
  - Frontend: `VocBoardPanel`(목록/작성/상세/답변 master-detail) + `Sidebar` 레일 아이콘·SidePane,
    `useVoc` 훅, `vocApi`, 타입. 상세에서 기존 `ReactionBar` 재사용(`voc_post`).
- **shadcn MCP 연결 + Base UI 기준 전환**: `frontend/.mcp.json`(shadcn MCP 등록)과
  `frontend/components.json`(shadcn CLI 설정, style `new-york`, Base UI 기본)을 추가해
  이후 컴포넌트 추가 시 레지스트리를 실제로 조회하도록 배선. `Button`/`Card`/`Badge`/
  `Tooltip`/`Dialog` 5종을 `frontend/src/components/ui/`에 도입(Tooltip·Dialog 는
  `@base-ui/react`, Button 은 기존 `@radix-ui/react-slot` 재사용 — 낡은 Radix 버전은
  그대로 두고 신규만 Base UI로 감).
  - 대량 교체 대신 어댑터 방식으로 점진 적용: 기존 `MacCard` 는 API 그대로 두고 내부만
    새 `Card` 위에 재구성(traffic-light dot 은 `variant="mac"` 옵션으로 보존). 대표
    사용처로 `JiraPushDialog`(커스텀 모달 → `Dialog`+`Button`)와 업무 표의 우선순위
    칩(`WorkItemTableRow` → `Badge` dot+텍스트)을 교체해 동작을 증명.
- **운영레벨 커스텀 색상 — 시드 hex → 톤 자동 생성**: 운영레벨 색상이 13개 고정
  프리셋뿐이었는데, 관리자가 임의의 hex 를 지정하면 bg/ring/band/text 4단계 톤을
  자동 산출(`lib/colorTone.ts`, HSL 근사)해 클러스터 아이콘(SVG)과 뱃지(인라인 style)에
  반영하도록 확장. `OperationLevelsManager` 에 커스텀 색상 피커 추가, customHex 미지정
  시 기존 동작 그대로 유지.
- **W3 Health Hero — Bento + Bullet Chart**: Dashboard 상단 4-col 통계 카드를 12-col
  Asymmetric Bento(`HealthHero`)로 교체. 좌측 큰 셀에 SVG Bullet Chart(`ui/BulletChart`,
  3-zone 배경 + 목표선 마커, `role="img"` a11y)로 전체 헬스 %를 표시하고 우측에
  위험/경고/정상/마지막 점검 KPI 4셀 배치.
- **Surface Container 5단계 토큰**: Material Theme Builder 의 surface-container 개념을
  차용해 그림자 대신 톤 차이로 깊이감을 주는 5단계 토큰(`bg-surface-container-lowest`
  ~ `-highest`) 추가 — 기존 "그림자 없는 flat 카드" 철학과 일치.
- **W5+ Sparkline / Heat Map**: PromQL 메트릭 카드 하단에 최근 1시간 추이 Sparkline
  (`ui/Sparkline`, 새 백엔드 range-query 엔드포인트 `/promql/query/{id}/sparkline`)을
  추가. Dashboard 하단에 "Recent Check History" Heat Map(`CheckHistoryHeatmap`,
  cluster×time, hover 시 Tooltip 상세)을 신설 — 이전에 빠져 있던(orphan) 히스토리
  섹션을 대체.
- **W4 접근성 패스**: 사이드바를 건너뛰고 바로 본문(`#main-content`)으로 이동하는
  skip link 추가(Tab 포커스 시 노출). `jsx-a11y/control-has-associated-label` 규칙으로
  전체 코드베이스를 스캔해 icon-only 버튼/빈 테이블 헤더/폼 컨트롤의 접근 가능한 이름
  누락 54건을 25개 파일에서 수정하고, 회귀 방지를 위해 규칙을 상시 활성화. 신규 차트
  컴포넌트(Sparkline)에 sr-only 데이터 표, BulletChart 에는 값이 속한 구간(위험/주의/정상)
  까지 포함한 상세 aria-label 을 추가.

### Fixed
- **Prometheus Insights 섹션이 항상 "Loading..." 에 멈추던 버그**: `/promql/query/all`
  라우트가 `/promql/query/{card_id}` 보다 뒤에 선언돼 있어 UUID 타입 검증이 먼저 실패해
  422 를 반환하고 폴백되지 않았다. 라우트 선언 순서를 바로잡아 해결.
- **`historyApi.getLogs` 의 `pageSize` 파라미터가 항상 무시되던 버그**: axios 요청
  인터셉터의 camelCase→snake_case 변환이 body 에만 적용되고 쿼리 파라미터(`params`)에는
  적용되지 않아, 백엔드가 기대하는 `page_size`/`cluster_id` 대신 `pageSize`/`clusterId`
  가 그대로 전송돼 항상 기본값(20건)만 조회됐다. 파라미터명을 백엔드에 맞게 수정.

### Changed
- **브랜드/상태 raw HEX → 토큰화**: Jira 브랜드색 `#0052CC` 를 `brand.jira` 토큰
  (`--brand-jira`)으로 옮기고 `WorkItemTableRow`/`JiraPushDialog`/`WorkItemDetailPage`
  에서 참조. `NodeDetailPanel` 의 사용률 게이지 raw hex 도 `status.*` CSS 변수로 교체.
- DESIGN_SYSTEM.md §6/§10, CLAUDE.md 의 styling 스택 설명을 "Base UI 기본·Radix 호환 +
  shadcn MCP" 로 갱신하고, W1 raw-HEX DoD 에 3D/canvas/recharts/컬러픽커 화이트리스트를
  명시.

## [1.5.1] - 2026-07-16

### Added
- **Jira 양방향 반영 — 편집 내용 되쓰기(제목/설명/우선순위)**: 업무 상세의 "Jira 반영"이
  기존에는 칸반 상태 transition + 코멘트만 보냈는데, PEP 에서 편집한 **제목(summary)·
  설명(description)·우선순위(priority)** 도 연결된 Jira 이슈에 `PUT /rest/api/2/issue/{key}`
  로 되쓰도록 확장. 클릭 시 무엇이 반영되는지 보여주는 확인 다이얼로그(`JiraPushDialog`)와
  선택 코멘트를 추가하고, Jira 쪽이 더 최신이면 충돌 안내 후 강제 반영을 지원한다.
  담당자(assignee)는 이름 역매핑이 불안정해 반영에서 제외, 우선순위는 프로젝트별 스킴
  차이를 감안해 best-effort(실패 시 나머지는 정상 반영).
  - Backend: `JiraService.update_issue()`, `PEP_PRIORITY_TO_JIRA`/`strip_issue_key_prefix`
    헬퍼, `push_to_jira` 확장, `JiraPushRequest.push_fields`/`JiraPushResult.fields_updated`.
  - Frontend: `JiraPushDialog` 신설, `WorkItemDetailPage` 의 원클릭 push → 다이얼로그로 교체.
- **NFS 모니터링(Isilon) — NAS 서버 SSH 기반 신규 화면·점검 추가**: K8s 가 마운트해서 쓰는
  NFS 를 Isilon(OneFS) NAS **서버 쪽**에서 점검한다. 좌측에서 Isilon 서버를 선택하면 `isi`
  명령 수집 결과(Export/마운트, 쿼터·용량, 클라이언트/성능, 노드 health)와 K8s PV(`spec.nfs`)↔
  Isilon export 매칭(누락 감지)을 보여주는 전용 페이지(`/isilon-nfs`, 스토리지 그룹)를 추가.
  같은 수집 로직을 쓰는 `isilon_nfs` deep checker 를 등록해 운영 점검 콘솔·cron·알림에도 통합했다
  (기본 비활성, 권장 15~30분).
  - **NAS 무부하 설계**: 읽기전용 `isi` 명령만 허용(변경 동사·셸 메타문자·`--repeat` 등 거부),
    한 수집당 SSH 세션 1개로 직렬 실행, 서버별 60초 TTL 캐시(강제 재수집은 명시적 새로고침만).
  - **isi 명령 커스텀 등록**: 수집 명령을 DB(`isilon_commands`)로 관리 — 기본 명령도 시드되어
    OneFS 버전/환경에 맞게 편집·비활성·추가 가능(페이지의 "isi 명령 관리" 모달).
  - Backend: `IsilonServer`/`IsilonCommand` 모델(+`_run_migrations` 보강, 자격증명은 `secret_box`
    암호화 저장·백업 마스킹), `isilon_service`(검증·캐시·수집), `isilon_nfs` deep checker + registry,
    `/api/v1/isilon-nfs/*` 라우터(서버·명령 CRUD, 연결 테스트, `/overview`), builtin 명령 시드.
  - Frontend: `IsilonNfsPage` + 서버/명령 관리 모달, `useIsilonNfs` 훅, `isilonNfsApi`, 타입,
    사이드바 스토리지 그룹에 `NFS 모니터링` 등록.
- **Jira 가져오기 — 세션 쿠키 인증 방식 추가**: PAT(Personal Access Token) 발급이 막힌 SSO
  환경을 위해, 사용자가 사내 브라우저로 Jira 에 로그인한 뒤 세션 쿠키를 복사해 등록하면 그
  쿠키로 이슈를 가져올 수 있게 했다. 설정 ▸ Jira 연동에서 "Personal Access Token"과
  "세션 쿠키(SSO)" 중 선택하고, 쿠키 얻는 방법(개발자 도구 ▸ Network ▸ Request Headers 의
  Cookie 복사) 안내를 함께 제공한다.
  - Backend: `UserJiraCredential.auth_type` 컬럼 추가(`_safe_add_column` 마이그레이션),
    `JiraService` 가 `auth_type='cookie'` 일 때 `Cookie` 헤더 + XSRF 회피용
    `X-Atlassian-Token: no-check` 로 REST 호출. 자격 저장/테스트/가져오기/push 경로 모두 반영.
  - Frontend: `JiraIntegrationPanel` 에 인증 방식 토글·쿠키 입력(textarea)·안내 추가,
    `types`/`api`/`useJira` 에 `authType` 전달.

### Fixed
- **Deep Check ingest 무인증 차단**: `SUPERPOD_INGEST_TOKEN` 미설정 시 `/deep-check/ingest`
  를 fail-closed(503)로 거부하고, 토큰 비교를 `secrets.compare_digest`(상수시간)로 변경해
  임의 결과 주입·타이밍 공격을 차단.
- **Deep Check 실행/정의 권한 강화**: 정의 생성/수정/삭제/Test, `POST /deep-check/run/{id}`,
  운영 점검 실행을 operator 이상으로 제한(컨트롤플레인 exec·파드 생성 유발 동작 보호).
- **Deep Check 부하/안정성**: `POST /deep-check/run/{id}` 를 Celery 백그라운드로 전환(504
  방지, worker 부재 시 동기 폴백), `deep_check_results` 리텐션 정리 태스크 추가(매일 03:10),
  `pod_to_pod` 임시 프로브 파드 명시 삭제로 누수 방지, 결과 자동연결을 최근 회차(6h)로 제한.
- **Deep Check 판정 정확성**: `cert_expiry` 가 연/주 단위 잔여기간(CA 인증서 등)을 놓치던
  정규식을 duration 파서로 교체, `etcd_defrag` 파싱 실패를 warning→pending 으로 정정,
  `pod_to_pod` 의 신뢰 불가한 밀리초 계측 제거. ingest 클라이언트 TLS 검증 옵션화.

## [1.5.0] - 2026-07-15

### Added
- **운영 노트(운영관리) — DL 링크 추가**: 운영 노트(`/ops-notes`)에 기존 Confluence
  링크와 나란히 "DL 링크"(Data Lake 등 참고 자료) 필드를 추가. 등록/수정 폼, 목록 테이블
  작업 컬럼, 카드 보기 푸터, 상세 읽기 화면에 모두 노출된다.
  - Backend: `OpsNote` 모델에 `dl_url` 컬럼 추가(`_safe_add_column`으로 마이그레이션),
    schema/router 반영.
  - Frontend: `OpsNoteForm.tsx` 에 `ConfluenceUrlInput` 재사용으로 DL 링크 입력 추가,
    `OpsNoteTable.tsx`/`OpsNoteReadView.tsx`/`OpsNotesPage.tsx`(카드 보기)에 링크 노출.

## [1.4.0] - 2026-07-14

### Added
- **담당자별 진행 현황(주간) 스윔레인 — 상태 막대 투명도 + 글자색 커스터마이즈**: 홈
  "담당자별 진행 현황" 주간 탭의 상태 막대(완료/진행중/검토/Todo/Backlog)를 Settings →
  "화면 UI 설정" → 홈 화면 설정에서 배경 투명도(0~100% 슬라이더)와 막대 안 글자색(색상
  피커, 기본값 흰색)으로 조절 가능. 사용자별 localStorage 저장, 범례 스와치도 동일하게
  반영.
  - Frontend: `stores/homeStore.ts`(`weeklyBarOpacity`/`weeklyBarTextColor`),
    `WeeklyStatusTimeline.tsx`(Tailwind 그라데이션 클래스 → hex 기반 `rgba()` inline
    style 로 전환), `SettingsPage.tsx` 슬라이더/색상 피커 UI.
- **업무관리 게시판 — Jira/Confluence 링크 컬럼 추가**: `WorkItem` 모델에는 이미
  `jiraUrl`/`confluenceUrl` 필드가 있어 업무 등록/수정 폼과 상세 보기에서는 편집·확인이
  가능했지만, 게시판 목록(테이블)에는 (Jira API 연동으로 채워지는) `jiraIssueKey` 뱃지
  외엔 노출 위치가 없었다 — 컬럼 관리에서 켤 수 있는 "Jira 링크"/"Confl. 링크" 컬럼을
  추가해 수동 입력/Jira Excel 미리보기 등 어떤 경로로 채워졌든 클릭 한 번으로 열 수 있게
  했다(기본은 숨김).
  - Frontend: `components/work-items/workItemColumns.ts`(`jiraLink`/`confluenceLink`
    컬럼 메타 추가), `WorkItemTableRow.tsx` 셀 렌더링 추가.
- **PEP 서비스 / APP 서비스 사이드바 아이콘 추가**: "지식/분석" 아이콘을 "PEP 서비스"로
  이름·개념 변경(Runtime/Catalog/Workflow/JupyterLab 등 상위 카테고리 → 하위 서비스
  2단 네비게이션)하고, 동일 구조의 "APP 서비스" 아이콘을 신규 추가(빈 카테고리로 시작,
  Settings 에서 직접 등록). 상위 카테고리는 Settings → "서비스 카테고리"에서 관리자가
  자유롭게 추가/편집/비활성화할 수 있다(PEP builtin 4개는 삭제 불가). 기존 LAKE 서비스
  시스템을 확장해 재사용 — 신규 필드로 도메인(pep/app)과 상위 카테고리를 부여했다.
  지식 허브(`/docs`)는 코드/데이터 그대로 유지되며 직접 URL 접근으로만 남는다.
  - Backend: 신규 `ServiceCategory` 모델 + `/api/v1/service-categories` CRUD 라우터.
    `LakeServiceType`/`LakeService` 에 `domain`/`category_id` 컬럼 추가(`_safe_add_column`),
    부팅 시 PEP builtin 카테고리 4개 자동 시드 + 기존 8개 builtin 타입 category_id 백필.
  - Frontend: `ServiceDomainCatalog`(카테고리 레일 + 서비스 카드), `/pep-services`,
    `/app-services` 라우트, Settings `ServiceCategoryManager`, `LakeServiceTypeManager` 에
    도메인/카테고리 필드 추가.
- **홈 "플랫폼 현황" 매트릭스 전면 개편**: `InfraHealthBar`/`DailyCheckReviewPanel`/
  `IncidentMiniPanel` 세로 스택 대신, 행(점검 항목) × 열(등록된 클러스터) 매트릭스로
  교체 — 셀 클릭 시 기간별 트렌드 차트 + 변경 이력 상세 모달. 점검 항목은 사용자가
  추가/삭제/재정렬 가능(기본값으로 기존 자동 점검 전부 시드), AiStor/NFS/N-W 스위치처럼
  자동 체커가 없는 항목은 수동 입력 타입으로 등록. 이력 보관 주기는 별도 설정(DB 용량
  고려) 후 자동 정리.
  - Backend: `models/check_matrix.py`(`CheckMatrixItem`/`Schedule`/`Result`/`ResultLog`),
    `routers/check_matrix.py`, `services/check_matrix_service.py`, `Cluster.check_cron_expr`.
  - Frontend: `components/platform-status/{PlatformStatusMatrix,CheckMatrixCellDetailModal,
    CheckMatrixItemFormModal,CheckMatrixSettingsModal}`, `hooks/useCheckMatrix.ts`.

### Changed
- **점검 스케줄 체계 완전 대체**: 하루 3회(09/13/18시) 하드코딩 + `CheckSchedule`
  온오프 플래그를 제거하고, "플랫폼 현황" 매트릭스에서 클러스터별/항목별 cron 을 직접
  관리하도록 변경. `Cluster.status` 산정에 쓰이는 핵심 점검(API 서버 응답시간)은
  기존 `DailyChecker.run_daily_check()` 를 그대로 재사용해 authority/AI 리뷰 파이프라인은
  무변경, 나머지 deep_check/addon 항목은 항목×클러스터 단위로 독립 스케줄(5분 미만
  간격 거부).
  - Backend: `celery_app.py`(`run_check_matrix_dispatch`/`run_check_matrix_log_purge` 가
    `run_scheduled_check`/`run_scheduled_single_check`/`run_deep_check_all` 대체).

### Removed
- **`CheckSchedule`(아침/점심/저녁 온오프) 모델 및 `GET/PUT /daily-check/schedule/{cluster_id}`
  API 제거** — 프론트에서 실제로 쓰이지 않던 기능(실제 시각은 항상 하드코딩값이었음).
  `check_schedules` 테이블 자체는 드롭하지 않음(비파괴 마이그레이션).

### Fixed
- **우측 슬라이드 패널(릴리즈 노트 / 계정 메뉴)이 오버레이 대신 메인 UI 안에 그대로
  노출되던 문제**: `SidePane` 의 `<aside>` 에 `fixed` 와 `relative` 클래스가 동시에
  들어가 있어 Tailwind 유틸리티 우선순위상 `relative` 가 이겨 실제 `position` 이
  `relative` 로 계산됐다 — `translate-x-full`(닫힘 상태) 오프셋이 뷰포트 기준이 아닌
  일반 문서 흐름 기준으로 적용되면서, 로그인 직후 두 패널이 항상 화면 중앙 부근에
  나란히 "튀어나온" 것처럼 보였다. 중복된 `relative` 클래스를 제거해 `fixed`(이미
  absolute 자손의 containing block 역할도 겸함) 하나만 남기는 것으로 해결.
  - Frontend: `components/common/SidePane.tsx`.
- **업무 등록/수정 폼에 "공통업무" 체크박스가 없던 문제**: `WorkItem.allAttendees` 필드는
  백엔드·타입·상세보기 배지·홈 "전체" 카드 필터까지 전부 연결돼 있었지만, 정작 등록/수정
  폼에 이 값을 켤 수 있는 UI 컨트롤이 없어 사용자가 지정할 방법이 없었다(state 는 있지만
  어떤 `onChange` 도 호출하지 않는 죽은 필드). `WorkItemForm.tsx` 에 체크박스를 추가해
  실제로 지정 가능하도록 수정. 표시 문구는 "전체 참석"(전원이 반드시 참석해야 하는 것처럼
  오해될 수 있음) 대신 실제 의미에 맞게 "공통업무"(특정 담당자 개인 업무가 아닌 파트 공통
  업무)로 표기(`👥 공통업무`, 필드명/데이터는 그대로 유지).

## [1.3.1] - 2026-07-13

### Changed
- **`ClusterSidebar` iconOnly 레일 — S/M/L 크기 토글을 드래그 리사이즈로 교체**: 1.3.0 의
  작게/보통/크게 3단계 토글 대신, 레일 우측 가장자리를 드래그해 폭을 자유롭게(48~120px)
  조절하는 방식으로 변경 — 아이콘이 레일 폭을 거의 그대로 채우도록(레일↔아이콘 여백을
  고정 6px 로 최소화) 만들어, 레일을 늘리면 아이콘도 그만큼 커 보이게 했다. 더블클릭으로
  기본값(64px) 복귀, 사용자별 localStorage 영속.
  - Frontend: `ClusterSidebar.tsx` `iconSizeFor()`(레일 폭→버튼/이미지/아이콘/도트 비율
    계산) + 기존 `ResizeHandle` 재사용. `stores/sidebarStore.ts` `clusterIconRailWidth`
    (기존 `clusterIconRailSize` 프리셋 대체).

### Removed
- **주간 타임라인 "색 반전" 토글 제거**: 상태 막대(박스) 배경/글씨 색을 반전하던
  기능을 제거 — 대신 주 이동 툴바(월/날짜범위)와 요일 헤더 글씨색을 테마와 무관하게
  고정 검정계열(`text-slate-700/800`)로 바꿔 반전 없이도 가독성을 확보.
  - Frontend: `WeeklyStatusTimeline.tsx`.

## [1.3.0] - 2026-07-13

### Added
- **클러스터 아이콘 빌더 — 업무명/운영타입/속성/지역 4개 밴드 구조로 개편**: 기존
  이니셜+환경색+지역 3요소 조합을 위→아래 4개 가로 밴드(1층 업무명, 2층 운영타입, 3층
  속성, 4층 지역)로 재구성. 속성(3층)은 `[업무명]-[운영타입]-[속성]` 표준 클러스터
  이름 규칙(클러스터 이름 표준화 도구와 동일 파싱)의 3번째 세그먼트(클러스터 기능 —
  예: computing/storage)를 자동 추출해 프리필. 4개 밴드는 운영등급 색 토큰 하나를
  명도만 달리해(운영타입 밴드가 가장 진한 강조색) 통일감 있게 표시.
  - Frontend: `lib/clusterIconBuilder.ts` `buildClusterIconSvg()` 재작성 +
    `suggestAttribute()`/`suggestOpTypeLabel()` 추가, 신규 `lib/clusterName.ts`
    (표준 이름 파싱 — `StandardizeClusterNamesModal` 과 공유), `ClusterIconPicker`
    빌더 탭 입력 폼 4개 필드로 확장.
- **`ClusterSidebar` iconOnly 레일 — 아이콘 크기 확대 + S/M/L 크기 조절**: 40px 버튼
  안에 24px 이미지만 차지해 여백이 커 보이던 문제 해결 — 기본 크기를 48px 버튼/34px
  이미지로 키우고, 레일 상단에 작게/보통/크게(S/M/L) 토글을 추가해 사용자가 취향껏
  조절 가능(사용자별 localStorage 저장). 아이콘 없는 클러스터의 status 아이콘(lucide)·
  이모지 아이콘도 같은 비율로 함께 커진다.
  - Frontend: `ClusterSidebar.tsx` — `ICON_RAIL_SIZE_PRESETS`, `IconRailButton` 픽셀
    기반 동적 크기. `stores/sidebarStore.ts` `clusterIconRailSize` 영속화.

### Fixed
- **인프라 토폴로지(`/infra-topology`) — 클러스터 선택이 표준 사이드바 대신 레거시
  가로 탭이었던 문제**: 클러스터를 클릭해도 다른 클러스터 페이지처럼 좌측 아이콘
  사이드바가 뜨지 않고 상단 버튼 탭만 있던 것을 `ClusterSidebar iconOnly` 표준
  패턴으로 마이그레이션.
  - Frontend: `InfraTopologyPage.tsx`.
- **릴리즈 노트 패널 — 요약 텍스트가 잘려 스크롤해야 보이던 문제**: 고정 480px 폭에서
  버전별 요약이 한 줄 말줄임(truncate)으로 잘려 전체 내용을 볼 수 없었다 → 기본 폭을
  640px 로 넓히고, 요약 텍스트를 말줄임 대신 줄바꿈(wrap)으로 바꿔 기본 상태에서도
  잘림 없이 표시. 왼쪽 가장자리를 드래그하면 420~1100px 범위로 추가 확장 가능(사용자별
  localStorage 영속).
  - Frontend: `SidePane.tsx` 에 범용 `resizable`/`widthStorageKey`/`minWidth`/`maxWidth`
    prop 추가(기존 `ResizeHandle` 재사용, 다른 SidePane 사용처는 옵트인이라 영향 없음),
    `ResizeHandle` 의 `side` 를 `'left'` 도 지원하도록 확장, `ReleaseNotesPanel.tsx`
    요약 미리보기 `truncate` → `break-words`, `Sidebar.tsx` 에서 활성화.

## [1.2.0] - 2026-07-09

### Added
- **홈 "담당자별 진행 현황" — "주간"(담당자 기준) 탭에도 접기/더보기 적용**: 담당자 탭에만
  있던 "인당 표시 5개 제한 + 더보기" 정책을 주간 탭의 담당자 기준 스윔레인 뷰에도 확장 —
  겹치는 업무가 많아 sub-lane 이 5개를 넘는 담당자는 처음 5개 lane 만 보이고 "+N건 더…"
  버튼으로 나머지를 펼치거나(클릭 시 "접기"로 되돌림) 다시 접을 수 있어, 특정 담당자의
  업무가 몰려도 패널 전체 높이가 과도하게 늘어나지 않는다.
  - Frontend: `WeeklyStatusTimeline.tsx` — `LANE_LIMIT`(5) + 담당자별 펼침 상태(`expandedAssignees`).
- **클러스터 아이콘 빌더**: 사이드바에서 클러스터를 한눈에 구분하기 어려운 문제 해결 —
  서비스 이니셜(이름에서 자동 추출) + 환경색(운영등급: 운영=빨강/스테이지=주황/개발=파랑,
  Settings 운영등급 색 설정 연동) + 하단 지역 약어 밴드(이천/용인/청주/우시 등) + k8s 휠
  워터마크를 조합한 SVG 아이콘을 생성. 아이콘 선택창에 "빌더" 탭 추가(실시간 미리보기,
  모든 값 편집 가능, 사각/원형), Settings ▸ 클러스터 탭에 **"아이콘 일괄 생성"** 버튼
  (아이콘이 비어있는 클러스터만 자동 생성 — 기존 아이콘은 유지). SVG data URL 로 기존
  icon 저장 형식을 그대로 사용해 백엔드 무변경, 모든 렌더 위치(사이드바/테이블/설정)
  즉시 반영.
  - Frontend: 신규 `lib/clusterIconBuilder.ts`, `ClusterIconPicker` 빌더 탭, `SettingsPage`.
- **`scripts/redeploy.sh` — Deployment 이름만으로도 재배포 가능**: `-t` 옵션과 함께 쓰는 target 을
  기존 `<deployment>:<container>` 뿐 아니라 `<deployment>` 이름만으로도 지정 가능(예:
  `backend frontend`) — 컨테이너가 정확히 1개인 Deployment 는 자동 판별하고, 여러 개면 자동 판별
  불가 사유와 함께 명시적으로 지정하라는 에러 메시지를 출력한다. v1.1.0 의 `-t` 옵션에 이어지는
  개선.
- **아이콘 picker — Airflow / Spark / JupyterHub / JupyterLab / StarRocks / CI-CD 아이콘 추가**:
  클러스터 · 서비스 카탈로그 아이콘 선택창(오픈소스 / CNCF 그룹 + 기본 그룹)에서 LAKE 계열
  OSS 로고와 일반 CI/CD 파이프라인 아이콘을 고를 수 있게 추가. 요청된 항목 중 Cilium/
  Keycloak/Nexus/Prometheus/Grafana/MinIO(AIStor)는 이미 등록되어 있어 그대로 재사용된다.
  Airflow/Spark 는 simple-icons 공식 로고, JupyterHub/JupyterLab 은 두 프로젝트가 공유하는
  동일한 Jupyter 로고. StarRocks 는 simple-icons 에 등록되어 있지 않아 공식 사이트
  (docs.starrocks.io) 의 원본 다색(골드+틸) 로고 SVG 를 직접 이식. CI/CD 는 특정 브랜드가
  아니라 lucide `Waypoints`(파이프라인 단계 형태) 아이콘을 범용으로 매핑.
  - Frontend: `lib/brandIcons.ts` — `BRAND_ICONS.Airflow/Spark/JupyterHub/JupyterLab/StarRocks`
    (+ 다색 SVG 전용 `brandMulti()` 헬퍼 신설), `lib/clusterIcons.ts` — `CLUSTER_ICON_OPTIONS['CI/CD']`.
- **Jira Excel 가져오기 — 복사·붙여넣기(TSV)로도 가져오기 가능**: 파일 업로드 없이 Jira
  이슈 목록/엑셀 표를 마우스로 드래그해 복사한 뒤 그대로 붙여넣어 가져올 수 있는 모드를
  추가. 파일 업로드와 동일한 헤더 자동 탐색·담당자 매칭 로직(`_extract_jira_rows`)을
  공유한다.
  - Frontend: `JiraExcelImportPage.tsx` — `ViewModeBar` 로 파일 업로드/붙여넣기 전환,
    `jiraApi.importPaste()`.
  - Backend: `POST /api/v1/jira/import/paste` (`JiraExcelPasteRequest`) — `routers/jira.py`.
- **홈 "담당자별 진행 현황 — 주간" 탭(WeeklyStatusTimeline) 밀도 개선 + 기본 탭 복귀**:
  담당자 기준 스윔레인 뷰에도 "담당자" 탭(MemberTodayTodos)과 동등한 표시 제한/펼치기를
  갖춰 기본 탭을 다시 '주간'으로 되돌렸다.
  - 담당자별 기본 5건만 표시 → "+N건 더보기"로 펼치고, 펼친 뒤에는 "접기"로 다시 접을 수
    있음.
  - 이번 주 전체 업무를 모은 "전체" 요약 행을 항상 목록 최상단(로그인 본인 행보다도 위)에
    강조 표시.
  - 화면당 표시할 담당자(행) 수를 툴바에서 조절 가능(기본 20명, 옵션 10/20/30/50 —
    사용자별 localStorage 저장), 라인 밀도(레인 높이 32→24px)와 글씨 크기를 줄여 스크롤
    없이 더 많은 담당자가 한 화면에 보이도록 개선.
  - Frontend: `WeeklyStatusTimeline.tsx`(`ASSIGNEE_ITEM_LIMIT`, `ROWS_LIMIT_OPTIONS`,
    `TEAM_ROW_NAME`), `HomePage.tsx`(`weeklyTab` 기본값 `'week'`로 변경).
- **Jira Excel 가져오기 — "업무 관리에 저장" 버튼**: 미리보기(파일 업로드/붙여넣기)가 성공하면
  헤더에 저장 버튼이 나타나고, 클릭하면 그 자리에서 다시 파일을 읽지 않고 미리보기 행을
  그대로 PEP 업무 관리 게시판(work_items)에 매핑 저장한다. 라이브 JQL 가져오기와 달리
  `jira_issue_id` 가 없어 `jira_issue_key` 로 dedup(재저장 시 갱신), `type`/카테고리는
  `jira_service.map_issue_type()` 재사용, 상태는 텍스트 매칭으로 kanban 상태 추정. 저장 후
  생성/갱신/스킵 건수 배너 + 업무 관리 게시판 바로가기 링크 노출.
  - Frontend: `JiraExcelImportPage.tsx` — 저장 버튼/결과 배너, `jiraApi.importSaveToBoard()`.
  - Backend: `POST /api/v1/jira/import/excel/save`(`JiraExcelSaveRequest`, `require_operator`)
    — `routers/jira.py` `import_excel_save()`, `_map_excel_status_to_kanban()`.

### Fixed
- **Jira Excel 가져오기 — `.xls` 업로드 시 "Expected BOF record" 오류**: Jira 의
  "엑셀(전체 필드)" 내보내기는 확장자만 `.xls` 일 뿐 실제 내용은 HTML 테이블(구버전 Excel
  호환용)이라, 진짜 OLE2 바이너리만 지원하는 xlrd 가 즉시 실패했다 → 업로드된 `.xls` 파일이
  HTML 인지 먼저 감지해 표준 라이브러리 `html.parser` 기반 테이블 추출기로 파싱(신규
  의존성 없음). 진짜 바이너리 `.xls` 는 기존 xlrd 경로 그대로 유지.
  - Backend: `routers/jira.py` `_looks_like_html()`/`_read_html_table_rows()`.
- **홈 "담당자별 진행 현황" — 인당 표시 개수 제한(기본 5개, 더보기)이 적용 안 되던 문제**:
  이 기능은 `MemberTodayTodos`(패널의 "담당자" 탭)에만 구현돼 있었는데, 패널의 기본 탭이
  "주간"(`WeeklyStatusTimeline` — 간트 스윔레인 뷰, 인당 표시 제한 없음)으로 설정돼 있어
  대부분의 사용자가 제한이 적용된 뷰를 아예 보지 못했다 → 기본 탭을 "담당자"로 변경.
- **Jira Excel 가져오기 — 헤더가 1행이 아니면 "필수 컬럼을 찾을 수 없습니다" 오류**: 제목행/빈
  행이 표 위에 끼어 있어 실제 `Key`/`Summary` 헤더가 2~4번째 행에 오는 엑셀은 무조건 실패했다
  → 첫 행만 보던 것을 최대 5행까지 순서대로 후보로 살펴 key/summary 를 모두 찾은 첫 행을
  헤더로 채택하도록 변경. 그래도 못 찾으면 에러 메시지에 스캔한 각 행의 헤더 후보를 함께 노출.
  - Backend: `routers/jira.py` `import_excel()` — `_EXCEL_HEADER_SCAN_ROWS`.
- **Jira Excel 가져오기 — HTML 기반 `.xls` 에서 표가 2개 이상이면 "최대 2행까지 확인" 오류
  (위 수정의 실제 근본 원인)**: `.xls` 확장자지만 실제로는 HTML 표인 Jira "엑셀(전체 필드)"
  내보내기 파서가 **문서의 첫 `<table>` 하나만** 읽도록 하드코딩돼 있었다. Jira 내보내기가
  요약/메타 정보를 담은 작은 표를 실제 이슈 목록 표보다 앞에 두거나(형제 표), 레이아웃용
  바깥 표 안에 실제 이슈 표를 중첩시키는 구조면, 작은 첫 표(예: 2행)만 읽고 진짜 데이터
  표는 통째로 무시된 채 "필수 컬럼을 찾을 수 없음" 이 났다 → 파서를 테이블 스택 기반으로
  다시 짜 문서 안의 모든 표(중첩 포함)를 각각 독립적으로 추출하도록 변경, 헤더 탐색도 표
  하나가 아니라 발견된 모든 표를 순서대로 확인해 Key/Summary 헤더를 가진 첫 표를 사용하도록
  확장. 파일 업로드/붙여넣기 공통 로직 `_extract_jira_rows()` 로 통합.
  - Backend: `routers/jira.py` `_JiraHtmlTableExtractor`(스택 기반 재작성) → `_read_html_tables()`,
    `_find_header_in_rows()`, `_extract_jira_rows()`.
- **로그인 시 홈 기본 화면이 이전 세션의 "플랫폼 현황" 상태를 물려받던 문제**: 로그인마다 홈
  모드를 항상 "업무 현황"으로 리셋하도록 변경(로그인 후 토글은 그대로 가능).
  - Frontend: `stores/authStore.ts` `setSession()`.
- **주간 타임라인 "색 반전" 토글 — 의도와 다르게 카드 전체 배경/텍스트가 반전되던 문제**:
  본래 의도는 상태 막대(업무 박스)의 배경색과 그 안의 글씨색을 반전하는 것인데, 카드
  surface 토큰(배경/테두리/보조색 등)을 통째로 어두운 팔레트로 덮어써 타임라인 전체
  분위기가 바뀌었다 → 카드 레벨 오버라이드를 제거하고, 각 상태 막대 버튼에만 Tailwind
  `invert`(filter: invert) 를 조건부로 적용해 그 막대의 배경 그라데이션과 글씨색만
  반전되도록 정정.
  - Frontend: `WeeklyStatusTimeline.tsx`(상태 막대 버튼 className), `index.css`(불필요해진
    `.timeline-color-invert` 규칙 제거).
- **Jira Excel 가져오기 — Description/Environment 셀에 이스케이프된 HTML 태그가 그대로
  노출**: Jira 의 HTML 기반 내보내기는 rich-text 필드를 이스케이프된 HTML(예:
  `&lt;p dir="auto"&gt;...&lt;/p&gt;`)로 담는 경우가 있는데, 파서가 엔티티를 복원하는
  과정에서 `<p dir="auto">...` 처럼 태그가 그대로 텍스트로 남아 화면에 보였다 → 태그를
  제거하고 순수 텍스트만 남기도록 정정. Created 필드도 시간까지 표시되던 것을 날짜만
  보이도록 변경(HTML 텍스트 날짜/네이티브 Excel 날짜 셀 모두 지원).
  - Backend: `routers/jira.py` `_strip_inline_html()`, `_excel_date_only()`/`_parse_excel_date()`.
- **아이콘 picker — 브랜드 로고가 실제 브랜드 색이 아니라 단색(currentColor)으로 표시되던
  문제**: Kubernetes/Prometheus/Cilium/Keycloak 등 simple-icons 기반 아이콘이 전부
  `fill: currentColor` 라 주변 텍스트 색을 그대로 물려받아 브랜드를 구분하기 어려웠다 →
  simple-icons 가 아이콘마다 제공하는 공식 브랜드 hex 컬러(`si.hex`)로 채우도록 변경, 항상
  실제 로고 색으로 표시된다(StarRocks 는 이미 다색 원본이라 영향 없음).
  - Frontend: `lib/brandIcons.ts` `brand()` — `fill: currentColor` → `fill: #${si.hex}`.

## [1.1.0] - 2026-07-09

### Added
- **당일 스케줄 — 담당자 순환 전환**: "나만" 버튼이 로그인 유저의 실명으로 표시되고, 양옆 화살표로
  다른 담당자를 순환 선택해 그 사람의 당일 일정만 볼 수 있다("전체" 토글은 그대로 유지). 선택 상태는
  사용자별 localStorage 에 저장(구버전 나만/전체 값과 하위호환).
  - Frontend: `DayScheduleBoard.tsx` — `useAssignees()` 로 전체 담당자 목록 조회.
- **업무 현황 홈 — 주간 타임라인 "업무 등록" 팝업화**: 홈페이지 "담당자별 진행 현황" 주간 탭의
  "업무 등록" 버튼이 별도 페이지로 이동하지 않고 팝업(`WorkItemFormModal`)으로 바로 뜬다(업무 관리
  페이지와 동일한 패턴).
  - Frontend: `WeeklyStatusTimeline.tsx`.
- **`scripts/redeploy.sh` — 태그만 지정하는 `-t` 옵션 추가**: 매번 전체 이미지 참조를 입력하지
  않아도, `-t <tag>` 로 태그만 주면 각 `<deployment>:<container>` 의 현재 배포 이미지에서
  저장소 경로(레지스트리+repo)를 그대로 읽어와 태그만 바꿔친다. 레지스트리 포트(`host:5000/...`)나
  다이제스트 고정(`@sha256:...`) 이미지도 안전하게 처리. 기존 전체 이미지 참조 방식도 그대로 유지.
- **Jira Excel 가져오기 — 레거시 `.xls` 지원**: 기존 `.xlsx`/`.xlsm` 뿐 아니라 Excel 97-2003
  바이너리 형식(`.xls`)도 업로드 가능. 신규 라이브러리 `xlrd` 를 확장자 기준으로 분기 사용하고,
  헤더 매칭·담당자 매칭 등 파싱 이후 로직은 `.xlsx` 경로와 완전히 공유(행을 동일한 값-튜플
  형태로 정규화).
  - Backend: `xlrd==2.0.1` 추가, `routers/jira.py` `_read_xls_rows()`(날짜 셀→`datetime` 변환
    포함) + `import_excel` 확장자 분기.
- **freelens 파리티 — 파드 로그 뷰어 고도화**: SSE 실시간 스트림은 유지하면서 컨테이너 드롭다운
  (init 포함, `kubectl.kubernetes.io/default-container` 어노테이션 존중), previous(재시작 전) 로그,
  타임스탬프·word-wrap 토글, 검색(정규식 옵션·prev/next·하이라이트), 다운로드(보이는 로그/전체),
  react-virtuoso 가상화(버퍼 5천→2만 줄) 추가. K8s 관리 콘솔 파드 목록의 "로그" 버튼에서
  `?namespace=&pod=` 딥링크로 자동 시작.
  - Backend: `analyze.py` 로그 스트림에 `timestamps`/`since_seconds` 파라미터, 신규
    `GET .../pods/{pod}/containers`·`GET .../logs/download`(10MB 상한).
  - Frontend: 신규 `PodLogStream` 컴포넌트, `LogViewer` 의 ANSI strip·토큰 컬러를 `logLine.tsx` 로
    추출해 공유.
- **freelens 파리티 — xterm.js TTY 터미널**: 파드 터미널을 라인 기반 입력에서 xterm.js 진짜 TTY 로
  교체 — vi/top 등 풀스크린 앱 동작, 창 크기 변경 시 K8s exec resize 채널로 반영, 멀티컨테이너
  드롭다운. 권한(admin/operator)·감사로그·세션 상한은 기존 그대로.
  - Backend: `k8s_exec.py` WS 인바운드를 JSON 프로토콜(`stdin`/`resize`)로 확장(비 JSON 프레임은
    stdin 취급 — 하위호환). Frontend: `PodTerminal` xterm 재작성(deps `@xterm/xterm`, `@xterm/addon-fit`).
- **freelens 파리티 — Pods 목록 컬럼 확장**: CPU/MEM 즉시 사용량(metrics-server, 없으면 `-`+안내),
  Warning 이벤트 아이콘(건수·최신 reason 툴팁), 로그 바로가기 버튼. Backend 는 파드 목록과
  메트릭·이벤트를 병렬 best-effort 조회.
- **freelens 파리티 — 상세 드로어 이벤트 탭**: 리소스 상세 슬라이드오버에 관련 이벤트(involvedObject
  기준, 15초 자동 갱신) 탭 추가, workload 요약에 Conditions 섹션 추가.
  - Backend: `GET /k8s/{cluster}/resources/{kind}/{ns}/{name}/events`.
- **freelens 파리티 — CRD 프린터 컬럼**: CR 목록이 CRD 의 `additionalPrinterColumns`(jsonPath)를
  평가해 kubectl 과 동일한 컬럼을 표시(priority>0 제외, date 형은 age 표기). CR 의 Age 미표시 버그 수정.
- **freelens 파리티 — 리소스 커버리지 확장(읽기 전용)**: Leases, EndpointSlices, RuntimeClasses,
  Mutating/ValidatingWebhookConfigurations, ValidatingAdmissionPolicies(+Bindings) 추가.
  kind-availability 프로브가 미지원 클러스터에서 자동 숨김.
- **K8s 테이블 컬럼 표시/숨김**: 리소스/Pods/Nodes 테이블에 컬럼 토글 드롭다운 추가, 선택은
  localStorage(`pep:k8s:cols:*`)에 영속화.
- **이벤트 스트림 배칭·가상화**: 이벤트 SSE 를 1초 버퍼로 coalesce(같은 오브젝트 uid 는 최신만)
  후 일괄 렌더 + Virtuoso 가상화(캡 1천→5천). freelens 의 watch 버퍼 패턴을 P2/P3 수용 기준으로
  `docs/openlens-architecture-roadmap.md` 에 문서화.
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
  클릭 시 우측 슬라이드 SidePane 으로 버전별 변경 이력을 테이블(버전/날짜/요약)로 보여주고,
  행 클릭 시 섹션별(Added/Fixed/Changed 등) 상세 항목이 아래로 펼쳐짐. 수동 큐레이션 데이터
  사본이 아니라 `CHANGELOG.md` 를 직접 파싱해 항상 실제 릴리즈 내용과 정확히 일치.
  - Backend: `GET /api/v1/release-notes` (`release_notes` 라우터, `[Unreleased]` 섹션은 제외).
  - Frontend: `ReleaseNotesPanel`, `useReleaseNotes`.
  - Infra: `cd.yml`/`release.yml` 이 backend 이미지 빌드 직전 `CHANGELOG.md` 를 build context
    로 복사(release_notes 라우터가 이미지 안에서 읽을 수 있도록).
- **릴리즈 자동화(`auto-release.yml`)**: `feat:`/`fix:` 등 conventional commit prefix PR 이
  `main` 에 머지될 때마다 SemVer 버전을 자동으로 올리고(`feat:` → MINOR, 그 외 → PATCH)
  `CHANGELOG.md` 의 `[Unreleased]` 를 새 버전 섹션으로 확정, `chore(release)` PR 을 열어
  즉시 병합한 뒤 `vX.Y.Z` 태그를 push(→ 기존 `release.yml` 이 이어받아 GHCR 이미지 태깅 +
  GitHub Release 생성). 기존 수동 `/release` 절차(`docs/branch-tag-strategy.md`)는 hotfix/
  자동화 실패 시 fallback 으로 유지.
  - 버전 계산/CHANGELOG 확정 로직은 `scripts/release/bump_version.py` 로 분리해 로컬에서도
    검증 가능(`--dry-run`).

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
- **업무 캘린더 날짜 클릭 등록 — 시작일 시간표시 기본값 오류**: 업무 관리 캘린더 뷰에서 날짜를 클릭해
  여는 등록 패널이 시작일에 `T09:00` 을 하드코딩해 "시간 포함" 토글이 항상 켜진 채로 떴던 문제 →
  날짜만 전달해 다른 등록 경로(팝업/전체 페이지)와 동일하게 날짜만 기본 표시.
  - Frontend: `WorkItemCalendar.tsx`.
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
