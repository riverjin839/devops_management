# 화면 단위 명세서 (Screens Reference)

PEP(Platform Engineering Portal)의 모든 화면(라우트)을 화면 단위로 정리한 문서입니다.
소스 코드(`frontend/src/pages/`, `frontend/src/services/api.ts`, `backend/app/routers/`)를 직접 읽어 생성했습니다.

> 최종 검증: 2026-07-17 (v1.6.0 기준). CI 의 `docs-sync` 검사가 `App.tsx` 의 모든 라우트가
> 이 문서에 섹션으로 존재하는지 자동 확인한다 — 새 라우트 추가 시 섹션도 함께 추가할 것
> (헤딩에 `` `/route` `` 백틱 표기 필수).

## 사용법

- 이 문서는 **여러분이 직접 편집**하는 것을 전제로 합니다. 각 화면 섹션 맨 아래 **"요청사항 (수정 요청)"** 항목에
  개선/버그/기능 요청을 자유롭게 적어주세요.
- 이후 Claude Code 세션에서 "docs/SCREENS.md 의 `<화면명>` 요청사항 반영해줘" 처럼 이 문서를 가리켜 대화하면,
  화면별 현재 구조(Frontend/Backend/기능)를 이미 파악한 상태로 바로 작업을 시작할 수 있습니다.
- 화면 구조 자체가 코드 변경으로 달라지면 이 문서도 오래된 내용이 될 수 있습니다 — 구조가 크게 바뀐 화면은
  해당 섹션을 다시 조사해 갱신해달라고 요청하세요.
- CLAUDE.md 의 UI/아키텍처 컨벤션(ClusterSidebar iconOnly 패턴, MacCard, `_safe_*` 마이그레이션 헬퍼 등)이
  이 문서의 "표준" 판단 기준입니다.

## 목차

1. [홈 / 인증 / 시스템](#홈--인증--시스템)
2. [클러스터 — 모니터링 / 리소스 관리](#클러스터--모니터링--리소스-관리)
3. [클러스터 — 운영 점검 / 로그·분석 / Pod 병목](#클러스터--운영-점검--로그분석--pod-병목)
4. [클러스터 — 관리 / 버전 / 실행 콘솔 / LAKE / APM](#클러스터--관리--버전--실행-콘솔--lake--apm)
5. [서버·인프라 / 네트워크 / 스토리지](#서버인프라--네트워크--스토리지)
6. [DevOps — Playbook / Batch Job / 명령어](#devops--playbook--batch-job--명령어)
7. [협업 — 업무 관리 / 스프린트 / 워크플로우](#협업--업무-관리--스프린트--워크플로우)
8. [PEP 서비스 (LAKE 기반, 구) / APP 서비스](#pep-서비스-lake-기반-구--app-서비스)
9. [지식 허브 (사이드바 아이콘 없음 — 직접 URL 접근)](#지식-허브-사이드바-아이콘-없음--직접-url-접근)

각 그룹은 사이드바(`frontend/src/components/layout/navConfig.ts`)의 그룹 분류(클러스터/서버·인프라/네트워크/
스토리지/DevOps/협업/PEP 서비스/APP 서비스/시스템)를 기준으로 나눴습니다. 사이드바 "PEP 서비스"
아이콘은 서비스 카탈로그 / 통합지식(`/services`, §9 참고)으로 연결되며, 과거 이 아이콘이 가리키던
LakeService 기반 화면(`/pep-services`)은 §8 에 "구" 표기로 남아 직접 URL 로만 접근 가능하다.

---

## 홈 / 인증 / 시스템

### 홈 (`/`)

- **파일**: `frontend/src/pages/HomePage.tsx` (+ `components/dashboard/MemberTodayTodos.tsx`, `WorkCalendar.tsx`, `WeeklyStatusTimeline.tsx`, `DayScheduleBoard.tsx`, `components/platform-status/{PlatformStatusMatrix,CheckMatrixCellDetailModal,CheckMatrixItemFormModal,CheckMatrixSettingsModal}.tsx`, `components/layout/WorkAlarmBell.tsx`)
- **목적 / UX**: 로그인 후 가장 먼저 보는 랜딩 화면. 좌측 상단 홈 버튼으로 "업무 현황"(work) ↔ "플랫폼 현황"(platform) 두 모드를 토글하며, 상단 고정 스트립에는 내 할일/미해결 이슈/위험 클러스터/다음 일정 KPI 필과 업무 알람 종이 항상 노출된다.
- **UI 구성**:
  - 공통 상단 스트립: 사용자명 + 날짜, KPI 필 4종(`내 할일`→`/todo-today`, `미해결 이슈`→`/items`, `위험 클러스터`→`/cluster-overview`, `다음 일정`→`/items`), `WorkAlarmBell`.
  - **업무(work) 모드**: 좌측 `DayScheduleBoard`(당일 시간단위 스케줄), 우측 "담당자별 진행 현황" 카드 내부 탭 3종(주간=`WeeklyStatusTimeline`, 월간=`WorkCalendar`, 담당자=`MemberTodayTodos`, 기본 탭은 `week`). `WeeklyStatusTimeline`(주간, 담당자 기준 스윔레인)은 담당자별 기본 5건 표시 + "더보기/접기", 항상 최상단 "공통" 요약 행(본인 행보다 위 — 개별 담당자 업무 전체 병합이 아니라 파트 전체 대상 업무만, `allAttendees=true`), 화면당 표시 인원 수 제한(기본 20명, 옵션 10/20/30/50, localStorage 저장), 축소된 라인 밀도(24px 레인)를 지원. `MemberTodayTodos`(담당자 탭)도 동일하게 최상단 "공통" 카드(`allAttendees=true` 항목만)를 노출한다.
  - **플랫폼(platform) 모드**: `PlatformStatusMatrix` — 행(점검 항목) × 열(등록된 클러스터) 매트릭스. 첫 열은 sticky(항목명 + 위/아래 이동 버튼 + hover 시 수정/삭제 아이콘, 시스템 항목은 삭제 버튼 숨김), 클러스터 열 헤더는 이름 + cron 배지(클릭 시 팝오버로 `Cluster.check_cron_expr` 편집), 셀은 상태 dot + 값/라벨(클릭 시 `CheckMatrixCellDetailModal` — 기간별 트렌드 차트 + 변경 이력 + manual 항목이면 값 입력 폼 + core_bundle 이외 항목이면 항목×클러스터 cron 편집). 카드 헤더에 "항목 추가"(`CheckMatrixItemFormModal`) + 설정 톱니바퀴(`CheckMatrixSettingsModal`, 이력 보관 일수) 버튼. 하단 "플랫폼 도메인" 퀵 액세스(`DomainQuickAccess`)는 제거됨.
  - ClusterSidebar 미사용(홈은 특정 클러스터에 종속되지 않음).
- **Frontend**: `useHomeStore`(Zustand, `mode`/`scheduleBg`, localStorage 키 `pep:homeMode`/`pep:scheduleBg`) · `useAuthStore`(user) · `useClusterStore` + `useClusters()`(TanStack Query) · `useWorkItems()`(TanStack Query) · 플랫폼 모드는 `hooks/useCheckMatrix.ts`(`useCheckMatrixGrid`/`useCheckMatrixItems`/`useReorderCheckMatrixItems`/`useDeleteCheckMatrixItem`/`usePutClusterCron`/`usePutSchedule`/`usePostManualEntry`/`useCheckMatrixCellHistory`/`useCheckMatrixSettings`). 로컬 state: `weeklyTab`.
- **Backend**: `GET /api/v1/clusters`(`clusters.py`) · `GET /api/v1/work-items`(`work_items.py`) · 플랫폼 모드는 `check_matrix.py` 라우터(prefix `/check-matrix`): `GET /items`, `POST/PUT/DELETE /items(/{id})`, `POST /items/reorder`, `GET /grid`, `GET /cell/{item_id}/{cluster_id}/history`, `POST /cell/{item_id}/{cluster_id}/manual-entry`, `PUT /schedule/{item_id}/{cluster_id}`, `PUT /clusters/{cluster_id}/cron`, `GET/PUT /settings`. 실행/집계는 `services/check_matrix_service.py`(`build_grid`/`get_cell_history`/`dispatch_due`/`purge_expired_logs`/`seed_default_items`). 구 `daily-check/summary` 기반 `InfraHealthBar`/`DailyCheckReviewPanel`/`IncidentMiniPanel`(2026-07 이전) 및 `CheckSchedule`(아침/점심/저녁 온오프) 스케줄 체계는 **완전히 대체·제거**되었다 — 상세는 `check_matrix.py` 모델 주석 및 CHANGELOG 참고.
- **핵심 기능**:
  - work/platform 2-모드 전환(세션 중에는 localStorage 유지, 단 **로그인할 때마다 항상 `'work'`로 리셋** — `authStore.setSession()`에서 강제).
  - 담당자별 진행 현황을 주간/월간/담당자 3가지 뷰로 전환, 업무 모드 스케줄 배경색(흰색/크림) 커스터마이즈(`SettingsPage`의 화면 UI 설정 탭에서 변경).
  - 플랫폼 모드: 클러스터 상태에 영향을 주는 핵심 점검(API 서버 응답시간, `is_system=true`, 삭제 불가)은 클러스터 열의 cron(`Cluster.check_cron_expr`)으로, 그 외 자동 점검(deep_check/addon 소스)과 수동 항목은 항목×클러스터별 cron(`CheckMatrixSchedule`, 5분 미만 간격 거부)으로 독립 스케줄. `Cluster.status`는 `DailyChecker.run_daily_check()`(무변경)가 여전히 유일한 authoritative 소스이며 `check-matrix-dispatch` Celery Beat(매분)가 due 한 클러스터에 대해 그대로 호출한다.
  - 셀 이력은 `CheckMatrixResultLog`에 append-only 저장되고, 설정한 보관 일수를 초과하면 `check-matrix-log-purge` Beat(매일 03:00 KST)가 청크 삭제로 정리한다.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 로그인 (route guard, `AuthGate`)

- **파일**: `frontend/src/pages/LoginPage.tsx` (+ `frontend/src/components/auth/AuthGate.tsx`)
- **목적 / UX**: 별도 라우트 경로 없이 앱 전체를 감싸는 `AuthGate`가 유효한 세션(token+user)이 없으면 자동으로 `LoginPage`를 렌더링하는 방식의 게이트. 사용자명/비밀번호로 로그인하면 세션이 저장되고 `AuthGate`가 재렌더링되어 원래 화면으로 자연 전환된다(수동 navigate 없음).
- **UI 구성**:
  - 중앙 정렬 단일 카드(`max-w-sm`): 로고+타이틀("DEVOPS MANAGEMENT" / "로그인"), 사용자명·비밀번호 입력, 에러 메시지(`role="alert"`), 로그인 버튼(제출 중 스피너).
- **Frontend**: 로컬 state만 사용(`username`, `password`, `error`, `submitting`) — TanStack Query/Zustand 쿼리 훅 없음. `useAuthStore((s) => s.setSession)`으로 세션 저장. 호출 함수: `authApi.login(username, password)`. `authStore.setSession()` 내부에서 `useHomeStore.getState().setMode('work')`를 함께 호출해 홈 모드를 리셋한다.
- **Backend**: `POST /api/v1/auth/login` (`backend/app/routers/auth.py`) — `User` 모델(`backend/app/models/user.py`) 조회 후 `verify_password` 검증, 성공 시 `create_access_token`으로 JWT 발급 + `audit_logger.record(action="login.success"/"login.failure")` 감사 로그 기록. 실패 시 401 + 한글 상세 메시지.
- **핵심 기능**:
  - 사용자명/비밀번호 로그인, JWT + `AuthUser` 세션을 `localStorage`(`k8s:auth:token`, `k8s:auth:user`)에 저장.
  - 로그인 성공 시 `useHomeStore` 모드를 항상 `'work'`(업무 현황)로 강제 리셋 — 이전 세션에서 플랫폼 현황으로 전환해뒀어도 로그인 직후에는 항상 업무 현황부터 보여준다(로그인 이후 토글은 자유롭게 가능, 그 상태는 다음 로그인 전까지만 유지).
  - 로그인 성공/실패 모두 감사 로그(`audit_logs`)에 기록.
  - 401 등 실패 응답의 `detail`을 그대로 폼 하단에 노출.
  - 이후 모든 API 호출은 axios 인터셉터가 저장된 token을 `Authorization: Bearer` 헤더로 첨부(`get_current_user`가 `OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")`로 검증).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 비밀번호 변경 (`/me/change-password`)

- **파일**: `frontend/src/pages/ChangePasswordPage.tsx`
- **목적 / UX**: 로그인한 사용자가 사용자 메뉴에서 진입해 본인 비밀번호를 직접 변경하는 셀프서비스 화면. 성공 시 토스트 없이 화면 내 성공 메시지 표시 후 0.8초 뒤 이전 화면(`navigate(-1)`)으로 돌아간다.
- **UI 구성**:
  - 중앙 정렬 카드(`max-w-md`): 현재 비밀번호 / 새 비밀번호 / 새 비밀번호 확인 3개 입력, 에러(`role="alert"`)·성공(`role="status"`) 메시지, "비밀번호 변경"/"취소" 버튼.
- **Frontend**: 로컬 state만 사용(`currentPassword`, `newPassword`, `confirmPassword`, `error`, `success`, `submitting`). `useAuthStore`에서 `user`, `setUser` 사용. 프론트단 검증(4자 이상, 확인 일치, 현재 비밀번호와 동일하면 거부)을 먼저 수행 후 `authApi.changeMyPassword(currentPassword, newPassword)` 호출.
- **Backend**: `POST /api/v1/auth/me/password` (`backend/app/routers/auth.py`, `SelfPasswordChangeRequest` 스키마) — `get_current_user` 의존성으로 본인 확인, `verify_password`로 현재 비밀번호 검증 후 `hash_password`로 갱신, `must_change_password=False`로 리셋, `audit_logger.record(action="user.password.change")` 기록. 응답은 세션 갱신 이슈 방지를 위해 `UserOut`을 명시적으로 재구성해 반환.
- **핵심 기능**:
  - 현재/신규/확인 3중 검증 후 비밀번호 변경.
  - 변경 성공 시 `mustChangePassword: false`로 로컬 `AuthUser` 갱신(`setUser`) → 강제 변경 플로우 해제.
  - 실패 시(현재 비밀번호 불일치, 신규=기존과 동일 등) 서버 `detail` 메시지를 그대로 노출.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 사용자 관리 (`/settings/users`, admin)

- **파일**: `frontend/src/pages/UsersPage.tsx` (+ `components/auth/RoleGate.tsx`, `components/ui/MacCard.tsx`, `components/common`의 `ConfirmDialog`/`useToast`)
- **목적 / UX**: admin 전용 계정 관리 화면. 사용자 목록 조회/생성/역할 변경/비밀번호 재설정/삭제를 한 화면에서 수행. `RoleGate allow={['admin']}`로 프론트 접근을 막고, 백엔드도 `require_admin`으로 이중 차단하며, 본인 강등/삭제는 UI(select/삭제 버튼 disabled)와 서버 양쪽에서 금지된다.
- **UI 구성**:
  - `MacCard title="사용자 관리"` 단일 카드.
  - 상단: 역할 설명 텍스트, "새로고침"/"새 사용자" 버튼.
  - 사용자 테이블(사용자명/표시 이름/역할 select/생성일/작업 열) — 본인 행은 역할 select 대신 `RoleBadge`만 표시.
  - 모달 3종: `CreateModal`(사용자명/초기 비밀번호/표시이름/역할), `ResetPasswordModal`(대상 사용자 비밀번호 재설정), `ConfirmDialog`(삭제 확인).
- **Frontend**: `useQuery(['users'], authApi.listUsers)` · `useMutation`(역할 변경 `authApi.updateUserRole`, 삭제 `authApi.deleteUser`) — 성공 시 `qc.invalidateQueries(['users'])` + `useToast()`. `useAuthStore((s) => s.user)`로 본인(`me`) 식별. 모달 내부는 로컬 state로 `authApi.createUser` / `authApi.resetPassword` 직접 호출 후 수동 invalidate.
- **Backend**: `GET /api/v1/auth/users`(목록) · `POST /api/v1/auth/users`(생성) · `PUT /api/v1/auth/users/{id}/role`(역할 변경) · `POST /api/v1/auth/users/{id}/password`(비밀번호 재설정) · `DELETE /api/v1/auth/users/{id}`(삭제) — 모두 `backend/app/routers/auth.py`, `Depends(require_admin)`. `User` 모델(`backend/app/models/user.py`, role: `admin`/`operator`/`viewer`). 자기 자신 대상 삭제/역할변경은 서버에서 400으로 거부, 모든 변경은 `audit_logger.record(action="user.create"/"user.delete"/"user.role.update")`로 감사 로그 남김.
- **핵심 기능**:
  - 사용자 CRUD(생성/역할변경/비밀번호 재설정/삭제) 및 역할 3단계(viewer/operator/admin) 관리.
  - 본인 계정 자기 강등·자기 삭제 이중(FE+BE) 차단.
  - 모든 변경사항이 감사 로그(`audit_logs`, `SettingsPage` → 감사 로그 탭)에 자동 기록.
  - 목록 실패 시 에러 메시지 인라인 노출, 각 뮤테이션 성공/실패 토스트.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 시스템 설정 (`/settings`, admin)

- **파일**: `frontend/src/pages/SettingsPage.tsx` (+ `components/settings/BackupRestorePanel.tsx`, `FeatureAccessManager.tsx`, `JiraIntegrationPanel.tsx`, `OperationLevelsManager.tsx`, `ServiceCatalogManager.tsx`, `LakeServiceTypeManager.tsx`, `NavMenuManager.tsx`, `PageStyleManager.tsx`, `TerminalAppearanceSettings.tsx`, `AssigneeManager.tsx`, `AuditLogManager.tsx`, `components/dashboard`의 `AddClusterModal`/`KubeconfigEditModal`, `components/common`의 `ClusterIconPicker`)
- **목적 / UX**: 클러스터·관리서버·담당자·운영레벨·서비스 카탈로그·화면 UI·접근제어·Jira 연동·Debug·백업/복구·감사로그까지 플랫폼 전역 설정을 12개 탭으로 모아둔 관리자 콘솔.
- **UI 구성**:
  - 탭 바(`TabId`): `클러스터`/`관리서버`/`담당자`/`운영레벨`/`서비스`/`LAKE 타입`/`화면 UI 설정`/`접근 제어`/`연동 (Jira)`/`Debug`/`백업 / 복구`/`감사 로그`, 각 탭 배지에 카운트 표시.
  - `클러스터` 탭: 상태 요약 카드 4개(전체/Healthy/Warning/Critical) + 클러스터 리스트(아이콘 picker, 연결확인/Kubeconfig 보기/수정/삭제 버튼, 아이콘 일괄 생성 버튼) + `AddClusterModal`/`EditClusterModal`(페이지 내부 정의)/`KubeconfigEditModal`.
  - `관리서버` 탭: Jump Host/Bastion/관리서버 목록 + ping/수정/삭제 + `ManagementServerModal`(페이지 내부 정의).
  - `화면 UI 설정` 탭: 홈 화면 설정(업무/플랫폼 모드별 홈 아이콘 picker, 스케줄 배경색 흰색/크림), `NavMenuManager`, `PageStyleManager`, `TerminalAppearanceSettings`.
  - 나머지 탭은 각각 전용 매니저 컴포넌트를 그대로 렌더(운영레벨/서비스/LAKE타입/담당자/접근제어/Jira/백업/감사로그).
  - ClusterSidebar 미사용(전역 설정 화면이라 클러스터 단위 필터 없음).
- **Frontend**: `useClusters()`+`useClusterStore`, `useUpdateCluster()`, `useDeleteCluster()`(`hooks/useCluster.ts`) · `useAssignees()`(담당자 카운트) · `useUiSettings()`/`useUpdateUiSettings()`(`hooks/useUiSettings.ts`) · `useOperationLevels()`(`hooks/useOperationLevels.ts`) · `useHomeStore`(`scheduleBg`) · `useDebugStore`(Debug 탭 토글, localStorage) · `useQuery(['management-servers'], managementServersApi.getAll)` + `useMutation`(`managementServersApi.delete`). 직접 호출 api 함수: `clustersApi.verify`, `managementServersApi.ping/create/update/delete`, `updateClusterMut.mutateAsync`(아이콘 저장 포함).
- **Backend**: `GET/PUT/DELETE /api/v1/clusters`, `POST /api/v1/clusters/{id}/verify`(`clusters.py`) · `GET/POST/PUT/DELETE /api/v1/management-servers`, ping 엔드포인트(`management_servers.py`) · `GET/PATCH /api/v1/ui-settings`(홈 아이콘 등, `ui_settings.py`, `AppSetting` 모델 기반 key-value 저장: `UI_SETTINGS_KEY`/`OPERATION_LEVELS_KEY`/`ASSIGNEES_KEY`/`FEATURE_ACCESS_KEY`) · 담당자/운영레벨/서비스카탈로그/Jira/백업/감사로그는 각 하위 매니저 컴포넌트가 별도 라우터(`work_item_custom_fields.py`, `jira.py`, `backup.py`, `audit_logs.py` 등) 호출.
- **핵심 기능**:
  - 클러스터 등록/수정/삭제/연결확인(Verify)/Kubeconfig 조회·수정/아이콘 설정(단건+일괄 생성).
  - 관리서버(Jump Host/Bastion 등) 등록/수정/삭제/Ping 상태 확인.
  - 홈 화면 아이콘(업무/플랫폼 모드별) 및 업무 스케줄 배경색 커스터마이즈.
  - 담당자/운영레벨/서비스 카탈로그/LAKE 타입/접근 제어/Jira 연동/Debug 로그/백업·복구/감사 로그 등 전역 운영 설정을 탭 단위로 통합 관리.
  - Debug 탭은 페이지별 API 호출 로그 패널 토글(localStorage 저장, 서버 상태 아님).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## 클러스터 — 모니터링 / 리소스 관리

### 클러스터 대시보드 (`/cluster-overview`)

- **파일**: `frontend/src/pages/Dashboard.tsx` (+ `components/dashboard/{SummaryStats,AddonGrid,MetricCardGrid,KanbanSummaryCharts,ClusterItemsGrid,AddClusterModal,AddAddonModal,AddMetricCardModal,KubeconfigEditModal,ClusterItemModal}`, `components/playbooks/{PlaybookCard,AddPlaybookModal,RunCredsModal}`)
- **목적 / UX**: PEP 의 오리지널 핵심 화면. 등록된 K8s 클러스터의 헬스(API 서버/컨트롤플레인/etcd/노드/애드온), PromQL 기반 Prometheus 인사이트, 대시보드 노출용 Ansible 플레이북, 업무 현황(칸반)을 한 화면에서 훑고 즉시 점검(Run Check)을 트리거하는 랜딩 화면.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + `allowAll`(`allLabel="전체 현황"`) 단일 선택. "전체 현황" 선택 시 `ClusterOverviewGrid`(클러스터별 카드 그리드)로 전환.
  - 상단 sticky 툴바 — Cluster/Check/Metric 추가 버튼, Daily Report(.md/.csv) 다운로드, Kubeconfig 편집, Run Check.
  - `현황 아이템` MacCard(단일 클러스터 선택 시만) — `ClusterItemsGrid` (사용자 정의 카드, 실행/리사이즈/삭제).
  - `Cluster Status` MacCard — `AddonGrid`(애드온별 헬스 카드) 또는 미연결(pending) 시 grayscale 오버레이 안내.
  - `Prometheus Insights` MacCard — `MetricCardGrid`(PromQL 카드).
  - 2단 그리드: `Playbook Checks`(대시보드 노출 플레이북) ↔ `업무 현황`(`KanbanSummaryCharts`).
- **Frontend**: `useClusters`/`useSummary`/`useAddons`/`useHealthCheck`/`useCreateAddon`/`useDeleteAddon`/`useAddonHealthCheck` (`hooks/useCluster.ts`), `useDashboardPlaybooks`/`useRunPlaybook`/`useDeletePlaybook`/`useToggleDashboard`/`useUpdatePlaybook` (`hooks/usePlaybook.ts`), `useMetricCards`/`useMetricResults`/`useDeleteMetricCard` (`hooks/useMetricCards.ts`), `useClusterItems`/`useRunClusterItem`/`useUpdateClusterItem`/`useDeleteClusterItem`, `useWorkItems`. Zustand: `useClusterStore`(clusters/summary/addons/isChecking), `usePlaybookStore`(runningIds). `healthApi.exportReport()` 직접 호출(리포트 다운로드).
- **Backend**: `GET /api/v1/clusters`, `GET /api/v1/health/summary`, `GET /api/v1/health/addons/{clusterId}`, `POST /api/v1/health/check/{clusterId}`, `POST /api/v1/health/check/{clusterId}/addons/{addonId}`, `POST/PUT/DELETE /api/v1/health/addons...`, `GET /api/v1/health/report` — 라우터 `backend/app/routers/health.py` + `clusters.py`. 서비스: `services/daily_checker.py`(`DailyChecker`), `services/health_checker.py`, `services/checkers/*`(argocd/control_plane/etcd/jenkins/keycloak/nexus/node/system_pod). 모델: `models/cluster.py`(`Cluster`, `StatusEnum`), `models/addon.py`(`Addon`), `models/metric_card.py`.
- **핵심 기능**:
  - 클러스터 전체/개별 헬스 체크 실행 및 실시간 상태 반영.
  - 애드온(체크 항목) CRUD, 기본 애드온(etcd Leader/Node Status/Control Plane/CoreDNS) 일괄 추가.
  - PromQL 메트릭 카드 조회/추가/편집/삭제.
  - 대시보드 노출 플레이북 실행(SSH 자격증명 세션 캐시 지원) 및 토글.
  - 클러스터별 커스텀 "현황 아이템" 카드 실행/리사이즈.
  - Daily Report(.md/.csv) 익스포트, Kubeconfig 편집 모달.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### K8s 상세 관리 (`/k8s-manage`, `/k8s-manage/:clusterId`)

- **파일**: `frontend/src/pages/K8sManagePage.tsx` (단일 파일 1147줄 — `ResourceTablePanel`/`NodesPanel`/`PodsPanel`/`OverviewPanel`/`HelmPanel`/`CrdPanel`/`DetailDrawer`를 내부 정의), + `components/k8s/{PodTerminal,EventsStream,NamespaceMultiSelect,ColumnToggle}`, `components/common/LogViewer`, `components/auth/RoleGate`.
- **목적 / UX**: Lens/OpenLens 스타일의 K8s 리소스 탐색기. 좌측 카테고리 내비(Cluster/Nodes/Workloads/Config/Network/Storage/Namespaces/Events/Helm/AccessControl/CRD)로 리소스 종류를 전환하며 목록 조회, YAML 상세/편집, scale/restart/delete/cordon/drain 같은 쓰기 작업, Pod 터미널·이벤트 확인까지 한 화면에서 처리.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` 단일 선택(`allowAll` 없음), URL 파라미터(`:clusterId`) 동기화.
  - 두 번째 sticky 사이드바 — Lens 식 카테고리 내비(`NAV` 상수, `kindAvailability` 응답으로 존재하는 kind만 노출).
  - 리소스별 패널: `NodesPanel`(cordon/drain 포함 노드 전용 컬럼), `PodsPanel`(터미널 진입), 그 외 kind는 공통 `ResourceTablePanel`(Virtuoso 가상 스크롤, 네임스페이스 멀티셀렉트, 컬럼 토글, 검색).
  - `OverviewPanel`(노드/네임스페이스 통계), `HelmPanel`(릴리스 목록 + values 보기), `CrdPanel`(CRD 목록 → 오브젝트 드릴다운), `EventsStream`(events 탭).
  - `DetailDrawer` — 우측 슬라이드 패널(요약/YAML/이벤트 탭), `RoleGate(['admin','operator'])`로 편집·쓰기 UI 게이팅, viewer는 읽기 전용 배지.
  - `PodTerminal` 모달(WebSocket exec).
- **Frontend**: 별도 커스텀 hook 없이 TanStack `useQuery` 직접 사용(`k8s-mng-list`/`k8s-mng-nodes`/`k8s-mng-helm`/`k8s-mng-crds`/`k8s-mng-yaml`/`k8s-caps`/`k8s-avail` 등 쿼리키), `useColumnPrefs`(컬럼 표시/숨김 로컬 저장). `useClusters`. api.ts: `k8sResourcesApi.{list,yaml,resourceEvents,capabilities,kindAvailability,richNodes,richPods,scale,restart,remove,apply,cordon,drain,crds,crdObjects,crdObjectYaml}`, `k8sHelmApi.{releases,values}`.
- **Backend**: 라우터 `backend/app/routers/k8s_resources.py`(prefix `/k8s`) — `GET /k8s/{id}/resources/{kind}`, `GET .../yaml`, `GET .../events`, `POST .../scale`, `POST .../restart`, `DELETE .../{kind}/{ns}/{name}`, `PUT .../yaml`, `POST /k8s/{id}/nodes/{name}/cordon`, `POST /k8s/{id}/nodes/{name}/drain`, `GET /k8s/{id}/crds(...)`, `GET /k8s/{id}/resources-capabilities`, `GET /k8s/{id}/nodes`, `GET /k8s/{id}/pods`, `GET /k8s/{id}/kind-availability`; `backend/app/routers/k8s_helm.py`(`/k8s/{id}/helm/releases(...)`); Pod 터미널은 `backend/app/routers/k8s_exec.py`(`WS /k8s/{id}/exec`). kubectl/kubernetes SDK 직접 호출 기반 서비스 계층(요청 시점 즉시 조회, DB 캐시 없음).
- **핵심 기능**:
  - 20여 종 K8s 리소스 종류별 목록/검색/네임스페이스 필터/컬럼 커스터마이즈.
  - YAML 보기·편집(apply), scale/restart/delete/cordon/drain 등 쓰기 액션(operator/admin만).
  - CRD 자동 탐색 + 오브젝트 목록/YAML(additionalPrinterColumns 파리티).
  - Helm 릴리스 목록 및 values 조회(읽기 전용).
  - Pod exec 터미널, 리소스별 관련 이벤트 탭, 실시간 이벤트 스트림.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### K8S 자원 관리 (`/k8s-allocation`, `/k8s-allocation/:clusterId`)

- **파일**: `frontend/src/pages/K8sAllocationPage.tsx` (단일 파일 1231줄 — `SummarySection`/`PodScheduleCalc`/`NodesView`/`NamespacesView`/`NsRankingView` 등 내부 정의), + `components/common/{EmptyState,Skeleton,SnapshotProgressCard,SnapshotProgressBar,ExportMenu}`.
- **목적 / UX**: 노드/네임스페이스/워크로드별 request 대비 실사용량(slack)을 진단해 과할당(낭비) · 과사용(위험) 파드를 찾는 용량 계획 화면. "얼마나 더 스케줄할 수 있는가", "어디서 자원이 낭비되고 있는가"를 시각화.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` 단일 선택.
  - `클러스터 요약` MacCard — 노드/NS/Pod 수, CPU/MEM 할당효율·사용효율 스탯(물음표 툴팁 — 상단에 "관점" 한 줄 안내: 할당효율은 쿠버네티스 스케줄러 기준, 사용효율은 노드 실사용 기준), `PodScheduleCalc`(CPU/MEM 입력 → 스케줄 가능 Pod 수 계산기), 할당 가용/추정 낭비 라인.
  - `PodCapacityStatusCards` — `클러스터 요약` 바로 아래 2-카드 행: **POD 용량**(스케줄 가능 Pod/전체 Pod/전체 할당 가능 Pod, 크기 무관 슬롯 기준) · **POD 상태**(running/pending/error/failed/succeeded/unknown 종류별 수치). 카드 헤더의 새로고침 버튼으로 카드별 즉시 재조회.
  - 3-탭 전환(`view`): `NodesView`(카드/테이블 뷰 토글, 정렬·검색·CSV 내보내기), `NamespacesView`(네임스페이스 → 워크로드 → 파드 드릴다운), `NsRankingView`(req vs 실사용 막대 랭킹 차트).
  - 자동갱신 셀렉트(끔/15초~5분), `ExportMenu`(화면 캡처/내보내기), 누적 집계 진행률 `SnapshotProgressBar`/`SnapshotProgressCard`(computing 상태 폴링).
- **Frontend**: `useAllocNodes`/`useAllocNamespaces`/`useAllocWorkloads`/`useAllocPods`/`useRefreshAllocNode`/`useRefreshAllocNamespace`/`useForceAllocRefresh`/`usePodsSummary` (`hooks/useK8sAllocation.ts`, `HOLD_OPTS`로 자동 재페치 억제 + computing 시 1.5s 폴링; `usePodsSummary` 는 `staleTime` 30s 의 일반 쿼리). api.ts: `k8sAllocationApi.{nodes,node,namespaces,namespace,workloads,pods}`, `k8sResourcesApi.podsSummary`.
- **Backend**: 라우터 `backend/app/routers/k8s_allocation.py`(prefix `/k8s`) — `GET /k8s/{id}/allocation/nodes`, `GET .../nodes/{node}`, `GET /k8s/{id}/allocation/namespaces`, `GET .../namespaces/{ns}`, `GET .../namespaces/{ns}/workloads`, `GET .../workloads/{kind}/{name}/pods`. `refresh=true` 쿼리로 강제 재집계, 미완료 시 `status: "computing"` + `processed/total/progress` 로 부분 결과 스트리밍(폴링 기반). Pod 용량/상태 카드는 `backend/app/routers/k8s_resources.py` 의 `GET /k8s/{id}/pods-summary`(노드+파드 병렬 조회, allocation 라우터와 별도 — 컨테이너 상태 기반 error 분류 포함) 사용.
- **핵심 기능**:
  - 노드별 allocatable vs request vs 실사용(메트릭 서버 있으면) 게이지/미터 바.
  - 클러스터 CPU/MEM 할당효율·사용효율 계산 및 경고 임계치(30%/50%/90%/105%).
  - "얼마나 더 스케줄 가능한가" 계산기(노드별 CPU/MEM/max-pods 제약 반영) + 크기 무관 스케줄 가능/전체/할당 가능 Pod 수 카드.
  - Pod 상태별(running/pending/error 등) 카운트 카드 — 카드별 개별 새로고침.
  - 네임스페이스별 비효율(req−use) 랭킹 차트, 네임스페이스→워크로드→파드 드릴다운.
  - 개별 노드/네임스페이스 단위 즉시 재계산, CSV 내보내기, 화면 캡처 내보내기.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### k9s 콘솔 (`/k9s`, `/k9s/:clusterId`)

- **파일**: `frontend/src/pages/K9sPage.tsx` + `frontend/src/components/k8s/K9sTerminal.tsx`(xterm.js 터미널) + `components/common/{ClusterSidebar,EmptyState}`, `components/ui/MacCard`.
- **목적 / UX**: 각 클러스터의 control-plane(master) 서버에 **SSH 로 접속해 서버에 내장된 `k9s` TUI 를 그대로 웹 터미널로 스트리밍**한다. 별도 재구현이 아니라 실제 k9s 를 브라우저에서 조작(파드/노드/디플로이 탐색, 로그, describe 등)한다.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` 단일 선택. 클러스터를 고르면 `/k9s/:clusterId` 로 이동.
  - **접속 폼**(연결 전): `타겟` MacCard(master 노드 후보 드롭다운 — etcdctl master-candidates 재사용 · 수동 host override · 사용자 · 포트), `인증·실행` MacCard(비밀번호/Private Key 토글 · 네임스페이스(선택) · `--readonly` 토글 · 연결 버튼).
  - **터미널**(연결 후): `K9sTerminal` — xterm.js 풀스크린 TUI(재연결/전체화면/종료 헤더). WebSocket `onopen` 직후 SSH 자격증명을 **init 프레임**(JSON)으로 전달(비밀번호가 URL/로그에 남지 않도록), 이후 stdin/resize 프레임 전송.
- **Frontend**: `useClusters`, `etcdctlApi.masters`(master 후보), `k8sStreamUrls.k9s(clusterId, token)`(WS URL). 자격증명은 서버에 저장하지 않고 세션에서만 사용.
- **Backend**: 라우터 `backend/app/routers/k9s_ssh.py`(prefix `/k8s`) — WebSocket `GET /k8s/{cluster_id}/k9s`. 전역 `_auth` 미적용, 핸들러가 query token 을 직접 검증(admin/operator 만) 후 accept. init 프레임의 host/자격증명으로 `ssh_runner.connect_client` → paramiko `invoke_shell`(PTY) → `exec k9s [-n ns] [--readonly]` 실행, stdout/stdin/resize 브리지. 세션 open/close 감사 로그(`k9s.ssh.open`/`k9s.ssh.close`). `PEP_K9S_SSH_ENABLED=false` 로 비활성화. 명령은 서버가 검증된 조각(네임스페이스 정규식·화이트리스트 플래그)으로만 조립.
- **핵심 기능**:
  - control-plane 서버 내장 k9s 를 웹에서 실시간 조작(풀스크린 TUI, tty+resize).
  - master 노드 후보 자동 조회 + 수동 host override, 비밀번호/Private Key 인증.
  - 네임스페이스 지정·읽기 전용(`--readonly`) 옵션, 1시간 세션 상한.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 클러스터 추이 (`/cluster-trends`, `/cluster-trends/:clusterId`)

- **파일**: `frontend/src/pages/ClusterTrendsPage.tsx` (+ `components/k8s/NodeMultiSelect.tsx`, `components/common/EmptyState.tsx`, Recharts `LineChart`).
- **목적 / UX**: 선택한 노드×지표(CPU/Memory/Disk/DiskIO/Network/Network Err) 조합의 Prometheus 시계열을 (노드 × 지표) 카드 그리드로 나란히 비교해 시간대별 추이를 훑는 화면. 노드/지표를 최소 1개씩 선택해야 조회(과수집 방지).
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` 단일 선택, URL 파라미터 동기화.
  - 컨트롤 바 MacCard — 시간창(30m/1h/6h/24h/7d) 토글, 지표 토글 버튼, `NodeMultiSelect`(최대 30개, `MAX_NODES`), 이름/최신값 정렬, 카드 열 수(1/5/10/20) 선택.
  - offline/error/dropped(상한 초과 노드 제외) 상태 배너.
  - 차트 그리드 — 셀 = `{node}__{metric}`, 각 셀에 최신값 + `LineChart`(recharts, `connectNulls`).
- **Frontend**: `useClusterTrends` (`hooks/useClusterTrends.ts`, `keepPreviousData` + `enabled: nodes>0 && metrics>0`, 자동갱신 off 기본). `useClusters`. api.ts: `clusterTrendsApi.get(clusterId, {range, metrics, nodes})`.
- **Backend**: `GET /api/v1/k8s/{clusterId}/trends` — 라우터 `backend/app/routers/cluster_trends.py`(prefix `/k8s`). 클러스터별 Prometheus(`Cluster.prometheus_url`/`prometheus_enabled`, 없으면 전역 `PROMETHEUS_URL` fallback)로 PromQL 질의, 노드 상한은 `settings.trends_max_nodes`(프론트 `MAX_NODES=30`과 동기화 필요).
- **핵심 기능**:
  - 노드×지표 매트릭스 시계열 카드 그리드, 컬럼 수/정렬 커스터마이즈.
  - 시간창 5종, 지표 6종(CPU/Memory/Disk/DiskIO/Network/NetworkErr) 토글 조합.
  - Prometheus offline/에러/노드 상한 초과 시 명시적 경고 배너.
  - `%`/`B/s` 단위 자동 포맷팅 및 값 없음(`null`) 처리.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### K8s 실시간 이벤트 (`/k8s-events`)

- **파일**: `frontend/src/pages/K8sEventsPage.tsx`.
- **목적 / UX**: kubewatch 웹훅으로 수집된 K8s 이벤트(Pod/Node/Deployment/PVC 등)를 심각도(critical/warning/info)별로 필터링해 확인하고 필요 시 삭제하는 이벤트 로그 화면. 클러스터별 필터 또는 전체 클러스터 통합 조회 지원.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + `allowAll`(`allLabel="전체 클러스터"`) 단일 선택.
  - 심각도 필터 탭(전체/Critical/Warning/Info) + 새로고침 버튼.
  - 요약 카운터(critical/warning/info 건수, 표시 건수/총 건수).
  - 이벤트 테이블(시각/심각도/Kind/이름/네임스페이스/Reason/메시지) — 행 클릭 시 raw JSON 펼침, 행별 삭제 버튼.
- **Frontend**: `useK8sEvents({clusterId, severity, limit:200})`(`hooks/useK8sEvents.ts`, 30초 `refetchInterval`), `useDeleteK8sEvent`. `useClusters`. api.ts: `k8sEventsApi.{list,delete}`.
- **Backend**: `GET /api/v1/events/` (`response_model=K8sEventListResponse`), `DELETE /api/v1/events/{id}` — 라우터 `backend/app/routers/k8s_events.py`(조회용 `router`, prefix `/events`; 별도 `ingest_router`가 kubewatch 웹훅 수신 담당, `/api/v1` 최상위 마운트로 인증 미들웨어 제외). 모델: `models/k8s_event.py`(`K8sEvent` — `event_type`, `resource_kind`, `resource_name`, `namespace`, `reason`, `message`, `severity`, `raw` JSONB, `received_at`).
- **핵심 기능**:
  - 클러스터별/전체 이벤트 조회, 심각도 필터.
  - 30초 주기 자동 새로고침 + 수동 새로고침.
  - 이벤트 상세(raw JSON) 인라인 펼침.
  - 이벤트 개별 삭제.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 실시간 로그 (`/k8s-logs`, `/k8s-logs/:clusterId`)

- **파일**: `frontend/src/pages/K8sLogsPage.tsx` (+ `components/common/{LogViewTabs,NamespaceSingleSelect,PodSingleSelect}`, `components/k8s/PodLogStream.tsx`).
- **목적 / UX**: 특정 클러스터의 특정 네임스페이스/파드 로그를 실시간 스트리밍으로 확인하는 화면(OpenLens 파리티). K8s 관리 콘솔의 파드 목록 "로그" 버튼에서 `?namespace=&pod=&container=` 쿼리로 딥링크 진입 시 자동으로 스트림이 시작된다.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` 단일 선택, URL 파라미터 동기화.
  - `LogViewTabs`(로그 화면 종류 전환 탭, 현재 `stream`).
  - `로그 스트림` MacCard — `NamespaceSingleSelect` + `PodSingleSelect` 대상 선택 → `PodLogStream`(네임스페이스+파드 선택 시에만 렌더, `key`로 재마운트).
- **Frontend**: 페이지 자체는 커스텀 데이터 hook 없이 `useClusters`만 사용하고 네임스페이스/파드 목록은 `NamespaceSingleSelect`/`PodSingleSelect` 내부에서 처리; 로그 스트림은 `PodLogStream` 컴포넌트가 SSE(`fetch` + `ReadableStream`, `k8sStreamUrls.logsStream`)로 소비. 로컬 state: `namespace`, `pod`(쿼리 파라미터로 초기화, 클러스터 변경 시 리셋).
- **Backend**: 스트리밍은 `GET /api/v1/analyze/clusters/{clusterId}/namespaces/{ns}/pods/{pod}/logs/stream`(SSE), 다운로드는 `.../logs/download` — 라우터 `backend/app/routers/analyze.py`(prefix `/analyze`). 네임스페이스/파드 목록은 같은 라우터의 `GET /analyze/clusters/{id}/namespaces`, `GET /analyze/clusters/{id}/namespaces/{ns}/pods`.
- **핵심 기능**:
  - 네임스페이스/파드 선택 후 실시간 로그 스트림(follow) 시작/중지.
  - 딥링크(`namespace`/`pod`/`container` 쿼리 파라미터)로 자동 스트림 시작.
  - 컨테이너 선택(멀티 컨테이너 파드), previous/timestamps 옵션(`PodLogStream` 내부).
  - 로그 전체 다운로드(non-follow).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## 클러스터 — 운영 점검 / 로그·분석 / Pod 병목

### 운영 점검 콘솔 (`/ops-checks`, `/ops-checks/:clusterId`)

- **파일**: `frontend/src/pages/OpsCheckConsolePage.tsx` (+ `components/common/ClusterSidebar`, `components/common/LogViewer`, `components/common/StatusBadge`)
- **목적 / UX**: 클러스터 하나를 골라 `deep_check`/`addon`/`batch_job(SSH)`/`playbook(Ansible)` 등 소스가 다른 점검 항목을 하나의 카탈로그 테이블에 모아 놓고, 카테고리(OS/K8s/Storage/Network/앱서비스)·이름 검색으로 필터링해 개별 실행 또는 체크박스 다중 선택 후 일괄 실행할 수 있게 한다. 실행 중 진행 상황을 실시간(폴링)으로 보여주고, 완료된 항목은 모달로 상세 로그(JSON)를 연다.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + 단일 선택(`selectedId`/`onSelect`), `allowAll` 없음(반드시 특정 클러스터 URL로 리다이렉트).
  - MacCard "점검 항목" — 카테고리 필터 pill 바 + 검색창 + 전체선택 체크박스 + 선택 실행 버튼 + 카탈로그 테이블(이름/분류/소스/상태/작업).
  - MacCard "실행 진행" — 활성 run 이 있을 때만 표시, 항목별 상태(대기/실행중/완료/실패)와 총계(정상/경고/위험/실패) 라이브 업데이트.
  - 항목 상세 모달 — `LogViewer` 로 `details` JSON 렌더.
  - 헤더에 `/daily-check/review/:clusterId`, `/daily-check/settings` 로의 바로가기 링크.
- **Frontend**: `useClusters`(cluster 목록), `useOpsCheckCatalog(clusterId)`, `useStartOpsRun()`, `useOpsRun(activeRunId)`(2초 폴링, 완료 시 정지), `useOpsRunItems(runId, isRunning)`(실행 중일 때만 2초 폴링). 로컬 state: `selected`(Set), `category`, `search`, `activeRunId`, `detail`. api.ts: `opsCheckApi.catalog`, `opsCheckApi.run`, `opsCheckApi.getRun`, `opsCheckApi.getRunItems`.
- **Backend**: `GET /api/v1/ops-checks/catalog/{cluster_id}`, `POST /api/v1/ops-checks/run`, `GET /api/v1/ops-checks/runs/{run_id}`, `GET /api/v1/ops-checks/runs/{run_id}/items` — `backend/app/routers/ops_check.py`. 서비스는 `backend/app/services/ops_check_service.py`(`OpsCheckService.build_catalog`/`create_run`/`execute_run`). 실행은 `POST /run` 에서 Celery(`run_ops_check_batch.delay`) 로 enqueue 하고 브로커 부재 시 동기 폴백. 모델: `OpsCheckRun`/`OpsCheckRunItem` (`backend/app/models/ops_check.py`).
- **핵심 기능**:
  - 소스가 다른 4가지 점검(deep_check/addon/batch_job/playbook)을 단일 카탈로그로 통합 표시.
  - 개별 실행(`runOne`)과 다중 선택 일괄 실행(`runSelected`) 모두 동일한 `OpsCheckRun` 묶음으로 생성.
  - 실행 중 폴링 기반 진행률 표시(`ok/warn/crit/error` 카운트).
  - `enabled === false`(비활성 — cron 미실행) 항목도 카탈로그에 노출하되 뱃지로 구분, 수동 실행은 허용.
  - 항목별 상세 로그(JSON details) 모달.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### K8s 로그 — AI 장애 분석 (`/incident-analysis`)

- **파일**: `frontend/src/pages/IncidentAnalysisPage.tsx` (+ `components/common/SearchableSelect`, `components/common/LogViewTabs`)
- **목적 / UX**: 클러스터 → namespace → pod 를 드릴다운으로 선택하고, `kubectl logs`/`events`/`describe` 를 자동 수집(또는 직접 붙여넣기)한 뒤 LLM(또는 rule-based) 분석기에 보내 근본 원인·신뢰도·조치 방안을 받는다. 실시간 로그 스트리밍(폴링), 로그 라인 필터도 제공한다.
- **UI 구성**:
  - `ClusterSidebar` 미사용 — 상단에 `<select>` 드롭다운(클러스터) + `SearchableSelect`(namespace/pod) 로 대상 선택(레거시 패턴, CLAUDE.md 표준 사이드바 미적용).
  - "대상 선택" 패널 — "이슈 있는 항목만 보기(느림)" 토글, glob 패턴(`nsPattern`/`podPattern`)으로 스캔 범위 축소, "자동 채우기" 버튼.
  - 이벤트 테이블(최대 20건), 로그/Describe textarea 3개(현재 로그/이전 로그/describe) + 실시간 LIVE 토글 + 로그 라인 필터.
  - 결과 패널(`ResultPanel`) — severity 배지, 근본 원인, confidence bar, 조치 방안 순번 리스트, 관련 런북.
  - `LogViewTabs current="analysis"` 로 로그 관련 다른 화면과 탭 전환.
- **Frontend**: `useAnalyzerHealth()`, `useAnalyzeIncident()`(mutation), `useAnalyzeNamespaces(clusterId, onlyWithIssues, withCounts, nsPattern, podPattern)`(300ms 디바운스), `useAnalyzePods(clusterId, namespace, onlyWithIssues)`, `useFetchIncidentContext()`(mutation, 자동채우기/스트리밍 공용). `useClusters()`. 로컬 state 다수(`clusterId`/`namespace`/`podName`/`onlyIssues`/로그 텍스트/`streaming`/`logFilter` 등). api.ts: `analyzeApi.health`, `analyzeApi.analyze`, `analyzeApi.listNamespaces`, `analyzeApi.listPods`, `analyzeApi.fetchContext`.
- **Backend**: `POST /api/v1/analyze/incident`, `GET /api/v1/analyze/health`, `GET /api/v1/analyze/clusters/{cluster_id}/namespaces`, `GET /api/v1/analyze/clusters/{cluster_id}/namespaces/{namespace}/pods`, `GET /api/v1/analyze/clusters/{cluster_id}/namespaces/{namespace}/pods/{podName}/context` — `backend/app/routers/analyze.py`. `kubernetes` SDK(`CoreV1Api`)로 실시간 조회, `app/services/analyzers.py`(`get_analyzer()` — `ANALYZER_BACKEND` env 로 Claude/Local LLM/Rule-based 선택).
- **핵심 기능**:
  - 대용량 클러스터 대응 fast/slow path 분리(`onlyIssues`/`withCounts` 미지정 시 이름만 빠르게 조회, 큰 클러스터에서 axios 타임아웃 최대 150s).
  - "자동 채우기" 로 logs/previous logs/events/describe 한 번에 수집.
  - SSE/WebSocket 미지원 백엔드 특성상 동일 fetch-context 엔드포인트를 N초 간격 폴링해 "실시간" 흉내(`streaming` 토글, textarea 포커스 중엔 갱신 일시정지).
  - severity(critical/warning/info)별 색상 결과 패널 + confidence bar + 조치 방안/런북.
  - 로그 라인 필터(클라이언트 사이드 텍스트 매칭).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 일일 점검 리뷰 (`/daily-check/review`, `/daily-check/review/:clusterId`)

- **파일**: `frontend/src/pages/DailyCheckReview.tsx` (+ `components/daily-check/{AiSummaryCard,TrendChart,DiffPanel,DeepCheckGrid,NotificationSettingsPanel,ResourceTrendChecklist}`)
- **목적 / UX**: 클러스터별 daily check 회차(점검 회차 선택 드롭다운)를 고르면, 그 회차의 AI 요약/원격조치 제안, deep-check 항목별 결과 그리드, 이전 회차와의 diff, 최근 7일 트렌드 차트를 한 화면에서 확인한다. 상단 버튼으로 기본 헬스체크(Daily Check)와 등록된 deep-check 정의 실행(Deep Check)을 각각 트리거할 수 있다.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + 단일 선택(`allowAll` 없음), URL 파라미터로 클러스터 지정, 없으면 첫 클러스터로 자동 리다이렉트.
  - 헤더 — "Daily Check 실행"/"Deep Check 실행" 버튼, "체크 정의"(→`/daily-check/settings`) 링크.
  - MacCard "점검 회차 선택" — 최근 20개 로그 드롭다운(상태 이모지 마커 + 스케줄 타입 한글 라벨).
  - `ResourceTrendChecklist` — 리소스 추세 체크리스트(클러스터 단위, 별도 hook).
  - 로그 미선택 시 안내 카드, 선택 시 `AiSummaryCard` / `DeepCheckGrid` / `DiffPanel` / `TrendChart` / `NotificationSettingsPanel` 순서로 렌더.
- **Frontend**: `useClusters`, `useLatestDailyCheckLog(clusterId)`(404 시 null), `useDeepCheckReview(dailyCheckLogId)`, `useDailyCheckTrend(clusterId, 7)`, `useRunDeepCheckNow()`, `useRunDailyCheckNow()`(성공 시 daily/deep 캐시 동시 무효화), `useDailyCheckLogs(clusterId, 20)`. URL `?log=` 쿼리 파라미터로 회차 선택 상태 관리. api.ts: `dailyCheckApi.latestLog/listLogs/runNow`, `deepCheckApi.review/trend/runNow`.
- **Backend**: `GET /api/v1/daily-check/results/{cluster_id}/latest`, `GET /api/v1/daily-check/results/{cluster_id}`, `POST /api/v1/daily-check/run/{cluster_id}` — `backend/app/routers/daily_check.py`. `GET /api/v1/deep-check/review/{daily_check_log_id}`, `GET /api/v1/deep-check/trend/{cluster_id}`, `POST /api/v1/deep-check/run/{cluster_id}` — `backend/app/routers/deep_check.py` (`DeepCheckService`, `ReviewService`). 모델: `DailyCheckLog`(`daily_check.py`), `DeepCheckResult`(`deep_check.py`, `ai_summary`/`ai_diff`/`ai_trend` 필드는 `DailyCheckLog` 레벨).
- **핵심 기능**:
  - 회차(daily_check_log) 단위로 AI 요약(`ai_summary`)·원격조치(`ai_remediation`)·이전 회차 대비 diff(`ai_diff`) 노출.
  - Deep Check 실행은 최신 daily 회차에 결과를 묶어(`daily_check_log_id`) 저장 — Daily Check 실행(기본 헬스체크)과는 별개 파이프라인.
  - 회차 선택 드롭다운에서 상태 마커(🟢/🟡/🔴/⚪)와 스케줄 타입(아침/점심/저녁/수동) 함께 표시.
  - 7일 트렌드 차트(`GET /deep-check/trend/{cluster_id}`).
  - 알림 채널 설정 패널(`NotificationSettingsPanel`)을 리뷰 화면에도 노출.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Deep Check 정의 관리 (`/daily-check/settings`) — admin 전용

- **파일**: `frontend/src/pages/DeepCheckSettings.tsx` (+ `components/daily-check/{DeepCheckDefinitionForm,DeepCheckDefinitionList,DeepCheckRunHistory,NotificationSettingsPanel}`)
- **목적 / UX**: 인증서 만료, OS 파라미터, 스토리지/네트워크 등 deep-check 항목의 "정의"(check_type, 임계값, cron, params)를 admin 이 CRUD 하는 화면. 클러스터별 전용 정의와 전체 클러스터 공용(글로벌, `cluster_id=NULL`) 정의를 함께 관리하고, **커스텀 체커 3종(`custom_http`/`custom_kubectl`/`custom_promql`)으로 코드 없이 새 점검을 직접 만들 수 있다**. 정의별 실행 이력(개별 로그)도 이 화면에서 확인한다. 라우트는 `RequireAdmin` 가드로 보호.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + `allowAll`(`allLabel="글로벌 + 전체"`) + 단일 선택. 선택된 클러스터로 정의 목록을 필터링(글로벌 정의는 항상 포함). 글로벌 정의의 "즉시 실행" 대상 클러스터로도 사용.
  - 검색 입력 + 카테고리 필터 칩(전체/K8s/OS/스토리지/네트워크/앱 — check-types 의 `category` 기준).
  - 헤더 "정의 추가" 토글 버튼 → MacCard "새 정의"(`DeepCheckDefinitionForm`). Check Type 셀렉트는 "커스텀 (UI 에서 직접 정의)" / "내장 체커" optgroup 으로 구분(`seed_default` 플래그).
  - 행 편집 버튼 → MacCard "편집 — {name}"(같은 폼 재사용, `initial` prop). 폼은 boolean 체크박스 / list 줄바꿈 textarea / 라벨 `(a|b)` 패턴 자동 select / cron 프리셋 + 직접 입력을 지원하고, **"미리 실행"**(저장 전 폼 값 그대로 ad-hoc 실행)과 "Test now"(저장된 값 실행) 버튼이 있다. 결과는 `ExecutionStepsTimeline` + 상세 JSON 으로 표시.
  - `DeepCheckDefinitionList` — sortOrder → name 순 정렬. 행마다 최근 실행 상태 dot(`with_status` 요약)·최근 실행 시각/소요·즉시 실행(이력 기록)·실행 이력·복제·편집·삭제·활성 토글 버튼.
  - `DeepCheckRunHistory` — 실행 이력 버튼으로 여는 MacCard 패널: 상태 필터 칩 + 페이지네이션 목록(상태/시각/클러스터/메시지/소요), 행 펼치면 step 타임라인(`details._steps`)과 상세 JSON. "지금 실행" 버튼 포함.
  - `NotificationSettingsPanel` 하단 배치.
- **Frontend**: `useClusters`, `useCheckTypes`, `useDeepCheckDefinitions(clusterId, includeGlobal, withStatus=true)`, `useCreateDefinition`/`useUpdateDefinition`/`useDeleteDefinition`/`useDuplicateDefinition`/`useRunDefinition`/`useTestDefinition`/`usePreviewCheck`, `useDefinitionResults(definitionId)`. 로컬 state: `selectedClusterId`, `editing`, `adding`, `historyOf`, `search`, `category`. api.ts: `deepCheckDefinitionsApi.list(withStatus)/create/update/remove/duplicate/test/run/preview/results` — 쿼리 파라미터는 수동 snake_case, thresholds/params 는 응답 camelize 를 폼에서 필드명(snake)으로 재정규화.
- **Backend**: `backend/app/routers/deep_check_definitions.py` — `GET/POST /api/v1/deep-check/definitions`(`with_status` 시 정의별 최신 결과 요약 포함), `PUT/DELETE /definitions/{id}`(admin, 삭제 시 이력은 `definition_id=NULL` 로 보존), `POST /definitions/{id}/duplicate`(admin, 비활성 복제), `POST /definitions/{id}/test`(operator, 무기록), `POST /definitions/{id}/run`(operator, `DeepCheckResult` 영속), `GET /definitions/{id}/results`(이력 페이지네이션 + status 필터), `POST /definitions/preview`(operator, 저장 전 ad-hoc), `GET /check-types`. `check_type` 은 `app/services/deep_checkers/REGISTRY` 화이트리스트 검증, `schedule_cron` 은 `validate_cron_min_interval`(5분 미만 거부). 모델: `DeepCheckDefinition`(+`last_run_at`), `DeepCheckResult`.
- **핵심 기능**:
  - `cluster_id=None` 정의는 모든 클러스터에 적용되는 글로벌 정의로 취급.
  - **커스텀 점검 생성**: `custom_http`(URL/host:port 프로브 — 기대 status/본문 정규식/지연 임계), `custom_kubectl`(읽기전용 verb 화이트리스트 kubectl + lines/number/regex_count 파싱, gte/lte 임계), `custom_promql`(instant 쿼리 + max/min/sum/avg/count 집계). `seed_default=False` 라 자동 시드/체크매트릭스에서 제외되고 admin 이 인스턴스를 직접 만든다.
  - **정의별 개별 로그**: 모든 실행(자동/수동)이 `DeepCheckResult` 로 남고 `details._steps` 에 단계별 로그 저장 → 실행 이력 패널에서 회차별 확인.
  - **`schedule_cron` 배선됨**: 값을 주면 매분 check-matrix 디스패처가 이 정의만 due 평가해 자동 실행(글로벌 정의는 전 클러스터). 비우면 기존처럼 홈 "플랫폼 현황" 매트릭스의 `CheckMatrixSchedule` cron 만 적용(내장 체커의 기본 경로). 둘 다 최소 5분 간격.
  - `sort_order` 로 UI 표시 순서 제어.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Pod 병목 진단 (`/pod-bottleneck`)

- **파일**: `frontend/src/pages/PodBottleneckPage.tsx` (+ `components/common/{NamespaceSingleSelect,PodSingleSelect}`)
- **목적 / UX**: 두 pod 사이의 네트워크 병목을 4개 축(TCP 상태/TCP 성능/DNS 지연/K8s endpoints)으로 진단하는 폼과 최근 진단 이력 목록을 제공한다. `PacketFlowPage` 등 다른 화면에서 `?cluster=&ns=&src=&dst=&svc=` 쿼리로 넘어와 폼을 prefill 할 수 있다.
- **UI 구성**:
  - `ClusterSidebar` — `iconOnly` + `allowAll`(`allLabel="전체 클러스터"`) + 단일 선택.
  - MacCard "진단 폼" — Namespace/Source Pod/Dest Pod (`NamespaceSingleSelect`/`PodSingleSelect`) + Dest Service(옵션, endpoints probe용) + "지금 진단" 버튼.
  - MacCard "최근 진단 결과" — `overallStatus` 별 좌측 색상 바 + namespace/src→dst pod + 시각 + 소요시간(ms) 리스트, 행 클릭 시 상세 페이지 이동.
- **Frontend**: `useClusters`, `useBottleneckRuns({clusterId, limit: 50})`, `useRunBottleneckAnalysis()`(mutation, 성공 시 `['bottleneckRuns']` 무효화). 로컬 state: `selectedClusterId`/`namespace`/`sourcePod`/`destPod`/`destService`/`submitError`(+URL prefill sync). api.ts: `podBottleneckApi.listRuns`, `podBottleneckApi.runAnalysis`.
- **Backend**: `GET /api/v1/pod-bottleneck/runs`, `POST /api/v1/pod-bottleneck/run` — `backend/app/routers/bottleneck.py`. `POST /run` 은 `require_operator` 권한 필요, `app/services/bottleneck_probes.py`(`BOTTLENECK_PROBE_REGISTRY`)의 4개 probe 를 `asyncio.gather` 로 병렬 실행 후 `worst_status()` 로 종합 상태 산출, `audit_logger.record` 로 감사 로그 기록. 모델: `BottleneckRun`(`backend/app/models/bottleneck_run.py`, `probes` JSONB 1컬럼에 4 probe 결과 통합 저장).
- **핵심 기능**:
  - 진단 실행 성공 시 즉시 `/pod-bottleneck/:id` 상세 페이지로 이동.
  - namespace 변경 시 source/dest pod 선택 초기화(선택 일관성 보장).
  - 다른 화면(PacketFlowPage)에서 cross-link 로 폼 prefill.
  - `overallStatus`(healthy/warning/critical/pending) 별 시각 구분(border+text 색상 맵).
  - 진단 이력은 `cluster_id`(선택 시) 필터, `namespace`+`source_pod`+`dest_pod` 페어 단위 인덱스로 조회 가능(백엔드).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Pod 병목 진단 상세 (`/pod-bottleneck/:id`)

- **파일**: `frontend/src/pages/PodBottleneckDetailPage.tsx` (+ `components/pod-bottleneck/ProbeResultCard`, `components/common/ConfirmDialog`)
- **목적 / UX**: 특정 진단 run 1건의 4개 probe(`tcp_state`/`tcp_perf`/`dns_latency`/`endpoints`) 결과를 카드 그리드로 상세히 보여주고, 필요 시 해당 진단 결과를 삭제할 수 있다.
- **UI 구성**:
  - 별도 `ClusterSidebar` 없음(단일 run 상세 화면) — 상단에 목록으로 돌아가기 링크, `namespace/src→dst(svc)` 제목, 전체 상태 배지, 삭제 버튼.
  - 4-probe 고정 순서(`tcp_state`, `tcp_perf`, `dns_latency`, `endpoints`) grid — 결과 없는 probe 는 "실행되지 않음" 안내 MacCard, 있으면 `ProbeResultCard`(probe별 label/axis/result).
  - 삭제 확인은 `ConfirmDialog`(danger 스타일).
- **Frontend**: `useBottleneckRun(id)`, `useBottleneckProbes()`(probe 메타 카탈로그, 10분 staleTime), `useDeleteBottleneckRun()`(성공 시 `/pod-bottleneck` 로 navigate). 로컬 state: `confirmDelete`. api.ts: `podBottleneckApi.getRun`, `podBottleneckApi.listProbes`, `podBottleneckApi.deleteRun`.
- **Backend**: `GET /api/v1/pod-bottleneck/runs/{run_id}`, `GET /api/v1/pod-bottleneck/probes`, `DELETE /api/v1/pod-bottleneck/runs/{run_id}` — `backend/app/routers/bottleneck.py`. 삭제는 `require_operator` 권한 + `audit_logger.record(action="bottleneck.delete")`. 모델: `BottleneckRun.probes`(JSONB, 각 probe 는 `status`/`message`/`details`/`manual_fallback`/`recommendation` 구조).
- **핵심 기능**:
  - `probeMetaMap`(probeKey→메타)으로 카탈로그 label/axis 를 실제 결과와 매핑.
  - probe 4축을 항상 고정 순서로 표시(존재하지 않아도 placeholder 카드).
  - 삭제 시 확인 다이얼로그 후 목록으로 리다이렉트.
  - `triggeredByUser`/`durationMs` 등 메타 정보 헤더에 노출.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## 클러스터 — 관리 / 버전 / 실행 콘솔 / LAKE / APM

### K8S 노드 라벨 (`/node-labels`)

- **파일**: `frontend/src/pages/NodeLabelsPage.tsx` (+ `components/node-labels/NodeLabelEditorModal.tsx`, `NodeLabelsTable.tsx`, `nodeLabelsShared.ts`, `components/common/ExportMenu`)
- **목적 / UX**: 클러스터(또는 전체 클러스터)의 모든 노드에 붙은 K8s 라벨을 노드 기준 / 레이블 기준 두 뷰로 조회하고, 특정 노드를 골라 라벨을 추가·삭제(patch)한다. 여러 클러스터를 한 화면에서 취합해 라벨 표준화 여부를 점검하는 용도.
- **UI 구성**:
  - `ClusterSidebar` — `allowAll` + `allLabel="전체 클러스터"` + `iconOnly` (단일 선택 + 전체 옵션 패턴)
  - 검색창(클러스터/노드명/라벨 key·value), 노드 기준 ↔ 레이블 기준 뷰 토글
  - 우측 툴바: 화면 캡처(`ExportMenu`), CSV 내보내기, 수동 새로고침, 자동새로고침(60초) on/off
  - 일부 클러스터 조회 실패 시 경고 배너(부분 실패 허용) + 노드 라벨 편집 모달(`NodeLabelEditorModal`)
- **Frontend**: `useClusters()` (클러스터 목록), `useClustersNodes(targetClusters, {autoRefresh})` — 클러스터별 독립 `useQueries`로 병렬 조회 후 취합(부분 실패 허용, `keepPreviousData`), `usePatchNodeLabels()` mutation. 로컬 state: `selectedClusterId`(undefined=미선택→첫 클러스터, null=전체), `viewMode`, `searchQuery`, `autoRefresh`. 호출 함수: `nodeLabelsApi.getNodes`, `nodeLabelsApi.patchNodeLabels`.
- **Backend**: `GET /api/v1/clusters/{cluster_id}/nodes` (raw kubectl/K8s SDK 노드 목록+라벨), `PATCH /api/v1/clusters/{cluster_id}/nodes/{node_name}/labels` (add/remove 라벨) — `backend/app/routers/node_labels.py`, 서비스는 `app/services/k8s_node_label_service.py`(`NodeLabelService`, `map_k8s_error`), `kubernetes` Python SDK 직접 사용. DB 모델 관여 없음(순수 K8s API 프록시).
- **핵심 기능**:
  - 다중 클러스터 병렬 취합 + 부분 실패 시 나머지 표시
  - 노드 기준 / 레이블 기준(태그별로 노드 그룹핑) 뷰 전환
  - 라벨 add/remove patch (`NodeLabelEditorModal`)
  - 현재 뷰·검색 결과 CSV 내보내기, 화면 캡처 내보내기
  - 60초 자동 새로고침 토글
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### K8S 노드 이미지 (`/node-images`)

- **파일**: `frontend/src/pages/NodeImagesPage.tsx` (+ `components/node-images/NodeImagesTable.tsx`, `NodeLabelGroupView.tsx`, `ImageCentricView.tsx`, `NodeImagesCsvExportMenu.tsx`, `ImageDistributeDialog.tsx`, `components/common/SnapshotProgressCard`)
- **목적 / UX**: 선택한 클러스터의 모든 노드에 캐시된 컨테이너 이미지를 노드별/라벨그룹별/이미지별 3가지 시각으로 확인해, 불필요한 이미지·중복 적재·용량을 파악한다. 또한 특정 노드의 이미지를 아직 없는 다른 노드(동일/타 클러스터)로 배포(prepull)할 수 있다.
- **UI 구성**:
  - `ClusterSidebar` — 단일 선택(`iconOnly`, `allowAll` 없음)
  - 통계 요약 타일 4개(노드 수/총 이미지 슬롯/고유 이미지/총 용량)
  - 검색창 + 탭(`노드별(Table)` / `라벨 그룹(Card)` / `이미지별`)
  - 각 이미지 행의 **배포** 버튼 → `ImageDistributeDialog`(대상 클러스터/노드 선택 · 보유/미보유 배지 · 런타임/sudo/SSH 자격증명 · 노드별 결과 표)
  - 백그라운드 집계 중이면 `SnapshotProgressCard` 진행률 표시, CSV 내보내기(`NodeImagesCsvExportMenu`) + 화면 캡처(`ExportMenu`)
- **Frontend**: `useClusters()`, `useNodeImageList(activeClusterId)` — `status: 'computing'|'ready'`인 백그라운드 스냅샷 envelope을 폴링(computing 중 1.5s, 완료 후 60s). 로컬 state: `selectedClusterId`, `searchQuery`, `view`, `distributeImage`. 호출 함수: `nodeImagesApi.getNodeImages`, `nodeImagesApi.exportCsv`, `nodeImagesApi.distribute`. 배포 다이얼로그는 대상 클러스터의 `bulkExecApi.nodeList` + `useNodeImageList`(보유 여부 계산)를 사용.
- **Backend**: `GET /api/v1/clusters/{cluster_id}/node-images` (백그라운드 집계 결과 or 진행 상태), `GET /api/v1/clusters/{cluster_id}/node-images/export.csv?sort=`, `POST /api/v1/clusters/{cluster_id}/node-images/distribute` (이미지 참조 검증 후 `ssh_runner.run_bulk` 로 대상 노드에 pull 명령 일괄 실행, `require_operator` + 감사 로그) — `backend/app/routers/node_images.py`. K8s 노드/이미지 목록을 `kubectl`/SDK로 수집해 노드당 imageCount/totalSizeBytes/images[]로 집계(스냅샷 캐시, computing/ready/stale 상태 포함).
- **핵심 기능**:
  - 노드별/라벨그룹별/이미지별 3-way 뷰
  - 이미지 배포(prepull) — 특정 이미지를 미보유 노드(동일/타 클러스터)로 SSH pull, 보유/미보유 자동 선별, 노드별 실행 결과 표시
  - 백그라운드 집계 진행률 표시(대형 클러스터 대응)
  - 정렬 옵션이 있는 CSV 내보내기(`sort=default|size|lines`)
  - 검색(노드명/이미지명), 고유 이미지 dedup 카운트
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 버전 / 설정 관리 (`/versions`)

- **파일**: `frontend/src/pages/VersionsPage.tsx` (+ `components/versions/EtcdSystemdModal.tsx`, `KernelParamsCollectModal.tsx`, `NodeNicsCollectModal.tsx`, `KubeletConfigCollectModal.tsx`, `CsvExportModal.tsx`)
- **목적 / UX**: kubeconfig(+ SSH)로 클러스터의 K8s/Cilium 버전, 컨트롤플레인·kubelet·CNI·OS(sysctl/etcd systemd)·MinIO/DirectPV 스토리지 설정을 스냅샷으로 수집하고, 컴포넌트별 현재값·변경 히스토리·diff를 확인한다. 운영자가 "언제 무엇이 바뀌었는지" 추적하는 감사 성격의 화면.
- **UI 구성**:
  - `ClusterSidebar` 단일 선택(`iconOnly`)
  - 헤더 액션: `3D 그래프` 링크(`/versions/:clusterId/graph`), CSV 내보내기, etcd(systemd)/kubelet config/커널 파라미터/노드 NIC SSH 수집 모달 4개, MinIO 수집, "지금 수집"(kubeconfig 기반, 중지 가능)
  - 컴포넌트를 카테고리(`control_plane`/`cni`/`kubelet`/`os`/`storage`/`other`)별 접기 섹션으로 그룹핑, 각 항목 펼치면 현재값(모듈별 전용 디테일: MinIO Tenant/DirectPV/kernel sysctl/etcd systemd/kubelet config) + 히스토리 타임라인(최대 2개 선택해 diff 자동 표시)
  - 노드/컴포넌트/버전/config 경로 통합 검색
- **Frontend**: `useClusters()`, 순수 `useQuery(['versions','current',clusterId])`(`versionsApi.current`), `useQuery(['versions','history',...])`(`versionsApi.history`), `useQuery(['versions','diff',...])`(`versionsApi.diff`) — 별도 훅 파일 없이 `VersionsPage.tsx`/`VersionGraphPage.tsx` 내부에 인라인. Mutation은 `useAbortableMutation`으로 `versionsApi.collect`, `.collectMinio` 등. 호출 함수: `versionsApi.{current,history,diff,collect,collectMinio,collectEtcdSystemd,collectKernelParams,collectKubeletConfig,collectNodeNics,exportCsv}`.
- **Backend**: `POST /api/v1/clusters/{id}/collect-versions`, `POST .../collect-etcd-systemd`, `POST .../collect-kernel-params`, `POST .../collect-kubelet-config`, `POST .../collect-etcdctl-config`, `POST .../collect-node-nics`, `POST .../collect-minio`, `GET .../versions/current`, `GET .../versions/history`, `GET .../versions/diff`, `GET .../versions/export.csv` — `backend/app/routers/versions.py`. DB 모델은 `ClusterConfigSnapshot`(`backend/app/models/config_snapshot.py`, `cluster_config_snapshots` 테이블) — 동일 `component`에 대해 `content_hash`가 바뀔 때만 새 행 추가(히스토리 누적), `data` JSONB에 image/flags/configmap/host별 원시 데이터 저장.
- **핵심 기능**:
  - kubeconfig 기반 컴포넌트 버전/플래그/ConfigMap 자동 수집 (변경 시에만 히스토리 적재)
  - SSH 기반 보조 수집: etcd systemd config, kubelet 실사용 config, 커널 sysctl, 노드 NIC, MinIO/DirectPV
  - 컴포넌트별 히스토리 타임라인 + 2-스냅샷 diff 뷰
  - CSV 내보내기(디테일 레벨 선택), 3D 관계 그래프로 이동
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 버전 컴포넌트 관계 그래프 (`/versions/:clusterId/graph`)

- **파일**: `frontend/src/pages/VersionGraphPage.tsx` (react-force-graph-3d + three.js)
- **목적 / UX**: `/versions` 페이지의 스냅샷 데이터를 클러스터→카테고리→컴포넌트→플래그 계층의 3D 노드-엣지 그래프로 시각화해, 어떤 플래그/설정이 어떤 컴포넌트에 속하는지 탐색한다.
- **UI 구성**: 상단 툴바(뒤로가기, 클러스터 `<select>` 드롭다운 — ClusterSidebar 미사용, 색상 범례, 재수집 버튼), 전체 화면 3D 그래프 캔버스, 노드 클릭 시 우상단 상세 패널(`NodeDetail`: type/version/value/category/collectedAt).
- **Frontend**: `useClusters()`, `useQuery(['versions','graph',selectedId])` → `versionsApi.graph`. 로컬 state: `selectedId`(URL param `clusterId` 우선), `dims`(ResizeObserver), `selectedNode`. 호출 함수: `versionsApi.graph`, `versionsApi.collect`(재수집).
- **Backend**: `GET /api/v1/clusters/{cluster_id}/versions/graph` — `backend/app/routers/versions.py` (1248행). `ClusterConfigSnapshot`을 카테고리/컴포넌트/플래그 노드+엣지(`contains`/`param`/`configures`/`replaces`)로 변환해 반환. 재수집은 `POST /clusters/{id}/collect-versions` 재사용.
- **핵심 기능**:
  - 클러스터/카테고리/컴포넌트/플래그 4-tier 3D 그래프 (타입별 색상/크기)
  - 노드 클릭 시 카메라 이동 + 상세 패널
  - `/versions` 페이지와 캐시 공유(`queryKey: ['versions', ...]`) — 재수집 시 양쪽 모두 무효화
- **요청사항 (수정 요청)**:
  - ClusterSidebar iconOnly 표준을 따르지 않고 `<select>` 드롭다운을 사용 중 — CLAUDE.md 컨벤션상 금지 패턴(❌ 페이지 내 dropdown 형태 클러스터 선택기)이므로 표준화 필요 여부 확인
  - _(추가 개선/수정 요청을 여기에 적어주세요)_

### 노드 일괄 실행 (SSH/SCP) (`/bulk-exec`)

- **파일**: `frontend/src/pages/BulkExecPage.tsx` (+ `components/common/{ConfirmDialog,LogViewer,SavedCommands,DebugLogPanel,ResizeGrip,DoubleScrollX}`)
- **목적 / UX**: 여러 클러스터의 여러 노드를 한 번에 선택해 SSH 명령 실행 또는 SCP 파일 업로드를 병렬/순차로 수행하고, 결과를 요약/상세 뷰로 확인·필터링·내보내기(CSV/TXT/클립보드)한다. 운영자가 대규모 노드에 동일 작업을 배포할 때 쓰는 실행 콘솔.
- **UI 구성**: mc 클라이언트 콘솔처럼 **[타겟 노드 | 명령 메뉴 | 실행 결과]** 를 한 로우(`lg:grid-cols-12`, 3:4:5)에 나란히 배치. 결과 컬럼은 항상 우측 같은 자리에 고정되고(실행 전엔 플레이스홀더), 컬럼 내부에서만 스크롤된다.
  - `ClusterSidebar` — `multiSelect` + `iconOnly` (다중 선택 패턴, `selectedIds`/`onMultiSelectChange`)
  - 타겟 노드(3): 클러스터별로 묶인 노드 체크박스 목록(`ClusterNodeGroup`, 클러스터별 접기/전체선택)
  - 명령 메뉴(4): action(ssh/scp) 토글, 병렬/순차 모드, 인증(비밀번호/PrivateKey), 명령/업로드 내용, 타임아웃/청크 설정
  - 실행 결과(5): 요약 테이블 `SummaryResultsTable` ↔ 상세 테이블 토글, 공통 필터, CSV/TXT/클립보드 내보내기
  - 실행 확인 `ConfirmDialog`
- **Frontend**: `useClusters()`, `useQueries`로 선택된 클러스터별 노드 목록 병렬 조회(`bulkExecApi.nodeList`), `useAbortableMutation`으로 `bulkExecApi.run`. 로컬 state: `clusterIds`(다중), `selected`(Set, `clusterId::nodeName` 키), 실행 옵션 다수. 호출 함수: `bulkExecApi.nodeList`, `bulkExecApi.run`.
- **Backend**: `GET /api/v1/clusters/{cluster_id}/node-list`, `POST /api/v1/bulk-exec/run` — `backend/app/routers/bulk_exec.py`. `require_operator` 권한 필요, `app/services/ssh_runner.py`(`SSHTarget`, `run_bulk`)로 paramiko 기반 SSH/SCP 실행(병렬/청크 단위), `app/services/audit_logger`로 감사 로그 기록. DB 모델 관여 없음(휘발성 실행 결과).
- **핵심 기능**:
  - 다중 클러스터 × 다중 노드 선택 (클러스터별 그룹 UI)
  - SSH 명령 실행 / SCP 파일 업로드, 병렬(동시성 조절)·순차 모드, 청크 단위 실행(대규모 완화)
  - 비밀번호/Private Key 인증(저장하지 않음), 실행 중 중지(abort)
  - 결과 요약/상세 뷰, 공통 필터, CSV/TXT/클립보드 내보내기
  - 저장된 명령어(`SavedCommands`, localStorage) 재사용
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### etcdctl 콘솔 (`/etcdctl`)

- **파일**: `frontend/src/pages/EtcdCtlPage.tsx` (+ `components/common/{ConfirmDialog,LogViewer,SavedCommands}`)
- **목적 / UX**: control-plane(master) 노드에 SSH로 접속해 `etcdctl` 명령을 실행(endpoint health, member list, snapshot 등)하거나 `etcd.service`의 systemd 로그(journalctl)를 조회한다. defrag/compact/snapshot 등 위험 명령은 확인 모달에서 경고 표시.
- **UI 구성**:
  - `ClusterSidebar` 단일 선택(`iconOnly`)
  - 탭: `etcdctl 실행` / `etcd 서비스 로그`
  - 좌측 패널: master 후보 드롭다운(`master-candidates`) + 수동 host override, SSH 인증
  - 우측 패널: 프리셋 버튼(args 자동 채움), env file 옵션, args/timeout, 또는 로그 탭의 unit/tail/since/grep
  - 실행 확인 `ConfirmDialog`(위험 명령 정규식 매칭 시 danger 스타일), 결과 패널(`ResultPanel` — executed command, stdout/stderr `LogViewer`)
- **Frontend**: `useClusters()`, `useQuery(['etcdctl','masters',clusterId])`(`etcdctlApi.masters`), `useQuery(['etcdctl','presets',clusterId])`(`etcdctlApi.presets`), `useAbortableMutation`으로 `etcdctlApi.run` / `etcdctlApi.logs`. 호출 함수: `etcdctlApi.{presets,masters,run,logs}`.
- **Backend**: `GET /api/v1/clusters/{cluster_id}/etcdctl/presets`, `GET .../etcdctl/master-candidates`, `POST .../etcdctl/run`, `POST .../etcdctl/logs` — `backend/app/routers/etcdctl.py`. master 후보는 control-plane 라벨 노드를 K8s SDK로 조회, 실행은 SSH 러너(bulk_exec와 유사한 SSH 실행 계층)로 `etcdctl` 바이너리/env file을 원격 실행, 로그는 `journalctl -u {unit}` 실행.
- **핵심 기능**:
  - control-plane 노드 자동 탐지(라벨 기반) + 수동 host override
  - env file(`/etc/etcd.env`) source 옵션 + etcdctl 경로/timeout 커스터마이즈
  - 프리셋 명령(endpoint health 등) + 저장된 명령(`SavedCommands`)
  - 위험 명령(defrag/compact/snapshot/member add·remove 등) 실행 전 위험 경고 확인
  - etcd systemd 서비스 로그(journalctl) 조회 + grep 필터
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 클러스터 관리 (`/cluster-manage`)

- **파일**: `frontend/src/pages/ClusterManagePage.tsx` (+ `components/cluster-manage/{CiliumConfigModal,ClusterCard,ClusterTableRow,ClusterUpdateDiffDialog,ClusterCustomFieldsManager,StandardizeClusterNamesModal}`, `components/versions/NodeNicsCollectModal`)
- **목적 / UX**: 등록된 전체 클러스터를 테이블/카드 뷰로 관리 — 검색/필터/정렬/그룹화(지역·운영레벨), CIDR 겹침 감지, kubeconfig 기반 자동 정보 수집(diff 미리보기 후 적용), 커스텀 컬럼 추가, 드래그 정렬. `/cluster-manage/:id/edit`으로 이동해 상세 메타를 편집한다.
- **UI 구성**:
  - 이 페이지 자체는 **ClusterSidebar를 사용하지 않음** — 전체 클러스터를 관리하는 목록/테이블 화면이라 별도 좌측 사이드바 없이 본문 전체가 테이블/카드
  - 헤더: 테이블/카드 뷰 토글(`ViewModeBar`), 이름 표준화, 컬럼 관리(커스텀 필드), 노드 IP 일괄 수집, 컬럼너비 리셋, 검색/필터 패널
  - 테이블 뷰: 리사이즈 가능한 다열 테이블(이름/상태/지역/운영레벨/BGP/CIDR/bond0·1/Pod·Svc CIDR/Max Pods/K8s·Cilium 버전/노드 IP + 커스텀 필드), 지역/운영레벨 그룹 헤더 행
  - 카드 뷰: `dnd-kit` 드래그 정렬 가능한 `ClusterCard` 그리드(그룹 내에서만 순서 변경)
  - 행/카드 액션: 새로고침(auto-update dry-run → `ClusterUpdateDiffDialog`), NIC 수집, 수정(`/cluster-manage/:id/edit`), 삭제, Cilium 설정 보기(`CiliumConfigModal`)
- **Frontend**: `useClusters()` + `useClusterStore()`(Zustand, 클러스터 목록 캐시), `useOperationLevels()`, `useClusterCustomFields()`. 로컬 state: 검색/필터/정렬/그룹, 다수의 진행중 ID(`deletingId`,`autoUpdatingId` 등). 호출 함수: `clustersApi.{delete,autoUpdate,reorder,update(via edit page)}`, `clusterCustomFieldsApi`(via `ClusterCustomFieldsManager`).
- **Backend**: `GET /api/v1/clusters`, `POST /api/v1/clusters/reorder`, `DELETE /api/v1/clusters/{id}`, `POST /api/v1/clusters/{id}/auto-update?dry_run=`, `GET /api/v1/clusters/{id}/cilium-config` — `backend/app/routers/clusters.py`. 커스텀 컬럼은 `GET/POST/PUT/DELETE /api/v1/cluster-custom-fields`, `PUT /api/v1/clusters/{id}/custom-values` — `backend/app/routers/cluster_custom_fields.py`, 모델 `ClusterCustomField`(`backend/app/models/cluster_custom_field.py`) + `Cluster.custom_values`(JSONB). `Cluster` 모델(`backend/app/models/cluster.py`)의 `seq`(드래그 정렬), `cidr/pod_cidr/svc_cidr`, `bond0_ip/bond1_ip`, `node_ips` 등이 테이블 컬럼 데이터 소스.
- **핵심 기능**:
  - kubeconfig 기반 auto-update(dry-run diff 미리보기 → 적용) — K8s 버전, node IP, CIDR, Max Pods 등 자동 갱신
  - CIDR 겹침(internal/pod/svc) 자동 탐지 + 경고 배지
  - 지역/운영레벨 그룹화, 드래그 앤 드롭 수동 정렬(`clustersApi.reorder`)
  - 클러스터별 커스텀 컬럼 CRUD(`ClusterCustomFieldsManager`) + 값 편집
  - 이름 일괄 표준화(`StandardizeClusterNamesModal`), 노드 IP 일괄 수집
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 클러스터 정보 수정 (`/cluster-manage/:id/edit`)

- **파일**: `frontend/src/pages/ClusterMetaFormPage.tsx`
- **목적 / UX**: 단일 클러스터의 수동 메타데이터(노드 스펙/NIC, N/W CIDR, BGP, Cilium 설정, Coroot/Prometheus 연동 매핑 등)를 탭 폼으로 편집·저장한다. `ClusterManagePage`의 자동수집으로 채워지지 않는 값(설명, coroot project 매핑 등)을 사람이 직접 입력하는 용도.
- **UI 구성**: **ClusterSidebar 미사용** — 단일 클러스터 편집 폼 페이지(뒤로가기 헤더 + `클러스터명` 표시). 상단 공통 필드(지역/운영레벨/호스트명) + 3개 탭(`노드 스펙/NIC`, `N/W CIDR`, `기타`) 안에 그룹별 카드형 섹션.
- **Frontend**: `useClusters()` + `useClusterStore()`(Zustand)로 `id` 매칭 클러스터 조회, `useOperationLevels()`. 폼 필드는 모두 `useState`로 개별 관리 후 `hydrated` 플래그로 최초 1회 동기화. 호출 함수: `clustersApi.update(cluster.id, payload)`.
- **Backend**: `PUT /api/v1/clusters/{cluster_id}` — `backend/app/routers/clusters.py` (391행). `Cluster` 모델(`backend/app/models/cluster.py`)의 `region/operation_level/node_count/max_pod/hostname/cidr/internal_ips/first_host/last_host/pod_cidr/svc_cidr/bond0_ip/bond0_mac/bond1_ip/bond1_mac/cilium_config/description/bgp_enabled/as_number/coroot_project/coroot_url/coroot_enabled/prometheus_url/prometheus_enabled` 컬럼을 갱신.
- **핵심 기능**:
  - 노드 수/Max Pod, bond0·bond1 NIC(IP/MAC) 수동 입력
  - BGP 사용 여부 + AS Number
  - INTERNAL_IP 정규식 리스트(자동수집 우선순위: nodeIps > 수동 IP 리스트 > fallback CIDR) / Pod CIDR / Service CIDR
  - Cilium 주요 설정 텍스트, 클러스터 설명
  - Coroot APM 연동(project 매핑 + URL 오버라이드 토글), Cluster Trends Prometheus 연동(URL 오버라이드 토글)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### LAKE 서비스 (`/lake-services`)

- **파일**: `frontend/src/pages/LakeServicesPage.tsx` (+ `components/lake-services/{LakeServiceCard,AddLakeServiceModal}`)
- **목적 / UX**: K8s 위에 올라간 LAKE 도메인 OSS(airflow/spark/iceberg/trino/starrocks/jupyterlab/superset/polaris) 인스턴스를 클러스터·카테고리(카탈로그/런타임/분석)별로 목록 조회하고, 카드에서 바로 헬스체크를 실행하거나 상세로 진입한다.
- **UI 구성**:
  - `ClusterSidebar` — `allowAll` + `allLabel="전체 클러스터"` + `iconOnly` (`sticky top-4`로 고정)
  - 헤더 + "서비스 등록" 버튼(`AddLakeServiceModal`)
  - 카테고리 필터 칩(전체/카탈로그/런타임/분석, 카운트 표시)
  - 서비스 카드 그리드(`LakeServiceCard` — 클릭 시 상세 이동, "지금 점검" 버튼)
- **Frontend**: `useLakeServiceTypes()`(카탈로그 타입 라벨 매핑), `useLakeServices({clusterId, category, limit:200})`, `useRunLakeServiceCheck()` mutation. 로컬 state: `selectedClusterId`, `category`, `addOpen`. 호출 함수: `lakeServicesApi.{listTypes,list,runCheck}` (via `hooks/useLakeServices.ts`).
- **Backend**: `GET /api/v1/lake-services/types`, `GET /api/v1/lake-services`(필터: clusterId/serviceType/category/enabled), `POST /api/v1/lake-services/{id}/check` — `backend/app/routers/lake_services.py`. 모델 `LakeService`/`LakeServiceCheck`(`backend/app/models/lake_service.py`) — `service_type`은 코드 catalog(정적 enum), `category`는 catalog/runtime/analytics, cluster FK로 cascade 삭제. 서비스 타입 카탈로그 자체의 CRUD는 별도 라우터 `backend/app/routers/lake_service_types.py`(`/lake-service-types`, `LakeServiceType` 모델)로 관리.
- **핵심 기능**:
  - 클러스터(전체 포함)/카테고리 필터로 LAKE 서비스 조회
  - 카드에서 즉시 헬스체크 실행("지금 점검", 실행 중 로딩 표시)
  - 서비스 등록 모달(`AddLakeServiceModal` — 클러스터/타입/엔드포인트 입력)
  - 상세 페이지(`/lake-services/:id`)로 드릴다운
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### LAKE 서비스 상세 (`/lake-services/:id`)

- **파일**: `frontend/src/pages/LakeServiceDetailPage.tsx` (+ `components/lake-services/{HealthBadge,ServiceTypeIcon}`, `components/editor/RichContent`, `components/ui/MacCard`)
- **목적 / UX**: 단일 LAKE 서비스 인스턴스의 현재 상태, 트러블슈팅 가이드(ServiceEntry 지식베이스 연동), 점검+히스토리 통합 타임라인을 확인하고 즉시 재점검하거나 인스턴스를 삭제한다.
- **UI 구성**: **ClusterSidebar 미사용**(단일 리소스 상세 페이지). `MacCard` 3장 — "현재 상태"(최근 점검 시각/메시지/details JSON 펼치기), "트러블슈팅 가이드"(`ServiceEntry kind=guide`, 없으면 ServiceHub 작성 링크), "히스토리 timeline"(`LakeServiceCheck` + `ServiceEntry kind=history|troubleshoot` 통합, 최신순). 헤더에 "지금 점검"/"삭제" 버튼 + 삭제 확인 `ConfirmDialog`.
- **Frontend**: `useLakeService(id)`, `useLakeServiceTypes()`, `useLakeServiceChecks(id, {limit:50})`, `useRunLakeServiceCheck()`, `useDeleteLakeService()` (모두 `hooks/useLakeServices.ts`). 가이드/히스토리는 별도 `useQuery(['serviceEntries','lake',serviceSlug])` → `serviceEntriesApi.list(serviceSlug)`. 호출 함수: `lakeServicesApi.{get,listChecks,runCheck,remove}`, `serviceEntriesApi.list`.
- **Backend**: `GET /api/v1/lake-services/{service_id}`, `GET .../checks`, `POST .../check`, `DELETE /api/v1/lake-services/{service_id}` — `backend/app/routers/lake_services.py`. 가이드/히스토리는 `GET /api/v1/services/{service}/entries` — `ServiceEntry` 모델(`backend/app/models/service_entry.py`, `kind=guide/history/troubleshoot`, `service` 슬러그가 `LakeService.service_type`과 매칭).
- **핵심 기능**:
  - 최근 점검 상태 + details JSON 원시 데이터 확인
  - `service_type` 슬러그로 매칭된 트러블슈팅 가이드(리치텍스트, `RichContent`) 펼침
  - 점검 기록(`LakeServiceCheck`) + 지식베이스 히스토리(`ServiceEntry`)를 하나의 시간순 타임라인으로 병합
  - 즉시 재점검 실행, 인스턴스 삭제(연관 체크 이력 cascade 삭제)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

> ℹ️ **제거된 화면 — 애플리케이션 APM (Coroot) (`/coroot` 였음)**: COROOT APM 통합은 전체
> 제거되어 라우트/페이지/백엔드 라우터가 더 이상 존재하지 않는다
> (`navConfig.ts` 주석 참고 — 재추가하지 않음). 과거 명세는 git 히스토리에서 확인.

---

## 서버·인프라 / 네트워크 / 스토리지

### 노드 서버스펙 관리 대장 (`/node-specs`)

- **파일**: `frontend/src/pages/NodeSpecPage.tsx` (+ `components/node-specs/NodeSpecEditModal.tsx`, `NodeSpecCsvUploadModal.tsx`, `NodeSpecPasteModal.tsx`, `columns.tsx`)
- **목적 / UX**: 물리 서버(호스트명, CPU/RAM/Disk, bond0/bond1 IP, OS/커널, SSD/VM 여부, 랙 위치, 현재 용도)를 자산 대장 형태로 등록·조회한다. kubeconfig 기반 클러스터 임포트, CSV 업로드/붙여넣기(엑셀), SSH Host Facts 수집(bond IP·디스크·SSD 자동판별)으로 대량 입력 부담을 줄이는 것이 핵심 목적.
- **UI 구성**:
  - `ClusterSidebar`는 `allowAll`(`allLabel="전체 (등록 + 미배정)"`) + `iconOnly` 단일선택 패턴.
  - 상단 상태별 pill(전체/운영중/예비/점검/폐기, 클릭 시 필터), 검색/역할 필터, 전체 CPU(vCPU)·메모리 합계 배지.
  - 커스텀 그리드 테이블(`useGridSelection`으로 블록 선택 + Ctrl+C TSV 복사), 셀 인라인 편집(`InlineTextCell`, SSD/VM 클릭 토글), 컬럼 리사이즈(`useColumnWidths`).
  - CSV 내보내기/템플릿 다운로드/업로드 모달, 엑셀 붙여넣기 모달(`Ctrl+V` 전역 캡처), Host Facts 수집 모달(SSH user/password/key + 노드 다중선택), 신규등록/수정 모달, 삭제 `ConfirmDialog`.
- **Frontend**: `useClusters`(사이드바), `useQuery(['node-specs', clusterId, statusFilter, roleFilter, search])` → `nodeSpecsApi.list`; `useAbortableMutation`으로 `nodeSpecsApi.importFromCluster`; `nodeSpecsApi.update/delete/collectHostFacts`; `useGridSelection`, `useColumnWidths`, `useAbortableMutation` 훅.
- **Backend**: `GET/POST /api/v1/node-specs`, `GET/PUT/DELETE /api/v1/node-specs/{id}`, `POST /api/v1/node-specs/import/{cluster_id}`, `POST /api/v1/node-specs/collect-host-facts/{cluster_id}`, `POST /api/v1/node-specs/csv/preview`·`/csv/apply` — 라우터 `backend/app/routers/node_server_specs.py`, 모델 `backend/app/models/node_server_spec.py` (`NodeServerSpec`).
- **핵심 기능**:
  - kubeconfig 임포트 시 자동수집 필드만 upsert(벤더/자산태그/랙 등 수기 필드는 보존).
  - SSH 기반 Host Facts 수집으로 bond0/bond1 IP, lsblk 기반 SSD/디스크 종류 자동판별.
  - CSV 템플릿/업로드/미리보기(preview→apply 2단계) 및 엑셀 클립보드 붙여넣기 지원.
  - 그리드 블록 선택 + TSV 복사, 컬럼 너비 드래그 리사이즈(localStorage 영속화).
  - 상태(운영중/예비/점검/폐기)별 pill 필터 + 역할(control-plane/worker/etcd/storage/spare) 필터.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### OS / 커널 파라미터 조회 (`/kernel-params`)

- **파일**: `frontend/src/pages/KernelParamsPage.tsx`
- **목적 / UX**: 선택한 노드 여러 대에 SSH로 접속해 sysctl/conntrack/ulimit/디스크·IO/커널모듈/시간동기화 등을 **읽기 전용**으로 일괄 조회한다. 인증정보는 저장되지 않고 실행에만 사용됨을 명시.
- **UI 구성**:
  - `ClusterSidebar`는 `iconOnly` 단일선택(`allowAll` 없음).
  - 좌: 노드 체크리스트(ready 상태 dot + role 배지, 전체선택 토글).
  - 우: 프리셋 그리드(OS/Kernel 정보, sysctl-net/mem/fs, conntrack, limits, memory, disk-io, kernel-modules, time-sync) + 직접 입력(`SavedCommands` 연동), 인증(user/port/password|key), 실행모드(병렬/순차).
  - 결과: 노드별 접이식 `ResultCard`(exit code, stdout/stderr `LogViewer`, 노드 전체 공통 필터, 전체 펼침/접힘), 실행 전 `ConfirmDialog`.
- **Frontend**: `useClusters`, `useQuery(['bulk-exec','nodes',clusterId])` → `bulkExecApi.nodeList`; `useAbortableMutation` → `bulkExecApi.run({action:'ssh', ...})`.
- **Backend**: `GET /api/v1/clusters/{cluster_id}/node-list`, `POST /api/v1/bulk-exec/run` — 라우터 `backend/app/routers/bulk_exec.py`. 전용 DB 모델 없음(상태 비저장 SSH 병렬 실행, 결과는 응답으로만 반환).
- **핵심 기능**:
  - 10개 읽기전용 프리셋 + 직접 명령 입력, `SavedCommands`로 자주 쓰는 명령 저장.
  - 병렬/순차 실행 모드, 노드별 독립 결과(ok/error/timeout/auth_error/connect_error) 상태 배지.
  - 실행 응답 크기에 따라 타임아웃을 프론트에서 동적으로 추정(`bulkExecApi.run` 내부 로직).
  - 결과 카드 전역 텍스트 필터 + stdout/stderr 개별 `LogViewer`.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 인프라 토폴로지 (`/infra-topology`)

- **파일**: `frontend/src/pages/InfraTopologyPage.tsx` (+ `components/infra/NodeVerifyModal.tsx`)
- **목적 / UX**: 클러스터의 물리 노드를 스위치→랙→노드 계층으로 시각화해 물리 배치를 파악하고, 노드 CRUD·K8s 자동 동기화·신규노드 SSH/API 검증·Pod/Service→Switch 경로 추적(Trace)까지 한 화면에서 처리한다.
- **UI 구성**:
  - `ClusterSidebar`는 `iconOnly` 단일선택(`allowAll` 없음) — 기존 상단 가로 버튼 탭에서 CLAUDE.md 표준 패턴으로 마이그레이션.
  - role별(Master/Worker/Storage/Infra) 요약 통계 카드, "K8s 동기화" / "노드 추가" 버튼.
  - Pod/Service → Switch Trace 패널(namespace/target type/name 입력 → hop 리스트 + 병목 의심 홉 하이라이트).
  - 스위치 헤더 → 랙 카드 → `NodeCard`(role 배지, CPU/RAM/Disk, 스위치명, OS, auto-synced 배지) 계층 렌더링.
  - 노드 추가/수정 모달, 삭제 확인 모달, `NodeVerifyModal`(검증 결과).
- **Frontend**: `useClusters`; `useInfraNodes/useCreateInfraNode/useUpdateInfraNode/useDeleteInfraNode/useSyncInfraNodes/useVerifyInfraNode`(`frontend/src/hooks/useInfraNodes.ts`, 내부적으로 `infraNodesApi` 호출); Trace는 `topologyTraceApi.trace`를 페이지에서 직접 호출(전용 훅 없음).
- **Backend**: `GET/POST /api/v1/infra-nodes`, `GET/PUT/DELETE /api/v1/infra-nodes/{id}`, `POST /api/v1/infra-nodes/{id}/verify`, `POST /api/v1/infra-nodes/sync/{cluster_id}` — 라우터 `backend/app/routers/infra_nodes.py`, 모델 `backend/app/models/infra_node.py`(`InfraNode`). Trace는 `POST /api/v1/topology-trace` — 라우터 `backend/app/routers/topology_trace.py`.
- **핵심 기능**:
  - 스위치/랙 기반 계층형 물리 토폴로지 시각화(role 우선순위 정렬).
  - K8s 동기화 시 신규 노드 자동 검증 결과를 배너로 요약 노출.
  - 노드별 수동 "추가 검증"(SSH/API) 및 실패 시 사유 표시.
  - namespace + service/pod 기준 스위치까지의 hop 추적, latency/error 기반 병목 홉 강조.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요 — 예: `ClusterSidebar iconOnly` 표준 패턴으로 마이그레이션 필요)_

### Cilium BPF Trace (`/cilium-trace`)

- **파일**: `frontend/src/pages/CiliumTracePage.tsx`
- **목적 / UX**: Cilium/Hubble 기반 네트워크 디버깅 콘솔. BPF 맵(엔드포인트/LB/NAT/conntrack/tunnel 등)을 조회하고, `cilium monitor`·Hubble flow를 SSE로 실시간 스트리밍해 드롭/트레이스 이벤트를 분석한다.
- **UI 구성**:
  - `ClusterSidebar`는 `allowAll={false}` + `iconOnly` 단일선택.
  - 상태 스트립(Cilium 설치여부/버전, Agent Pod 수, Hubble Relay 여부, Trace 가용성).
  - 3-tab 구조: **BPF Inspector**(kind 선택 + agent pod 검색(`SearchableSelect`) + JSON 테이블/raw 출력, ad-hoc `cilium-dbg` 명령은 `RoleGate allow={['admin','operator']}`로만 노출 + 프리셋 저장), **Cilium Monitor**(SSE 스트림, type 필터 팝오버, related-to 필터, 일시정지/비우기), **Hubble Flows**(from/to pod·namespace·protocol·verdict 필터 + datalist 자동완성, SSE 스트림).
- **Frontend**: `useClusters`/`useClusterStore`; 로컬 `ciliumApi`(`api.get/post` 래퍼, `/cilium/{clusterId}/status|agents|bpf-inspect|exec-command`) + 자체 `startSseStream`(fetch 기반, Authorization 헤더 포함 SSE 파서, `/cilium/{clusterId}/monitor/stream`·`/hubble/stream`); `useCommands`/`useCreateCommand`(category=`cilium` 프리셋); `useAnalyzeNamespaces`/`useAnalyzePods`(Hubble 자동완성용, `analyzeApi`).
- **Backend**: `GET /api/v1/cilium/{cluster_id}/status`, `GET .../agents`, `POST .../bpf-inspect`, `POST .../exec-command`, `GET .../monitor/stream`(SSE), `GET .../hubble/stream`(SSE) — 라우터 `backend/app/routers/cilium_trace.py`. 프리셋은 `commands.py`(`CommandEntry` 모델) 재사용. 전용 영속 모델 없음(라이브 조회/스트림).
- **핵심 기능**:
  - BPF 맵 10종 인스펙터(JSON 결과는 자동 테이블 렌더, raw 텍스트 다운로드).
  - `cilium-dbg` ad-hoc 명령 실행(operator 권한 제한, 감사 로그 기록 명시) + 프리셋 저장.
  - `cilium monitor` 실시간 스트림(type 필터: drop/trace/capture/debug/recorder/agent/l7), 80ms throttle 버퍼링.
  - Hubble flow 실시간 관측(FORWARDED/DROPPED/AUDIT verdict 카운트, drop reason 표시).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 서비스 토폴로지 (`/service-topology`)

- **파일**: `frontend/src/pages/ServiceTopologyPage.tsx` (+ `components/topology/{TopologyCanvas,Topology3D,NodeDetailPanel,ManualLinkDialog,AddExternalNodeDialog}.tsx`)
- **목적 / UX**: 네임스페이스 단위 또는 클러스터 전체 범위에서 Service/Pod/ConfigMap/Secret/PVC 등 리소스 간 연계와 실시간 트래픽을 2D/3D 그래프로 시각화하고, 자동 탐지되지 않는 연계(외부 시스템 등)를 수동으로 추가할 수 있다.
- **UI 구성**:
  - `ClusterSidebar`는 `iconOnly` 단일선택(`allowAll` 없음).
  - 컨트롤 바: scope 토글(네임스페이스/전체 클러스터), 네임스페이스 선택(`NamespaceSingleSelect`, namespace scope) 또는 요약/상세 토글(cluster scope), 2D/3D 토글, Pod표시/미참조설정/실트래픽 pill 토글, 외부노드 추가, 링크 편집 모드.
  - 캔버스: `TopologyCanvas`(2D) / `Topology3D`(3D), 클러스터 전체 집계 중이면 `SnapshotProgressCard`(polling), 선택 노드 `NodeDetailPanel`, 범례.
  - 편집 모드에서 노드 2개 클릭 → `ManualLinkDialog`로 수동 링크 추가/삭제, `AddExternalNodeDialog`로 외부 노드 등록.
- **Frontend**: `useClusters`; `useServiceTopologyGraph`(namespace 그래프)/`useClusterTopologyGraph`(computing 시 1.5s 폴링)/`useServiceTopologyTraffic`(수동 트리거)/`useCreateTopologyLink`/`useDeleteTopologyLink`/`useCreateExternalNode`/`useDeleteExternalNode`(`frontend/src/hooks/useServiceTopology.ts`, `serviceTopologyApi` 래핑); `analyzeApi.listNamespaces`.
- **Backend**: `GET /api/v1/service-topology/{cluster_id}/graph`, `GET .../cluster-graph`, `GET .../traffic`, `GET/POST .../links`, `PATCH/DELETE /api/v1/service-topology/links/{id}`, `POST /api/v1/service-topology/{cluster_id}/external-nodes`, `DELETE /api/v1/service-topology/external-nodes/{id}` — 라우터 `backend/app/routers/service_topology.py`, 모델 `backend/app/models/service_topology.py`(`ServiceTopologyLink`, `ServiceTopologyExternalNode`).
- **핵심 기능**:
  - 자동 탐지 그래프(routes/exposes/uses_config/uses_secret/mounts_pvc) + 수동 링크/외부노드 병합.
  - 클러스터 전체 스캔은 백그라운드 집계(`status==='computing'`) 진행률 폴링.
  - Hubble→conntrack 기반 실트래픽 엣지 오버레이(온디맨드).
  - Prometheus 오프라인 시 requests/limits만 표시하는 경고 배지, 노드 상한 초과(truncated) 경고.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 서비스 모듈 관계도 (`/architecture`)

- **파일**: `frontend/src/pages/ArchitecturePage.tsx` (+ `components/architecture/{FlowDiagram,pepArchitecture}.tsx`)
- **목적 / UX**: PEP 자체 서비스 모듈(Frontend/Backend/PostgreSQL/Redis/Celery Beat·Worker/K8s/Ollama/Prometheus)의 관계와 실시간 헬스를 흐름도로 보여주거나(PEP 탭), 선택 클러스터의 애드온 hub-spoke 관계도(클러스터 탭)를 보여준다.
- **UI 구성**:
  - 탭(PEP 아키텍처 / 클러스터 토폴로지). `ClusterSidebar`(`iconOnly` 단일선택)는 **클러스터 토폴로지 탭일 때만 조건부 렌더**.
  - `MacCard` 안에 `FlowDiagram`(SVG 노드/엣지) + 상태 범례(정상/경고/위험/라이브 상태 미지원).
- **Frontend**: `usePepArchitectureGraph`(`frontend/src/hooks/useArchitecture.ts`) — `useSummary`(클러스터 요약), `agentApi.health`, `promqlApi.health`를 조합해 정적 레이아웃(`PEP_NODES/PEP_EDGES`)에 상태를 매핑; `useClusterAddonGraph` — `useAddons(clusterId)`로 hub(클러스터)-spoke(애드온) 그래프 생성.
- **Backend**: **전용 아키텍처 라우터 없음** — 기존 엔드포인트 조합: `GET /api/v1/health/summary`(또는 clusters summary), `GET /api/v1/agent/health`, `GET /api/v1/promql/health`, `GET /api/v1/clusters/{id}/addons`. Redis/Celery Beat/Worker 노드는 라이브 상태 API가 없어 `neutral`(구조만 표시) 고정.
- **핵심 기능**:
  - PEP 내부 모듈 상태를 기존 헬스 엔드포인트 3종 조합으로 실시간 매핑(백엔드=DB 신호 공유).
  - 클러스터 애드온(Nexus/Keycloak 등)을 hub-spoke 그래프로 상태와 함께 표시.
  - 라이브 신호가 없는 컴포넌트(Redis/Celery)는 회색 처리로 명확히 구분.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 패킷 흐름 분석 (`/packet-flow`)

- **파일**: `frontend/src/pages/PacketFlowPage.tsx` (+ `components/packet-flow/{FlowGraph3D,HopDetailPanel,HubbleTimeline,TcpdumpPanel}.tsx`)
- **목적 / UX**: North-South(외부→Ingress→Service→Pod) 또는 East-West(Pod↔Pod) 패킷 경로를 hop 단위로 추적해 각 hop의 정책/Identity/latency/error를 진단한다. Hubble flow 타임라인과 원격 tcpdump 캡처도 같은 화면에서 이어서 확인.
- **UI 구성**:
  - `ClusterSidebar`는 `iconOnly` 단일선택.
  - Target 구성 바(N-S/E-W 방향 토글, source/destination, protocol, port, path), 3-tab(경로 그래프/Hubble 플로우/원격 tcpdump).
  - `HopBreadcrumb`(hop 아이콘+verdict 색상) → `FlowGraph3D` + 선택 hop `HopDetailPanel`.
  - E-W 방향에서 pod-pair 패턴 인식 시 `/pod-bottleneck` 페이지로 prefill 이동하는 "병목 진단" 버튼(cross-link).
- **Frontend**: `useClusters`; `useAbortableMutation` → `topologyTraceApi.packetFlowV2`; 하위 탭은 각각 자체 훅으로 `topologyTraceApi.hubbleFlows`/`tcpdumpRun`/`tcpdumpInterfaces` 호출(컴포넌트 내부, 페이지에서는 직접 호출 안 함).
- **Backend**: `POST /api/v1/topology-trace/packet-flow-v2`(+구버전 `/packet-flow`), `POST /api/v1/topology-trace/hubble-flows`, `POST /api/v1/topology-trace/tcpdump`, `POST /api/v1/topology-trace/tcpdump/interfaces` — 라우터 `backend/app/routers/topology_trace.py`. 전용 영속 모델 없음(온디맨드 라이브 트레이스).
- **핵심 기능**:
  - N-S/E-W 두 방향의 hop 기반 경로 추적 + 3D 그래프 시각화.
  - hop별 verdict(allow/deny/warn) 색상 구분, latency+errorCount 기반 병목 홉 자동 계산.
  - source/destination 패턴에서 Hubble 필터를 자동 프리필.
  - pod-bottleneck-analyzer 페이지로의 컨텍스트 전달(cross-link, query param prefill).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### CIDR Calculator (`/cidr`)

- **파일**: `frontend/src/pages/CidrCalculatorPage.tsx`
- **목적 / UX**: CIDR 표기 입력만으로 네트워크/브로드캐스트/호스트 범위/서브넷마스크를 계산하고, 서브넷 균등 분할, 다중 CIDR 충돌 검사, 등록된 클러스터 CIDR과의 겹침 경고, 계산 결과를 클러스터 메타정보에 저장하는 것까지 지원하는 네트워크 유틸리티.
- **UI 구성**:
  - **`ClusterSidebar` 미사용** — 클러스터 개념이 아닌 순수 계산 도구이므로 페이지 전체가 `max-w` 중앙 정렬 단일 컬럼.
  - HERO 입력(CIDR 텍스트 입력 + Private/Public 배지 + Address Space 슬라이더), Network Details(4개 stat tile + 이진 마스크 시각화 + 클러스터 겹침 경고), 좌 컬럼(서브넷 분할/멀티 CIDR 비교 테이블 — 충돌 그룹 색상 매핑), 우 컬럼(클러스터에 적용 — plain `<select>`로 대상 클러스터 선택, Quick Reference prefix 표).
- **Frontend**: 순수 클라이언트 계산 함수(`parseCidr`, `divideSubnets`, `computeOverlap`, `cidrsOverlap` 등, 상태 없는 비트연산)로 구성되며 서버 데이터 의존 없음. `useClusterStore`/`useClusters`는 등록 클러스터의 CIDR과 충돌 검사 및 "적용" 대상 목록 조회용으로만 사용. `useColumnWidths`(비교 테이블 컬럼 리사이즈).
- **Backend**: **계산 로직 자체는 백엔드 호출 없음**(완전 클라이언트 유틸). 유일한 서버 호출은 "클러스터에 적용" 버튼 → `PUT /api/v1/clusters/{id}`(`clustersApi.update`, body: `cidr/first_host/last_host`) — 라우터 `backend/app/routers/clusters.py`, 모델 `backend/app/models/cluster.py`(`Cluster`).
- **핵심 기능**:
  - CIDR 파싱/네트워크·브로드캐스트·마스크·와일드카드·호스트범위 계산, Private(RFC1918) 여부 판정.
  - 서브넷 N등분(2~256), 다중 CIDR 겹침 검사(그래프 탐색으로 충돌 그룹 색상 클러스터링).
  - 등록 클러스터 CIDR과의 실시간 충돌 경고(현재 입력/적용 예정 값 기준 양방향).
  - Quick Reference로 prefix 클릭 시 현재 입력에 즉시 적용.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 클러스터 주요 링크 (`/links`)

- **파일**: `frontend/src/pages/ClusterLinksPage.tsx`
- **목적 / UX**: 클러스터별 대시보드/모니터링/관리 콘솔 URL과, 모든 클러스터에 공통되는 링크(예: Jira, Wiki)를 한곳에 모아 빠르게 접근할 수 있게 하는 즐겨찾기 허브.
- **UI 구성**:
  - **`ClusterSidebar` 미사용** — 모든 클러스터의 링크를 동시에 비교/열람하는 것이 목적이라 사이드바 대신 표/카드 매트릭스 레이아웃 사용.
  - `ViewModeBar`(표/종/횡 3가지 레이아웃), 검색, 통계 타일(전체 링크/클러스터 수/공통 링크).
  - **표 모드**: 클러스터별 열 + 공통 링크 열의 CSS Grid 매트릭스(컬럼 드래그 리사이즈, 인라인 추가/편집 폼).
  - **카드 모드**(종/횡): `dnd-kit`로 클러스터 그룹 드래그 정렬, `LinkCard` 그리드.
  - 삭제된 클러스터에 남은 "고아 그룹" 링크는 읽기 전용으로 별도 표시.
- **Frontend**: `useClusters`/`useClusterStore`; `useClusterLinks`/`useUpdateClusterLinks`(`frontend/src/hooks/useUiSettings.ts`, `uiSettingsApi` 래핑); `useTableViewStore`(표 스타일: 폰트크기/밀도/줄무늬/헤더테마, 로컬 Zustand).
- **Backend**: `GET/PUT /api/v1/ui-settings/cluster-links` — 라우터 `backend/app/routers/ui_settings.py`. 별도 전용 모델 없이 `AppSetting`(`backend/app/models/app_setting.py`) 류의 key-value/JSON 설정 테이블에 `clusterGroups`+`commonLinks` 구조로 저장되는 것으로 추정(모델 파일 상세 미확인).
- **핵심 기능**:
  - 클러스터별 링크 + 공통 링크 이중 구조, 3가지 뷰(표/종형카드/횡형카드) 전환.
  - 드래그 정렬(클러스터 그룹 순서), 컬럼 너비 드래그 리사이즈(localStorage 영속화).
  - 라벨/설명/URL 통합 검색.
  - 클러스터 삭제 후에도 남은 링크를 "고아 그룹"으로 보존 표시.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### mc 클라이언트 콘솔 (`/mc`)

- **파일**: `frontend/src/pages/McClientPage.tsx` (+ `components/mc/McPresetManager.tsx`)
- **목적 / UX**: MinIO `mc` CLI가 설치된 노드에 SSH로 접속해 `mc admin info`, `mc ls`, `mc mirror`, `mc policy set` 등 명령을 실행하는 스토리지 운영 콘솔. alias는 사전에 `mc alias set`으로 구성되어 있어야 하며, `{alias}` 플레이스홀더로 프리셋에서 치환.
- **UI 구성**:
  - `ClusterSidebar`는 `iconOnly` 단일선택.
  - 10-컬럼 그리드: 좌(2) 타겟+인증(노드 선택 select + 수동 host override, user/port, password|key), 중(3) `McPresetManager`(개인/공유 프리셋) + alias/mc경로/인자 입력(`SavedCommands`) + timeout, 우(5) 결과 패널(항상 고정 위치, executed/stdout/stderr `LogViewer`).
  - 위험 명령(`rm`/`mirror`/`admin service stop|restart`/`policy set`/`admin user remove` 등 정규식 매칭) 감지 시 `ConfirmDialog`를 `danger` 스타일로 강조.
  - 선택 클러스터의 `operationLevel`에 따라 터미널 테마(`useTerminalEnvStore`)가 자동 전환.
- **Frontend**: `useClusters`; `useQuery(['bulk-exec','nodes',clusterId])` → `bulkExecApi.nodeList`(노드목록 재사용); `useMutation` → `mcApi.run`; `useAuthStore`(admin 여부로 프리셋 공유 편집 권한), `useTerminalEnvStore`.
- **Backend**: `POST /api/v1/clusters/{cluster_id}/mc/run`, `GET /api/v1/clusters/{cluster_id}/mc/presets`, `GET/PUT /api/v1/mc/presets/personal`, `GET/PUT /api/v1/mc/presets/shared` — 라우터 `backend/app/routers/mc_client.py`. 노드 목록은 `GET /api/v1/clusters/{cluster_id}/node-list`(`bulk_exec.py` 재사용). 전용 실행결과 영속 모델 없음(온디맨드 SSH 실행).
- **핵심 기능**:
  - SSH 기반 원격 `mc` 명령 실행(비밀번호/PEM 키 인증 선택).
  - 개인/공유 프리셋 관리(`McPresetManager`) + `{alias}` 자동 치환.
  - 위험 명령(rm/mirror/policy/admin service 등) 정규식 기반 사전 경고 및 `danger` 확인 다이얼로그.
  - 클러스터 운영등급에 연동된 터미널 외관 자동 전환.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

### NFS 모니터링 (Isilon) (`/isilon-nfs`)

- **파일**: `frontend/src/pages/IsilonNfsPage.tsx` (+ `components/isilon/IsilonServerModal.tsx`, `components/isilon/IsilonCommandManager.tsx`)
- **목적 / UX**: K8s 가 마운트해서 쓰는 NFS 를 Isilon(OneFS) NAS **서버 쪽**에서 점검. SSH 로 `isi` 명령을 실행해 Export/마운트 가용성·쿼터/용량·클라이언트/성능·노드 health 를 수집하고, K8s PV(`spec.nfs`) ↔ Isilon export 매칭(누락 감지)을 보여준다. **NAS 무부하**가 최우선 — 읽기전용 명령만·SSH 세션 1개 직렬 실행·서버별 60초 TTL 캐시(강제 재수집은 명시적 새로고침만).
- **UI 구성**:
  - 좌측 서버 레일(Isilon 서버 목록, status dot + 기본 배지) + "서버 추가"/"isi 명령 관리" 버튼. 클러스터가 아닌 **서버 스코프**라 `ClusterSidebar` 대신 전용 서버 레일 사용.
  - 본문: 서버 헤더(접속 상태·수집시각·캐시 배지·새로고침) → "K8s 가 사용하는 NFS(PV↔export)" 매칭 테이블 → 섹션별(`SECTION_LABEL`) 수집 결과 카드(`MacCard`, parsed JSON/raw).
  - `IsilonServerModal`: host/port/user/비밀번호|PEM 키 + 연결 테스트. 자격증명은 암호화 저장, 응답엔 `hasPassword`/`hasPrivateKey` 플래그만.
  - `IsilonCommandManager`: `isi` 명령 등록/편집/삭제(글로벌 기본 + 서버 전용). 변경 동사·셸 메타문자·`--repeat` 등은 저장이 422 로 거부됨(부하 보호). builtin 은 비활성만(삭제 불가).
- **Frontend**: `useIsilonServers`/`useIsilonOverview`/`useIsilonCommands` + CRUD/test 뮤테이션(`hooks/useIsilonNfs.ts`), `isilonNfsApi`(`services/api.ts`), 타입은 `types/index.ts`(`IsilonServer`/`IsilonCommand`/`IsilonNfsOverview` 등). overview 는 부하 보호상 자동 폴링 안 함.
- **Backend**: `GET/POST/PUT/DELETE /api/v1/isilon-nfs/servers` (+ `/servers/{id}/test`), `GET/POST/PUT/DELETE /api/v1/isilon-nfs/commands`, `GET /api/v1/isilon-nfs/overview` — 라우터 `backend/app/routers/isilon_nfs.py`. 수집·검증·캐시는 `services/isilon_service.py`, 모델 `models/isilon_server.py`(`IsilonServer`/`IsilonCommand`, 자격증명 `secret_box` 암호화 + 백업 마스킹). 같은 수집을 쓰는 `isilon_nfs` deep checker(`services/deep_checkers/isilon_nfs_checker.py`, registry 등록)가 운영 점검 콘솔/cron 에도 노출(기본 비활성).
- **핵심 기능**:
  - SSH 기반 `isi` 명령 수집(비밀번호/PEM 키), 읽기전용·무부하 보장.
  - K8s NFS PV ↔ Isilon export 매칭으로 "실제 K8s 가 쓰는 NFS" 가용성 가시화.
  - `isi` 명령 커스텀 등록(DB 관리, OneFS 버전별 편집) + deep checker 통합(쿼터/가용성/health 판정).
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## DevOps — Playbook / Batch Job / 명령어

### Ansible Playbooks (`/playbooks`)

- **파일**: `frontend/src/pages/PlaybooksPage.tsx` (+ `components/playbooks/PlaybookCard.tsx`, `PlaybookListRow.tsx`, `AddPlaybookModal.tsx`, `RunCredsModal.tsx`, `PlaybookLogDialog.tsx`, 공통 `components/common/ClusterSidebar.tsx`)
- **목적 / UX**: 클러스터별로 등록된 Ansible playbook을 조회·실행하고 실행 결과(OK/Changed/FAILED)를 확인한다. 운영자가 여러 클러스터에 걸쳐 동일 계열의 점검/조치 playbook을 한 화면에서 일괄(Run All) 또는 개별 실행하고, 결과를 Markdown 리포트로 export 할 수 있다.
- **UI 구성**:
  - 좌측 `ClusterSidebar` — **multiSelect** 모드(`iconOnly` + `allowAll` + `multiSelect`), 빈 배열은 "전체 클러스터"를 의미 (CLAUDE.md에서 multiSelect 패턴의 기준 예시로 명시된 페이지).
  - 헤더: 상태 카운트 배지(OK/Changed/Failed), List/Card 뷰 토글, 정렬(이름/상태/최근 실행순) 컨트롤, `Export .md`, `Run All`(RoleGate: admin/operator), `Register Playbook`(RoleGate: admin/operator) 버튼.
  - 본문: List 뷰(`PlaybookListRow`, `dnd-kit` 드래그 정렬) 또는 Card 뷰(`SortableCardCell` → `PlaybookCard`) — `useLocalOrder` 훅으로 클러스터 선택 조합별 순서를 localStorage에 보존.
  - 모달: `AddPlaybookModal`(등록/수정, DB 관리형 playbook file/inventory 또는 구형 path 방식 선택), `RunCredsModal`(단일 실행 시 SSH 자격증명 입력, sessionStorage에 세션 캐시), `PlaybookLogDialog`(실행 로그 상세).
- **Frontend**: `usePlaybooks`, `useCreatePlaybook`, `useUpdatePlaybook`, `useDeletePlaybook`, `useRunPlaybook`, `useToggleDashboard`(모두 `hooks/usePlaybook.ts`, TanStack Query) + `usePlaybookStore`(Zustand: `playbooks`, `runningIds`) + `useClusterStore`/`useClusters`(전체 클러스터 목록) + `useLocalOrder`(드래그 순서 로컬 보존). 로컬 state로 `selectedClusterIds`(다중 선택), `sortKey/sortDir`, `viewMode`, `credsTarget`, `logTarget` 관리. 호출 함수: `playbooksApi.exportReport`(직접 호출, blob 다운로드) 외 CRUD/실행은 훅을 통해 `playbooksApi.getAll/create/update/delete/run/toggleDashboard`.
- **Backend**: `GET /api/v1/playbooks`(목록, cluster_id 옵션), `POST /api/v1/playbooks`(등록, `require_operator`), `PUT /api/v1/playbooks/{id}`(수정), `DELETE /api/v1/playbooks/{id}`, `PATCH /api/v1/playbooks/{id}/dashboard`(대시보드 토글), `GET /api/v1/playbooks/dashboard/{cluster_id}`, `POST /api/v1/playbooks/{id}/run`(동기 실행, SSH 자격증명은 DB 저장 없이 extra_vars로만 전달), `GET /api/v1/playbooks/report`(Markdown export) — 모두 `backend/app/routers/playbooks.py`. 실행은 `backend/app/services/playbook_executor.py`(`run_playbook`, local/ssh 모드, ansible JSON callback 파싱)를 사용하며, inventory가 없으면 `_cluster_node_hosts()`로 K8s 노드 IP 동적 inventory 생성. 모델: `backend/app/models/playbook.py`(`Playbook`, FK `cluster_id`/`playbook_file_id`/`inventory_id`), `AnsiblePlaybookFile`/`AnsibleInventory`(DB 관리형 자산, `ansible_assets.py` 라우터 — `/playbook-files`, `/playbook-inventories`)도 함께 참조. 실행 시 `audit_logger.record()`로 감사 로그 기록.
- **핵심 기능**:
  - 다중 클러스터 선택 필터링(클라이언트 사이드) + 클러스터 라벨 표시(2개 이상 선택 시)
  - List/Card 뷰 전환 및 드래그 앤 드롭 순서 변경(선택 조합별 별도 순서 키)
  - 단일 실행 시 세션 캐시된 SSH 자격증명 재사용, 없으면 모달로 입력받음; Run All은 캐시된 자격증명으로 일괄 실행
  - 실행 상태 실시간 표시(healthy/warning/critical/running, `runningIds` Zustand 세트)
  - Dashboard 노출 토글(`show_on_dashboard`) — 메인 Dashboard 화면에 카드로 표시
  - 클러스터 단일 선택 시 해당 클러스터 한정 Markdown 리포트 export, 다중/전체 선택 시 전체 export
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Batch Jobs (`/batch-jobs`)

- **파일**: `frontend/src/pages/BatchJobsPage.tsx` (+ `components/batch-jobs/BatchJobTable.tsx`, `BatchJobFilters.tsx`, `BatchJobSlideOver.tsx`(+`.EditForm`/`.RunForm`/`.RunHistory`/`.SavedCreds`), `CreateBatchJobWizard.tsx`(+`.StepType`/`.StepHost`/`.StepSchedule`), `UnregisteredTypeChips.tsx`, `StatusPill.tsx`, 공통 `ClusterSidebar`/`ConfirmDialog`/`useToast`)
- **목적 / UX**: etcd defrag, snapshot 저장 등 클러스터별 반복적 운영 작업(batch job)을 등록하고 수동/일괄/스케줄(cron) 실행하며 실행 이력을 확인한다. SSH 대상 호스트·자격증명을 잡에 저장해두고 재사용할 수 있다.
- **UI 구성**:
  - 좌측 `ClusterSidebar` — **단일 선택 + 전체** 모드(`iconOnly` + `allowAll` + `allLabel="전체"`, `selectedId`/`onSelect`).
  - 헤더: 잡 개수/실패/실행 중 요약, "새 잡" 버튼(클러스터 미선택 시 빈 wizard, 선택 시 prefilled).
  - `MacCard "배치 잡"`: `BatchJobFilters`(상태 필터 + 검색), 체크박스 다중 선택 시 일괄 실행 바(저장된 자격증명으로 `bulkRun`), `BatchJobTable`(정렬/선택 가능), 클러스터 선택 시 `UnregisteredTypeChips`(미등록 타입 바로가기).
  - 우측 `BatchJobSlideOver` — 행 클릭 시 잡 상세(수정/실행/이력/자격증명), 뷰포트 <1280px에서는 overlay 모드.
  - `CreateBatchJobWizard`(3단계: 타입 → 호스트 → 스케줄), 삭제 시 `ConfirmDialog`.
- **Frontend**: `useBatchJobTypes`, `useBatchJobs`, `useDeleteBatchJob`(+ 컴포넌트 내부에서 `useCreateBatchJob`/`useUpdateBatchJob`/`useRunBatchJob`/`useTestBatchJobConnection`/`useBatchJobRuns`, 모두 `hooks/useBatchJobs.ts`), `useClusters`. 순수 로컬 state(Zustand 스토어 없음)로 `selectedClusterId`, `statusFilter`, `search`, `sort`, `selectedJob`, `wizardCtx`, `selectedIds`(일괄 실행용), `overlayMode`(matchMedia) 관리. 일괄 실행은 훅이 아닌 `batchJobsApi.bulkRun()` 직접 호출 + `useToast`로 결과 알림.
- **Backend**: `GET /api/v1/batch-jobs/types`(등록된 job_type 목록), `GET/POST /api/v1/batch-jobs`, `PUT/DELETE /api/v1/batch-jobs/{id}`, `POST /api/v1/batch-jobs/{id}/run`(동기, timeout 600s), `POST /api/v1/batch-jobs/bulk-run`(Celery `run_batch_job.delay()`로 비동기 큐잉, 저장된 자격증명 없으면 스킵), `GET /api/v1/batch-jobs/{id}/runs`, `GET /api/v1/batch-jobs/runs/{id}`, `POST /api/v1/batch-jobs/{id}/test-connection`(SSH 연결만 검증) — 전부 `backend/app/routers/batch_jobs.py`. 서비스: `app/services/batch_job_service.py`(`execute_job`, `get_job_or_404`), `app/services/batch_jobs/`(`@register_executor` 패턴으로 job_type별 executor 등록, `list_executors`/`get_executor`), `app/services/ssh_runner.py`(paramiko 기반 `test_connection`), `app/services/secret_box.py`(자격증명 암/복호화). 모델: `backend/app/models/batch_job.py`(`BatchJob`, `BatchJobRun` — cron·`encrypted_password`/`encrypted_private_key`·`last_schedule_check_at`/`last_schedule_note` 필드로 스케줄 진단 지원).
- **핵심 기능**:
  - 클러스터 단일 선택/전체 보기, 상태 필터(전체/실패/실행중 등) + 텍스트 검색
  - 체크박스 다중 선택 후 저장된 자격증명으로 여러 클러스터 잡을 Celery 백그라운드 일괄 실행(`bulk-run`), 큐잉/스킵 결과를 토스트로 안내
  - 잡별 슬라이드오버에서 수정/수동 실행(요청 시 자격증명 override 가능)/실행 이력(`BatchJobSlideOver.RunHistory`)/저장된 자격증명 관리(`.SavedCreds`)
  - cron 스케줄 등록 시 자격증명 저장이 필수(422로 강제, `_require_cron_credentials`) — 백엔드가 매분 silent skip 되는 상황을 사전 차단
  - SSH 연결 테스트(명령 미실행, `test-connection`)로 자격증명/네트워크 사전 검증
  - 미등록 job_type을 클러스터별로 안내하는 `UnregisteredTypeChips` → wizard로 바로 등록 유도
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 주요 명령어 모음 목록 (`/commands`)

- **파일**: `frontend/src/pages/CommandsPage.tsx` (+ `components/commands/CommandsTable.tsx`, `components/common/ConfirmDialog`)
- **목적 / UX**: 자주 쓰는 kubectl/helm/docker/ansible 등 CLI 한 줄을 의미·주의사항·중요도(정보~치명)와 함께 기록해두는 운영 레퍼런스 라이브러리. 파괴적 명령(critical)은 시각적으로 강조되어 실수 방지에 도움을 준다. 클러스터 종속 화면이 아니라 전역 지식 목록이다.
- **UI 구성**:
  - `ClusterSidebar` 미사용 — 클러스터와 무관한 전역 목록 화면.
  - 헤더 + "새 명령어" 버튼(`/commands/new`로 이동).
  - `MacCard`(필터 바): 검색창(명령어/의미/주의사항/태그), 카테고리 드롭다운(등록된 항목에서 동적 추출), 중요도 드롭다운, 총 건수 표시.
  - `MacCard`(리스트, `bodyPadding="p-0"`): `CommandsTable` — 인라인 수정/생성/삭제/pin 토글 지원, 행 클릭 시 `/commands/{id}/edit`으로 이동해 상세 폼 오픈.
  - 삭제 시 `ConfirmDialog`.
- **Frontend**: `useCommands(queryParams)`, `useDeleteCommand`, `useUpdateCommand`, `useCreateCommand`(모두 `hooks/useCommands.ts`, TanStack Query). 로컬 state: `search`, `filterCategory`, `filterImportance`, `confirmDelete`. `queryParams`를 `useMemo`로 구성해 `commandsApi.list({q, category, importance})` 호출(테이블 인라인 편집은 `updateInline.mutate`/`createInline.mutate`로 즉시 반영).
- **Backend**: `GET /api/v1/commands`(검색/카테고리/중요도 필터, `q`는 command/description/caution/tags/category ILIKE), `POST /api/v1/commands`(`require_operator`), `PUT /api/v1/commands/{id}`(`require_operator`), `DELETE /api/v1/commands/{id}`(`require_operator`) — `backend/app/routers/commands.py`. 목록은 pinned → importance(critical 우선) → sort_order → updated_at 순으로 파이썬에서 재정렬(`_IMPORTANCE_RANK`). 모델: `backend/app/models/command_entry.py`(`CommandEntry`, PK는 UUID 문자열, `importance`/`pinned`/`sort_order`/`confluence_url` 필드 포함).
- **핵심 기능**:
  - 텍스트 검색 + 카테고리/중요도 필터 조합
  - 중요도별 색상 구분(info/low/medium/high/critical), critical은 경고 아이콘과 함께 강조
  - 상단 고정(pinned) 토글로 자주 쓰는 명령을 목록 최상단에 유지
  - 테이블에서 바로 인라인 수정/신규 추가 가능(폼 페이지 이동 없이)
  - Confluence 문서 링크 연결(`confluenceUrl`)로 상세 문서 참조
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 명령어 등록 / 수정 (`/commands/new`, `/commands/:id/edit`)

- **파일**: `frontend/src/pages/CommandFormPage.tsx` (내부 `CommandForm` 컴포넌트, `components/common/ConfluenceUrlInput`)
- **목적 / UX**: `/commands` 목록에서 진입해 명령어 항목을 상세 입력 폼으로 신규 등록하거나 수정한다. 카테고리·중요도·명령어 본문·의미·주의사항·예시·태그·Confluence 링크까지 구조화된 필드로 입력받는다.
- **UI 구성**:
  - `ClusterSidebar` 미사용.
  - sticky 상단 바: 뒤로가기(`/commands`) + "명령어 수정"/"새 명령어" 라벨.
  - 카드 폼: 카테고리/중요도/상단고정 3열, 명령어(필수, textarea, monospace), 의미, 주의사항, 예시(선택, monospace), 태그(쉼표 구분), `ConfluenceUrlInput`, 하단 취소/저장 버튼.
  - 수정 모드는 단건 fetch 엔드포인트 대신 `/commands` 목록 쿼리 캐시에서 `id`로 항목을 찾아 초기값 구성(전용 detail fetch 없음).
- **Frontend**: `useCommands()`(목록 캐시 재활용, edit 모드에서 `listData.data.find(id)`로 initial 값 도출), `useCreateCommand`, `useUpdateCommand`(`hooks/useCommands.ts`). `useToast`로 저장 성공/실패 알림, `formatApiError`로 에러 메시지 정규화. 로컬 state로 각 폼 필드(`category`, `command`, `description`, `caution`, `examples`, `tags`, `importance`, `pinned`, `confluenceUrl`) 및 `error` 관리.
- **Backend**: 신규 등록 시 `POST /api/v1/commands`, 수정 시 `PUT /api/v1/commands/{id}`(둘 다 `require_operator`) — `backend/app/routers/commands.py`. 별도의 `GET /api/v1/commands/{id}` 단건 조회 엔드포인트가 존재하지만 이 화면에서는 사용하지 않고 목록 쿼리 캐시를 재사용한다. 모델은 `CommandsPage`와 동일한 `backend/app/models/command_entry.py`(`CommandEntry`).
- **핵심 기능**:
  - 필수 필드(`command`) 미입력 시 클라이언트 사이드 유효성 검사 후 저장 차단
  - 저장 성공 시 토스트 알림 후 `/commands` 목록으로 자동 복귀
  - 수정 모드에서 목록 로딩 중/대상 없음 상태를 각각 별도 안내 문구로 표시
  - 신규/수정 공통 폼 컴포넌트(`CommandForm`) 재사용으로 로직 중복 최소화
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## 협업 — 업무 관리 / 스프린트 / 워크플로우

### 업무 관리 게시판 (`/tasks-mgmt`)

- **파일**: `frontend/src/pages/WorkItemBoardPage.tsx` (+ `components/work-items/WorkItemKanban.tsx`, `WorkItemCalendar.tsx`, `WorkItemTableRow.tsx`, `AddWorkItemRow.tsx`, `ColumnSettingsMenu.tsx`, `WorkItemFormModal.tsx`, `WorkItemCustomFieldsManager.tsx`, `JiraImportModal.tsx`)
- **목적 / UX**: 전사 업무(task/issue/meeting/training/etc)를 표(목록)/달력/칸반 3가지 뷰로 조회·필터링·정렬하고, 등록·수정·삭제·CSV 추출·Jira 가져오기까지 처리하는 업무 관리의 메인 허브.
- **UI 구성**:
  - 헤더: 전체/WIP/Done 카운트 배지, 뷰 전환(`ViewModeBar`: 목록/달력/칸반), Jira 가져오기 버튼(`jiraConfig.enabled`일 때만), CSV 추출, 업무 등록 버튼
  - 업무 분류 드롭다운(6개 유형) + 담당자/분류/우선순위/모듈/스프린트/기간(이번주 토글, from~to) 필터 바, 시간표시 토글, 사용자 정의 필드 관리, 컬럼 설정 메뉴
  - 목록 뷰: dnd-kit 기반 컬럼 드래그 정렬 + 행 드래그 정렬(로컬 순서, `useLocalOrder`), 컬럼 리사이즈(`useColumnWidths`)·표시여부(`useColumnLayout`), 하단 인라인 `AddWorkItemRow`
  - 칸반 뷰: `WorkItemKanban` (상태별 컬럼)
  - 달력 뷰: `WorkItemCalendar`
  - 모달: `WorkItemFormModal`(신규/하위 등록), `WorkItemCustomFieldsManager`, `JiraImportModal`, 삭제 `ConfirmDialog`
- **Frontend**: `useWorkItems(filters)`, `useCreateWorkItem`, `useDeleteWorkItem`(hooks/useWorkItems.ts, TanStack Query), `useClusters`/`useClusterStore`(Zustand), `useProjects`, `useSprints`, `useJiraConfig`(hooks/useJira.ts). 로컬 state로 뷰모드·필터·정렬·show-time(localStorage 영속) 관리. `workItemsApi.exportCsv`(axios blob) 직접 호출.
- **Backend**: `GET /api/v1/work-items`(목록, 필터 쿼리파라미터 snake_case 변환), `POST /api/v1/work-items`, `DELETE /api/v1/work-items/{id}`, `GET /api/v1/work-items/export/csv` — `backend/app/routers/work_items.py`. 프로젝트명/스프린트명 매핑을 위해 `GET /api/v1/projects`(`projects.py`), `GET /api/v1/sprints`(`sprint.py`)도 호출. Jira 가져오기 가능 여부는 `GET /api/v1/jira/config`(`jira.py`). 모델: `backend/app/models/work_item.py` (WorkItem).
- **핵심 기능**:
  - 표/달력/칸반 3뷰 전환 및 유형·담당자·분류·우선순위·모듈·스프린트·시작일 범위 복합 필터
  - 컬럼 순서/폭/표시여부 개인화(localStorage) + 헤더 드래그 정렬, 행 드래그(dnd-kit) 순서 저장
  - 인라인 행 추가(AddWorkItemRow), 팝업 등록/하위 등록(WorkItemFormModal), 상세 페이지 편집 딥링크(`?edit=1`)
  - CSV 추출, Jira 이슈 가져오기(JiraImportModal), 업무 사용자 정의 필드 관리
  - 삭제 시 403(본인 등록/담당만 삭제 가능) 등 서버 에러 메시지를 토스트로 구체 노출
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 업무 등록 (`/tasks-mgmt/new`)

- **파일**: `frontend/src/pages/WorkItemFormPage.tsx` (+ `components/work-items/WorkItemForm.tsx`)
- **목적 / UX**: 신규 업무 또는 특정 업무의 하위 업무를 등록하는 전용 페이지. 업무 수정은 이 페이지를 쓰지 않고 상세 페이지(`/tasks-mgmt/:id?edit=1`) 내 인라인 편집으로만 처리한다 — 별도 edit 라우트 없음.
- **UI 구성**:
  - sticky 상단바: 목록으로 가기, 페이지 타이틀("업무 등록" / "하위 업무 등록"), 상위 업무 요약(하위 등록 시)
  - 본문: `WorkItemForm`을 `embedded` 모드로 카드에 감싸 렌더링
- **Frontend**: `useWorkItems()`(hooks/useWorkItems.ts, 목록에서 `parentId`로 상위 항목 조회) — 별도 단건 GET을 쓰지 않고 이미 캐시된 목록에서 find. `useSearchParams`로 `parentId`/`type`/`startedAt` 쿼리 읽어 기본값 지정. 실제 저장 mutation은 `WorkItemForm` 내부에서 처리(`useCreateWorkItem`).
- **Backend**: 저장 시 `POST /api/v1/work-items` (`backend/app/routers/work_items.py`). 목록 조회는 `GET /api/v1/work-items`. 모델: `WorkItem` (parent_id 자기참조 FK로 하위 업무 구현).
- **핵심 기능**:
  - `type` 쿼리파라미터로 유형(task/issue/meeting/training/etc) 사전 지정, 유효하지 않으면 `task` 기본값
  - `parentId` 쿼리파라미터로 하위 업무 등록 모드 전환 + 상위 업무 제목 미리보기(HTML 스트립, 60자 절삭)
  - `startedAt` 쿼리파라미터로 캘린더/보드에서 날짜 지정 진입 지원
  - 취소/저장 완료 시 `/tasks-mgmt`로 복귀
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 업무 상세 (`/tasks-mgmt/:id`)

- **파일**: `frontend/src/pages/WorkItemDetailPage.tsx` (+ `components/work-items/WorkItemForm.tsx`, `WorkItemReadView.tsx`, `RelatedServiceEntriesSidebar.tsx`, `CommentThread.tsx`, `ActivityTimeline.tsx`)
- **목적 / UX**: 업무 1건의 상세 조회/인라인 편집, Jira 반영, 하위 업무 등록, 삭제를 한 화면에서 처리. `?edit=1` 쿼리로 진입하면 바로 편집 모드(칸반 카드/테이블 행의 연필 아이콘이 여기로 딥링크).
- **UI 구성**:
  - sticky 상단바: 목록으로, Jira 반영 버튼(`jiraIssueKey` 있을 때만), 하위 등록, 삭제(읽기 모드에서만 노출)
  - 읽기 모드: `WorkItemReadView`(본문 카드) + `item.service`가 있으면 우측 `RelatedServiceEntriesSidebar`(같은 서비스의 ServiceEntry 5건, sticky). 내부에 `ActivityTimeline`(변경 이력), `CommentThread`(댓글 + `ReactionBar`로 댓글 리액션) 포함
  - 편집 모드: `WorkItemForm` embedded
  - 삭제 확인 / Jira 강제 반영(conflict) `ConfirmDialog` 2종
- **Frontend**: `useWorkItems()`로 id 매칭(단건 GET 없이 목록 캐시 재사용), `useDeleteWorkItem`, `useJiraPush`(hooks/useJira.ts). `isEditing` 로컬 state(초기값 `searchParams.get('edit')==='1'`). 댓글/이력은 `useWorkItemComments`, `useAddWorkItemComment`, `useDeleteWorkItemComment`, `useWorkItemActivities`(hooks/useWorkItems.ts) — `WorkItemReadView`/`CommentThread`/`ActivityTimeline` 내부에서 호출.
- **Backend**: `DELETE /api/v1/work-items/{id}`, `PUT /api/v1/work-items/{id}`(편집 저장), `POST /api/v1/jira/push/{item_id}`(Jira 반영, `force` 파라미터로 충돌 강제 덮어쓰기) — `work_items.py`, `jira.py`. 댓글: `GET/POST /api/v1/work-items/{id}/comments`, `DELETE /api/v1/work-items/comments/{comment_id}`. 이력: `GET /api/v1/work-items/{id}/activities`. 댓글 리액션: `GET /api/v1/reactions`, `POST /api/v1/reactions/toggle`(`reactions.py`, `target_type="work_item_comment"`).
- **핵심 기능**:
  - 읽기/편집 모드 토글(라우트 분리 없음), 상세 URL에 `?edit=1`로 바로 편집 진입
  - Jira 반영(현재 상태 push) 및 Jira 쪽이 더 최신일 때 충돌 감지 → 강제 반영 확인 다이얼로그
  - 하위 업무 등록 딥링크(`/tasks-mgmt/new?parentId=...`)
  - 댓글 스레드(리액션 포함) + 활동 타임라인으로 변경 이력 추적
  - 같은 서비스에 속한 다른 ServiceEntry cross-view 사이드바(서비스 필드가 있을 때만)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Work To Do — 오늘의 할일 (`/todo-today`)

- **파일**: `frontend/src/pages/TodoTodayPage.tsx`
- **목적 / UX**: 로그인한 "나"의 담당 업무만 모아 스프린트 진행상황, 하루 일정, 카드/리스트 형태로 확인하고 빠르게 완료 처리·스프린트 배정을 할 수 있는 개인 대시보드. 다른 사람 업무는 노출하지 않는다.
- **UI 구성**:
  - 헤더: `{이름}님의 Work To Do`, 뷰 전환(`ViewModeBar`: 스프린트/일정/카드/리스트), 업무 게시판 바로가기, 업무 추가, 새로고침
  - 요약 통계 4칸: 지연/오늘/진행중/예정 카운트
  - 스프린트 뷰: 현재 진행 스프린트 헤더(기간, D-day, 목표, 진행률바) + 진행중/할일/완료 섹션 + "스프린트에 추가" 후보 목록(미배정·미완료 내 업무). 스프린트가 없으면 "2주 스프린트 시작" 또는 "기간 직접 설정"(→`/sprints`) 안내
  - 일정 뷰: 날짜 네비게이션(이전/다음/오늘로) + 해당일 시간표(시간순 테이블)
  - 카드/리스트 뷰: 지연·오늘·예정·최근완료 섹션(접기/펼치기)
- **Frontend**: `useWorkItems({assignee: myName})` + `useWorkItems({allAttendees: true})`(전체 참석 항목 병합, hooks/useWorkItems.ts), `useCurrentSprint`/`useCreateSprint`(hooks/useSprints.ts), `useUpdateWorkItem`, `usePatchWorkItemStatus`. `useAuthStore`(Zustand, 로그인 사용자명). 담당자 필드(정/부/legacy, 콤마 분리) 매칭 로직으로 "내 업무" 산출.
- **Backend**: `GET /api/v1/work-items?assignee=...`, `GET /api/v1/work-items?all_attendees=true`, `PATCH /api/v1/work-items/{id}/status`, `PUT /api/v1/work-items/{id}`(스프린트 배정) — `work_items.py`. `GET /api/v1/sprints/current`, `POST /api/v1/sprints`(2주 스프린트 즉시 생성) — `sprint.py`.
- **핵심 기능**:
  - 담당자(정/부/legacy) 이름 매칭으로 "내 업무"만 집계 + 전체 참석 항목(회의 등) 병합
  - 완료 토글(원클릭 상태 변경), 스프린트에 추가/후보 관리
  - 일정 뷰에서 날짜별 시간표(하루 단위) 탐색
  - 진행 스프린트 없을 때 원클릭 2주 스프린트 생성
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 스프린트 (`/sprints`)

- **파일**: `frontend/src/pages/SprintsPage.tsx`
- **목적 / UX**: 반복(iteration) 단위로 업무를 계획·추적하는 스프린트를 생성/수정/삭제하고, 미완료 항목을 다른 스프린트로 이월하거나 종료 처리하는 화면.
- **UI 구성**:
  - 헤더 + "새 스프린트" 버튼
  - 진행중/예정/완료 3개 그룹으로 스프린트 카드 그리드 렌더 (`SprintCard`: 상태 배지, 기간·D-day, 목표, 진행률바, 완료/전체/미완료/공수(h)/참여인원 요약, "게시판에서 보기"/이월/종료 액션)
  - `SprintModal`(생성/수정 — 이름, 목표, JIRA NO, Confluence 링크, 1~4주 프리셋 또는 직접 기간, 상태), `CarryOverModal`(미완료 항목을 다른 스프린트로 이월), 삭제 `ConfirmDialog`
- **Frontend**: `useSprints`, `useCreateSprint`, `useUpdateSprint`, `useDeleteSprint`, `useCarryOverSprint`(hooks/useSprints.ts, 모두 TanStack Query mutation 후 `sprints`+`workItems` 쿼리 invalidate). "게시판에서 보기"는 `navigate('/tasks-mgmt?sprint=' + id)` 딥링크.
- **Backend**: `GET /api/v1/sprints`, `POST /api/v1/sprints`, `PUT /api/v1/sprints/{id}`, `DELETE /api/v1/sprints/{id}`, `POST /api/v1/sprints/{id}/carry-over?to={targetId}` — `backend/app/routers/sprint.py`. 모델: `backend/app/models/sprint.py` (Sprint — `achievement_rate`/`total_items`/`done_items`/`total_effort_hours`/`assignees` 등 응답에 포함되는 집계 필드).
- **핵심 기능**:
  - 1~4주 기간 프리셋 버튼 + 시작일 기준 종료일 자동 계산, 직접 지정도 가능
  - 진행률(%)·공수·참여인원 자동 집계 표시
  - 미완료 항목 이월(carry-over) — 자기 자신/완료된 스프린트는 대상에서 제외
  - 스프린트 종료(status→completed) 원클릭 처리
  - 삭제 시 업무 자체는 유지, 스프린트 배정만 해제됨을 안내
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 멤버별 업무 (`/members`)

- **파일**: `frontend/src/pages/MemberBoardPage.tsx`
- **목적 / UX**: 등록된 담당자(Assignee)별로 작업/이슈를 묶어 한눈에 보고, 특정 주(이번주/지난주)에 진행·완료된 업무만 필터링해 팀 업무 현황을 텍스트로 복사·공유할 수 있는 화면.
- **UI 구성**:
  - 헤더: 멤버 수/전체 수, 진행중 합계 배지
  - 필터 바: 보기범위(나만/전체 — localStorage 영속), 검색(이름/사번/이메일/역할), 멤버 필터(전체/업무있음/미완료있음), 기간 필터(전체/이번주/지난주), 텍스트 복사, 부담당자 포함 체크박스
  - 멤버별 `MemberSection` 카드: 아바타(이니셜)+사번/이메일/역할, 작업 배지(진행/완료), 이슈 배지(미조치/완료), 펼치면 좌(작업)·우(이슈) 2단 리스트(각 최대 10건 + 더보기)
- **Frontend**: `useAssignees`(hooks/useAssignees.ts), `useWorkItems()`(전체 목록, 클라이언트에서 담당자별로 buckets 구성), `useAuthStore`(Zustand, 본인 식별 및 정렬 최상단 배치). 서버 mutation 없음 — 순수 조회/집계/클립보드 복사(`navigator.clipboard.writeText`).
- **Backend**: `GET /api/v1/work-items`(전체) — `work_items.py`. 담당자 마스터 데이터는 별도 assignees 엔드포인트(`useAssignees` 훅, 담당자 관리 라우터) 사용. 모델: `WorkItem`(primary/secondary assignee 콤마 구분 문자열 파싱).
- **핵심 기능**:
  - 담당자 필드(정/부, 콤마 다중값) 분리 파싱으로 멤버별 작업·이슈 집계
  - "나만/전체" 보기 범위 토글(사용자별 localStorage 저장)
  - 이번주/지난주 기간 필터 — 해당 주에 시작~완료(또는 진행중~오늘) 구간이 겹치는 항목만
  - 필터링 결과를 사람이 읽기 좋은 텍스트로 클립보드 복사
  - 항목 클릭 시 업무 상세 편집 모드로 딥링크(`/tasks-mgmt/{id}?edit=1`)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 워크플로우 보드 (`/workflow`)

- **파일**: `frontend/src/pages/WorkflowBoardPage.tsx` (단일 대형 파일, 1160줄 — 별도 하위 컴포넌트 분리 없이 캔버스/카드/사이드패널을 인라인으로 구현)
- **목적 / UX**: 운영 프로세스(장애 대응, 배포 절차 등)를 트리거→액션→조건→대기→알림 단계로 이루어진 노드-엣지 다이어그램으로 시각 설계하는 "기획용" 워크플로우 보드. 실행 엔진이 아니라 절차를 문서화·추적(할일/진행중/막힘/완료/제외 상태)하는 용도.
- **UI 구성**:
  - 좌측: 워크플로우 목록(생성/이름 인라인 편집/삭제), 선택 시 상태별(할일/진행중/막힘/완료/제외) 카운트
  - 캔버스: SVG 기반 노드-엣지 에디터 — 단계 카드(드래그 이동, 포트 드래그로 엣지 연결), 자동 배치(`handleAutoLayout`, BFS 깊이 기반), ctrl+wheel 줌(0.25~2.0), 단계 유형별 색상(trigger/action/condition/wait/notification)
  - 단계 카드 편집: 제목/설명, 참조 타입(클러스터/플레이북/이슈/작업/작업가이드/메트릭카드) + 참조 ID 선택 드롭다운, 상태/유형 드롭다운
- **Frontend**: `useQuery(['workflows'], workflowsApi.getAll)` 직접 TanStack Query 사용(전용 hooks 파일 없음), `useMutation`으로 `createWorkflow`/`updateWorkflow`/`deleteWorkflow`/`addStep`/`updateStep`/`deleteStep`/`createEdge`/`deleteEdge` 각각 정의 후 `workflows` 쿼리 invalidate. 참조 선택용으로 `useClusters`, `useWorkItems`, `usePlaybooks`, `useWorkGuides`, `useMetricCards` 호출.
- **Backend**: `GET/POST /api/v1/workflows`, `PUT/DELETE /api/v1/workflows/{id}`, `POST/PUT/DELETE /api/v1/workflows/{id}/steps[/{step_id}]`, `POST/DELETE /api/v1/workflows/{id}/edges[/{edge_id}]` — `backend/app/routers/workflows.py`. 모델: `backend/app/models/workflow.py` (`Workflow`, `WorkflowStep`, `WorkflowEdge`).
- **핵심 기능**:
  - 노드 드래그 배치 + 포트 드래그로 엣지(화살표) 연결, Escape로 연결 취소
  - 자동 배치(위상정렬 기반 depth 계산) — 다건 위치 갱신을 `Promise.all`로 병렬 처리 후 한 번만 invalidate
  - 레거시 상태값(idle/running/success/failed) → 신규 어휘(todo/in-progress/blocked/done/skipped) 자동 정규화(`normalizeStatus`)
  - 단계에 클러스터/플레이북/이슈/작업/작업가이드/메트릭카드 참조 연결
  - 줌/팬 가능한 대형 캔버스(3200×2000)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### WBS / 간트 (`/wbs`) — `RequireFeature feature="wbs"` 게이트

- **파일**: `frontend/src/pages/WbsFlowPage.tsx` (1048줄) (+ `components/wbs/ProjectHeader.tsx`, `ProjectFormModal.tsx`)
- **목적 / UX**: 프로젝트/작업/이슈를 기간(주/2주/월) 기준 간트 형태로 시각화해 일정 진척을 파악하는 화면. 기능 접근 제어(`RequireFeature`)로 관리자가 허용한 사용자에게만 노출된다.
- **UI 구성**:
  - `pageView` 3모드: `project`(프로젝트별 헤더+진척 — `ProjectHeader`), `grid`(담당자×날짜 그리드, 셀 클릭 시 상세 `SidePane`), `personal`(개인별 간트 — `PersonalGanttView`, 부모/자식 작업 들여쓰기 표시)
  - 상단: 기간 뷰 전환(주/2주/월, `ViewModeBar`), 날짜 네비게이션(이전/오늘/다음), 담당자 필터, "진행중만" 토글
  - 요약바(`SummaryBar`): 작업 총계/완료·진행·대기, 작업 진행률(%), 이슈 총계/해결·미해결, 이슈 해결률(%) — 4개 통계 카드
  - `ProjectFormModal`(신규 프로젝트 생성), `DetailModal`(그리드 셀 클릭 시 `SidePane`으로 작업/이슈 상세)
- **Frontend**: `useProjects`(hooks/useProjects.ts), `useQuery(['wbs-work-items'], workItemsApi.getAll)`(전용 hook 없이 직접 TanStack Query) — task/issue로 클라이언트 분할 후 날짜별 그룹핑. 서버 mutation은 프로젝트 생성/수정(`useCreateProject`/`useUpdateProject`, `ProjectFormModal` 내부)만 사용.
- **Backend**: `GET /api/v1/projects`, `POST /api/v1/projects` — `backend/app/routers/projects.py` (모델: `backend/app/models/project.py`). `GET /api/v1/work-items` — `work_items.py`. `wbs` 기능 접근권한은 `GET /api/v1/ui-settings/feature-access`(`RequireFeature` 컴포넌트가 내부에서 조회).
- **핵심 기능**:
  - 주/2주/월 단위 간트 그리드, 오늘 열 하이라이트, 주말 음영
  - 담당자별/프로젝트별/개인별 3가지 보기 모드 전환
  - 부모-자식(하위 업무) 계층을 간트 행에 들여쓰기로 표현
  - 작업 진행률·이슈 해결률 자동 집계 요약바
  - 셀 클릭 시 사이드패널로 작업/이슈 상세(시작일/완료일/상태) 확인
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Jira Excel 가져오기 (`/jira-import`)

- **파일**: `frontend/src/pages/JiraExcelImportPage.tsx`
- **목적 / UX**: Jira에서 내보낸 이슈 목록 Excel(.xlsx/.xls)을 업로드하거나, 표를 그대로 복사해 붙여넣어 테이블로 미리보고, 담당자(Assignee, "이름 회사" 형식)를 PEP에 등록된 담당자와 자동 매칭해 확인한 뒤 **"업무 관리에 저장"** 버튼으로 PEP 업무 관리 게시판(work_items)에 실제로 매핑 저장하는 화면. 저장 전까지는 미리보기(서버에 남지 않음).
- **UI 구성**:
  - 헤더 우측 `ViewModeBar`로 "파일 업로드" ↔ "붙여넣기" 모드 전환. 미리보기가 성공(`status: 'ok'`, 1건 이상)하면 그 옆에 **"업무 관리에 저장"** 버튼이 나타난다(`require_operator` — viewer 역할은 클릭 시 403 에러 배너로 표시됨).
  - 저장 성공/실패 배너: 저장 직후 헤더 아래에 생성/갱신/스킵 건수(+오류 있으면 앞 3개 미리보기) 배너와 "업무 관리 게시판에서 보기"(`/tasks-mgmt`) 링크가 뜬다.
  - 파일 업로드 모드: 파일 선택 버튼(.xlsx/.xlsm/.xls), 로딩 스피너, 파일명, 결과 요약 배지(총 건수/담당자 매칭/미매칭), 초기화 버튼, 에러 메시지.
  - 붙여넣기 모드: 사용법 안내(Ctrl+C/Ctrl+V/Ctrl+Enter) + `<textarea>`(TSV 붙여넣기) + "가져오기" 버튼, 나머지 요약 배지/초기화/에러는 파일 모드와 공유(`ImportSummaryBadges`).
  - 결과 테이블: Key(Jira 링크)/Summary/Issue Type/Status/Assignee(매칭 여부 아이콘)/Created(날짜만, 시간 제외)/Resolved/Due Date/Environment/Description
- **Frontend**: 전용 TanStack Query hook 없이 `jiraApi.importExcel(file)` / `jiraApi.importPaste(text)` / `jiraApi.importSaveToBoard(rows)`를 로컬 `useState`(mode/loading/error/result/saving/saveError/saveResult)와 함께 직접 호출(파일은 FormData multipart, 붙여넣기·저장은 JSON body, 모두 timeout 2분). 저장은 파일을 다시 읽지 않고 이미 미리보기로 받아둔 `result.rows`(`JiraExcelRow[]`)를 그대로 되돌려 보낸다.
- **Backend**: `POST /api/v1/jira/import/excel`(파일), `POST /api/v1/jira/import/paste`(붙여넣은 TSV 텍스트, `JiraExcelPasteRequest{text}`) — 둘 다 `backend/app/routers/jira.py`의 공용 헬퍼 `_extract_jira_rows(tables, db)`로 수렴(표 목록에서 헤더를 찾아 `assigneeRaw`→이름 추출, PEP 담당자 마스터와 매칭해 `assigneeMatched`/`assigneeName` 계산, `environment`/`description`은 `_strip_inline_html()`로 HTML 태그 제거). 응답 타입은 둘 다 `JiraExcelImportResult`(`total`, `matched`, `rows: JiraExcelRow[]`). **저장**은 `POST /api/v1/jira/import/excel/save`(`JiraExcelSaveRequest{rows}`, `require_operator`) — 라이브 JQL 가져오기(`POST /jira/import`)와 달리 `jira_issue_id`가 없으므로 **`jira_issue_key`로 dedup**해 기존 work_item을 갱신하거나 새로 생성(`type`은 `jira_service.map_issue_type()` 재사용, `kanban_status`는 상태명 텍스트 매칭 `_map_excel_status_to_kanban()`, `category="Jira"` 고정, `jira_watchers`에 저장한 사용자 추가). 응답은 라이브 가져오기와 같은 `JiraImportResult`(`imported`/`updated`/`skipped`/`errors`/`items`) 재사용.
- **핵심 기능**:
  - .xlsx/.xlsm/.xls 업로드 또는 표 복사·붙여넣기(TSV) → 서버 파싱 → 테이블 미리보기
  - **"업무 관리에 저장"** — 미리보기 행을 실제 work_items로 upsert(`jira_issue_key` dedup), 결과 배너 + 업무 관리 게시판 바로가기
  - 헤더 행이 1행이 아니어도(제목행/빈 행이 위에 끼어 있어도) 표마다 최대 5행까지 순서대로 `Key`/`Summary` 헤더 후보를 탐색해 자동 인식(`_EXCEL_HEADER_SCAN_ROWS`)
  - Jira의 HTML 기반 "가짜 .xls" 내보내기는 문서 안에 여러 `<table>`(요약 표 + 실제 이슈 표, 또는 레이아웃용 표에 중첩된 이슈 표)이 있을 수 있어 **모든 표를 스택 기반으로 분리 추출**한 뒤 순서대로 Key/Summary 헤더를 가진 첫 표를 사용 — 어떤 표에서도 못 찾으면 표별로 스캔한 행 후보를 에러 메시지에 그대로 노출
  - Description/Environment 셀에 이스케이프된 HTML(`&lt;p dir="auto"&gt;...`)이 그대로 텍스트로 노출되던 문제 — 태그를 제거하고 순수 텍스트만 표시(`_strip_inline_html()`)
  - Created 는 시간 없이 날짜만 표시(`_excel_date_only()` — HTML 텍스트 날짜/네이티브 Excel 날짜 셀 모두 파싱)
  - 담당자 이름 자동 추출 + PEP 등록 담당자와 매칭(매칭 성공/실패 아이콘 구분, 실패 시 원본 텍스트 tooltip)
  - Jira Key에 원본 이슈 링크(`jiraUrl`) 제공(있는 경우)
  - 총 건수 대비 매칭/미매칭 건수 요약 배지
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## PEP 서비스 (LAKE 기반, 구) / APP 서비스

> **사이드바 "PEP 서비스" 아이콘은 더 이상 이 `/pep-services` 화면을 가리키지 않는다.**
> Settings "서비스" 탭이 "PEP 서비스" 탭으로 이름이 바뀌면서(ui_settings.serviceCatalog 편집기),
> 사이드바 "PEP 서비스" 그룹의 진입 경로도 `/pep-services`(LakeService 기반)에서
> `/services`(서비스 카탈로그 / 통합지식 — [§ 서비스 카탈로그 / 통합지식](#서비스-카탈로그--통합지식-services))로
> 변경되었다. 아래 `/pep-services` 화면은 라우트/데이터는 그대로 유지되지만 사이드바 노출은
> 종료되어(`/docs`와 동일한 성격) 직접 URL 로만 접근 가능하다.

동일 구조의 "APP 서비스" 아이콘(사이드바 유지)은 그대로 `/app-services` 를 가리킨다. 두 화면
모두 좌측 `CategoryRail`(상위 카테고리 아이콘 레일 — Runtime/Catalog/Workflow/JupyterLab 등,
`ClusterSidebar iconOnly` 시각 컨벤션 준용)을 클릭하면 우측에 해당 카테고리 하위 서비스 인스턴스
카드가 표시되는 2단 네비게이션이다. 백엔드 데이터는 기존 LAKE 서비스 시스템
(`LakeService`/`LakeServiceType`)을 확장해 재사용한다(신규 `domain`: pep/app, `category_id`:
상위 카테고리 FK).

### PEP 서비스 — LAKE 기반, 구 (`/pep-services`, 사이드바 노출 종료)

- **파일**: `frontend/src/pages/PepServicesPage.tsx` → `components/service-domain/ServiceDomainCatalog.tsx` (`domain="pep"`) (+ `CategoryRail`, `AddServiceInstanceModal`, 기존 `LakeServiceCard`/`ServiceTypeIcon` 재사용)
- **목적 / UX**: 플랫폼 엔지니어링 서비스 카탈로그. 좌측 카테고리 레일에 Runtime/Catalog/Workflow/JupyterLab(부팅 시 자동 시드되는 builtin 4개, 삭제 불가·label/icon/정렬은 편집 가능) + 운영자가 추가한 custom 카테고리가 표시된다. Runtime 카테고리에는 spark/starrocks/trino/superset, Catalog 에는 iceberg/polaris, Workflow 에는 airflow, JupyterLab 에는 jupyterlab 타입이 기본 배정된다(부팅 시 1회 백필, 이후 Settings 에서 재분류 가능).
- **UI 구성**: `CategoryRail`(좌, sticky) + 헤더(제목/설명 + 클러스터 필터 select + "카테고리 관리"(Settings 딥링크) + "서비스 등록") + 카테고리 chip 요약(카운트) + 서비스 카드 그리드(카드 클릭 시 기존 `/lake-services/:id` 상세로 이동 — 도메인 무관 공용 상세 페이지).
- **Frontend**: `useServiceCategories('pep', {enabled:true})`, `useLakeServiceTypeRows({domain:'pep', enabled:true})`, `useLakeServices({domain:'pep', limit:500})` — 카테고리/클러스터 필터는 쿼리 파라미터 대신 응답을 클라이언트에서 필터링(axios 가 multi-word 쿼리 키를 camelCase 그대로 보내 백엔드 snake_case 파라미터와 어긋나는 기존 이슈를 회피).
- **Backend**: `GET /api/v1/service-categories?domain=pep`, `GET /api/v1/lake-service-types?domain=pep`, `GET /api/v1/lake-services?domain=pep` — 모두 기존 라우터에 `domain`/`category_id` 필터를 추가한 것.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### APP 서비스 (`/app-services`)

- **파일**: `frontend/src/pages/AppServicesPage.tsx` → 동일 `ServiceDomainCatalog.tsx` (`domain="app"`)
- **목적 / UX**: PEP 서비스와 동일한 구조의 애플리케이션 서비스 카탈로그. 기본 카테고리가 하나도 없는 빈 상태로 시작하며, Settings → "서비스 카테고리"에서 관리자가 카테고리를 먼저 추가하고 → Settings → "LAKE 타입"에서 해당 카테고리에 속하는 서비스 타입(custom slug)을 등록해야 이 화면에서 인스턴스 등록이 가능하다.
- **UI/Frontend/Backend**: PEP 서비스와 동일 컴포넌트/훅/엔드포인트를 `domain="app"`으로만 다르게 호출.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Settings — 서비스 카테고리 관리 (`/settings?tab=service-categories`)

- **파일**: `frontend/src/components/settings/ServiceCategoryManager.tsx` (Settings 탭 `service-categories`)
- **목적 / UX**: PEP/APP 서비스 상위 카테고리 CRUD. 도메인 탭(PEP/APP) 전환 + 테이블(아이콘/key/label/builtin 여부/활성/정렬) + 추가/편집 모달. PEP builtin 4개는 key/domain 변경·삭제 불가, label/icon/정렬/활성만 편집 가능.
- **Backend**: `GET/POST /api/v1/service-categories`, `PUT/DELETE /api/v1/service-categories/{id}` — `backend/app/routers/service_categories.py`, 모델 `ServiceCategory`(`backend/app/models/service_category.py`).
- **관련**: `LakeServiceTypeManager.tsx`(Settings "LAKE 타입" 탭)에도 도메인(PEP/APP) 필터 탭과 상위 카테고리 select 가 추가되어, 서비스 타입을 특정 카테고리에 배정할 수 있다.
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

---

## 지식 허브 (사이드바 아이콘 없음 — 직접 URL 접근)

> 구 "지식/분석" 사이드바 아이콘이 PEP 서비스로 대체되면서, 아래 화면들은 좌측 메뉴 진입점이
> 없어졌다. 코드/데이터는 그대로 유지되며 `/docs` 등 직접 URL 로만 접근 가능하다(기존
> `/ops-notes`·`/mindmap`·`/ontology`·`/trends` 와 동일한 성격). **예외**: 이 그룹에 함께
> 정리된 [서비스 카탈로그 / 통합지식 (`/services`)](#서비스-카탈로그--통합지식-services)만
> 사이드바 "PEP 서비스" 아이콘의 진입점으로 재연결되어 좌측 메뉴에서 다시 접근 가능하다.

### 지식 허브 (`/docs`)

- **파일**: `frontend/src/pages/KnowledgeHubPage.tsx` (+ 하위 임베드: `OpsNotesPage`, `MindMapPage`, `OntologyPage`, `TrendDigestPage`, 공통 `ServiceSidebar`)
- **목적 / UX**: 업무·노트·명령어·가이드·이슈·워크플로우 5종 지식 항목을 하나의 통합 표로 모아 검색·필터링하고, 상단 탭으로 Q&A/마인드맵/온톨로지/기술동향 같은 개별 분석 도구를 페이지 이동 없이 그대로 임베드해서 보여주는 허브 화면이다. CLAUDE.md 정책대로 `/ops-notes`·`/mindmap`·`/ontology`·`/trends`는 좌측 메뉴에서 제거되고 이 허브의 탭(`qa`/`mindmap`/`ontology`/`trends`)으로만 진입하는 것이 기본 동선이었으나, 2026-07 기준 지식 허브 자신도 좌측 메뉴에서 제거되어 모든 하위 화면이 직접 URL 접근으로만 남아 있다. `work-guides`는 탭에는 없고 지식 목록 표의 `guide` 종류 행 클릭으로 `/work-guides/:id`로 이동한다.
- **UI 구성**:
  - 상단 탭바: 지식 목록 / Q&A 노트 / 마인드맵 / 온톨로지 / 기술동향
  - `지식 목록` 탭: 좌측 `ServiceSidebar`(서비스별 필터) + 종류(업무/노트/명령어/가이드/이슈/워크플로우) chip 필터 + 미해결 이슈 빠른 필터 + 기간(주/월/분기) 필터 + 스프린트 select + 검색 + 정렬 가능한 테이블
  - 나머지 탭은 각 페이지 컴포넌트를 그대로 렌더(자체 레이아웃 유지)
- **Frontend**: `useQuery`로 `opsNotesApi.getAll`, `commandsApi.list`, `workGuidesApi.getAll`, `workItemsApi.getAll({limit:500})`, `workflowsApi.getAll`를 병렬 조회해 `HubItem[]`으로 정규화. `useServiceCatalog()`, `useSprints()` 훅 사용. 로컬 state로 검색어/서비스·종류·기간·스프린트 필터/정렬(key,dir)/탭을 관리.
- **Backend**: `GET /api/v1/ops-notes`(`ops_note.py`), `GET /api/v1/commands`(commands 라우터), `GET /api/v1/work-guides`(`work_guide.py`), `GET /api/v1/work-items`(work_items 라우터), `GET /api/v1/workflows`(workflows 라우터) — 5개 리소스를 조회 전용으로 묶어서 사용.
- **핵심 기능**:
  - 5종 지식 자산을 단일 테이블로 통합해 종류/제목/카테고리/상태/업데이트 정렬
  - 서비스·기간(이번 주/달/분기)·스프린트·미해결 이슈 교차 필터
  - 행 클릭 시 각 원본 화면(`/ops-notes/:id`, `/work-guides/:id`, `/tasks-mgmt/:id`, `/workflow`)으로 이동
  - 탭 전환으로 Q&A/마인드맵/온톨로지/기술동향 도구를 별도 라우팅 없이 인라인 임베드
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### DevOps Q&A / 업무 메모 (`/ops-notes`)

- **파일**: `frontend/src/pages/OpsNotesPage.tsx` (+ `frontend/src/components/ops-notes/OpsNoteTable.tsx`, `RichContent` 에디터 렌더)
- **목적 / UX**: 운영 중 마주친 질문과 해결책을 서비스별(k8s/keycloak/cilium/jenkins/argocd/nexus/기타) 포스트잇 형태 Q&A로 기록·검색하는 화면. 기본은 리스트(테이블) 뷰이며 카드 뷰(질문/답변/히스토리 탭이 있는 포스트잇 카드)로 전환 가능.
- **UI 구성**:
  - 헤더 + 뷰 모드 토글(리스트/카드) + "새 Q&A" 버튼
  - 통계 스트립(전체 Q&A, 고정 수, 답변 보유율, 작성자 수)
  - 서비스 chip 필터 + 검색창
  - 테이블 뷰: `OpsNoteTable`(정렬·인라인 셀 편집)
  - 카드 뷰: 고정 Q&A 섹션 + 최근 Q&A 그리드, 각 카드는 답변/히스토리 탭과 Confluence 링크 chip 포함
- **Frontend**: `useQuery(['ops-notes'], opsNotesApi.getAll)`. 로컬 state로 서비스 필터/검색/정렬/뷰모드/삭제중 id 관리. `opsNotesApi.update`(고정 토글, 인라인 수정), `opsNotesApi.delete` 호출 후 `queryClient.invalidateQueries(['ops-notes'])`.
- **Backend**: `GET/POST /api/v1/ops-notes`, `PUT/DELETE /api/v1/ops-notes/{id}` — `backend/app/routers/ops_note.py`. 모델은 `backend/app/models/ops_note.py`의 `OpsNote`(`service`, `title`, `content`, `back_content`, `color`, `author`, `pinned`, `confluence_url`). 쓰기(create/update/delete)는 `require_operator` 인증 필요.
- **핵심 기능**:
  - 서비스별 필터 + 전문(질문/답변/작성자) 검색
  - 고정(pin)/해제, 카드에서 바로 인라인 수정·삭제
  - 테이블 인라인 셀 편집(서비스/제목/작성자)으로 모달 없이 즉시 저장
  - 답변 보유율 등 요약 통계 표시
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Q&A 상세 / 수정 (`/ops-notes/:id`, `/ops-notes/:id/edit`)

- **파일**: `frontend/src/pages/OpsNoteDetailPage.tsx` (+ `frontend/src/components/ops-notes` 의 `OpsNoteForm`, `OpsNoteReadView`)
- **목적 / UX**: 단일 Q&A 항목을 읽기 전용으로 상세 조회하거나(`/ops-notes/:id`), 같은 라우트의 `/edit` 서브패스에서 수정 폼으로 전환하는 화면. URL(`location.pathname.endsWith('/edit')`)로 읽기/수정 모드를 판정한다.
- **UI 구성**:
  - 상단 sticky 바: 뒤로가기, "Q&A 상세"/"Q&A 수정" 라벨, (읽기 모드일 때만) 수정/삭제 버튼
  - 본문 카드: 읽기 모드는 `OpsNoteReadView`, 수정 모드는 `OpsNoteForm`
- **Frontend**: `useQuery(['ops-notes'], opsNotesApi.getAll)`로 전체 목록을 가져와 `id`로 `find`(전용 단건 조회 API를 쓰지 않음). 삭제 시 `opsNotesApi.delete` → `invalidateQueries(['ops-notes'])` 후 `/ops-notes`로 이동.
- **Backend**: 목록은 `GET /api/v1/ops-notes`, 삭제는 `DELETE /api/v1/ops-notes/{note_id}`, 저장(폼 내부)은 `PUT /api/v1/ops-notes/{note_id}` — 모두 `ops_note.py`. `GET /api/v1/ops-notes/{note_id}` 단건 엔드포인트가 라우터에 존재하지만 이 페이지는 사용하지 않고 목록에서 찾는 방식.
- **핵심 기능**:
  - 존재하지 않는 id 접근 시 안내 화면 + 목록으로 이동 버튼
  - 수정 완료/취소 시 상세 화면으로 복귀하는 내비게이션 흐름
  - 삭제 확인 다이얼로그(`confirm`) 후 목록으로 이동
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### Q&A 새로 만들기 (`/ops-notes/new`)

- **파일**: `frontend/src/pages/OpsNoteFormPage.tsx` (+ `frontend/src/components/ops-notes/OpsNoteForm.tsx`)
- **목적 / UX**: 새 Q&A(서비스, 질문 제목, 답변, 히스토리)를 작성하는 전용 화면. `?service=` 쿼리 파라미터로 목록 화면에서 필터 중이던 서비스를 기본값으로 미리 채워준다.
- **UI 구성**: sticky 상단 바(뒤로가기) + 헤더 + `OpsNoteForm` 카드(서비스 선택, 제목, 리치텍스트 답변/히스토리 입력).
- **Frontend**: `useSearchParams()`로 `defaultService` 읽기. 실제 생성 API 호출은 `OpsNoteForm` 내부(`opsNotesApi.create`)에서 이뤄지며, 저장 성공 시 `onSaved(savedId)` 콜백으로 `/ops-notes/:id` 또는 `/ops-notes`로 이동.
- **Backend**: `POST /api/v1/ops-notes` — `ops_note.py`의 `create_ops_note`, `require_operator` 인증 필요. 저장 대상 모델은 `OpsNote`.
- **핵심 기능**:
  - 목록에서 선택 중이던 서비스 필터를 새 글 기본값으로 승계
  - 저장 성공 시 상세 화면으로 바로 이동해 결과 확인
  - 취소 시 목록으로 복귀
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 마인드맵 (`/mindmap`)

- **파일**: `frontend/src/pages/MindMapPage.tsx` (SVG 캔버스를 자체 구현, 별도 하위 컴포넌트 없이 페이지 내부에 `MindMapCanvas`/`NodeEditor` 정의)
- **목적 / UX**: 여러 개의 마인드맵을 만들고 각 맵 안에서 루트/자식 노드를 자유롭게 추가·배치해 개념 간 관계를 시각적으로 정리하는 화면. 마인드맵/트리/조직도 3가지 레이아웃, 노드 도형·색상·테두리 커스터마이즈, PNG/SVG 내보내기를 지원한다.
- **UI 구성**:
  - 좌측 사이드바: 마인드맵 목록(생성/이름변경/Confluence 링크/삭제)
  - 우측 캔버스: 줌/팬/자동배치 툴바, 레이아웃 전환(마인드맵/트리/조직도), 커넥터 스타일(베지어/직선/꺾은선), PNG/SVG 내보내기, 키보드 단축키 도움말 패널
  - 노드 편집 모달(`NodeEditor`): 이름, 메모, 색상, 모양(8종), 테두리, 크기
- **Frontend**: `frontend/src/hooks/useMindMap.ts`의 `useMindMaps`, `useMindMap(id)`, `useCreateMindMap`, `useUpdateMindMap`, `useDeleteMindMap`, `useCreateNode`, `useUpdateNode`, `useDeleteNode`, `useBulkUpdatePositions` — 모두 TanStack Query 뮤테이션으로 `mindmapApi` 래핑. 드래그로 노드 이동 시 800ms 디바운스 후 `bulkUpdatePositions` 호출.
- **Backend**: `GET/POST /api/v1/mindmaps/`, `GET/PUT/DELETE /api/v1/mindmaps/{map_id}`, `POST/PUT/DELETE /api/v1/mindmaps/{map_id}/nodes[/{node_id}]`, `PATCH /api/v1/mindmaps/{map_id}/nodes/positions` — `backend/app/routers/mindmap.py`. 모델은 `backend/app/models/mindmap.py`의 `MindMap`/`MindMapNode`(`parent_id`로 트리, `x`/`y`로 좌표, `extra` JSONB에 모양/테두리/크기 저장).
- **핵심 기능**:
  - Tab(자식 추가)/Enter(형제 추가)/Delete(삭제)/F2(수정)/방향키(인접 이동) 키보드 단축키
  - 노드 삭제 시 하위 트리 전체를 재귀적으로 함께 삭제(프론트 확인 다이얼로그 + 백엔드에서도 descendant 재귀 삭제)
  - 노드 드래그 위치를 디바운스 벌크 저장으로 서버에 영속화
  - PNG(2x 래스터)/SVG 내보내기(선택 핸들 제외하고 캡처)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 온톨로지 그래프 (`/ontology`)

- **파일**: `frontend/src/pages/OntologyPage.tsx` (3D 그래프는 `react-force-graph-3d` + `three` 직접 사용, 별도 하위 컴포넌트 없이 `NodeDetailPanel`/`ImpactPanel`을 페이지 내부에 정의)
- **목적 / UX**: 클러스터 내 인프라 구성요소(노드/하드웨어/OS/커널 파라미터/네트워크/K8s·Cilium 컴포넌트/워크로드/서비스/설정 항목)와 그 관계를 3D 그래프로 시각화하고, 설정 변경(config_item/kernel_param)이 다른 엔티티에 미치는 파급 범위(blast radius)를 분석하는 화면.
- **UI 구성**:
  - 상단 툴바: 클러스터 선택, 노드 검색, 노드/관계 수 통계, 범례 토글, 필터 초기화, 새로고침
  - 엔티티 타입별 chip 필터 바(10종, 색상 구분)
  - 중앙 3D 포스 그래프(구체 크기=연결 수, 파티클=관계 방향, 링크 굵기=가중치)
  - 좌상단 범례 패널, 우상단 노드 상세 패널(속성 + "변경 영향 분석" 버튼), 좌하단 영향 분석 결과 패널(blast radius score, 영향 엔티티, 영향 경로)
- **Frontend**: `useClusters()`(클러스터 목록), `frontend/src/hooks/useOntology.ts`의 `useOntologyGraph(clusterId)`(`useQuery`), `useAnalyzeImpact()`(`useMutation`, 성공 시 그래프 쿼리 invalidate).
- **Backend**: `GET /api/v1/ontology/graph/{cluster_id}`, `POST /api/v1/ontology/impact` (엔티티/관계 등록용 `POST /api/v1/ontology/entities`, `/relationships`도 존재하나 이 화면은 조회/분석만 사용) — `backend/app/routers/ontology.py`. 모델은 `backend/app/models/ontology.py`의 `OntologyEntity`/`OntologyRelationship`/`OntologyEvent`. 영향 분석 알고리즘은 `backend/app/services/ontology_service.py`의 `calculate_blast_radius`(그래프 탐색으로 blast score·경로 계산), 분석 결과는 `OntologyEvent`로 감사 기록됨.
- **핵심 기능**:
  - 엔티티 타입별 표시 on/off, 이름 검색 필터
  - 노드 클릭 시 카메라 포커스 이동 + 상세 속성 패널
  - config_item/kernel_param 노드에서 "변경 영향 분석" 실행 → blast radius score, 영향받는 엔티티, 영향 경로(최대 4단계 depth) 표시
  - 데이터 없는 클러스터에는 빈 상태 안내(엔티티 등록 API 예시 코드 노출)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 기술 동향 다이제스트 (`/trends`)

- **파일**: `frontend/src/pages/TrendDigestPage.tsx` (하위 컴포넌트 없이 페이지 내부에 `DigestPanel`/`TrendItemCard`/`SourcesPanel`/`SourceRow`/`AddSourceForm` 정의)
- **목적 / UX**: Kubernetes/Cilium/Linux/CNCF 관련 릴리즈·블로그·뉴스를 RSS/GitHub Releases 소스에서 자동 수집하고 AI로 한국어 요약해 날짜별 다이제스트로 제공하는 화면. 수집 소스 등록/편집/활성화 관리도 같은 화면에서 수행한다.
- **UI 구성**:
  - 좌측: lookback 기간 select + "지금 수집" 버튼, 날짜별 다이제스트 목록(상태 아이콘: 대기/수집중/요약중/완료/실패), 하단 "소스 관리" 탭 토글
  - 우측(다이제스트 탭): 상태 + 종합 AI 요약, 카테고리(k8s/cilium/linux/cncf)/타입(릴리즈/블로그/뉴스) 필터, 접이식 아이템 카드(개별 AI 요약 + 원문 링크)
  - 우측(소스 관리 탭): 카테고리별로 그룹핑된 소스 목록, 소스별 활성 토글/수정/삭제, 새 소스 추가 폼(GitHub Releases owner/repo 또는 RSS URL)
- **Frontend**: `frontend/src/hooks/useTrends.ts`의 `useTrendDigests(30)`, `useTrendItems(date, category, itemType)`, `useTrendSources`, `useTriggerCollect`, `useToggleSource`, `useCreateSource`, `useUpdateSource`, `useDeleteSource` — 모두 TanStack Query.
- **Backend**: `POST /api/v1/trends/collect`(`target_date`, `lookback_days`), `GET /api/v1/trends/digests`, `GET /api/v1/trends/digests/{date}`, `GET /api/v1/trends/items/{date}`, `GET/POST/PUT/PATCH/DELETE /api/v1/trends/sources[/{id}]` — `backend/app/routers/trends.py`. 서비스 로직은 `backend/app/services/trends/trend_service.py`(`TrendService`), 모델은 `backend/app/models/trend.py`(`TrendSource`/`TrendDigest`/`TrendItem` 추정 — 소스별 `last_status`/`last_message`/`last_item_count` 등 수집 상태 필드 포함).
- **핵심 기능**:
  - 수동 "지금 수집" 트리거(lookback 7~365일 선택), 백그라운드로 수집·AI 요약 진행
  - 다이제스트 상태 실시간 표시(대기/수집중/요약중/완료/실패) 및 실패 사유 노출
  - 카테고리/타입 교차 필터로 아이템 탐색, 항목별 한국어 AI 요약 펼쳐보기
  - 소스 CRUD + 활성/비활성 토글, 소스별 마지막 수집 결과(성공/빈 결과/실패) 상태 배지
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 작업 가이드 (`/work-guides`, `/work-guides/new`, `/work-guides/:id`, `/work-guides/:id/edit`)

- **파일**: `frontend/src/pages/WorkGuidePage.tsx` (+ `frontend/src/components/work-guides` 의 `GuideForm`, `GuidePageView`; 리치텍스트는 TipTap `RichTextEditor`/`RichContent` 사용)
- **목적 / UX**: 운영 절차·배포 가이드·트러블슈팅 등 팀 지식을 Notion 스타일 계층형 페이지 트리로 관리하는 화면. 하나의 라우트 트리(`/work-guides`, `/new`, `/:id`, `/:id/edit`)를 URL 패턴으로 판정해 목록/작성/읽기/수정 4가지 모드를 같은 레이아웃 안에서 전환한다.
- **UI 구성**:
  - 좌측 사이드바: 페이지 트리(부모-자식, 폴더/파일 아이콘, 상태 배지, 인라인 이름변경·하위 페이지 추가), "새 페이지" 버튼
  - 우측 본문: 모드별로 `GuideForm`(작성/수정) 또는 `GuidePageView`(읽기, 수정/하위추가/워크플로 추가/삭제 액션 포함) 또는 빈 상태 안내
  - "워크플로에 노드로 추가" 모달(`AddToWorkflowModal`, `SidePane`) — 가이드를 기존 워크플로 스텝으로 연결
- **Frontend**: `useQuery(['work-guides'], workGuidesApi.getAll)`로 전체 트리 로드 후 `parentId` 기준 클라이언트 필터링. 워크플로 연결 시 `workflowsApi.getAll` + `workflowsApi.createStep`. 이름변경/삭제/자식생성은 `workGuidesApi.update`/`delete`/`create` 직접 호출 후 `invalidateQueries(['work-guides'])`.
- **Backend**: `GET/POST /api/v1/work-guides`, `GET/PUT/DELETE /api/v1/work-guides/{guide_id}` — `backend/app/routers/work_guide.py`. 모델은 `backend/app/models/work_guide.py`의 `WorkGuide`(`parent_id`로 계층, `status` draft/active/archived, `embedding` — pgvector 컬럼으로 유사 문서 검색용, 제목/본문 변경 시 `compute_work_guide_embedding` Celery 태스크로 비동기 재계산). 워크플로 스텝 연결은 workflows 라우터의 `createStep` 사용.
- **핵심 기능**:
  - 트리에서 더블클릭/연필 아이콘으로 인라인 이름 변경, +버튼으로 즉시 자식 페이지 생성 후 편집 진입
  - draft/active/archived 상태 배지
  - 가이드를 기존 워크플로의 액션 스텝으로 연결(`referenceType='work_guide'`)
  - 제목/본문 저장 시 백그라운드로 임베딩 재계산 큐잉(유사 가이드 추천 등에 사용될 것으로 추정)
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 서비스 카탈로그 / 통합지식 (`/services`)

> **사이드바 "PEP 서비스" 아이콘의 진입점.** 클릭하면 이 화면으로 이동하고, 서비스 카드/행을
> 클릭하면 아래 [서비스 허브 (`/services/:service`)](#서비스-허브-servicesservice)로 이동해
> 작업 계획서·업무 소개·이슈 대응·구축 작업 노트와 연관 업무를 확인한다.

- **파일**: `frontend/src/pages/ServicesCatalogPage.tsx` (+ `frontend/src/components/services/serviceCatalog.ts`의 `colorBadgeClass`, `frontend/src/components/common`의 `DebugLogPanel`/`ViewModeBar`/`DoubleScrollX`)
- **목적 / UX**: k8s/keycloak/nexus/jenkins/argocd 등 관리 서비스별로 등록된 지식 항목(가이드/트러블슈팅/변경이력/메모/링크) 개수와 최근 갱신을 한눈에 보고 각 서비스 허브로 진입하는 진입점 화면. Settings의 서비스 카탈로그 정의(`ui_settings.serviceCatalog`)와 실제 DB에 쌓인 통계를 병합해 표시한다.
- **UI 구성**: 뷰 모드 토글(리스트/카드) + 서비스 검색. 리스트 뷰는 서비스/설명/항목수/유형별 분포/최근 업데이트 컬럼 테이블(가로 스크롤 `DoubleScrollX`), 카드 뷰는 서비스별 카드 그리드.
- **Frontend**: `useServiceCatalog()`(`ui_settings` 기반 카탈로그 정의), `useGetServiceDef()`, `useQuery(['service-catalog','all'], serviceEntriesApi.catalog)`로 DB 통계를 가져와 카탈로그 정의와 `Map` 병합(카탈로그에 없는 커스텀 서비스 키는 'other' fallback으로 표시).
- **Backend**: `GET /api/v1/services/catalog` — `backend/app/routers/service_entries.py`의 `get_catalog`. `service_entries` 테이블을 `service` 별로 그룹핑해 `total`/`by_kind`/`last_updated` 집계. 모델은 `backend/app/models/service_entry.py`의 `ServiceEntry`.
- **핵심 기능**:
  - 서비스명/키 검색
  - 서비스별 등록 항목 수 + kind별(가이드/트러블슈팅/변경이력/메모/링크) 분포 배지
  - 각 행/카드 클릭 시 `/services/:service` 상세 허브로 이동
  - 서비스 카탈로그 자체의 추가/수정은 이 화면이 아닌 Settings → "PEP 서비스" 탭에서 수행함을 안내 문구로 명시
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_

### 서비스 허브 (`/services/:service`)

- **파일**: `frontend/src/pages/ServiceHubPage.tsx` (+ `frontend/src/components/services`의 `ServiceEntryEditModal`, `RelatedWorkItemsPanel`, `RelatedOpsNotesPanel`, `KIND_CATALOG`/`KIND_BY_KEY`/`colorBadgeClass`; 리치텍스트는 `RichContent`)
- **목적 / UX**: 특정 서비스(예: k8s, keycloak) 하나에 대한 가이드/트러블슈팅/변경이력/메모/링크를 모아보고 관리하는 상세 화면. 같은 서비스와 연관된 `WorkItem`(업무/이슈)과 `OpsNote`(Q&A)도 하단에 교차 표시해 지식이 흩어지지 않도록 한다.
- **UI 구성**:
  - 헤더: 서비스 아이콘/이름/설명 + kind별 "새 항목 추가" 버튼들
  - 탭바(전체/가이드/트러블슈팅/변경이력/메모/링크, 각 카운트 표시) + 검색 + 태그 필터 select
  - 항목 카드 그리드: kind 배지, severity 배지, 고정(pin), 리치 콘텐츠 미리보기, 태그 chip, 작성자/시간/클러스터, 공유 URL 복사/Markdown 복사(Slack/Teams용)/수정/삭제 액션
  - 하단: `RelatedWorkItemsPanel`, `RelatedOpsNotesPanel`(같은 `service` 값을 가진 업무/Q&A 교차 표시)
  - 생성/수정 모달: `ServiceEntryEditModal`
- **Frontend**: `useGetServiceDef()`로 서비스 메타 조회. `useQuery(['service-entries', service, kindFilter, search, tagFilter], serviceEntriesApi.list)`. `serviceEntriesApi.update`(핀 토글), `delete` 직접 호출 후 `invalidateQueries(['service-entries'])` + `['service-catalog']`.
- **Backend**: `GET /api/v1/services/{service}/entries`(kind/search/tag 필터), `GET/POST/PUT/DELETE /api/v1/service-entries[/{id}]` — `backend/app/routers/service_entries.py`. 태그 필터는 JSONB `@>` 연산자로 구현. 모델은 `ServiceEntry`(`backend/app/models/service_entry.py`).
- **핵심 기능**:
  - kind/검색/태그 교차 필터로 서비스 지식 탐색
  - 항목 고정(pin), 인라인 삭제 확인(`ConfirmDialog`)
  - 공유 URL 복사 및 Slack/Teams용 Markdown 복사(태그/심각도/발생시각 포함 포맷)
  - 같은 서비스의 업무(WorkItem)·Q&A(OpsNote)를 하단 패널로 교차 노출해 서비스 단위 지식을 통합
- **요청사항 (수정 요청)**:
  - _(여기에 개선/수정 요청을 직접 적어주세요)_
