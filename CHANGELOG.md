# Changelog

이 프로젝트의 주요 변경을 기록한다. 형식은 [Keep a Changelog], 버전은 [SemVer] 를 따른다.
브랜치·태그·릴리스 절차는 `docs/branch-tag-strategy.md` 참고.

[Keep a Changelog]: https://keepachangelog.com/ko/1.1.0/
[SemVer]: https://semver.org/lang/ko/

## [Unreleased]

1.27.1 이후 main 에 병합된 변경 (다음 릴리스 후보).

### Fixed
- **업무 관리 게시판 — 필터/컬럼 개편, Jira 가져오기 제목 정리**: "필터 더보기" 팝오버를
  없애고 담당자/우선순위/모듈/스프린트/기간 필터를 전부 한 줄에 인라인으로 노출, "시간"
  토글과 "필드"(사용자 정의 필드 관리) 버튼을 제거했다. 필터는 더 이상 값이 바뀔 때마다
  자동 저장되지 않고 "필터 저장" 버튼을 눌러야 사용자별로 유지되며(기본 필터링은 항상
  빈 상태로 시작 — "내 업무" 기본 ON, 진행중 스프린트 자동 선택도 제거), 기본 컬럼
  순서를 상태·담당자·상위업무·이슈종류·DL·WIKI·작업제목·시작일·마감일·관리·업무 분류로
  재지정했다. 구 "작업 제목" 셀에 인라인으로 붙어 있던 Jira 키 칩과 Confluence 문서
  칩을 "DL"/"WIKI" 독립 컬럼으로 분리하고, Jira 가져오기 시 제목에 섞여 들어가던 이슈
  키 접두어(`"DL-42 요약"` 형식)를 제거해 요약문만 저장하도록 고쳤다. Jira 연결 관리
  다이얼로그에서 "연결 해제하고 이 업무도 삭제"를 눌렀을 때 확인 팝업이 뒤에 가려져
  동작하지 않던 버그도 함께 고쳤다(공용 `ConfirmDialog` 가 다른 모달보다 항상 위에
  그려지도록 z-index 조정). Backend: `services/jira_service.py`(`map_jira_issue`),
  `routers/jira.py`(`import_excel_save`). Frontend: `pages/WorkItemBoardPage.tsx`,
  `components/work-items/WorkItemTableRow.tsx`, `components/work-items/workItemColumns.ts`,
  `components/common/ConfirmDialog.tsx`.

## [1.27.1] - 2026-08-10

### Changed
- **메인 사이드바 — 릴리즈 노트/버그 픽스 로그를 VOC 게시판 탭으로 통합**: 하단 레일의
  "릴리즈 노트" · "버그 픽스 로그" 아이콘 2개를 없애고, "사용자 VOC 게시판" 아이콘 하나가
  여는 SidePane 안에 [VOC / 릴리즈 노트 / 버그 픽스 로그] 3개 탭으로 통합했다. 각 탭 본문은
  기존 컴포넌트를 그대로 재사용하며, 비활성 탭은 데이터를 미리 가져오지 않는다(지연 로드).
  Frontend: `components/layout/UserFeedbackPanel.tsx`(신규), `components/layout/Sidebar.tsx`.

### Fixed
- **업무 관리 게시판 — Jira 마감일 미반영 및 UX 개선**: 행 단위 "보내기"(Jira 반영)가
  제목/설명/우선순위만 전송하고 마감일(due date)은 빠뜨려 PEP 에서 마감일을 바꾸고
  보내도 Jira 쪽 duedate 가 그대로였던 것을 고쳤다. 그 외 "Jira 가져오기" 버튼 아이콘을
  행의 "보내기"(Upload) 아이콘과 대칭되는 방향(Download)으로 바꿔 일관성을 맞추고, 목록
  최상단의 인라인 "행 추가" 기능을 제거했으며(등록은 "업무 등록" 팝업으로 통일), "필터
  더보기" 버튼에 마우스오버 hover 배경을 추가했다. Backend: `routers/jira.py`
  (`push_to_jira`). Frontend: `pages/WorkItemBoardPage.tsx`,
  `components/work-items/WorkItemTableRow.tsx`(`AddWorkItemRow` 제거),
  `components/work-items/JiraPushDialog.tsx`.
- **업무 등록 팝업 — 담당자 기본값**: `QuickAddTaskModal` 신규 등록 시 담당자가 비어있던
  것을 로그인한 본인으로 기본 채움(하위 업무는 기존대로 상위 업무 담당자를 물려받음).
  Frontend: `components/dashboard/QuickAddTaskModal.tsx`.
- **업무 관리 게시판 — 담당자 뱃지 정/부 표시 제거**: 목록 뷰·칸반 카드의 담당자 뱃지에
  붙던 "정:"/"부:" 접두어를 지우고 이름만 표시. Frontend:
  `components/work-items/WorkItemTableRow.tsx`, `WorkItemKanban.tsx`.

### Added
- **스크립트 라이브러리(`/scripts`, 신규 화면)**: Batch Jobs·점검 매트릭스의 실행 로직이
  파이썬 파일에 하드코딩돼 있어 UI 편집·재사용·버전관리가 불가능하던 것을 해소하는 배치 잡
  실행 모델 재설계 **Phase 1** — Python/Ansible Playbook/Shell 스크립트를 DB 에 저장하고
  UI 에서 바로 작성·버전관리(새 버전 저장 시 자동으로 "현재 버전"이 되고 이전 버전은 불변
  보존, 롤백은 새 버전 없이 포인터만 이동)·테스트 실행(저장 전 초안도 즉시 실행, 자격증명·
  결과 모두 영속화하지 않음)할 수 있다. 테스트 실행 결과는 기존 `ExecutionStepsTimeline`/
  `CommandTraceList` 를 그대로 재사용해 단계별 진행과 실행된 명령을 시각화한다. Python
  스크립트 실행(대상 클러스터의 일회용 K8s Job)은 Phase 2 예정 — 지금은 명확한 사유와 함께
  501 을 반환한다. 권한은 `require_operator` 기본 허용 + `AppSetting` 토글로 admin 전용
  전환 가능. 아직 Batch Job/점검 항목이 스크립트를 참조하지는 않는다(연결은 Phase 2).
  설계: `docs/02-design/features/batch-jobs-execution-redesign.design.md`. Backend:
  `routers/scripts.py`, `models/executable_script.py`, `services/script_test_run.py`.
  Frontend: `pages/ScriptsPage.tsx`, `components/scripts/`, `hooks/useScripts.ts`.
- **Batch Jobs — 스크립트 라이브러리 연동 (Phase 2)**: "새 잡" 등록 시 **실행 방식** 을
  시스템 제공(기존 3종 하드코딩 executor) 또는 **스크립트 선택**(`/scripts` 라이브러리의
  Shell/Ansible Playbook 스크립트) 중 고를 수 있다 — 버전은 항상 최신 또는 특정 버전에
  고정 가능하며, 실제 실행 시점에 사용된 버전은 매 실행 기록에 스냅샷으로 남는다(스크립트가
  나중에 수정돼도 과거 실행 기록은 그때 정확히 뭐가 돌았는지 그대로 보여준다). 실행은 기존
  단계별 추적(`ExecutionStepsTimeline`/`CommandTraceList`)에 그대로 편입돼 스케줄(cron)·
  수동 실행·중지가 기존 배치 잡과 동일하게 동작한다. 스크립트가 Batch Job 에 연결돼 있으면
  스크립트 라이브러리에서 삭제할 수 없다(409, 참조 건수 안내). Python 스크립트는 아직
  지원하지 않는다(Phase 2 의 K8s Job 실행기 구현 예정). Backend: `models/batch_job.py`
  (`execution_mode`/`script_id`/`script_version_id`), `services/batch_jobs/script_executor.py`,
  `services/batch_job_service.py`, `routers/batch_jobs.py`, `routers/scripts.py`(사용 중
  스크립트 삭제 차단). Frontend: `CreateBatchJobWizard.StepType.tsx`(실행 방식 토글 +
  스크립트/버전 선택), `BatchJobRow.tsx`/`BatchJobSlideOver.tsx`/`.EditForm.tsx`(스크립트
  이름 표시).

## [1.27.0] - 2026-08-10

### Added
- **플랫폼 현황 — 점검 매트릭스 셀 즉시실행**: 매트릭스 셀에 hover 시 ▶ 버튼이 나타나고,
  클릭하면 "지금 실행하시겠습니까?" 확인 팝업 후 그 셀(항목×클러스터)만 즉시 실행한다
  (수동 입력 항목은 제외). 기존 클러스터/항목 단위 일괄 실행과 같은 확인 절차·실행
  인프라(`ConfirmDialog`, `useRunCheckMatrixCell`)를 그대로 재사용한 프론트엔드 전용
  변경으로, 스키마·API 변경은 없다(배치 잡 실행 모델 재설계 Phase 0 —
  `docs/02-design/features/batch-jobs-execution-redesign.design.md`). Frontend:
  `components/platform-status/PlatformStatusMatrix.tsx`.

### Fixed
- **버전·설정(/versions) — impeccable critique P0+P1 반영 (수집 실행 로그·raw 출력 버그)**:
  이 화면의 수집 실행 8종이 결과를 토스트 요약(오류 앞 3건 절단)으로만 남기던 것을 고쳤다.
  페이지의 **지금 수집/MinIO 수집**에 "로그 보기" 토글 + 세션 수집 로그 패널(경고 전체
  기록)을 추가했고, SSH 수집 모달 4종(etcd/인증서/커널/kubelet)의 결과 표에 호스트별
  **raw 출력(stdout/stderr/exit code) 열람** 열을 추가했다 — 백엔드가 성공 호스트에도
  원본 출력을 첨부하도록 확장(스냅샷 저장 데이터에는 미포함이라 dedup 해시 불변).
  노드 NIC 모달의 기존 raw 출력 뷰어는 **camelCase 변환 버그로 한 번도 렌더된 적이 없었다**
  — axios 응답 인터셉터가 `raw_stdout` 을 `rawStdout` 으로 바꾸는데 타입/코드가 snake_case
  를 읽고 있었다(수정). etcd 모달의 **systemd unit 입력이 표시만 바뀌고 실제 수집에는
  반영되지 않던 플라시보**였던 것을 payload 전송으로 고쳤다. 그 외: 메인 스냅샷 조회
  실패가 "스냅샷 없음" 빈 상태로 위장되던 것(+ 히스토리/diff/모달 노드 목록 동일 패턴)을
  오류·재시도 분기로 구분, 오류 목록 절단(slice 3건)을 펼침형 전체 목록으로 교체, SSH
  자격증명(password/private key) 포함 입력 전반의 키보드 포커스 표시 누락을 focus ring
  으로 보강(페이지 검색창의 이중 opt-out 포함). Backend: `routers/versions.py`(수집 5종
  per-host raw 첨부). Frontend: `pages/VersionsPage.tsx`,
  `components/versions/RawOutputDetails.tsx`(신규 공용),
  `components/versions/*Modal.tsx` 5종, `types/index.ts`.

### Fixed
- **클러스터 관리(/cluster-manage) — impeccable critique 15건 반영**: 이 화면의 수집
  실행(재수집/IP 수집/일괄 수집)이 결과를 토스트 요약으로만 남기고, 특히 일괄 수집 실패가
  익명 카운트("실패 3")로 삼켜지던 것을 고쳤다 — 새 **수집 로그** 패널("로그 보기" 토글)이
  대상별 성공/실패와 사유를 한 줄씩 기록하고, 실패분만 골라 재시도할 수 있다(CLAUDE.md
  실행-로그 필수 규칙). 행 드래그 정렬에 KeyboardSensor 를 등록해 그립이 화살표 키로도
  실제로 동작하게 했고(D-052 미완분), per-row "IP 수집"에 일괄 경로와 동일한 확인 절차를
  추가했다. 툴바를 재구성해 **검색을 상시 노출**하고 저빈도 도구(이름 표준화/컬럼 관리/너비
  리셋)를 "도구" 팝오버로 접었으며, 같은 팝오버의 **표시 컬럼** 토글로 기본 컬럼을 켜고 끌
  수 있다 — 같은 nodeIps 데이터를 반복하던 bond0/bond1 컬럼은 기본 숨김(언제든 재활성
  가능, 상세는 노드 IP 트리·카드 뷰에 유지). 그 외: 커스텀 컬럼 조회 실패를 빈 상태와
  구분(모달 에러 분기 + 헤더 경고 배지), 커스텀 컬럼 라벨/순서 저장 실패의 무음 처리 해소
  (D-042 클래스 재발분) + 순서 스왑 연타/중복 sortOrder 가드, 인라인 편집·NIC 수집 모달
  전반 focus ring 누락 보강, 컬럼 헤더 provenance 설명을 키보드/스크린리더 접근 가능한
  Tooltip 으로 병행 제공, 카드 뷰 CIDR 겹침에 상대 클러스터명 텍스트 병기(색상 단독 해소),
  클러스터명 아래 마지막 갱신 상대시각 표시, 체크박스 커스텀 셀 연타 가드+aria-pressed,
  NIC 수집 성공 호스트도 raw 출력 열람 가능, Cilium 모달 오류 사유 표시+이모지 제거,
  스켈레톤 컬럼 수 실제 표와 일치. Frontend: `pages/ClusterManagePage.tsx`,
  `components/cluster-manage/*`(ClusterTableRow, ClusterCard, ClusterCustomFieldsManager,
  ClusterCustomCell, CiliumConfigModal, StandardizeClusterNamesModal),
  `components/common/InlineEdit.tsx`, `components/versions/NodeNicsCollectModal.tsx`.

### Fixed
- **노드 서버스펙 대장(/node-specs) — impeccable critique 12건 반영**: 헤더의 CSV내보내기/
  템플릿/CSV업로드/엑셀붙여넣기/HostFacts수집/클러스터임포트 6개 버튼이 색만 다르게 동일
  비중으로 나열돼 있던 것을 "내보내기"/"가져오기" 드롭다운 메뉴 2개로 접어 "신규 등록"만
  유일한 강조 버튼으로 남겼다. **Host Facts 수집(SSH)** 실행은 CLAUDE.md 필수 규칙(실행
  버튼은 상세·실시간 로그 + 사용자가 켜고 끄는 로그 보기)을 위반해 결과를 건수 토스트
  하나로만 보여주고 실패 호스트를 알 방법이 없었다 — 실행 전 확인 절차를 추가하고, 완료
  후 모달을 자동으로 닫지 않고 호스트별 상태를 로그 뷰(접기/펼치기)로 남기게 했다.
  그 외: 목록 조회 실패가 "등록된 서버 없음"과 똑같이 보이던 것을 별도 에러 상태로 구분,
  상태 배지/헤더 버튼/디스크 타입의 하드코딩 팔레트 색을 `--status-*` 토큰으로 교체,
  CSV/엑셀 붙여넣기의 중복 hostname 사전 경고 + 적용 후 오류 itemize + 대용량 경고,
  3개 모달 닫기(X) 버튼 aria-label 보강, Host Facts 모달 입력 6곳 focus ring 추가,
  SSD/VM 순환 토글에 aria-pressed + 저장 중 재클릭 방지, 표를 `MacCard` 로 통일,
  역할 필터에 `ingress` 옵션 추가. Frontend: `pages/NodeSpecPage.tsx`,
  `components/node-specs/NodeSpecCsvUploadModal.tsx`,
  `components/node-specs/NodeSpecPasteModal.tsx`,
  `components/node-specs/NodeSpecEditModal.tsx`,
  `components/node-specs/DiffRow.tsx`(신규 — 두 모달이 공유하던 diff 행 렌더러를
  분리해 중복 제거).

## [1.26.1] - 2026-08-06

### Added
- **테마 3종 추가 — Summer Breeze / Wildflower Meadow / Tropical Punch**: Figma 색상 조합
  라이브러리의 실제 배색 3개(조합 100/97/52)를 그대로 옮긴 앱 전체 UI 테마가 추가됐다.
  기존 Burnt Sienna/Tuscan Sunset/Electropop 에 이어 사이드바 테마 순환 버튼에 편입돼
  총 10종 테마가 됐다. Frontend: `index.css` 에 `html.summer-breeze` /
  `html.wildflower-meadow` / `html.tropical-punch` 토큰 블록 추가, `themeStore.ts`
  `Theme`/`STANDALONE_THEMES` 확장, `Sidebar.tsx` 테마 순환/라벨/아이콘 갱신.
- **클러스터 아이콘 빌더 — 배색 패턴을 아이콘 빌더에서 직접 선택 가능**: 배색 패턴(Burnt
  Sienna 등 6종)이 지금까지 Settings ▸ 운영레벨 관리에만 있어 실제 아이콘 빌더 화면에서는
  적용할 방법이 없었던 문제를 고쳤다 — "빌더" 탭에 배색 패턴 스와치를 추가해, 클릭 한 번으로
  해당 아이콘 1개에만 색을 적용할 수 있다(운영등급 설정 자체는 바뀌지 않음). Frontend:
  `ClusterIconPicker.tsx` `BuilderTab` 에 `COLOR_PATTERNS` 스와치 + `patternHex` 상태 추가.
- **클러스터 아이콘 — 뷰어의 UI 테마에 맞춰 색상 자동 동기화 (커스텀 지정 시 항상 우선)**:
  아이콘 빌더로 만든 클러스터 아이콘이 이제 색을 한 번 굽어서 고정하지 않고, 보는 사람의
  현재 활성 테마(배색 패턴과 이름이 일치하면 그 팔레트, 아니면 운영타입 색상)에 맞춰
  매번 다시 렌더된다 — 같은 클러스터를 봐도 각자 테마에 맞는 색으로 보인다. 아이콘 빌더에서
  배색 패턴을 직접 골라 커스텀 지정한 경우엔 그 색이 테마 변경과 무관하게 항상 우선한다.
  Backend: `Cluster.icon_config` JSONB 컬럼 추가(`{workName, attribute, regionAbbr, shape,
  watermark, level, colorMode: 'theme'|'custom', customHex}`), `ClusterBase`/`ClusterUpdate`
  스키마에 노출. Frontend: `lib/clusterIconTheme.ts`(`resolveIconSeed`) + 신규 훅
  `hooks/useClusterIconSrc.ts` 로 렌더 시점에 색을 계산하도록 `ClusterSidebar`/
  `ClusterTableRow`/`SettingsPage` 의 아이콘 표시를 전환, `BuilderTab` 이 레시피(iconConfig)를
  함께 저장.

### Fixed
- **홈 플랫폼 현황 — "좁게" 밀도가 실제로는 줄지 않던 문제 + 페이지당 행 수 제한 추가**:
  행 높이 밀도 "좁게"가 `minHeight` 만 낮췄던 탓에, 라벨 셀이 원래 2줄(이름/카테고리 +
  소스뱃지/실행·수정·삭제) 구조라 콘텐츠 높이가 이미 그보다 커서 체감상 거의 줄지
  않았다. "좁게"에서는 두 줄을 한 줄로 접어 실제로 절반 가까이 줄어들게 했다. 점검
  항목이 많아져도 스크롤 없이 볼 분량을 직접 정할 수 있도록 "표시 설정" 팝오버에
  화면당 표시 행 수(전체/10/20/30) 선택 + 이전/다음 페이지 이동을 추가했다(정렬·드래그는
  페이지 경계와 무관하게 전체 목록 기준으로 계속 동작). Frontend:
  `components/platform-status/PlatformStatusMatrix.tsx`.

## [1.26.0] - 2026-08-06

### Changed
- **Batch Jobs 화면을 독립 사이드바 메뉴에서 홈의 "플랫폼 현황" 탭 서브탭으로 병합**:
  Batch Jobs 는 그대로 클러스터 단위 운영 화면이라 화면 수를 줄이기 위해 접었다 —
  데이터 모델/백엔드는 무변경(배치잡은 상태를 바꾸는 "액션", 점검 매트릭스는 읽기 전용
  "상태 조회"라 매트릭스 셀 자체로 흡수하지는 않음). 홈 → `플랫폼 현황` 탭 안에 **점검
  매트릭스** / **배치잡** 서브탭이 새로 생겼고, 사이드바 `DevOps` 그룹 메뉴에서는
  Batch Jobs 항목이 빠졌다. 배치잡 서브탭은 접근 제어(Settings)로 `/batch-jobs` 를
  끄면 버튼 자체가 숨는다. 구 URL `/batch-jobs` 는 `/` 로 리다이렉트(북마크 호환),
  Your Island 패널 등록은 라우트와 무관해 영향 없음.

### Changed
- **홈 플랫폼 현황 — 헤더 줄 병합 + 행/열 크기 조정**: 세그먼트 탭("업무 현황"/"플랫폼 현황")
  줄 바로 아래에 "플랫폼 현황" 제목을 다시 반복하던 매트릭스 카드 헤더 줄을 탭 줄과 한 줄로
  합쳐 세로 공간을 줄였다(제목은 탭이 이미 보여주므로 카드 쪽에서는 뺐다). 점검 항목 열/각
  클러스터 열 너비를 헤더 경계 드래그로 조정할 수 있게 됐고(더블클릭으로 기본값 복원, 너비는
  브라우저에 저장), 새 "표시 설정" 팝오버에서 행 높이를 좁게/보통/넓게 3단계로 바꿔 점검
  항목이 많아져도 한 화면에 더 많이 보이게 할 수 있다. Frontend:
  `pages/HomePage.tsx`(세그먼트 탭 줄에 툴바 portal slot 추가),
  `components/platform-status/PlatformStatusMatrix.tsx`(`toolbarSlot` prop + portal,
  `useColumnWidths`/`ResizeGrip` 로 열 리사이즈, `MatrixDisplaySettings` 행 높이 토글).

### Fixed
- **인클러스터 Ollama(qwen2.5-coder:7b) 이미지 — 모델이 실제로는 비어있던 문제**: 수동으로
  빌드/push 했던 `ghcr.io/riverjin839/ollama-qwen2.5-coder:7b` 는 헬스체크는 온라인으로
  뜨지만 실제로는 `/root/.ollama/models` 가 비어있어 챗봇/장애분석/임베딩이 전부
  "model not pulled" 로 실패하는 상태였다. `docker/ollama-qwen2.5-coder/Dockerfile` 신설
  (serve→pull→`ollama list` 검증을 한 RUN 레이어에서 끝내고, 모델이 없으면 빌드 자체를
  실패시킨다) + `.github/workflows/ollama-qwen2.5-coder.yml` 로 GHCR
  자동 빌드/게시(`ghcr.io/riverjin839/devops_management/ollama-qwen2.5-coder:7b`,
  GITHUB_TOKEN 사용) 로 교체. `k8s/base/ollama.yaml` 의 부팅 대기 로직도 curl 의존성을
  제거해 `ollama list` 기반으로 바꿔, curl 이 없는 베이스 이미지에서 무한 대기 로그만
  찍히던 부수 증상도 함께 해소. `k8s/overlays/airgap/`, `helm/k8s-daily-monitor/
  values.yaml`, `scripts/deploy-airgap.sh` 의 이미지 참조를 새 경로로 갱신.

## [1.25.2] - 2026-08-06

### Added
- **Jira·Confluence 자동 생성 — 이슈 종류 선택 + Epic/상위 이슈 목록 선택 + Confluence 옵션
  확장**: 프로젝트 키가 필수 입력으로 바뀌었고, 이슈 종류가 텍스트 입력 대신 Epic/Task/
  Sub-task 3종 선택 버튼으로 바뀌어 종류에 따라 필요한 하위 옵션만 보여준다(Epic 은 상위
  연결 입력 자체가 없고, Task 는 Epic 키, Sub-task 는 상위 이슈를 수동 입력하거나 "목록"
  버튼으로 프로젝트 내 후보를 불러와 고를 수 있다). Confluence 문서 생성 옵션에 문서 ID
  (기존 문서를 제목 검색 없이 직접 지정), 라벨, Contributor(기본값은 나 자신, 수정 가능)를
  추가했다. Backend: `routers/jira.py` `GET /jira/lookup/issues`(프로젝트+이슈종류로 후보
  조회), `provision_work_item` 이 `page_id`/`confluence_labels`/`contributor` 를 처리,
  `ConfluenceService.add_labels()` 신설, `schemas/jira.py` `ProvisionRequest`/
  `ProvisionDefaults`/`JiraIssueLookupResult` 확장. Frontend:
  `components/work-items/JiraProvisionModal.tsx` 전면 개편, `hooks/useJira.ts`
  `useJiraIssueLookup`.
- **점검 매트릭스 — 클러스터 cron on/off 스위치**: 클러스터 열 헤더의 cron 배지가 "미설정"
  하나로만 표시되던 것을, cron 을 저장한 적 없는 상태(미설정)와 저장은 돼 있지만 꺼둔 상태
  (꺼짐)로 구분했다. 배지 팝오버에 "자동 실행" 체크박스가 추가돼 cron 표현식을 지우지 않고도
  실행만 껐다 켰다 할 수 있다(항목별 `CheckMatrixSchedule.enabled` 와 동일한 패턴). Backend:
  `models/cluster.py` `check_cron_enabled` 컬럼 추가, `routers/check_matrix.py`
  `PUT /check-matrix/clusters/{id}/cron` 이 값을 받아 저장, `services/check_matrix_service.py`
  디스패처·그리드 빌드가 꺼진 클러스터를 실행 대상에서 제외. Frontend:
  `components/platform-status/PlatformStatusMatrix.tsx` `ClusterCronBadge`.
### Fixed
- **Deep check 전체 — 단계 실패의 서버 로그 추적성 + 실행 화면에서 바로 SSH 수집**: 각
  체커가 흔히 쓰는 "권한 부족/바이너리 없음 등으로 `st.status="failed"` 만 세팅하고
  예외 없이 pending 결과를 반환"하는 경로는 `safe_run()` 의 일반 예외 로깅을 타지 않아
  DB/steps 에만 기록되고 서버 로그(journalctl 등)에는 아무 흔적도 없었다(실사례:
  `kubectl exec ... kubeadm certs check-expiration` 이 "Internal error occurred" 로
  실패). `deep_checkers/base.py` 의 `_step()` 한 곳에서 실패 상태를 감지해 로깅하도록
  고쳐, 개별 체커 19종 전체가 별도 조치 없이 커버된다(cert_expiry 는 pod 이름 등 추가
  맥락을 위해 자체 로깅도 유지). 또한 `cert_expiry`/`etcd_defrag` 처럼 pod exec 이
  구조적으로 실패하기 쉬운(distroless 이미지, systemd 데몬 등) 점검은 실패를 본 셀
  상세의 "실행 방식" 탭에서 바로 SSH 수집 모달(`KubeadmCertsModal`/`EtcdSystemdModal`)을
  열 수 있는 인라인 액션을 추가해, `/versions` 를 따로 찾아가지 않아도 즉시 조치할 수
  있게 했다(같은 패턴을 쓰는 점검이 늘면 `SSH_COLLECT_ACTIONS` 맵에 추가).
  Backend: `services/deep_checkers/base.py`, `cert_expiry_checker.py`. Frontend:
  `components/platform-status/CheckMatrixRunbookPanel.tsx`.

### Changed
- **홈 플랫폼 현황(`/`, 플랫폼 현황 탭) — impeccable polish·layout·delight 고도화**: 이미 여러 차례
  critique+fix 라운드를 거친 화면을 한 단계 더 다듬었다. 행 순서 변경 그립이 마우스 드래그
  전용이던 것에 화살표 위/아래 키보드 대체 수단을 추가했고, 클러스터 cron 설정 팝오버에
  `aria-haspopup`/`aria-expanded`와 Escape-로-닫기(다른 팝오버·모달과 동일한 `useModalA11y`
  패턴)를 부여했다. 빈 셀("—")의 안내 문구를 상황별(수동 미입력/예약 대기/미실행)로 구분했고,
  일괄 실행 완료 메시지가 실패 건이 섞여도 무조건 "끝났습니다"로만 뜨던 것을 성공/실패 건수와
  아이콘·색으로 정직하게 구분했다. "등록된 클러스터/점검 항목 없음" 빈 상태를 안내 문장만 있던
  것에서 실제 동작하는 CTA 버튼(`EmptyState`)으로 교체했고, 헤더 툴바에 구분선을 추가해 화면
  정체성과 동작 버튼 그룹을 시각적으로 분리했으며, 무언가 실행 중일 때 "수행 로그" 버튼에
  은은한 점 표시를 추가해 패널을 열지 않고도 알 수 있게 했다. Frontend:
  `components/platform-status/{PlatformStatusMatrix,CheckMatrixRunLogPanel}.tsx`.
### Added
- **테마 3종 추가 — Burnt Sienna / Tuscan Sunset / Electropop**: Figma 색상 조합 라이브러리의
  실제 배색(Burnt sienna, Tuscan sunset, Electropop)을 그대로 옮긴 앱 전체 UI 테마 3개가
  추가됐다. 사이드바 레일의 테마 순환 버튼(default → comfort → 번트 시에나 → 토스카나 선셋 →
  일렉트로팝 → light → dark → system)으로 전환한다. Electropop 은 네온 액센트의 비비드
  다크 테마로, 이 앱에서 유일한 "다크 계열 + 원색 accent" 조합이다. Frontend:
  `index.css` 에 `html.burnt-sienna` / `html.tuscan-sunset` / `html.electropop` 토큰 블록
  추가, `stores/themeStore.ts` `Theme` 유니언 확장, `Sidebar.tsx` 테마 순환/라벨/아이콘 갱신.

### Changed
- **운영레벨 커스텀 색상 — 배색 패턴 프리셋을 Figma 원본 3종으로 교체**: 커스텀 색상
  선택기의 배색 패턴 프리셋을 근사값 5종에서 Figma 색상 조합 라이브러리 원본 HEX 3종
  (Burnt Sienna/Tuscan Sunset/Electropop)으로 교체했다. Frontend: `lib/colorPatterns.ts`
  `COLOR_PATTERNS` 값 갱신.
- **좌측 사이드바 + 상단바 flyout 메뉴가 마우스 오버만으로 열리도록 개선**: 클러스터/서버/
  네트워크 등 그룹 아이콘, 즐겨찾기·Your Island 아이콘(좌측 사이드바)과 협업/문서 관리
  드롭다운·즐겨찾기 버튼(상단 `AppTopBar`)이 지금까지 클릭해야만 열렸는데, 마우스를
  올리기만 해도(hover-intent) 바로 열리도록 바꿨다. 150ms 오픈 지연(레일/상단바를 스쳐
  지나가는 마우스에 깜빡이지 않도록)과 200ms 닫기 지연(아이콘→패널로 이동하는 짧은 순간
  hover 가 끊겨도 패널 진입 시 취소)을 뒀다. 클릭 동작은 그대로 즉시 토글된다. 사이드바
  아이콘은 hover 시 flyout 헤더가 이미 이름을 보여주므로, 라벨만 뜨는 중복 툴팁은 더 이상
  뜨지 않는다(flyout 이 없는 테마 토글 등은 기존처럼 툴팁만 뜬다). 구현 중 두 곳에서 서로
  다른 원인의 "hover 로 연 flyout 이 열리자마자 닫히는" 버그를 발견해 함께 고쳤다 — 사이드바는
  click-outside 캐처가 레일(`<aside>`)과 같은 z-index 라 DOM 순서상 레일 위에 그려지던 문제,
  상단바는 캐처가 `<header>` **내부의 자식**으로 렌더돼 포지션 없는 버튼들보다 z-index 값과
  무관하게 항상 위에 그려지던 문제(두 경우의 스태킹 맥락이 달라 처방도 다르다). 부수적으로
  사이드바에서 flyout 이 열린 상태에 다른 그룹 아이콘을 클릭하면 캐처에 막혀 두 번 클릭해야
  열리던 잠재 버그도 함께 해소됐다. R-4 5차 라운드(D-054~D-060) 잔여 D-057~D-059 도 함께
  처리: 마지막 고아 라우트 `/jira-import` 를 협업 그룹에 편입(D-057), '클러스터' flyout(20여
  항목)을 모니터링/콘솔/점검/관리 섹션으로 구분(D-058), flyout 이 있는 아이콘에 점 인디케이터
  추가(D-059) — 5차 라운드 전 항목 완료. Frontend: `components/layout/{Sidebar,AppTopBar,
  NavFlyout}.tsx`, `navConfig.ts`.

### Fixed
- **K8S 자원 관리(`/k8s-allocation`) — 사용효율 경고 로직·포커스 접근성·Pod 상태 노출 수정**: impeccable
  critique 진단(Design Health 30/40)에서 나온 이슈를 반영. CPU/MEM 사용효율 요약 카드의 경고
  로직이 "낭비"(30% 미만)만 반영하고 자체 툴팁이 설명하는 "스로틀/OOM 위험"(105% 초과) 케이스는
  실제로 반영하지 않던 버그를 수정했고, 경고 신호에 색상만이 아니라 아이콘을 병기했다.
  `NsRankingView`에만 없던 "집계 중(computing)" 상태 분기를 추가해 상단 배너와 탭 본문이
  모순되던 문제를 해소했다. `PageSizeSelect`·자동갱신 간격 select·카드 열 수 select·Pod
  스케줄 계산기 입력 2개 등 5개 폼 컨트롤에 키보드 포커스 인디케이터가 전혀 없던 문제(전역
  CSS가 outline을 제거한 뒤 로컬 보완이 빠짐)를 수정했다. API에는 있지만 화면 어디에도
  렌더링되지 않던 파드 `phase`(Running/Pending/Failed 등)를 파드 드릴다운 테이블에 상태
  배지로 노출해 "Pending 원인 조사" 워크플로가 화면 안에서 완결되게 했다. 그 외 노드 뷰(카드·
  테이블)에만 없던 효율 배지(`EffBadge`) 추가로 네임스페이스/워크로드 뷰와 대칭을 맞췄고,
  요약 그리드에 누락돼 있던 "MEM 사용효율" 슬롯을 추가했으며, "스케줄 가능 Pod" 수치가 두
  카드에서 중복 노출되던 것을 정리했다. 물음표 툴팁(`StatTooltip`)을 프로젝트 표준 Base UI
  `Tooltip` 프리미티브로 교체해 키보드/스크린리더 접근성을 개선했다. Frontend:
  `pages/K8sAllocationPage.tsx`.
- **홈 업무 현황(`/`, 업무 현황 탭) — 상태색 통일·에러 처리·삭제 확인·접근성 수정**: impeccable
  critique 진단(Design Health 22/40, P0 1건)에서 나온 이슈를 반영. 당일 스케줄·주간 스윔레인·
  담당자별 진행 현황 세 컴포넌트가 같은 업무 상태에 서로 다른 색 토큰을 쓰던 문제를 공용
  소스(`lib/statusColors.ts`)로 통일했고, `MemberTodayTodos`에만 남아있던 하드코딩 팔레트
  (amber/red)를 다른 패널과 같은 flat 톤으로 교체했다. `WorkCalendar`/`MemberTodayTodos`가
  API 장애를 "일정 없음"으로 뭉개던 문제를 재시도 버튼이 있는 에러 상태로 보강했고, 시간
  블록 삭제에 `ConfirmDialog(danger)` 확인 절차를 추가했다. 그 외 "다음 일정" KPI 개인화(옆의
  "내 할일"과 다른 모집단이던 문제), 상태 색상에 아이콘 보강(색맹 접근성), 시간 블록 키보드
  이동(화살표 위/아래로 15분 단위), 담당자 스윔레인 업무량순 정렬 토글, 탭 라벨 "내 업무"→
  "업무 현황"(실제 표시되는 팀 전체 콘텐츠와 정합), `/todo-today` 이동 CTA 라벨 통일, 홈 패널
  2곳의 `MacCard` 전환(+`WeeklyStatusTimeline` 자체 카드 이중중첩 해소), 아이콘 버튼 `title`
  누락 2건, `localStorage` 키의 구 브랜드(`k8s:`) 접두어를 `pep:`로 정리, 캘린더 요일 장식에
  `status-critical`/`status-info` 재사용을 중립 토큰으로 분리를 함께 수정했다. Frontend:
  `pages/HomePage.tsx`, `pages/SettingsPage.tsx`,
  `components/dashboard/{DayScheduleBoard,WeeklyStatusTimeline,WorkCalendar,MemberTodayTodos,StatusGlyph}.tsx`,
  신규 `lib/statusColors.ts`.
- **업무 관리 게시판(`/tasks-mgmt`) — 디자인 토큰 통일·필터 바 재구성·접근성 수정**: impeccable
  critique 진단(Design Health 24/40, P0 2건)에서 나온 이슈를 반영. 칸반/캘린더/Jira 모달 전반의
  고정 팔레트(`bg-red-500` 등)를 테이블 뷰(`WorkItemTableRow.tsx`)와 동일한 `--status-*`/
  `--chart-*` 토큰으로 통일해 같은 화면 안에서 뷰마다 다르던 우선순위 색 체계를 맞췄다. 필터
  바의 상시 노출 컨트롤을 15개에서 4개(유형/상태/검색/내 업무)로 줄이고 담당자·우선순위·모듈·
  스프린트·기간을 "필터 더보기" 팝오버로 묶었다(활성 조건 수 배지 표시). 그 외 Kanban 카드
  `focus-within` 액션 노출, 아이콘 버튼 `aria-label` 누락 보강, 커스텀 필드/Jira 임포트 삭제의
  `window.confirm` → `ConfirmDialog(danger)` 전환, WIP 한도 표시를 칸반과 동일한 기준으로 통일,
  마감일 지난 업무 헤더 배지 추가, CSV 추출 실패 시 무음 콘솔 로그 대신 토스트 알림, Jira push
  충돌 시 "다시 가져오기" 후속 액션 추가, 색상 단독으로만 전달되던 지연/우선순위 표시에 아이콘·
  라벨 보강을 함께 수정. Frontend: `pages/WorkItemBoardPage.tsx`,
  `components/work-items/{WorkItemKanban,WorkItemCalendar,WorkItemTableRow,WorkItemCustomFieldsManager,JiraIssueChip,JiraLinkDialog,JiraImportModal,JiraProvisionModal,workItemKanbanUtils}.tsx`.
- **클러스터 관리(`/cluster-manage`) — viewer 권한 게이팅·확인절차·접근성 수정**: impeccable
  critique 진단(Design Health 30/40)에서 나온 이슈를 반영. 커스텀 컬럼 삭제를 네이티브
  `confirm()`에서 `ConfirmDialog(danger)`로 교체했고, 커스텀 컬럼 셀에 키보드로 편집 진입할 수
  있는 연필 버튼을 추가했다. 모달 닫기 버튼 5곳(Cilium 설정·커스텀 컬럼·정보수집 diff·NIC 수집)에
  누락된 `aria-label`을 채웠다. 서버(`require_operator`)만 막던 변경성 동작(삭제·정보수집·인라인
  편집·이름 표준화·컬럼 관리)을 프론트에서도 `viewer` 역할에는 숨기거나 조회 전용으로 표시해,
  클릭 후 403으로만 실패를 알게 되던 문제를 해소했다. 그 외 카드뷰 드래그 핸들 포커스 가시성,
  `ClusterCard`의 `MacCard` 미사용, 이름 표준화 확인 절차 부재, IP 배지 색상단독 표시,
  `NodeNicsCollectModal`의 `LogViewer` 미사용·에러 상태 누락, CIDR 겹침 배지의 상대 클러스터명
  누락을 함께 수정. Frontend: `pages/ClusterManagePage.tsx`,
  `components/cluster-manage/{ClusterCard,ClusterTableRow,ClusterCustomCell,ClusterCustomFieldsManager,StandardizeClusterNamesModal,CiliumConfigModal,ClusterUpdateDiffDialog}.tsx`,
  `components/versions/NodeNicsCollectModal.tsx`.

## [1.25.1] - 2026-08-05

### Fixed
- **Deep Check 실패가 TLS/인증서 문제일 때도 "곧 나아질 것"(pending)으로 잘못 분류되던
  문제**: `HTTPSConnectionPool(...): Max retries exceeded` 는 순수 연결 불가(타임아웃 등)
  뿐 아니라 `Caused by SSLError(...)`/`x509: ...` 처럼 TLS/인증서 검증 실패(클러스터 CA
  로테이션 후 kubeconfig 미갱신, 인증서 만료 등)로도 나타난다 — 이건 재시도로 저절로
  낫는 문제가 아니라 kubeconfig 를 다시 등록해야 하는 지속적 설정 오류인데, 기존
  분류 힌트("ssl:" 하나)가 전자와 뭉뚱그려져 "pending" 으로 표시되며 운영자가 진짜
  원인을 놓쳤다. TLS/인증서 관련 패턴(`certificate verify failed`/`x509`/
  `certificate signed by unknown authority`/만료 등)을 먼저 확인해 **critical** +
  "kubeconfig 를 최신 상태로 다시 등록하세요" 안내 메시지로 분리 분류하도록 수정
  (kubectl 기반 배치잡의 `k8s_diagnose.classify_kubectl_failure` 와 같은 원칙).

## [1.25.0] - 2026-08-05

### Fixed
- **Deep Check 기반 점검(배치잡/점검 매트릭스)이 API 서버가 응답하지 않는 클러스터에서
  최대 240초씩 멈춘 뒤 `SoftTimeLimitExceeded` + `HTTPSConnectionPool(...port=6443):
  Max retries exceeded` 로 실패하던 문제**: "API 서버 응답시간"(core_bundle) 점검은
  `httpx` 에 명시적 타임아웃(30초)을 쓰기 때문에 정상 동작했지만, 대부분의 Deep Check 체커
  (`cert_expiry`/`etcd_defrag`/`oom_events`/`pod_to_pod`/`stuck_terminating`/`audit_rbac`/
  `cni_flow`/`isilon_nfs`/`pvc_health` 등)는 kubernetes 파이썬 클라이언트 호출에
  타임아웃을 넘기지 않아, 죽은 API 서버(`:6443`)에 물리면 셀 하나가 무한정 대기하다
  Celery 의 soft time limit(240초)에야 겨우 죽었다. `DeepCheckerBase._v1()`/`_wrap_api()`
  가 반환하는 클라이언트를 얇은 타임아웃 프록시로 감싸 모든 K8s API 호출에 기본
  15초 타임아웃을 강제로 주입하도록 수정(호출자가 직접 넘긴 값은 그대로 존중) — 개별
  체커 코드를 일일이 고칠 필요 없이 한 곳에서 구조적으로 막는다. 부수적으로
  `SoftTimeLimitExceeded` 가 그대로 새어나온 경우도 연결 오류로 정확히 분류되도록
  분류 힌트에 추가.
### Added
- **업무 관리 ↔ Jira 동기화 확장**: 마감일(Jira `duedate`), 스프린트(Jira Sprint
  커스텀필드 → PEP `Sprint` 이름 매칭, 설정 `jira_sprint_field`), 상위업무 체인
  (Epic→Task, Sub-task 는 상위를 1회 추가 조회해 Epic 값을 끌어옴 — 형제 Sub-task 는
  배치당 1회만 조회), Confluence 원격 링크 전체 목록(`confluence_links`, 복수 등록
  가능 — 대표 링크 `confluence_url` 은 그대로 유지)을 가져오기/재가져오기/재연결마다
  동기화한다. 담당자는 title/content 와 동일하게 이제 Jira 가 무조건 소유(매 동기화마다
  PEP 매핑 이름으로 갱신 — 이전엔 비어있을 때만 채움). 업무 관리 게시판에 **마감일**
  컬럼 신규, **상위업무**(구 Epic) 컬럼이 Epic+상위 2개 칩 체인으로, Confl. 링크
  컬럼이 다중 링크 드롭다운으로 확장. Backend: `services/jira_service.py`
  (`extract_sprint_name`, `map_jira_issue` 의 `epic_override`/`remote_confluence_links`
  파라미터), `routers/jira.py`(`_resolve_epic_chain`, `_resolve_sprint_id`,
  `_JIRA_OWNED_ATTRS`/`_SYNC_FIELDS` 확장), `models/work_item.py`(`due_date`,
  `confluence_links`). Frontend: `WorkItemTableRow.tsx`, `workItemColumns.ts`.
- **하위 업무 등록 팝업을 상위 업무 등록과 통일**: `WorkItemFormModal`(무거운 전체 폼)
  대신 `QuickAddTaskModal`(컴팩트 팝업, 저장 후 Jira/Confluence 자동 생성으로 이어지는
  흐름)을 하위 업무 등록에도 재사용 — 상위 업무를 읽기전용 칩으로 보여주고(수정 불가)
  담당자/카테고리를 상위 업무 값으로 기본 채운다. Frontend:
  `components/dashboard/QuickAddTaskModal.tsx`(`parentItem` prop 신규),
  `pages/WorkItemBoardPage.tsx`.
- **업무 관리 필터 "이번주" 버튼 4단 순환**: 이번주(월~일) → 2주(이번주+다음주) →
  이번달(1일~말일) → 해제 순으로 반복 클릭 시 넓어진다. Frontend:
  `pages/WorkItemBoardPage.tsx`(`cycleDateFilter`).
- **컬럼 순서/폭/표시여부 개인화**: 업무 관리 게시판 컬럼 레이아웃(순서/폭/표시여부)이
  필터 조건과 마찬가지로 로그인 계정별 localStorage 키로 분리 저장돼, 같은 브라우저를
  여러 계정이 써도 서로 섞이지 않는다. Frontend: `pages/WorkItemBoardPage.tsx`
  (`useColumnLayout`/`useColumnWidths` storageKey 에 username 반영).
- **Confluence 문서 가져오기 조건 추가**: 상위 페이지 ID(ancestor)·문서 제목 필터를
  추가하고, 최근 수정 기간 기본값을 "이번주"(월요일부터)로 변경(Jira 가져오기와 동일
  패턴, 수정 가능). Backend: `schemas/confluence_docs.py`(`title`, `ancestor_id`),
  `routers/confluence.py`(`_build_confluence_cql`). Frontend:
  `components/documents/ConfluenceImportModal.tsx`.

### Fixed
- **업무 완료일 — 칸반 드래그로 재오픈해도 완료일이 안 지워지던 문제**: 정식 폼 저장
  (PUT)은 done 에서 벗어나면 완료일을 해제했지만, 칸반 드래그(PATCH `/status`) 경로는
  그 분기가 없어 재오픈해도 완료일이 남아있었다 — 두 경로가 동일하게 동작하도록 수정.
  Backend: `routers/work_items.py`(`patch_status`).
- **작업 제목/작업 내용 항목명·설명 명확화**: 업무 관리 게시판의 "제목" 컬럼을
  "작업 제목"으로 변경(Jira summary 와 동기화됨을 명시).

## [1.24.3] - 2026-08-05

### Changed
- **Jira 가져오기 — 미리보기/가져오기 버튼을 하나로 통합**: 별도의 "미리보기" 버튼을 없애고
  "가져오기"를 누르면 항상 먼저 검색 결과를 미리보기로 보여준 뒤, 같은 버튼이 "가져오기 확정"으로
  바뀌어 눌러야 실제로 저장되도록 변경. 미리보기가 뜬 뒤 검색 조건(프로젝트/JQL/필터 등)을 바꾸면
  미리보기가 자동으로 무효화돼 "다시 검색"이 필요하다. Frontend: `JiraImportModal.tsx`.

### Fixed
- **Jira 가져오기 담당자 매핑 — "이름 회사명" 표시명이 그대로 담당자로 들어가던 문제**: Jira
  표시명(displayName)이 "홍길동 ACME회사"처럼 회사명이 붙어 있으면 담당자 레지스트리와 문자열이
  정확히 일치하지 않아 PEP 담당자 이름으로 변환되지 않았다. 이메일(고유 식별자)이 노출되는
  인스턴스는 이메일로 우선 매칭하고, 없으면 표시명의 첫 토큰(이름 부분)으로 레지스트리와
  매칭하도록 보강. "내게 할당"(scope=me) 가져오기는 `assignee = currentUser()` 로 대상이 로그인
  사용자 자신임이 이미 확정되므로, Jira 쪽 표시명 매칭을 아예 건너뛰고 사번(employeeId) 기준으로
  역참조한 본인의 PEP 담당자 이름을 바로 사용한다. Backend: `routers/jira.py`
  (`_build_assignee_resolver`, 신규 `_resolve_self_assignee_name`), `services/jira_service.py`.

### Changed
- **NFS 모니터링(Isilon) — mc 클라이언트 콘솔 패턴 적용, 일괄 수집 → 선택 실행으로 전환**: 페이지
  로드 시 등록된 isi 명령을 전부 자동 수집하던 방식을 없애고, mc 클라이언트처럼 등록된 명령 중
  원하는 것만 체크박스로 골라(중복 선택 가능) "선택 실행" 하도록 바꿨다. 결과는 항상 우측 결과
  패널(플레이스홀더 고정)에 표시되고 출력은 plain `<pre>` 대신 `LogViewer` 로 렌더링되며, 상태는
  ok/error `StatusBadge` 로 통일했다. K8s PV ↔ Isilon export 매칭 테이블은 직전 실행 결과 기준으로
  갱신된다. Backend: `POST /api/v1/isilon-nfs/servers/{id}/run`(선택 키만 캐시 없이 온디맨드 실행,
  `isilon_service.run_selected_commands`) 신규 추가. Frontend: `IsilonNfsPage.tsx` 재구성,
  `components/isilon/IsilonCommandSelector.tsx`(신규) + `useRunIsilonCommands` 훅,
  `useTerminalEnvSync` 최상단 호출 추가.

### Fixed
- **홈 "플랫폼 현황" 매트릭스 — 일괄 실행 확인·조회 실패 표시·색상단독 상태·접근성 수정**:
  impeccable critique/audit 진단(Design Health 26/40, Audit 12/20)에서 나온 이슈를 반영.
  클러스터/항목 단위 "전체 실행"에 `ConfirmDialog`(danger)를 추가해 삭제보다 마찰이 낮던
  문제를 해소했고, 그리드 조회 실패 시 "항목/클러스터 없음"으로 오인되던 것을 재시도 가능한
  에러 배너로 분리했다. 클러스터 cron 배지·셀 값 표시가 색상(StatusDot/배경색)에만 의존하던
  부분에 톤별 아이콘(정상/경고/위험/실행중)을 병행했고, 모달 닫기 버튼 3곳에 누락된
  `aria-label`을 채웠다. 행 편집/삭제 버튼은 hover 전용(`opacity-0`)이라 키보드 포커스 시
  보이지 않고 터치 기기에서 아예 도달 불가했던 것을 상시 노출(`opacity-40`) +
  hover/focus-within 시 100%로 바꿔 두 문제를 함께 해결했다. 행 라벨 셀에 최대 8개 요소가
  한 줄에 몰려 있던 것을 2줄로 분리해 정리. Frontend:
  `components/platform-status/PlatformStatusMatrix.tsx`,
  `CheckMatrixCellDetailModal.tsx`/`CheckMatrixItemFormModal.tsx`/`CheckMatrixSettingsModal.tsx`.

### Removed
- **PEP 서비스 / APP 서비스 완전 삭제**: 사이드바 "PEP 서비스"(`/services` 서비스 카탈로그·허브)·
  "APP 서비스"(`/app-services`) 그룹과 레거시 `/pep-services` 화면을 삭제했다 — 제공하던 서비스별
  가이드/이슈대응 노트 기능이 이미 "문서 관리" 그룹(`/docs`·`/work-guides`·`/ops-notes`)과
  중복이었다. 업무 관리의 "관련 서비스" 태그(`ServiceChip`)와 상세 페이지의 연관 ServiceEntry
  사이드바도 함께 제거했다. LAKE 서비스 모니터링(`/lake-services`)과 Settings "관리 서비스"
  (서비스 타입/카테고리 레지스트리)는 완전히 별개 기능이라 영향 없음. Backend:
  `routers/service_entries.py`·`models/service_entry.py`·`schemas/service_entry.py`·
  `data/lake_service_knowledge.py` 삭제, `service_entries` 테이블/`work_items.service` 컬럼은
  과거 데이터 보존을 위해 스키마는 그대로 둠(DROP 없음). Frontend: `PepServicesPage`·
  `AppServicesPage`·`ServicesCatalogPage`·`ServiceHubPage`·`components/service-domain/` 삭제.

### Changed
- **홈 "모드"를 사이드바 게이팅에서 분리, 업무 도메인을 전역 상단바로 이동**: 사이드바 로고
  버튼이 "업무 현황"/"플랫폼 현황" 모드를 토글하면서 반대 도메인 그룹(협업 7개 화면 또는
  클러스터·서버·네트워크·스토리지·DevOps 36개 화면)이 사이드바에서 통째로 사라지던 문제
  (R-4 5차 D-054)를 없앴다. 협업/문서 관리 그룹은 신규 전역 `AppTopBar`(모든 화면 상단,
  사용자명·날짜·알람 종 포함)로, 클러스터/서버/네트워크/스토리지/서비스/DevOps 그룹은 좌측
  사이드바에 그대로 남아 **두 도메인이 항상 동시에 보인다**. 홈 화면 안의 "업무 현황/플랫폼
  현황" 선택은 라벨 있는 세그먼트 탭(`[내 업무] [플랫폼 현황]`)으로 대체(D-055). 로그인마다
  선택이 `work` 로 강제 리셋되던 것도 제거해 기기 간 선호가 유지된다(D-056). Backend 무변경.
  Frontend: `components/layout/AppTopBar.tsx`·`NavFlyout.tsx`(신규, `Sidebar.tsx` 의 flyout
  공용화), `navConfig.ts`(`GROUPS.modes`→`GROUPS.domain`), `stores/homeStore.ts`(`mode`→
  `homeTab`, localStorage 키 `pep:homeMode`→`pep:homeTab`), `stores/authStore.ts`(강제 리셋
  제거), `pages/HomePage.tsx`, `index.css`(`--topbar-h` + `.app-min-h-screen`/`.app-h-screen`/
  `.app-max-h-screen` 유틸리티, 60여 개 페이지 적용).

### Added
- **홈 KPI 스트립에 "점검 실패" 신호 추가**: 위험 클러스터 옆에 점검 매트릭스의 critical 셀
  개수를 보여주는 필을 추가했다(R-4 5차 D-060 단기안) — 업무 탭에 있어도 플랫폼 이상 유무를
  바로 알 수 있다. 클릭하면 페이지 이동 없이 `플랫폼 현황` 탭으로 전환된다. `플랫폼 현황`
  탭 라벨에도 위험 클러스터+점검 실패 합계 배지가 붙고 0건이면 숨는다. Frontend:
  `hooks/useCheckMatrix.ts` 의 `useCheckMatrixFailureCount()`(신규, `useCheckMatrixGrid()` 와
  쿼리키를 공유해 추가 네트워크 요청 없음), `pages/HomePage.tsx`.
- **홈 개인화 — 기본 홈 탭 · 즐겨찾기 · 최근 방문**: 로그인 시 열릴 홈 탭(`내 업무`/`플랫폼
  현황`)을 서버에 저장해 기기를 넘어 유지하고(Settings "화면 UI 설정" 탭에 선택기 추가),
  전역 상단바·좌측 사이드바 flyout 메뉴 항목에 마우스를 올리면 별 아이콘으로 즐겨찾기를
  바로 추가/해제할 수 있으며, 상단바 ★ 드롭다운과 사이드바 최상단 "즐겨찾기" 레일 아이콘에서
  즐겨찾기 목록과 최근 방문(기기 로컬, 최대 5개) 화면을 확인·이동할 수 있다(R-4 5차 D-060
  잔여 해소). Backend: `routers/home_prefs.py`(신규, `GET/PUT /api/v1/me/home-prefs`,
  `user_settings` 테이블 재사용이라 스키마 변경 없음), `schemas/home_prefs.py`. Frontend:
  `hooks/useHomePrefs.ts`·`hooks/useFavorites.ts`·`stores/recentPathsStore.ts`·
  `components/layout/FavoritesFlyoutBody.tsx`(신규), `components/layout/NavFlyout.tsx`
  (`FlyoutLink` 에 즐겨찾기 토글 별 버튼 추가), `AppTopBar.tsx`·`Sidebar.tsx`·`HomePage.tsx`·
  `SettingsPage.tsx`.

## [1.24.2] - 2026-08-05

### Changed
- **사이드바 "사용자 관리" → Settings "시스템 담당자" 탭으로 통합, Settings 여백 축소**: 사이드바
  독립 아이콘이던 로그인 계정 관리(`/settings/users`)를 없애고 Settings 의 "담당자" 탭을
  "시스템 담당자" 탭으로 확장해 **담당자 명부**(기존 `AssigneeManager`) / **로그인 계정**(신규
  `SystemUserAccountManager`, 구 `UsersPage.tsx`) 두 서브탭으로 묶었다 — 담당자 명부에 사번을
  등록하면 로그인 계정이 자동 생성되던 기존 동작과 개념이 합쳐진다. 구 라우트는
  `/settings?tab=assignee` 로 자동 리다이렉트. 또한 Settings 본문 컨테이너가 `mx-auto` 로
  가운데 정렬되며 메인 사이드바로부터 과도한 여백이 생기던 문제를 좌측 정렬(flush) + 여백 축소
  (`px-8 py-8` → `px-4 lg:px-6 py-5`) + 폭 확대(`max-w-[1200px]` → `max-w-[1700px]`)로
  수정해, 클러스터/관리서버/담당자/감사로그 등 각 탭의 표가 더 넓게 표시된다. Frontend:
  `Sidebar.tsx`(레일 버튼 제거), `App.tsx`(`/settings/users` → redirect), `SettingsPage.tsx`,
  `components/settings/SystemUserAccountManager.tsx`(신규).

### Changed
- **클러스터 아이콘 빌더 — 운영타입 전용 밴드 제거, 남는 공간 재할당**: 운영타입은 색상(테두리·
  배경·밴드 명도)만으로 구분되고 텍스트 라벨이 없었는데도 아이콘 내부에 전용 밴드를 따로 차지하고
  있었다. 이제 그 밴드를 없애고 확보한 공간을 업무명/속성 밴드에 재배분했으며(지역 밴드는 값이 있을
  때만 추가), 글자 크기도 넓어진 밴드에 맞춰 커졌다. Frontend: `clusterIconBuilder.ts`
  `buildClusterIconSvg()` 가 지역 유무에 따라 2~3개 밴드로 동적 구성, `ClusterIconPicker.tsx`
  빌더 탭 라벨을 층수 표기 대신 항목명으로 정리.
- **운영레벨 커스텀 색상 — 큐레이션 배색 패턴 프리셋 추가**: Settings ▸ 운영레벨 관리의 커스텀 색상
  선택기에 Burnt Sienna/Tuscan Sunset/Electropop/Pop Art/Urban Graffiti 5가지 배색 패턴 팔레트를
  추가해 어울리는 색 조합을 클릭 한 번으로 고를 수 있다. Frontend: `lib/colorPatterns.ts`
  (`COLOR_PATTERNS`), `OperationLevelsManager.tsx` 에 `PatternColorPicker` 팝오버 추가.

## [1.24.1] - 2026-08-05

### Changed
- **업무 알람 벨 — 확인한 개인 알림이 아이폰 알림센터처럼 목록에서 자동으로 사라짐**: 댓글 등
  개인 인앱 알림을 한 번 확인(클릭)하면 벨 목록에서 즉시 빠지고, 링크로 이동하지 않고도 바로
  치울 수 있는 지우기(X) 버튼이 각 알림에 추가됐다 — 이전엔 읽어도 90일 보존기간까지 목록에
  계속 남아 있었다. Backend: `GET /notifications/my` 가 읽지 않은 알림만 반환. Frontend:
  `WorkAlarmBell.tsx` 알림 행에 개별 지우기 버튼 추가.

### Fixed
- **내 담당자 정보 — operator 가 IP 주소·좌석 등을 저장하면 "권한이 부족합니다" 오류가 나던 문제**:
  사용자 메뉴의 "내 담당자 정보" 패널이 담당자 **전체 목록**을 덮어쓰는 admin 전용 API 를 호출하고
  있어, admin 이 아닌 계정(담당자 등록 시 자동 생성되는 operator 포함)은 본인 정보조차 저장할 수
  없었다. 이제 본인 행만 부분 갱신하는 전용 API 로 저장하므로 로그인한 사용자 누구나 본인의
  이메일·IP·좌석·담당역할을 바꿀 수 있고, 다른 담당자의 데이터를 덮어쓸 위험도 사라졌다.
  이름·사번은 업무 담당자 식별 키·로그인 계정 키라서 계속 admin(Settings ▸ 담당자 탭) 전용이다.
  Backend: `PUT /api/v1/ui-settings/assignees/me` 추가(인증만 필요, 본인 행만 부분 수정).
  Frontend: `SelfAssigneePanel` 이 새 API 를 쓰고 저장 실패 시 서버 사유를 그대로 노출.

## [1.24.0] - 2026-08-05

### Added
- **점검 매트릭스(홈 → 플랫폼 현황) — 클러스터 cron 배지 색상 판독**: 클러스터 열 헤더의 cron 배지가
  더 이상 항상 같은 회색이 아니다 — **중지**(cron 미설정) / **실행중**(파랑, 지금 이 클러스터에서
  점검이 돌고 있음 — 전역 활성 수행을 4초 주기로 가볍게 폴링) / **정상·경고·위험**(초록/주황/빨강,
  핵심 점검(`core_bundle`) 행의 최근 셀 상태)로 한눈에 구분된다. Backend: `GET /check-matrix/runs`
  에 `run_state`(쉼표 다중값, 예 `queued,running`) 필터 추가.

### Fixed
- **점검 매트릭스 셀 상세 — "실행 방식"/"수행 로그" 탭이 실행 중 상태·실제 결과 색을 전혀
  보여주지 못하던 문제**: "실행 방식" 탭은 계획(설계)만 회색으로 그렸을 뿐 실제 수행 결과로
  단계를 색칠한 적이 없었고, "수행 로그" 탭은 목록/상세 모두 실행 중인 수행을 폴링하지 않아
  완료될 때까지 화면이 그대로 멈춰 있었다. 이제 "실행 방식" 탭이 이 셀의 가장 최근 수행을
  가볍게 폴링해 상태 배지 + 실제 단계 색을 보여주고(진행 중이면 완료 시 자동 반영), "수행 로그"
  탭의 목록·상세 모두 실행 중인 항목을 짧은 주기로 따라간다. 실행 단계 타임라인(`ExecutionStepsTimeline`
  — 딥체크/배치잡/점검 매트릭스 공용)의 각 단계 아이콘을 클릭하면 그 단계의 전체 로그·metrics·
  소요시간을 펼쳐 볼 수 있다(기존엔 hover 툴팁의 짧은 발췌만 가능했음).
- **점검 매트릭스 — 완료(위험)/실패 수행에서 원인을 알기 어렵던 문제**: 결과가 경고/위험이거나
  아예 실패한 수행은 상세 화면을 열면 사유 콜아웃(메시지/에러)이 강조되고 "결과 상세"(원본 필드)가
  자동으로 펼쳐진다 — 이전엔 접힌 JSON 을 직접 펼쳐야 원인을 확인할 수 있었다.
- **홈 대시보드 — 플랫폼 현황 매트릭스가 남는 세로 공간을 못 쓰고 고정 높이(520px)로 스크롤되던
  문제**: 매트릭스가 이제 페이지의 남는 공간을 모두 채우고(고정 높이 제한 제거) 카드 안쪽
  스크롤 하나만 갖는다 — 화면이 큰 모니터에서 아래쪽이 비거나 이중 스크롤이 생기던 현상 해소.

### Changed
- **AI 어시스턴트 진입점을 우하단 플로팅 버튼에서 좌측 사이드바 하단 레일로 이동**: 다른 화면
  요소(콘텐츠·모달)에 겹쳐 가리던 문제를 없애고, 릴리즈 노트·VOC 게시판 등 다른 개인 존
  아이콘과 같은 자리에 고정했다. 패널은 트리거 근처(좌하단)에서 열린다. 동작·접근 제어는
  변경 없음(기능 접근이 꺼진 사용자에게는 아이콘 자체가 보이지 않음).

## [1.23.1] - 2026-08-05

### Fixed
- **K8s 인증서 만료 점검(`cert_expiry`) — kube-apiserver 가 distroless 인 클러스터에서 상세로그 없이 실패하던 문제**: kubeadm 클러스터의 최신 apiserver 이미지는 셸/`kubeadm` 바이너리가 없는 distroless 라 `kubectl exec ... kubeadm certs check-expiration` 이 항상 실패하는데, 실행 단계·명령·stderr 가 전혀 기록되지 않아 점검 수행로그만 봐서는 원인을 알 수 없었다. `etcd_defrag` 와 동일한 `source: auto|pod|snapshot` 패턴을 적용해 (1) 각 단계(파드 탐색·`kubeadm` 실행·파싱·판정)를 실시간 타임라인으로 노출하고 실패 시 stderr 요약을 단계 상세에 남기며, (2) `source=auto`(기본값) 는 파드 실행 실패 시 `/versions` 화면에서 SSH 로 수집해둔 `kubeadm certs check-expiration` 스냅샷으로 자동 폴백한다. Backend: `POST /api/v1/versions/{cluster_id}/collect-kubeadm-certs`(요청 시에만 SSH 자격증명 사용, 미저장) + `cert_expiry_checker.py` 재작성 + `registry.py` 에 `source`/`snapshot_max_age_hours` params 노출(UI 편집 가능). Frontend: `/versions` 툴바에 "K8s 인증서(kubeadm)" 수집 모달 추가.
- **노드 일괄 실행 — "다른 노드에서 불러오기" 연결 실패 시 상세로그 없이 에러 메시지만 보이던 문제**(`/bulk-exec`): SCP 로 원격 파일을 읽어오는 `fetch_remote_file` 이 접속·stat·read 각 단계를 추적하지 않아, 실패해도 어느 단계(접속/경로 확인/읽기)에서 왜 멈췄는지 화면에서 알 수 없었다. 이제 딥체크와 동일한 단계별 실시간 타임라인(`ExecutionStepsTimeline`)과 명령 추적(`CommandTraceList`)을 결과 영역에 표시한다. `CommandTraceList` 를 batch-jobs 전용 로컬 컴포넌트에서 `components/common/` 공용 컴포넌트로 추출해 재사용.

## [1.23.0] - 2026-08-05

### Added
- **노드 일괄 실행 — SCP 업로드 내용 로컬에 저장**(`/bulk-exec`): "다른 노드에서 불러오기"로 채웠든 직접 입력했든, 현재 업로드 내용을 브라우저 다운로드로 내 컴퓨터에 파일로 저장할 수 있다. 파일명은 업로드 원격 경로의 마지막 세그먼트를 재사용하고, CSV/TXT 내보내기와 달리 BOM 없이 저장해 bash 셔뱅(`#!/bin/bash`) 등 스크립트 실행에 영향을 주지 않는다.

## [1.22.0] - 2026-08-05

### Added
- **노드 일괄 실행 — SCP 업로드 내용을 다른 노드에서 불러오기**(`/bulk-exec`): 로컬 파일 선택과 나란히, 현재 화면에 로드된 노드 중 하나를 골라 원격 경로의 텍스트 파일을 그대로 읽어와 업로드 입력창을 채울 수 있다(가져온 뒤 수정해서 다른 노드들에 재배포하는 흐름에 유용). 업로드 대상에 입력한 인증 정보를 그대로 재사용하고 별도 저장은 하지 않는다. Backend: `POST /api/v1/bulk-exec/fetch-file` + `ssh_runner.fetch_remote_file`(SFTP pull, UTF-8 텍스트·2MB 상한, 바이너리/용량초과는 에러로 반환).

## [1.21.0] - 2026-08-05

### Added
- **노드 일괄 실행 — 사용자별 저장 스크립트**(`/bulk-exec`): bash/python 스크립트를 이름·설명과 함께 저장해두고 목록에서 클릭 한 번으로 불러오거나 수정·삭제할 수 있다. 기존 localStorage 전용 `SavedCommands` 위젯을 이 화면에서 DB 백엔드 라이브러리로 교체 — 다른 브라우저/기기에서도 동일하게 보인다. 명령창 옆 bash/python 토글로 언어를 고르면, python 은 서버가 원격 `python3` 인터프리터로 감싸 실행한다(본문은 그대로 저장·표시, 인증정보는 여전히 저장하지 않음). Backend: `models/saved_script.py`(`SavedScript`, 사용자별 소유권) + `routers/saved_scripts.py`(CRUD) + `services/script_wrap.py`(python 스크립트 → heredoc 변환). Frontend: `components/bulk-exec/{SavedScriptPanel,SavedScriptEditorModal}` + `hooks/useSavedScripts.ts`.

## [1.20.1] - 2026-08-05

### Fixed
- **알림 규칙의 "모듈" 조건이 아무 알람에도 걸리지 않던 문제** (`/alerts` → 알림 규칙):
  모듈 조건이 알람 라벨 중 `module` 하나만 보고 있었는데, Alertmanager 알람에도 사내
  alert-forwarder 페이로드에도 그런 라벨은 사실상 없다. 그래서 모듈 조건을 건 규칙은
  **매칭이 조용히 실패**했고, 운영자에게는 "규칙을 만들었는데 알림이 안 온다"로 나타났다.
  이제 `module` · `job` · `service` · `component` · `app` 순으로 처음 존재하는 라벨 값에
  **정규식 부분 매칭**한다(대개 `job` 이 모듈을 알려준다 — `fluent-bit`, `opensearch` …).
  후보 라벨이 하나도 없으면 통과가 아니라 미매칭으로 처리한다.

### Added
- **알림 규칙 편집 UI 보강** (`/alerts` → 알림 규칙): 그동안 API 로만 설정할 수 있던 두 항목을
  화면에서 편집할 수 있다(CLAUDE.md §UI-First).
  ① **모듈/서비스 패턴** — 어떤 라벨을 보는지 입력 아래에 안내를 함께 표시.
  ② **재전파 채널** — 규칙에 걸린 알람을 기존 알림 채널(Slack/webhook/email)로도 보낼지
  체크박스로 선택. 규칙 목록에도 "재전파" 열과 모듈 조건(`module~…`)이 표시된다.

### Fixed
- **업무 프로비저닝 재시도가 500 으로 실패하던 문제**: Jira 는 이번에 새로 만들고 Confluence 는
  이미 연결돼 있던 상태로 재시도하면 `UnboundLocalError: page_title` 로 500 이 났다. 상호 링크
  단계가 "Confluence 를 이번에 만들었는지"가 아니라 `conf_ok`(이미 연결돼 건너뛴 경우도 True)를
  보고 있었던 탓이다. 이제 **이번 호출에서 실제로 만든 경우에만** Jira Description 에 Confluence
  링크를 덧붙인다 — 이미 연결된 문서 때문에 기존 Description 을 덮어쓰는 PUT 도 더 이상 나가지
  않는다(재시도 멱등성).

### Added
- **Batch Jobs — 단계별 실행 추적 가시화**: 실행 이력·실행 결과 카드에 **실행 단계 타임라인**(kubeconfig 해석 → kubectl 연결·Job 조회 → 대상 선정 → 삭제 / SSH 잡은 명령 조립 → SSH 실행 → 결과 정리)과 **실측 명령 trace**(실제로 나간 kubectl/SSH 명령 + exit code·소요시간·출력 발췌, kubeconfig 경로 마스킹)를 표시 — "어느 단계에서 무엇을 하다 실패했는지"를 로그를 뒤지지 않고 판독. deep check 의 `ExecutionStep`/`ExecutionStepsTimeline` 패턴을 배치잡 프레임워크에 이식(`BatchJobExecutor._step`/`_record_command`/`step_plan`), 실행마다 `batch_job_runs.steps`/`commands`(JSONB)에 영속(실패·예외 경로 포함). Backend: `services/batch_jobs/base.py` + executor 3종 계측. Frontend: `BatchJobLogDetail` 에 타임라인+`CommandTraceList`.
- **Batch Jobs — non-SSH(K8s) 잡 사전 연결테스트**: `POST /batch-jobs/{id}/test-connection` 이 non-SSH 타입을 422 로 거부하던 것을 **K8s 사전 점검**으로 대체 — kubeconfig 해석 → kubectl 바이너리 → 인증 `/healthz` 프로브 → `auth can-i list jobs`(RBAC) 를 단계별 결과로 반환하고, 실행 폼의 "사전 점검" 버튼으로 실행 전 원인 확인 가능.
- **Batch Jobs — cron 상태 색상 인터랙션**: 클러스터 그룹 섹션과 잡 행 테두리를 cron 건강 상태로 착색 — 정상 동작 초록 / 비정상(실패·평가 오류·자격증명 없음) 레드 / 중지·미설정 회색 / 실행 중 블루. 접힌 그룹에서도 상태 dot 로 판독 가능, hover 시 상태색 강조.
- **감사 로그 — batch_job 필터 + details 테이블 보기**: 감사 로그 액션 드롭다운에 `batch_job.*`(패밀리 전체 조회, 백엔드 `action_prefix`/`target_type` 필터 신설)과 개별 6종 액션 추가. 상세(details) 셀은 클릭 시 원문 JSON 대신 **key/value 테이블**로 펼쳐져 긴 페이로드도 판독 가능.

### Fixed
- **연결된 클러스터가 "미연결"로 오진되던 문제 (DailyChecker)**: anonymous-auth 를 끈 하드닝 클러스터는 익명 `/healthz` 프로브에 401/403 을 반환하는데, 일일점검이 200 이 아니면 전부 critical→pending(미연결)으로 판정해 kubectl 인증이 정상인 클러스터도 항상 미연결로 표시됐다. 401/403 을 "도달 가능(인증 필요)"으로 판정하도록 수정하고(등록 검증·HealthChecker 와 기준 통일), 익명 프로브가 완전히 실패하면 **kubeconfig 인증 프로브로 폴백**해 재확인한다. 실패 시에도 원인 힌트(DNS/포트/라우팅/TLS — `services/k8s_diagnose.py`)를 점검 상세에 남긴다.
- **배치잡 연결 실패가 전부 "에러"로 뭉개지던 문제**: k8s_job_cleanup 의 kubectl 실패를 stderr 기반으로 `connect_error`(연결 실패)/`auth_error`(인증·RBAC)/`error` 로 분류하고, headline 에 stderr 첫 줄 + 한국어 원인 힌트를 실어 상태 pill 만 봐도 원인 계열을 알 수 있게 했다.
- **kubeconfig 해석 실패 사유 무표시**: `ensure_kubeconfig_file` 이 사유 없이 None 을 반환해 "kubeconfig 미등록" 한 메시지로 뭉개지던 것을 `resolve_kubeconfig` 로 세분화 — 미등록 / **경로만 등록(DB content 없음 — Compose 워커가 파일을 못 보는 케이스)** / 파일 재생성 실패를 구분해 실행 로그·사전 점검·클러스터 연결 확인에 그대로 노출.

### Changed
- **클러스터 "연결 확인"(verify) 의미 변경**: API 서버는 도달하지만 kubeconfig 가 없거나 인증 불가면 이제 healthy 가 아니라 **warning** 으로 마킹 — "클러스터는 연결됨인데 배치잡·점검은 kubeconfig 미등록 에러" 모순을 해소. Settings 연결 확인 UI 도 한 줄 요약 대신 3개 체크(healthz/kubeconfig 인증/kubectl) 개별 결과를 행으로 표시. (기존에 healthy 로 보이던 kubeconfig 미등록 클러스터는 다음 확인부터 warning 으로 나타남)

## [1.20.0] - 2026-08-04

### Added
- **업무 관리 게시판 — 기본 필터/정렬/검색 강화**: 진입 시 기본으로 **본인 담당 + 현재(2주)
  스프린트** 기준으로 필터되며, "OOO님, 본인 담당 업무 · 'N차 스프린트' 스프린트 기준으로
  필터된 결과입니다" 안내 토스트를 1회 표시한다. "상태"(칸반) 필터 드롭다운과 제목 검색바
  (300ms 디바운스, title/content ILIKE)를 추가했고, 기본 정렬을 시작일 최신순으로 바꿨다.
  - Backend: `GET /work-items`·`/work-items/export/csv` 에 `q` 파라미터(title/content ILIKE)
    추가, `type` 필터 정규식에 누락돼 있던 `build_response` 추가(선택 시 422 나던 버그 수정).
  - Frontend: `StatusFilterDropdown`(TypeFilterDropdown과 동일 패턴), 디바운스 검색 input,
    `useCurrentSprint()` 로 스프린트 기본값 시딩(`?sprint=` 딥링크가 있으면 그쪽 우선).
- **업무 등록/수정 팝업 통일**: 업무 관리 게시판의 "업무 등록"·✏️ 수정 버튼이 홈 "업무 현황"과
  동일한 팝업(`QuickAddTaskModal`)을 쓰도록 통일 — 게시판 전용 별도 등록 폼을 없애 중복 코드를
  줄였다. `QuickAddTaskModal` 에 수정 모드(`initial` prop)를 추가해 같은 디자인/패턴으로 제목·
  시간·우선순위·담당자·클러스터·상태를 수정할 수 있다(유형은 생성 후 불변 정책에 따라 배지로만
  표시). 부분 업데이트(PUT, `exclude_unset`)만 보내 본문(content) 등 이 팝업이 다루지 않는
  필드는 건드리지 않는다 — 리치텍스트 편집 등은 팝업의 "상세 수정" 링크로 이어지는 전체 폼에서.
  - Frontend: `components/dashboard/QuickAddTaskModal.tsx`, `pages/WorkItemBoardPage.tsx`.
- **Jira·Confluence 동시 생성 시 상호 링크**: "Jira 이슈 · Confluence 문서 자동 생성"(provision)
  에서 둘 다 새로 만들면, 기존에도 Confluence 문서 본문에 Jira 링크가 들어갔던 것에 더해
  이제 **Jira Description 끝에도 Confluence 문서 제목·링크**가 자동으로 붙는다(Jira 이슈
  생성 → Confluence 문서 생성 → Jira Description PUT 갱신 순서). 이미 한쪽만 연결된 업무는
  건드리지 않는다.
  - Backend: `routers/jira.py` `provision_work_item` — `JiraService.update_issue()` 로 후속 반영.
- **Jira 가져오기 — 기본 날짜 범위 = 이번주**: "내게 할당"/"프로젝트" 스코프에 "최근 N일
  변경분" 옵션을 추가하고, 모달을 열면 이번주 월요일부터에 해당하는 일수로 기본값을 채운다
  (직접 수정 가능, 비우면 전체 이력). 기존 "조건 조합" 스코프의 동일 옵션과 공유.
  - Backend: `import_issues` 의 me/project JQL 조립에 `updated_since_days` 반영.
  - Frontend: `JiraImportModal.tsx` `daysSinceMonday()` 기본값 + me/project 스코프에도 입력 노출.
- **Confluence 연동 — 검색해서 업무로 가져오기 + 행 단위 동기화**: "Jira 가져오기" 옆에
  "Confluence 연동" 버튼을 같은 패턴(검색 → 선택 → 반영)으로 추가 — Confluence 문서를 검색해
  고른 페이지를 새 업무(유형=기타, category="Confluence")로 게시판에 등록한다. 이미 Confluence
  와 연결된 업무는 게시판 행의 "관리" 열에 새 동기화 버튼이 생겨, 수정한 내용을 Jira "반영"
  버튼과 동일한 방식으로 연결된 Confluence 문서에 재게시(page_id 기준 — 제목이 바뀌어도 같은
  문서 유지)할 수 있다.
  - Backend: `WorkItem.confluence_synced_at` 컬럼 추가, `POST /jira/confluence/link`
    (검색 결과 → 신규 업무 생성), `POST /jira/confluence/sync/{item_id}`(재게시).
  - Frontend: `ConfluenceLinkModal.tsx`(신규), `WorkItemTableRow.tsx` 동기화 버튼,
    `useConfluenceSearch`/`useConfluenceLink`/`useConfluenceSync` 훅.

## [1.19.0] - 2026-08-04

### Added
- **업무 유형에 "구축 대응" 추가**: 이슈 대응/회의/운영 대응/기타 4종이던 선택 가능 업무 유형에
  "구축 대응"(`build_response`)을 추가 — 시스템/인프라 구축 요청에 대응하는 업무를 다른 유형과
  구분해 등록할 수 있다. 업무 등록(QuickAdd 유형 picker)·업무 관리 게시판 유형 필터·CSV
  내보내기 라벨에 자동 반영.
  - Backend: `WorkItemType` Literal 에 `build_response` 추가(DB 는 이미 자유 문자열 컬럼이라
    마이그레이션 불필요), CSV 내보내기 `type_label_map` 에 라벨 추가.
  - Frontend: `WORK_ITEM_TYPE_ORDER`/`WORK_ITEM_TYPE_CONFIG`(`HardHat` 아이콘, amber 톤)에 추가.
- **홈 "업무 현황" — 당일 스케줄 패널에 업무 관리 바로가기 추가**: `DayScheduleBoard`(홈 화면
  좌측 당일 시간단위 스케줄)의 업무 등록 버튼 옆에 "업무 관리"(→ `/tasks-mgmt`) 버튼을 추가해,
  우측 "담당자별 진행 현황" 패널과 동일하게 두 버튼이 나란히 노출되도록 통일. 기존 "등록"
  버튼 라벨도 "업무 등록"으로 명확화.
  - Frontend: `components/dashboard/DayScheduleBoard.tsx`.

## [1.18.2] - 2026-07-31

### Changed
- **업무 현황 — 업무 등록 진입점 통합 + Jira/Confluence 연계**: 홈 화면 업무 현황(work)
  모드에서 동시에 노출되던 두 등록 버튼(당일 스케줄 패널의 "등록" ↔ 담당자별 진행 현황
  패널의 "업무 등록", 서로 다른 팝업으로 각각 열렸음)을 "등록"(`QuickAddTaskModal`) 팝업
  하나로 통합했다. 이 팝업으로 업무를 등록하면 이제 PEP 저장 성공 직후 Jira 연동이
  켜져 있을 때만 Jira 이슈·Confluence 문서 생성 팝업(`JiraProvisionModal`)으로 자동
  전환된다 — 만들지 않고 "나중에"를 누르면 PEP 에만 저장된 채로 끝난다(업무 관리
  게시판의 인라인 등록행이 쓰던 것과 같은 흐름). Frontend:
  `WeeklyStatusTimeline`(중복 버튼·모달 제거), `QuickAddTaskModal`(Jira 단계 체이닝).
- **업무 유형 재정리**: "유형"이 곧 "업무 유형"인데 선택지 안에 "업무"가 들어있던 순환을
  정리해, 새 업무 등록 시 고를 수 있는 유형을 **이슈 대응 · 회의 · 운영 대응 · 기타** 4종으로
  줄였다. 기존 "업무"는 "운영 대응"으로 라벨만 재정의(같은 내부 값 재사용, 데이터 이관
  불필요)했고, "교육"은 선택 목록에서만 제외했다(과거에 교육으로 등록된 항목은 배지·CSV
  라벨 그대로 유지, 신규 등록만 불가). 백엔드 스키마(`WorkItemType` Literal)는 하위 호환을
  위해 변경하지 않았다 — 프론트 표시 라벨과 CSV 내보내기 라벨만 맞췄다.
  Frontend: `workItemKanbanUtils.ts`(`WORK_ITEM_TYPE_CONFIG`/`WORK_ITEM_TYPE_ORDER`).
  Backend: `work_items.py`(CSV export `type_label_map`).

### Added
- **Batch Jobs — 실행 중지(Stop)**: 실행(수동/스케줄/일괄) 후 중지할 방법이 없던 문제를 해소 — 부하/오작동으로 지금 실행 중인 잡을 강제 중지할 수 있다. 수동(동기) 실행은 in-process `CancelToken` 이 SSH 채널/kubectl 프로세스를 직접 닫아 중단하고, 스케줄·일괄(Celery) 실행은 `celery_app.control.revoke(terminate=True)` 로 워커 프로세스를 강제 종료해 프로세스 경계를 넘어 중단한다. 어느 경로든 실제 강제종료 성공 여부와 무관하게 DB 상태(실행 이력·잡 상태)는 항상 `cancelled` 로 정확히 정리되어 "실행 중"에 화면이 갇히지 않는다. Backend: `POST /batch-jobs/{id}/stop`, `services/batch_jobs/base.py` 의 `CancelToken`, `services/active_runs.py`(in-process 레지스트리), `BatchJob.active_task_id`(Celery revoke 대상 추적). Frontend: 배치 잡 테이블 각 행과 슬라이드오버에 "중지" 버튼(위험 확인 다이얼로그 포함).
- **Batch Jobs — 행별 즉시 실행 아이콘**: 잡 상세를 열지 않고도 테이블 행에서 바로 실행할 수 있는 ▶ 아이콘 추가(저장된 자격증명 또는 non-SSH 잡에 한해 활성화) — hover 시 잡 이름·타입·호스트·최근 실행 정보를 툴팁으로 보여준다. 자격증명이 없는 SSH 잡은 비활성화되고 이유가 툴팁에 안내된다.
- **Batch Jobs — cron 상태 시각화**: cron 등록 여부가 실제로 스케줄대로 동작하는지 표에서 판독하기 어렵다는 피드백을 반영 — cron 셀을 색상 코드 배지(등록됨/대기 중/평가 오류/자격증명 없음/꺼짐)로 바꾸고, hover 시 cron 식·활성화 여부·저장 자격증명 상태·스케줄러 최근 평가 결과·최근 실행 시각을 툴팁으로 노출.

## [1.18.1] - 2026-07-30

### Fixed
- **K8S 자원 관리(`/k8s-allocation`) 정확성/안정성 감사 수정**: request/slack 집계가
  네이티브 사이드카(Istio/Linkerd 등 init `restartPolicy: Always`)·init 컨테이너·
  `RuntimeClass` overhead 를 누락해 메시 주입 클러스터에서 여유(slack)가 과대평가되던
  문제를 수정했다. 이 외에 apiserver 5xx/`_continue` 토큰 만료로 절단된 스냅샷이 24시간
  캐시로 확정 데이터처럼 서빙되던 문제(짧은 partial TTL 로 자동 재집계), 행업된 백그라운드
  집계가 새로고침으로도 복구되지 않던 문제(stuck timeout 재시작), 과할당 노드의 음수
  여유(slack)가 초록색 "여유 -8192Mi"로 표시되던 문제, 사용률 배지·%R 색상 판정 기준이
  반올림 vs 원시 비율로 서로 어긋나던 문제, 네임스페이스 비효율 랭킹 정렬이 데이터에
  따라 순서가 흔들리던 문제(비추이적 comparator), 실제 K8s pod-template-hash 알파벳과
  안 맞아 워크로드 개수가 부풀려지던 ReplicaSet 이름 매칭, 한글 클러스터명이 CSV 파일명에서
  전부 `-` 로 뭉개지던 문제, nanocores 서브밀리코어 usage 가 절삭으로 소실되던 문제를 고쳤다.
  Backend: `routers/k8s_allocation.py`(`_pod_effective_resources`, `_strip_hash`, ApiClient
  누수 정리), `services/snapshot_jobs.py`(partial/stuck TTL), `services/k8s_paging.py`(절단 로깅).
  Frontend: `pages/K8sAllocationPage.tsx`(단위 표기·임계값·정렬·CSV·새로고침 스피너/에러 표시).

## [1.18.0] - 2026-07-29

### Added
- **Comfort 테마**: 기존 기본/라이트/다크/시스템에 더해 크림 배경 + 딥그린 액센트 +
  화이트 카드 + 큰 라운딩(16px)의 부드러운 대시보드 톤 테마를 추가했다. 사이드바 하단
  테마 토글로 순환 선택(기본 → 컴포트 → 라이트 → 다크 → 시스템).
  Frontend: `index.css`(`html.comfort` 토큰 블록 + 소프트 카드 섀도), `stores/themeStore.ts`,
  `components/layout/Sidebar.tsx`.

### Changed
- **클러스터 아이콘 빌더 — 운영타입 밴드 라벨 제거**: 아이콘 2층(운영타입) 밴드에서 텍스트
  라벨을 뺐다. 운영 레벨은 밴드 색상만으로 이미 구분되므로, 라벨을 없애 아이콘 안 정보량을
  줄이고 가독성을 높였다(업무명·속성·지역 3개 밴드는 라벨 유지).
  Frontend: `lib/clusterIconBuilder.ts`(`opTypeLabel` 옵션·`suggestOpTypeLabel` 제거),
  `components/common/ClusterIconPicker.tsx`, `pages/SettingsPage.tsx`(일괄 생성).
### Added
- **Confluence 문서 가져오기/내보내기 + 문서 관리 대시보드** (`/documents`): Jira 연동과 같은
  dry-run 프리뷰 → 선택 커밋 방식으로 Confluence 페이지를 문서(WorkGuide)로 가져오고, PEP 에서
  작성/수정한 문서를 같은 페이지의 새 버전으로 게시한다. 문서 테이블(출처·동기화 상태 배지)과
  "AI 검색"(임베딩 시맨틱, 미기동 시 일반 검색 폴백)을 갖춘 대시보드가 사이드바 work 모드의
  신규 "문서 관리" 그룹으로 추가됐고, 기존 지식 화면들(`/work-guides` `/docs` `/ops-notes`
  `/mindmap` `/ontology` `/trends`)도 이 그룹으로 사이드바에 복귀.
  Backend: `routers/confluence.py`(`/confluence/docs/*`), storage-format ↔ 에디터 HTML 변환기
  `services/confluence_storage.py`(code/info/warning/expand 매크로 ↔ 코드블록/Callout/토글),
  `GET /work-guides/search` 시맨틱 검색 + HNSW 인덱스, 가져온 문서 임베딩 자동 계산(LLM 학습
  소스 편입). Frontend: `DocumentsPage` + `components/documents/`, 문서 읽기 화면 게시/재가져오기
  버튼. 가져오기 검색은 Jira 조건 조합처럼 **기여자(contributor)·라벨·최근 수정 기간**으로
  세부 필터링할 수 있고, 기본값은 "본인이 기여한 문서"(`contributor = currentUser()`)다.
- **업무 등록 시 Jira·Confluence 자동 생성 모달 — 전체 등록 경로로 확장**: 목록 하단 인라인
  추가에만 연결돼 있던 자동 생성 흐름을 우측 상단 "업무 등록" 버튼(팝업 등록)에도 연결했다.
  인라인 추가 행은 스크롤 없이 바로 쓸 수 있도록 표 맨 아래에서 **헤더 바로 아래(목록 최상단)로
  이동**.
- **Jira·Confluence 연계 생성 부분 실패 재시도**: 한쪽만 만들어졌을 때(예: Jira 성공,
  Confluence 실패) 이미 성공한 쪽은 건드리지 않고 실패한 쪽만 다시 시도할 수 있다. 결과
  화면이 "다시 시도" 버튼과 함께, 원인이 토큰/세션 문제로 보이면 연결 설정 카드를 그 자리에
  띄워 재연결 후 바로 재시도하게 한다. 업무 관리 게시판에서도 일부만 생성된 행은 Rocket
  아이콘이 노란색으로 남아 클릭 한 번으로 재반영할 수 있다. Backend: `work_items` 에
  `provision_status`/`provision_jira_error`/`provision_confluence_error` 추가해 마지막
  시도 결과를 영속화, `POST /jira/provision` 은 이미 연결된 쪽을 멱등하게 건너뛰고
  401(`auth_failed`)을 반환 신호로 명확히 구분.

- **업무 관리 게시판 필터 개인화 + 상태 필터**: 유형/담당자/우선순위/모듈/스프린트/기간
  필터에 **상태(칸반 상태) 필터**를 추가했고, 마지막으로 쓴 필터 조건을 사용자별로 기억해
  다음 방문 때 그대로 복원한다(`k8s:item-board:filters:{username}`).

### Fixed
- **업무 관리 게시판 필터 바 정렬**: 업무 분류 드롭다운이 별도 컨테이너(좌측 고정)에 있어
  나머지 필터(우측 정렬)와 줄바꿈 시 어긋나 보이던 문제 — 모든 필터를 하나의 `flex-wrap`
  행으로 통일. "업무 분류" 드롭다운과 이름이 겹쳐 혼동을 주던 자유 텍스트 "분류" 필터 제거.

### Changed
- **업무 관리 게시판 컬럼 정리**: "상태"와 "Jira 상태"가 같은 정보(Jira 연결 업무는 "상태" 셀이
  이미 Jira 원본 상태명을 보여줌)라 별도 "Jira 상태" 컬럼을 없애고 "상태" 하나로 병합.

### Added
- **Ontology RAG 확장**: AI 분석·챗봇의 근거 인용(RAG) 대상에 구성변경 영향분석 이력
  (`ontology_events` — `POST /ontology/impact` 로 생성되는, 특정 설정 변경이 온톨로지
  그래프 상에서 얼마나 넓게 영향을 미치는지 계산한 기록)을 추가했다. "과거 이런 구성
  변경이 이런 영향을 미쳤다"는 사내 이력이 이제 네 번째 근거 소스(work_guide/work_item/
  ops_note/ontology_event)로 검색·인용된다. Backend: `OntologyEvent.embedding`
  컬럼(pgvector) + `compute_ontology_event_embedding` Celery 태스크(영향분석 생성 커밋
  직후 큐잉) + `backfill_embeddings` 확장. Frontend: `RagCitation.sourceType` 에
  `ontology_event` 추가, `CitationList` 에 전용 아이콘/라벨(구성변경 영향분석) 표시.
- **K8s 이벤트(kubewatch) 직접 트리거 AI 자동분석**: 지금까지는 알람 파이프라인을
  거친 경우만 자동 분석됐는데, kubewatch 로 수신되는 K8s 이벤트도 알람과 동일한
  범위(scope) 규칙·디바운스·레이트 제한을 거쳐 전용 `llm` 큐로 직접 분석 요청할 수
  있다. Backend: `IncidentAnalysis`/`K8sEvent` 에 `k8s_event_id`/`analysis_id`·
  `analysis_status` 연결 컬럼 추가, 범위 매칭 로직을 `_MatchFields` 로 일반화해 알람/
  K8s 이벤트 양쪽에 공용 적용하고 규칙마다 `sources`(알람/K8s 이벤트 부분집합) 로
  적용 파이프라인을 고를 수 있게 함(레거시 규칙은 필드 없으면 둘 다 적용 — 하위 호환).
  같은 (클러스터,네임스페이스,리소스) 는 두 파이프라인이 공유하는 디바운스 키를 써서
  어느 쪽이 먼저 들어와도 중복 분석되지 않는다. `run_auto_incident_analysis_k8s_event`
  Celery 태스크 + `GET/POST /events/{id}/analysis`,`/analyze` 신설. Frontend: 알람
  인박스와 K8s 이벤트 화면이 공용 `IncidentAnalysisPanel` 컴포넌트를 공유하도록 리팩터링
  (`AlertAnalysisPanel`/`K8sEventAnalysisPanel` 은 얇은 래퍼), K8s 이벤트 목록의 펼침
  행에 AI 분석 패널을 부착. Settings → AI/LLM 의 자동 분석 범위 규칙 테이블에 소스
  선택(알람/K8s 이벤트) 체크박스 열 추가.
- **AI 챗봇 SSE 토큰 스트리밍**: `/agent/chat/stream` 신설 — 답변을 토큰 단위로
  실시간 전송해 챗봇 응답 체감 속도를 개선한다. 게이트웨이에 `chat_stream_for_purpose`
  추가(Ollama NDJSON / OpenAI-호환 SSE 델타 파싱, 마스킹·사용량 통계 재사용). fallback
  규칙: 델타가 아직 하나도 안 나간 상태에서 primary 가 실패하면 다음 프로필로 넘어가고,
  이미 일부를 보낸 뒤 끊기면 그 자리에서 종료한다(중간에 다른 LLM 으로 갈아타 앞뒤가
  안 맞는 답변이 되는 것을 방지). `AgentChat.tsx` 는 인증 fetch+reader 로 SSE 를 소비하고
  (PodLogStream.tsx 와 동일 패턴), 스트림 시작 자체가 실패하면 기존 비스트리밍
  `/agent/chat` 으로 자동 폴백한다. 대화 저장·RAG 인용·정보요청 파싱은 기존 로직 재사용.
- **무실행 보증 강화 + 배포/폐쇄망 반입 (Phase 4)**: LLM 파이프라인이 실행 경로(SSH/
  kubectl exec/플레이북/일괄 실행)와 구조적으로 격리돼 있음을 CI 회귀 테스트로 고정
  (`test_no_execution_guard.py` — AST import 그래프 + `AnalysisResult` 필드 계약).
  프롬프트로 나가는 로그/컨텍스트에서 Bearer 토큰·비밀번호·AWS 키·PEM·kubeconfig
  JWT 등을 게이트웨이 진입점에서 일괄 마스킹(`services/llm/masking.py`, 과잉 마스킹
  회귀 테스트 포함). 배포: Helm 차트에 Ollama Deployment/Service(+선택적 PVC)와
  LLM 전용 Celery 워커 템플릿 추가(이전엔 values 만 있고 실제 배포 안 됨), configmap/
  secret 에 `OLLAMA_*`/`LLM_API_BASE`/`LLM_API_KEY` 방출, 기본 모델을 pre-baked
  이미지와 일치하는 `qwen2.5-coder:7b` 로 수정. `deploy-airgap.sh` 가 Ollama 이미지도
  미러링(이전엔 backend/frontend 만 다뤄 수동 반입 필요했음). GPU 서빙(vLLM) 과 Ollama
  모델 영속화(PVC)는 opt-in kustomize component(`k8s/components/{vllm-gpu,ollama-pvc}`)
  로 제공 — base 오버레이는 무변경.
- **AI 근거 인용(RAG) + 정보요청 루프 + 대화 지속 챗봇 (Phase 3)**: AI 분석·챗봇
  답변에 사내 지식(작업 가이드·업무 이력·운영 노트) 근거를 pgvector 유사 검색으로
  인용한다 — 클릭 가능한 딥링크 + 유사도 표시, 근거 없는 내용은 '(추정)' 표기 지시.
  컨텍스트가 부족하면 AI 가 구조화된 정보요청(코드/이력/로그/설정)을 보내고,
  **운영자가 칩 UI 로 직접 제공** 한다(자율 실행 없음 — 무실행 보증 유지;
  트러블슈팅 이력은 `GET /llm/rag-search` 사내 검색 모달로 첨부). 챗봇은 한국어
  UI 로 전면 개편 — 마크다운 렌더, 서버 저장 멀티턴 대화(목록/이어가기/삭제),
  화면별 접근 제어 게이트 적용. Backend: `rag_service`, `ops_notes.embedding`
  (+`compute_ops_note_embedding`/`backfill_embeddings` — llm 큐), `response_parser`,
  `agent_conversations`/`agent_messages` 테이블(보존 180일), 분석 결과 `citations`.
  Frontend: `CitationList`, `InfoRequestChips`, `AgentChat` 개편.
- **알람 AI 자동 분석 — 범위 지정 점진 롤아웃 (Phase 2)**: 알람(`/alerts`) 수신 시
  운영자가 정의한 범위 규칙(클러스터/네임스페이스/알람명 패턴/최소 심각도, priority
  first-match)에 매칭되면 AI 장애 분석을 자동 실행하고 결과를 알람 행 확장에 표시한다
  (원인 분석·조치 가이드 — **실행 권한 없음, 사람이 수행**). 부하 제어: 전용 Celery
  `llm` 큐(워커 분리, concurrency 1)·Redis 디바운스·규칙별/전역 시간당 상한, 기본
  전부 꺼짐(운영자가 사용량 대시보드를 보며 점진 확대). 수동 분석/재분석 버튼(operator+),
  분석 백엔드·프로필(analyzed_by) 투명 표기. Backend: `incident_analyses` 테이블,
  `alert_events.analysis_id/analysis_status`, `analysis_hook`(scope 매칭)·
  `incident_context_builder`, `run_auto_incident_analysis` 태스크, retention/backup 등록.
  Frontend: `AlertAnalysisPanel`, Settings AI/LLM 탭에 분석 범위 규칙 편집기.
- **폐쇄망 LLM 이중 운용 — 프로필 × 용도 라우팅 게이트웨이 (Phase 1)**: 사내 OpenAI-호환
  LLM 서비스와 인클러스터 Ollama 를 동시에 등록하고, 기능별(챗봇/장애분석/점검리뷰/
  아키텍처문서/트렌드/임베딩)로 어느 LLM 을 쓸지 UI 에서 라우팅한다(primary 실패 시
  fallback 자동 전환). Settings 에 **AI / LLM 탭** 신설 — 프로필 CRUD·연결 테스트·용도별
  라우팅·분석기 백엔드 선택·API 키 암호화 저장(`llm_credentials`)·최근 24h 사용량
  (호출/오류/지연/토큰) 가시화. 시스템 프롬프트 한국어 기본화.
  Backend: `services/llm/` 게이트웨이 신설, 기존 5개 Ollama 하드코딩 호출부
  (`agent_service`/`local_llm_analyzer`/`embedding_service`/`trends summarizer`/
  `architecture_doc_service`) 이관, `ANALYZER_BACKEND` raw env → AppSetting
  `llm_settings` 로 이동(UI-First), `routers/llm_settings.py` 신설.
  Frontend: `LlmSettingsTab.tsx`, `useLlmSettings.ts`, `llmApi`.

## [1.17.1] - 2026-07-29

### Fixed
- **Deep check 실행이 여전히 500 (`ai_status` NotNullViolation, 심각)**: 스키마 점검이
  `missing_column`/`not_null_drift` 두 종류만 감지해 이 케이스를 놓쳤다 —
  `deep_check_results.ai_status` 는 **모델에 존재한 적조차 없는** 컬럼인데 운영 DB 에만
  NOT NULL + 기본값 없이 남아 있어, ORM 이 값을 채울 방법이 없어 그 테이블의 **모든 저장**이
  실패했다(기존 두 드리프트 종류는 "모델 → DB" 단방향 비교라 모델에 없는 DB 전용 컬럼은
  스캔 대상 자체가 아니었다). `orphan_not_null_column` 드리프트 종류를 신설해 모델에 없는
  DB 전용 컬럼 중 NOT NULL + 기본값 없음인 것을 별도 스캔하고, 부팅 자동 복구·Settings ▸
  스키마 점검 화면·수동 복구 API 모두에서 기존 NOT NULL 드리프트와 동일하게 처리한다
  (컬럼 자체는 삭제하지 않고 제약만 완화 — DROP COLUMN 은 여전히 하지 않는다).
- **점검 항목 삭제 실패 (심각)**: 항목을 지우면
  `null value in column "item_id" of relation "check_matrix_runs"` 로 실패했다.
  `CheckMatrixSchedule`/`Result`/`Run` 의 `item` 관계에 `passive_deletes=True` 가 빠져 있어,
  SQLAlchemy 가 DB 의 `ON DELETE CASCADE` 를 쓰지 않고 자식 행의 `item_id` 를 NULL 로
  UPDATE 하려 한 것이 원인(코드베이스가 `cluster` 쪽에는 이미 적용해 둔 패턴인데 `item`
  쪽만 누락). 세 관계 모두 수정 — 이제 자식 정리는 DB CASCADE 가 담당한다. 회귀 테스트 추가.
- **스키마 자동 복구가 조용히 실패하던 문제**: NOT NULL 완화 DDL 은 ACCESS EXCLUSIVE 락이
  필요한데, 운영 중에는 Celery 워커/API 가 같은 테이블을 쓰고 있어 락을 못 잡을 수 있다.
  기존에는 무제한 대기(부팅 정지 위험)하거나 실패해도 로그 한 줄만 남아 운영자가 알 수
  없었다. `lock_timeout` + 재시도를 걸고, **부팅 자동 복구 결과(감지 대상·완화 건수·실패
  사유)를 Settings ▸ 스키마 점검 화면 상단에 노출**한다 — "재시작하면 자동으로 고쳐진다"가
  실제로 지켜졌는지 로그 없이 확인할 수 있다.

### Added
- **업무 게시판 Jira 기준 레이아웃** (`/tasks-mgmt`): 가져온 이슈를 Jira 에서 보던 것과 같은
  축으로 표에 펼친다 — **Epic · 이슈 종류(Epic/Story/Task/Sub-task/Bug) · Jira 원본 상태 ·
  컴포넌트 · 라벨** 컬럼이 추가됐고(기본 숨김, 컬럼 설정에서 켠다), Jira 연결 업무의 상태
  셀은 칸반 5단계로 축약하지 않고 **Jira 상태명 그대로** 보여준다(점 색은 `statusCategory`
  기준이라 커스텀 워크플로에서도 의미가 유지된다). Epic 셀은 `DL-12 제목` 박스로 렌더되고
  키가 Jira 로 링크된다. 가져오기가 Jira component 를 업무 분류로 매핑해 주간보고 진척률의
  `category × Epic` 축도 제대로 잡힌다(이전에는 전부 "Jira" 로 들어갔다).
  Backend: `models/work_item.py`(jira_epic_key/epic_summary/issue_type/parent_key/
  parent_summary/status_category/components/labels), `services/jira_service.py`,
  `routers/jira.py`(`_jira_sync_values`). Frontend: `workItemColumns.ts`, `WorkItemTableRow.tsx`.
- **제목 옆 Confluence 문서 박스**: Jira 키 박스 옆에 문서 링크 박스(`DocLinkChip`)가 붙는다.
  링크가 없으면 점선 `＋문서` 버튼이 되고 클릭하면 그 자리에서 URL 을 입력·저장한다(상세
  화면까지 들어갈 필요 없음). Jira 가져오기는 이슈 본문에서 설정된 Confluence Base URL 로
  시작하는 링크를 찾아 자동으로 채우고(행 단위 재가져오기는 원격 링크도 조회), **사용자가
  직접 넣은 링크는 덮어쓰지 않는다**.
- **업무 등록 → Jira·Confluence 연계 생성 확장**: 생성 조건에 **Epic 키**와 **상위 이슈
  (Sub-task)** 가 추가돼 task = Epic, sub task = Epic 아래 이슈로 만들 수 있다. 프로젝트 ·
  이슈 종류 · 우선순위 · 라벨 · 컴포넌트 · Epic · 저장 위치는 **사용자별로 기억**되어 다음
  등록에서 자동으로 채워진다(모달에서 언제든 수정, 체크박스로 저장 해제 가능).
  Backend: `routers/jira.py`(`user_settings` 의 `jira_provision_preset`).
- **게시판 기본 필터 = 로그인 사용자**: 처음 들어오면 내 담당 업무만 보인다. 상단 "내 업무"
  토글로 전체 보기로 바꿀 수 있고 그 선택은 브라우저에 기억된다.

- **Jira 연결 복구 — 해제 · 변경 · 연결 점검**: Jira 에서 이슈를 직접 지웠거나 잘못된
  프로젝트에 만들었을 때, PEP 에 남는 죽은 링크를 화면에서 정리할 수 있다. 게시판 행의
  **Jira 연결 관리** 버튼에서 (1) 연결만 해제 (2) 다른 이슈로 연결 변경 (3) 연결 해제 +
  업무 삭제 를 고를 수 있고, 다시 가져오기가 "Jira 에 없음"으로 끝나면 이 창이 사유와 함께
  자동으로 열린다. 가져오기 팝업의 **연결 점검** 탭은 내 업무의 Jira 연결을 한 번에 확인해
  죽은 링크를 골라 일괄 정리한다.
  - 연결을 해제하면 `jira_issue_key` 가 비어 **Jira·Confluence 자동 생성이 다시 열린다** —
    잘못된 프로젝트에 만든 이슈를 지우고 올바른 곳에 재생성하는 흐름이 이걸로 완성된다.
  - 연결 변경은 **Jira 에서 실제로 조회해 존재를 확인한 뒤에만** 반영한다(또 다른 죽은 링크
    방지). 이미 다른 업무가 쓰는 키는 거절한다.
  - 이슈를 못 찾아도 **자동으로 정리하지 않는다** — 조회 권한이 없어도 Jira 는 똑같이 404 를
    주므로, 삭제인지 권한 문제인지는 사용자가 판단한다.
  Backend: `routers/jira.py` `POST /jira/{unlink,relink,verify-links}` ·
  `_clear_jira_link()`/`_parse_issue_key()` · `services/jira_service.py`(404 에 `missing` 플래그).
  Frontend: `components/work-items/JiraLinkDialog.tsx`, `JiraImportModal.tsx`.

### Fixed
- **Jira 링크를 수동으로 고쳐도 아무 일이 없던 문제**: 업무 수정 폼의 "Jira 링크"는 표시용
  URL 일 뿐이고 실제 연결은 `jira_issue_key`/`jira_issue_id` 가 쥐고 있어서, URL 만 바꿔도
  칩·재가져오기·중복 판정이 모두 예전 이슈를 계속 봤다. 연결된 업무는 이 입력을 읽기 전용으로
  바꾸고 연결 관리로 안내한다(실제 변경은 검증을 거치는 연결 변경으로만).
- **연결 해제 시 Jira 필드가 일부만 지워지던 문제**: `DELETE /jira/issue/{key}` 가 5개 필드만
  비워 Epic·컴포넌트·라벨 잔재가 남았다. `_clear_jira_link()` 로 모아 전부 정리한다.
- **업무 등록 팝업 레이아웃**: 시작일/완료일 입력 버튼이 옆 select/input 보다 커서 한 줄
  그리드가 어긋나던 문제 수정(`DateTimePicker` 에 `size="sm"` 추가, 지우기 버튼 자리를
  값 유무와 무관하게 유지해 폭이 밀리지 않게 함). 공통업무 체크박스 옆 긴 설명 문구는
  툴팁으로 옮겨 두 칸을 잡아먹지 않게 했다.
- **`work_items.confluence_url` 중복 선언 제거**: 같은 컬럼이 모델에 두 번 정의돼 있었다.

### Fixed
- **웹 터미널에서 Ctrl+C 복사 / Ctrl+V 붙여넣기가 되지 않던 문제** (노드 SSH 터미널 ·
  k9s 콘솔 · 파드 exec 터미널): xterm.js 는 `Ctrl+<문자>` 를 제어문자로 바꾼 뒤 브라우저
  기본 동작을 취소해, `Ctrl+C` 는 선택 영역을 복사하지 않고 SIGINT 만 보내고 `Ctrl+V` 는
  `^V`(`\x16`) 가 셸에 입력됐다. 이제 **드래그로 선택한 뒤 Ctrl+C 로 복사**(선택이 없으면
  기존대로 SIGINT — 복사 직후 선택은 해제되어 연속 Ctrl+C 로 중단 가능)하고 **Ctrl+V 로
  붙여넣기**할 수 있다. macOS 는 ⌘C/⌘V 를 쓰고 Ctrl+C 는 항상 SIGINT 로 남는다.
  터미널 헤더에 단축키 안내도 표시된다.
  구현: `lib/terminalClipboard.ts` — 브라우저 기본 복사/붙여넣기에 위임하므로
  `navigator.clipboard`(HTTPS 전용 API)가 없는 **HTTP(NodePort) 접속 환경에서도 동작**한다.

### Changed
- **etcdctl 콘솔 레이아웃을 mc 클라이언트와 통일** (`/etcdctl`): 실행 결과가 화면 **아래로**
  붙던 것을 **우측 컬럼으로** 옮겼다. 타겟(2) : 실행 구성(3) : 결과(5) 10-컬럼 그리드로,
  컨트롤과 로그를 한 화면에서 나란히 보며 인자를 고쳐가며 반복 실행할 수 있다. 결과 패널은
  실행 전에도 같은 자리에 플레이스홀더로 있어 레이아웃이 흔들리지 않고, 스크롤은 패널
  내부에서만 일어난다(상태 배지 헤더는 sticky). 좌측 `ClusterSidebar` 여백도 mc 와 동일하게
  flush 로 맞췄다.

### Fixed
- **클러스터 관리 목록 기능 버그 일괄 수정** (`/cluster-manage`, DESIGN.md D-041~D-044·D-048):
  ①표의 인라인 편집(지역/운영레벨/INTERNAL_IP/Pod·Svc CIDR)에서 값을 지워 저장하면 이제
  실제로 해제된다(빈 입력을 `null` 로 전송 — 이전엔 `undefined` 가 직렬화에서 사라져 30초 뒤
  옛 값이 되살아났음) ②인라인 편집·커스텀 컬럼 저장 실패가 토스트로 고지되고, 커스텀 컬럼은
  편집 진입 시점의 서버 값으로 초기화돼 낡은 값 덮어쓰기가 사라짐 ③목록 로딩/조회 실패를
  "등록된 클러스터가 없습니다" 로 위장하던 것을 skeleton·오류(사유+다시 시도)·빈 상태 3분기로
  분리 ④검색/필터 중 카드 드래그 시 가려진 클러스터의 순서가 오염되던 것을 전체 목록 기준
  재정렬로 수정 ⑤클러스터 삭제를 native `confirm` 대신 `ConfirmDialog`(연쇄 삭제 범위 명시)로
  게이팅하고, 노드 IP 일괄 수집에 실행 전 확인(대상 수·갱신 범위)+진행률(n/N)+중단 버튼+
  실패 구분 토스트를 추가. Frontend: `ClusterManagePage`, `ClusterTableRow`,
  `ClusterCustomCell`, `useCluster`/`api` 타입에 null 해제 반영.
- **클러스터 관리 목록 인터랙션 버그 수정** (`/cluster-manage`, DESIGN.md D-045~D-047):
  ①드래그 순서 변경을 수동 정렬 모드에서만 활성화(이름/상태순에서는 드롭이 즉시 재정렬돼
  되돌아간 것처럼 보였음)하고, **테이블 뷰에도 행 드래그를 추가**(수동 정렬 시 이름 셀
  좌측 그립) — 카드 뷰에서만 가능하던 수동 정렬 수단이 양쪽 뷰에서 동작 ②이름 표준화
  모달이 30초 자동 리페치마다 입력·완료 표시를 초기화하던 문제 수정(열려 있는 동안 편집
  보존) ③클러스터 정보 수집(auto-update)을 여러 클러스터에서 동시에 실행 가능 —
  클러스터별 스피너/중지가 독립 동작하고, 다른 클러스터의 늦은 응답이 열려 있는 변경
  미리보기를 덮어쓰지 않음(토스트 안내). Frontend: `ClusterManagePage`,
  `ClusterTableRow`(행 `useSortable`), `ClusterCard`, `StandardizeClusterNamesModal`.

### Changed
- **클러스터 관리 목록 디자인·접근성 정비** (`/cluster-manage`, DESIGN.md D-049~D-053):
  ①고정 팔레트 115곳을 테마 토큰으로 전환(상태색 `status-*`, 범주색 `chart-*`) — 특히
  bond0/bond1 IP 가 다크 테마에서, 상태 배지가 라이트 테마에서 저대비로 보이던 문제 해소
  ②검색/필터 패널·표 컨테이너를 `MacCard` 로 통일 ③**표 헤더 고정(sticky)** 과 셀 클리핑
  추가 — 13열 이상 표를 스크롤해도 헤더가 남고, 컬럼을 좁혀도 내용이 옆 칸으로 넘치지 않음.
  페이지 헤더는 좁은 폭에서 줄바꿈, 카드 그리드는 좁은 폭 가로 오버플로 제거
  ④인라인 편집·순서 변경 진입점이 키보드 포커스에서 보이고, 아이콘 버튼에 클러스터명이 담긴
  `aria-label` 부여, 그룹 헤더 이모지를 아이콘+텍스트로 교체 ⑤**검색/필터/정렬/그룹/뷰모드가
  URL 에 저장**돼 새로고침·공유·뒤로가기에서 유지되고, 빈 상태·조회 실패·검색 무결과가 공용
  `EmptyState` + 실행 버튼(클러스터 등록/다시 시도/필터 초기화)으로 통일. CIDR 겹침 판정의
  옥텟 검증(`999.x` 같은 잘못된 값 배제)과 배지 문구("겹침 클러스터 N개")도 정정.
  Frontend: `ClusterManagePage`, `cluster-manage/*`, `versions/NodeNicsCollectModal`,
  공용 `DoubleScrollX`(`bodyClassName` prop 추가).

## [1.17.0] - 2026-07-29

### Added
- **노드 SSH 터미널** (`/node-ssh`): 클러스터의 **개별 노드에 SSH 로 붙어 로그인 셸을 그대로**
  웹 터미널로 쓴다. 노드 목록(이름/IP 검색·Ready·master 배지)에서 클릭으로 대상을 고르고
  비밀번호 또는 Private Key 로 접속하며, 터미널을 열기 전 **연결 테스트**로 자격증명만 먼저
  확인할 수 있다. 접속 후 실행할 명령(`sudo -i` 등) 지정, 드래그·리사이즈 되는 플로팅 창,
  별도 브라우저 창으로 빼기를 지원한다. tty + resize 라 `journalctl`·`top`·`vi` 같은 인터랙티브
  명령도 동작한다. 클러스터 밖 서버도 수동 host 입력으로 접속 가능.
  Backend: 라우터 `node_ssh.py`(WS `/node-ssh/session` + REST `/node-ssh/test`), 감사 로그
  `node.ssh.open`/`node.ssh.close`, `PEP_NODE_SSH_ENABLED=false` 로 비활성화.
  Frontend: `NodeSshPage`/`NodeSshPopupPage`, 노드 목록은 mc·노드 일괄 실행과 같은
  `node-list` 엔드포인트 재사용.

### Changed
- **SSH 웹 터미널 공용화**: k9s 콘솔과 노드 SSH 터미널이 같은 base 툴을 쓰도록 정리했다 —
  백엔드 `services/ssh_pty.py`(WebSocket↔paramiko PTY 브리지·init 프레임·토큰 검증),
  프론트 `components/k8s/SshTerminalWindow.tsx`(xterm 창)·`lib/terminalPopout.ts`(창 간 handoff).
- **SSH 터미널에 터미널 Appearance 적용**: k9s·노드 SSH 터미널의 색상/글꼴이 Settings →
  터미널 Appearance 의 활성 프로파일(개발/운영)을 따른다(기존에는 고정 팔레트). 세션이 열린
  상태에서 프로파일을 바꿔도 즉시 반영된다.

## [1.16.4] - 2026-07-28

### Added
- **Observability 지표 대시보드** (`/observability`): 클러스터에 깔린 관측 스택의 개별 지표를
  **dense 리스트 테이블**로 한 화면에서 훑는다. `kube-prometheus-stack` 부터 지원하며
  Prometheus 서버·Alertmanager·exporter·operator·알람규칙 5개 카테고리 30여 개 지표가 기본
  등록된다. 지표 / 알람 규칙 / 스크레이프 타겟 / 발화중 알람 4개 뷰를 탭으로 전환한다.
  지표 목록·PromQL·임계값은 전부 DB 행이라 **운영자가 화면에서 직접 편집**할 수 있어,
  배포마다 다른 job 라벨도 코드 수정 없이 맞출 수 있다(`alert-forwarder`/`opensearch-stack`/
  `fluent-operator` 모듈도 지표를 추가하면 그대로 활성화된다). PEP 에서 클러스터 Prometheus 에
  닿지 않는 환경을 위해 **pull(직접 조회) / push(in-cluster 수집기 스냅샷)** 두 수집 모드를
  클러스터별로 고를 수 있고, 화면에 실시간/스냅샷 신선도를 표시한다.
  Backend: `routers/observability.py`, `services/alertmanager_service.py`,
  `services/observability/catalog_seed.py`, `models/observability.py`,
  `PrometheusService.{rules,active_alerts,targets,tsdb_status}`.
  Frontend: `pages/ObservabilityPage.tsx`, `components/observability/`.
- **인시던트 알람 PEP 수신 + 알람 인박스** (`/alerts`): 그동안 사내 메신저(cube)로만 가던
  인시던트 알람을 PEP 도 함께 받는다. **Alertmanager webhook 과 사내 alert-forwarder 를 모두
  수용**하며(표준 v4 포맷 우선, 임의 JSON 은 generic 파서가 정규화), 수신 엔드포인트는
  `ALERT_INGEST_TOKEN` Bearer 로 **fail-closed**(미설정 시 503)다. 같은 알람이 반복 수신되면
  행이 늘지 않고 반복 수(×N)만 올라가고, firing → resolved 상태 전이도 반영된다. 화면에서는
  심각도를 색 바·배경 그라데이션·글자 굵기로 구분하고, 확인(ack)·일괄 확인·원본 페이로드
  열람을 제공한다. 상단의 "알람 수신 설정 방법" 안내에서 Alertmanager receiver YAML 을 그대로
  복사해 붙여넣을 수 있다.
  Backend: `routers/observability.py`(`ingest_router`), `services/observability/alert_ingest.py`,
  `models/alert_event.py`. Frontend: `pages/AlertInboxPage.tsx`.
- **알림 라우팅 규칙 + 중복 억제** (`/alerts` → 알림 규칙): 알람을 **전체 브로드캐스트 /
  담당자 지정 / 알림 없이 인박스만** 중에서 고를 수 있고, 클러스터·알람명·네임스페이스·라벨·
  최소 심각도 매처로 규칙을 만들어 담당자를 매핑한다. **중복 억제**로 같은 알람이 창(기본 5분)
  안에서 쏟아져도 개인 알림은 1건만 생성되며, 요약 모드는 기존 알림 문구를 "최근 5분간 10회"로
  갱신한다. 규칙에서 심각도 재정의도 가능하다. 전역 기본값(알림 대상·최소 심각도·억제 창·
  보존일)은 Settings 없이 같은 화면에서 편집한다.
  Backend: `models/alert_notify_rule.py`, `services/observability/alert_router.py`.

### Fixed
- **전체 공지 알림이 아무에게도 보이지 않던 문제**: `recipient="all"` 공유 행으로 만든 알림을
  조회 쪽(`notifications._me_ids`)이 매칭하지 않아, critical K8s 이벤트 알림이 실제로는 누구의
  알림 종에도 뜨지 않았다. 이제 생성 시점에 **활성 사용자별 개인 행으로 팬아웃**한다
  (`services/user_notify.notify_broadcast`) — 읽음 처리도 개인별로 정확히 동작한다.
### Changed
- **Settings 서비스 설정 통합 — "서비스 카테고리" 탭 폐지, "관리 서비스"로 일원화**: 서로
  중복되던 두 탭을 하나로 합쳤다. 최상위 "서비스 카테고리" 탭이 사라지고, "관리 서비스" 탭이
  **PEP 서비스 / APP 서비스** 두 탭으로만 구성된다. 각 탭 안에서 해당 도메인의 카테고리와
  서비스 타입을 한 화면에서 관리하므로, 카테고리를 만들려고 다른 탭으로 이동할 필요가 없다.
  기존 "서비스 타입" / "서비스 카탈로그" 서브탭 구분도 제거했다. 레거시 딥링크
  (`?tab=service`, `?tab=service-categories`)는 `?tab=mgmt-service` 로 리다이렉트된다.
  Frontend: `ServiceCategoryManager`/`LakeServiceTypeManager` 가 `domain` prop 을 받도록 변경,
  각 컴포넌트 내부의 도메인 탭·도메인 select 제거.
- **서비스 카탈로그를 PEP 서비스로 머지**: 서비스 아이콘·색상 정의가 `ui_settings.serviceCatalog`
  와 PEP 서비스 타입 두 곳으로 갈라져 있던 것을 **PEP 서비스 한 곳**으로 합쳤다. `/services`
  지식 카탈로그와 업무/이슈의 서비스 태그가 이제 PEP 서비스의 아이콘·색상을 그대로 사용한다.
  이름이 겹치던 서비스(Kubernetes/Keycloak/Nexus/Prometheus/Grafana/Cilium)는 PEP 서비스 쪽
  정의로 통일하고 색상만 이어받으며, 카탈로그에만 있던 Jenkins/ArgoCD/etcd/Hubble/Ingress/
  Storage 는 PEP 서비스에 자동 추가된다. Backend: `lake_service_types.color` 컬럼 추가,
  부팅 시 1회성 머지(`_merge_service_catalog_into_pep_types`), `ui_settings.service_catalog`
  필드 폐지.

## [1.16.3] - 2026-07-28

### Added
- **주간보고 진척률 표**: 전체 요약 아래에 `category(component) × task(Epic)` 단위 진척률을
  추가했다 — 계획진도율(일정 경과 기준) · 실적진도율(완료 비율) · 달성률(실적/계획) · 완료/
  진행중/전체 Task 수. 표 위에 **Jira WBS 간트 차트 링크**(설정값)를 노출한다. Epic 수집을 위해
  `work_items.jira_epic` 컬럼과 관리자 설정 `jira_epic_field`(Epic Link 커스텀 필드 ID)를 추가.
- **업무 등록 시 Jira·Confluence 자동 생성**: 업무를 만들면 곧바로 Jira 이슈와 Confluence
  문서를 함께 생성할 수 있다(`GET /jira/provision/defaults`, `POST /jira/provision`).
  프로젝트/이슈종류/우선순위/컴포넌트/라벨과 Confluence 스페이스·상위 페이지·제목은 **사용자
  정보와 설정으로 기본값이 채워지고 모두 수정 가능**하며, 한쪽만 만들 수도 있다. 생성된
  Confluence 문서에는 담당자·일정·Jira 링크가 들어간 기본 골격이 들어간다. 미연결 업무는
  게시판 행에서도 바로 생성할 수 있고, 결과는 `work_items.confluence_url` 에 연결된다.
- **Jira 이슈 칩 표시**: 표에서 이슈를 평문 대신 **키(링크) · 제목 · 상태**가 한 덩어리인 칩으로
  보여준다(주간보고 상세/진척률 표 적용).

### Changed
- **주간보고 task/sub task 매핑 정정**: `task` = Jira **Epic**, `sub task` = 그 Epic 아래 이슈로
  바로잡았다(기존에는 업무 제목/조치 내용이 들어갔다).
- **가져오기 중복 정정**: `jira_issue_id` 로 못 찾으면 **이슈 키(DL-#) 기준**으로 기존 행을 찾아
  덮어쓴다 — Excel 등으로 먼저 들어와 ID 가 없던 잘못된 행이 중복 생성되지 않고 정정된다.

### Added
- **내 Jira 연결 카드** (`JiraConnectCard`): 개인 세션 쿠키·PAT 등록을 **가져오기 팝업에서 바로**
  할 수 있다. 자격증명은 원래 사용자별이지만 등록 UI 가 관리자 화면에만 있어 일반 사용자가
  찾지 못하던 문제를 해결한다. 저장 시 자동으로 연결 테스트까지 수행하고, 접이식 **연결 가이드**
  (F12 ▸ Network ▸ Cookie 헤더 전체 복사, `이름=값` 형식 경고, PAT 발급 안내)를 포함한다.
  Settings 의 수동 등록 영역도 같은 컴포넌트를 쓰도록 바꿔 동작이 갈리지 않는다.
- **가져오기 조건에 프로젝트 다중 지정**: 프로젝트도 쉼표로 여러 개 지정할 수 있어 프로젝트·
  컴포넌트·라벨을 **개별 또는 조합**으로 쓸 수 있다.
- **실행된 JQL 노출**: 가져오기 결과·미리보기에 실제로 Jira 에 보낸 JQL 을 표시해 조건이
  의도대로 적용됐는지 화면에서 바로 확인할 수 있다.
- **업무 게시판 행 단위 Jira 동기화**: 각 행에서 **Jira 에서 다시 가져오기**(`POST /jira/refresh/{item_id}`,
  변경 필드만 갱신하고 결과를 토스트로 안내)와 **수정 내용 Jira 로 보내기**를 바로 실행할 수 있다.
- **주간보고 화면 개편**: 표 3종을 세로 스크롤 대신 **탭**으로 분리하고, 필터바에 구분(component)·
  담당자·상태·검색을 추가했다(요약 숫자도 필터 결과 기준으로 재계산). 상세/담당자 표는 **컬럼
  헤더 클릭 정렬**을 지원한다.
- **Jira Excel·붙여넣기 가져오기를 가져오기 팝업에 통합**하고 사이드바 메뉴에서 제거했다
  (전용 페이지는 "전체 표로 자세히 보기" 링크로 유지).

### Changed
- **가져오기 완료 후 UI**: 확정 가져오기가 끝나면 입력 폼 대신 **결과 요약만** 보여주고
  `다시 가져오기` / `닫기` 버튼으로 전환한다.

### Added
- **주간보고 자동 생성 + Confluence 게시** (`/weekly-report`): 한 주(월~금)의 업무를 집계해
  ① 전체 요약(전체/진행중/완료/지연/비고) ② 구분별 상세(구분·task·sub task·시작일·종료
  예정일·종료일·상태·이슈·비고) ③ 담당자별(task·담당자·주요 추진업무·issue 요약) **3개 표**로
  보여주고, 그대로 Confluence 페이지로 게시한다. 저장 위치(스페이스·상위 페이지·제목)는 게시
  때마다 바꿀 수 있고, 같은 제목이면 새 버전으로 갱신된다. 관리자는 cron(기본 금 17:00)으로
  **자동 생성·게시**를 켤 수 있다. Backend: `services/weekly_report_service.py`,
  `POST /jira/weekly-report/{preview,publish}`, `GET/PUT /jira/weekly-report/settings`,
  Confluence `upsert_page()`, Celery `weekly-report-dispatcher`.
- **Jira 다중 조건 가져오기**: 프로젝트 키에 더해 **라벨 · 컴포넌트 · 상태 · 담당자 · 최근 N일
  변경분**을 조합해 가져올 수 있다(입력한 조건은 AND, 쉼표로 나열한 값은 OR). 가져오기 모달에
  "조건 조합" 범위가 추가됐다.
- **재가져오기 변경 확인**: 미리보기가 Jira 기준으로 **바뀌는 필드만 old → new 로** 보여주고,
  변경 없는 항목은 "변경없음"으로 구분한다. 체크박스로 **적용할 항목만 선택**해 반영할 수 있다.
- **PEP → Jira 신규 생성 / 삭제**: 업무를 Jira 이슈로 생성해 자동 연결하고(`POST /jira/create`),
  Jira 이슈를 삭제하면 PEP 업무는 보존한 채 연결만 해제한다(`DELETE /jira/issue/{key}`).

### Fixed
- **수동 등록 세션 쿠키로는 Confluence 가 인증되지 않던 문제**: Confluence 는 SSO 로그인이 따로
  캡처한 쿠키만 보고 있어, 세션 쿠키를 수동 등록한 사용자는 Confluence 테스트가 항상 실패했다.
  이제 Confluence 전용 세션이 없으면 **Jira 자격으로 폴백**하고(SiteMinder 류는 SMSESSION 이
  상위 도메인 공용), 통하면 Confluence 세션으로 승격 저장한다.

### Added
- **SSO 진단에 파드 출발지 IP 표시**: SSO/보안 에이전트가 클라이언트 IP 를 검사하는 구성인지
  판단하고 허용 목록에 등록할 IP 를 확인할 수 있도록, 진단 결과에 이 파드의 호스트명과
  대상 서버로 나갈 때의 출발지 IP 를 함께 보여준다(K8s 는 보통 노드 IP 로 NAT 되므로 노드가
  여러 대면 파드마다 달라질 수 있다는 점이 중요한 단서다).
- **CA SiteMinder 계열 SSO 지원**: `SMENC`/`SMLOCALE`/`TARGET`/`SMAUTHREASON` 필드를 쓰는
  SiteMinder(Layer7) 로그인 폼에서, 인증 후 목적지(`TARGET`)가 **로그인 페이지 자신**을
  가리키면 제품 URL 로 교정한다 — 교정 전에는 인증에 성공해도 로그인 화면으로 되돌아와
  "자격 오류"로 오판됐다.
- **로그인 직후 안내 페이지 통과**: "세션 유효기간 안내"처럼 로그인 뒤 끼어드는 페이지의
  `확인/계속` 버튼(hidden 없는 폼)과 링크를 자동으로 따라간다.
- **SSO 계정 필드명 지정** (공통 설정): 사번(empnum) 로그인처럼 IdP 로그인 폼의 계정 칸
  이름이 특수한 경우, 자동 추정 대신 필드명을 직접 지정할 수 있다. SSO 진단 표에도
  **계정 필드** 열이 추가되어 백엔드가 어느 칸에 아이디를 넣는지 확인할 수 있다.

### Fixed
- **비밀번호가 빈 값으로 전송되던 문제 (SiteMinder 계열)**: 로그인 폼이 화면 입력과 **별개로
  비어 있는 hidden 자격 필드**(`PASSWORD` 등)를 두고 브라우저 JS 가 그것을 채우는 구성이 있다.
  서버가 hidden 쪽을 읽으면 우리는 빈 비밀번호를 보낸 셈이 되어, 오류 문구 없이 로그인 폼만
  다시 표시됐다. 이제 값이 비어 있는 자격용 hidden 필드도 함께 채운다(값이 있는 상태 hidden 은
  그대로 보존).
- **보안 에이전트 설치 페이지로 새면서 로그인이 끊기던 문제**: 로그인 페이지가 에이전트
  미설치 시 설치 안내(`/tray/view/install.do` 등)로 보내는 스크립트를 함께 갖고 있으면
  그쪽을 따라가 흐름이 끝났다. 이제 설치/다운로드성 URL 은 건너뛰고 다음 후보를 쓴다.
- **인증에 성공했는데도 실패로 처리하던 문제**: 로그인 폼이 다시 보이면 즉시 거부로 단정했으나,
  이제 **세션을 먼저 확인**해 실제로 로그인됐으면 성공으로 처리한다.
- **`<select>`/`<textarea>` 필드를 제출에서 빠뜨리던 문제**: 폼 파서가 `<input>`/`<button>` 만
  수집해, 도메인 선택 같은 필수 값이 누락되면 IdP 가 흐름을 되감았다.
- **SSO 로그인 실패 사유에 로그인 페이지의 상시 안내문이 오류로 표시되던 문제**: "비밀번호
  5회 이상 입력 오류 시 계정이 잠깁니다" 같은 **정적 안내 문구**를 IdP 오류 메시지로 오인해
  보고했다. 이제 자격 제출 **직전 페이지와 비교해 새로 생긴 문구만** 오류로 판단하며, 새
  문구가 없으면 "같은 로그인 폼이 다시 표시됨(새 오류 문구 없음)"으로 구분해 안내한다.
  실패 메시지에 **계정을 채운 필드명**도 함께 표시해 필드 오선택을 바로 확인할 수 있다.
- **계정 칸 앞에 다른 텍스트 입력이 있으면 엉뚱한 칸에 아이디를 넣던 문제**: 알려진 계정
  필드명(사번 계열 `empnum`/`empno`/`sabun` 등 포함)을 우선 매칭하도록 보완.

## [1.16.2] - 2026-07-28

### Fixed
- **클러스터 삭제 시 점검 수행 로그(check_matrix_runs) 때문에 삭제가 실패하던 문제**:
  `CheckMatrixRun.cluster` 관계에 `passive_deletes=True` 가 빠져 있어, 클러스터를 삭제하면
  ORM 이 NOT NULL 인 `check_matrix_runs.cluster_id` 를 NULL 로 UPDATE 하려다 터졌다. 형제
  테이블(schedules/results)과 동일하게 DB 의 `ON DELETE CASCADE` 에 위임하도록 수정.
  회귀 가드(`test_cluster_backrefs_never_nullify_not_null_fk`)가 잡아낸 CI 실패 해소.

## [1.16.1] - 2026-07-28

### Fixed
- **등록된 클러스터 삭제 실패 (`NotNullViolation: cluster_id of relation
  check_matrix_results`)**: 연결이 안 된(pending) 클러스터를 포함해 클러스터 삭제가 500 으로
  실패하던 문제를 고쳤다. 원인은 두 가지 — ① 자식 모델의 `backref` 기본 cascade 에 delete 가
  없어 SQLAlchemy 가 부모 삭제 시 자식의 `cluster_id` 를 NULL 로 UPDATE(NOT NULL 컬럼이라
  위반), ② 삭제 라우터가 정리 대상 테이블을 손으로 나열해 모델이 추가될 때마다 누락. Backend:
  신규 `services/cluster_purge.py` 가 메타데이터에서 `cluster_id` 보유 테이블 32개를 전수
  탐색해 FK 의존성 순서대로 정리하고(업무·서비스 카탈로그·서버 스펙은 연결만 해제),
  Cluster 쪽 `backref` 7곳에 `passive_deletes=True` 를 적용해 nullify UPDATE 를 차단했다.
  삭제 실패 시 원인 테이블이 담긴 에러 메시지를 반환하고, kubeconfig 파일 삭제는 DB 커밋
  성공 후로 옮겨 실패 시 파일만 사라지는 문제도 없앴다. 다중 대상 업무의
  `cluster_ids`/`cluster_names` 에서도 삭제된 클러스터를 제거하고 대표를 승격한다.
  신규 회귀 테스트 `tests/test_cluster_deletion.py` 가 정리 정책 누락과 nullify 를 CI 에서 막는다.

### Added
- **점검 매트릭스 — 실행 방식 공개 + 수동 실행 3단위 + 수행 로그** (홈 ▸ 플랫폼 현황):
  - **실행 방식(런북)**: 셀을 클릭하면 그 점검이 **실제 운영 클러스터에서 수행하는 명령**을
    순서대로 볼 수 있다. kubectl 실행 / K8s API 호출 / HTTP 프로브 / SSH / PEP DB 조회를
    배지로 구분하고, 대상에 변경을 일으키는 명령에는 "변경" 배지가 붙는다. 이 클러스터에서
    해석된 실제 대상(점검 정의·애드온)과 적용되는 임계값·파라미터도 함께 표시된다.
  - **수동 실행 3단위**: 셀 1개(동기 실행, 결과 즉시), 클러스터 열 전체(K8s 단위),
    공통 점검 항목 행 전체(전 클러스터). 일괄 실행은 셀마다 독립 작업으로 큐잉돼 느린
    클러스터 하나가 나머지를 막지 않는다.
  - **수행 로그**: cron 자동 실행과 수동 실행(셀/클러스터/항목/수동 입력)이 모두 개별 기록으로
    남는다. 트리거·실행자·소요 시간, 실행 단계 타임라인, **실제로 나간 kubectl 명령과 종료
    코드·stdout/stderr**, 그 시점의 실행 계획까지 확인할 수 있다. 실행 대상이 없는 셀은 실패가
    아니라 "건너뜀"으로 남아 셀이 비어 있는 이유를 설명한다.
  - **사용 매뉴얼**: 화면 내 도움말(`?`)이 기본 사용법/실행하기/점검 방식/로그·보관 4탭으로
    확장돼 deep check·addon·수동 입력의 동작 방식과 사용법을 담는다. 상세판은
    `docs/CHECK_MATRIX_GUIDE.md`.
  - Backend: `models/check_matrix.py` 에 `CheckMatrixRun`(trigger/run_state/batch_id/
    triggered_by/details) 추가, 신규 `services/check_matrix_runbook.py`, `check_matrix.py` 라우터에
    `GET /cell/{item}/{cluster}/runbook`·`POST /cell/{item}/{cluster}/run`·
    `POST /clusters/{id}/run`·`POST /items/{id}/run`·`GET /runs`·`GET /runs/{id}`,
    Celery `run_check_matrix_run_one` 태스크, `DeepCheckerBase._kubectl` 의 실행 명령 계측.
    수행 로그는 값 이력과 같은 보관 일수로 매일 정리된다.
  - Frontend: `CheckMatrixCellDetailModal` 3탭화(추이·이력/실행 방식/수행 로그),
    신규 `CheckMatrixRunbookPanel`·`CheckMatrixRunLog`·`CheckMatrixRunLogPanel`,
    매트릭스 열/행 실행 버튼과 카드 헤더 "수행 로그" 진입점.
- **점검 매트릭스 — 셀 대표값 숫자 표시 + 기본 등록 항목 설정 편집**:
  - **셀에 대표값 숫자**: 인증서 만료가 "정상"이 아니라 **잔여일(예: 361일)** 로 표시된다.
    프로브류는 실패율(%), 이벤트류는 건수, 노드류는 이상 노드 수 — 전 deep check 타입에
    대표값 규칙(`deep_checkers/registry.py` `CELL_VALUE_SPECS`)을 정의했고 시드 시 항목
    단위도 함께 채워진다(구버전 DB 는 부팅 시 자동 보강).
  - **소스 설정 확인·수정**: 셀 상세 "실행 방식" 탭의 **설정 편집**으로 기본 등록 점검의
    임계값·파라미터(애드온이면 config)를 매트릭스에서 바로 고칠 수 있다. 값은 필드 타입으로
    강제되고 비우면 기본값으로 복귀하며, 글로벌 정의면 전 클러스터 적용 경고가 뜬다.
    Backend: `PUT /check-matrix/cell/{item}/{cluster}/source-config`, 런북에
    definition/addon 식별자·필드 명세 포함.
  - **시스템 항목도 표시 속성 수정 가능**: 잠긴 것은 실행 소스뿐 — 이름/설명/단위/표시
    여부는 다른 행과 똑같이 편집된다.

- **점검 매트릭스 — 영역 구분·행 색 커스텀·드래그 정렬**: 행마다 **영역(category)**
  (k8s/network/storage/os/app 또는 자유 입력)과 **배경 색**(8색 프리셋)을 지정할 수 있다 —
  행에 색 띠·배경 틴트와 영역 칩이 표시돼 어떤 영역 점검인지 한눈에 구분된다. 기본 등록
  항목은 체커 도메인에서 영역·기본 색이 자동으로 채워진다(구버전 DB 부팅 시 보강). 색은
  hex 가 아니라 테마 대응 차트 토큰 프리셋(`chart-1..8`)으로 저장돼 다크/라이트를 자동으로
  따른다. 행 순서는 위/아래 화살표 대신 **그립(⋮⋮) 드래그**로 바꾼다.
  Backend: `check_matrix_items.category/color` + 마이그레이션·시드·backfill,
  Frontend: `rowColors.ts` 프리셋 + 항목 폼 색 피커 + 매트릭스 DnD.

### Fixed
- **점검 매트릭스 대시보드 audit (디버그·UI)**:
  - 셀 동기 실행이 axios 기본 30초에 잘려 느린 점검(pod_to_pod·핵심 번들)이 성공하고도
    실패로 보이던 문제 — 셀 실행만 300초로 확대(백엔드 태스크 한도 280초에 정합).
  - 워커가 죽으면 수행이 "대기열/실행 중"에 영원히 갇히던 문제 — 매분 디스패처가 30분
    초과 수행을 실패로 마감하는 고아 수행 스위퍼 추가.
  - 일괄 실행 완료 후에도 3초 폴링이 계속되고 매트릭스 셀은 최대 60초 늦게 갱신되던 문제 —
    배치 종료 감지 시 폴링 중단 + 그리드 즉시 1회 갱신.
  - UI 규칙 위반 수정: `text-red-500`(고정 팔레트) → 상태 토큰, 버튼/입력 라운딩을
    디자인 시스템 규격(`rounded-xl`)으로 정리, 아이콘 전용 버튼(수정/삭제/설정)에
    `aria-label` 보강.
- **점검 매트릭스 수동 실행 500 (심각)**: 셀/클러스터/항목 실행과 수동 입력이 전부
  `AttributeError: 'User' object has no attribute 'full_name'` 으로 실패했다 — 실행자
  표시명 해석이 User 모델에 없는 `full_name` 을 참조. `display_name or username` 으로
  수정하고 회귀 테스트 추가.
- **실행 버튼 발견성**: 행의 전 클러스터 실행 ▶ 가 hover 에서만 보여 "버튼이 없다"고
  오인됐다 — 항상 노출로 변경. 행마다 실행 방식 배지(핵심/Deep/Addon/수동)를 붙이고,
  수동 입력 항목의 셀 상세에는 실행 버튼이 없는 이유(자동 실행 없음)와 자동 점검으로
  바꾸는 방법을 안내한다.
- **문서**: `docs/CHECK_MATRIX_GUIDE.md` 에 DB 구조(Schema Audit) 섹션 추가 —
  테이블 5종 관계도(ER)·인덱스/제약·enum 확장 절차·runs 테이블 용량 특성·이중 기록.
- **Deep check 실행 500 (심각)**: 매트릭스에서 deep check 를 실행하면 전부
  `null value in column "daily_check_log_id" violates not-null constraint` 로 실패했다.
  일일점검 회차 없이 도는 단독 실행(매트릭스 셀/"지금 점검")은 이 컬럼이 NULL 인데,
  초기 스키마의 NOT NULL 이 구버전 DB 에 남아 있었고 `create_all` 은 기존 컬럼 제약을
  바꾸지 않는다. 부팅 마이그레이션에 `DROP NOT NULL` 추가(재시작만으로 복구) + 회귀 테스트.
- **etcd 가 데몬(systemd)인 환경 지원**: `etcd_defrag` 점검이 `kube-system` 의 etcd 파드만
  찾아서, etcd 가 master 노드 systemd 유닛으로 뜨고 env 가 `/etc/etcd.env` 인 환경에서는
  항상 "etcd pod 를 찾지 못했습니다"로 끝났다. 실행 경로를 파라미터
  `source`(`auto`/`pod`/`snapshot`)로 노출하고, 데몬 환경은 `버전/설정 관리(/versions)`
  화면이 SSH 로 수집해 둔 `etcdctl_config` 스냅샷을 읽어 단편화율을 판정한다(`auto` 는
  파드 → 스냅샷 폴백, 스냅샷이 `snapshot_max_age_hours` 보다 낡으면 대기 처리).
  체커가 직접 SSH 하지 않으므로 자격증명이 저장되지 않는다.

- **스키마 드리프트로 인한 반복 500 (근본 대응)**: `daily_check_logs.ai_status`,
  `deep_check_results.status/.message`, `deep_check_results.daily_check_log_id` 의 레거시
  NOT NULL 처럼, 모델과 실제 DB 가 어긋나 **특정 기능에서만 500** 이 나는 문제가 반복됐다.
  Alembic 없이 `create_all` 로 운영하는 구조상 이미 존재하는 테이블의 컬럼·제약이 자동으로
  갱신되지 않기 때문이다. 한 컬럼씩 사후에 쫓아가는 대신 전체를 기계적으로 비교·복구한다:
  - 부팅 안전망에 `_relax_not_null_drift` 추가 — 모델이 nullable 인데 DB 에 NOT NULL 이 남은
    컬럼을 자동 완화(기존 `_sync_missing_model_columns` 의 누락 컬럼 보강과 짝).
  - Settings ▸ **스키마 점검** 탭 신설 — 드리프트(테이블/컬럼 누락, 레거시 NOT NULL)를 표로
    보여주고 **안전한 것만**(컬럼 추가는 항상 nullable, NOT NULL 해제) 복구한다. 컬럼 삭제·타입
    변경은 하지 않으며, `실행 계획 보기`로 실행될 SQL 을 먼저 확인할 수 있다.
    Backend: `GET /api/v1/schema-health`, `POST /api/v1/schema-health/repair`(admin).

### Changed
- **UI-First 원칙을 프로젝트 규약으로 명문화** (`CLAUDE.md` §UI-First 원칙): 환경마다
  달라지는 값(네임스페이스·라벨·경로·엔드포인트·실행 경로)은 코드에 하드코딩하지 않고
  `param_fields`/`threshold_fields`(또는 `Addon.config`)로 노출해 **운영자가 파이썬 파일을
  고치지 않고 화면에서 확인·수정**할 수 있어야 한다. 자격증명은 params 에 저장 금지(런북·
  실행 로그 노출) — 수집 화면이 남긴 스냅샷을 읽는 구조를 쓴다. `add-deep-checker` 스킬과
  `docs/CHECK_MATRIX_GUIDE.md` §환경 차이 대응에 절차 반영.

## [1.16.0] - 2026-07-28

### Added
- **Jira+Confluence SSO 통합 로그인 (K8s 파드 내, 브라우저 불필요)**: 관리자가 설정 ▸ 연동에
  Confluence Base URL 을 등록하면, SSO 자동 로그인(ID/PW 폼)이 **한 번의 IdP 로그인으로 Jira 와
  Confluence 세션을 동시에 캡처**해 저장한다. Confluence 연결 테스트 버튼과 세션 상태 배지도
  추가. Backend: `jira_sso_http.sso_login_products()`(다중 제품 SSO 체인, Chromium/Playwright
  불필요), 신규 `services/confluence_service.py`(fail-safe REST 클라이언트 — user/current·CQL
  검색·페이지 조회), `POST /jira/confluence/test`·`GET /jira/confluence/search`,
  `user_jira_credentials.confluence_cookie_encrypted`(암호화 저장·백업 마스킹 등록).
- **Jira/Confluence 세션 만료 시 자동 재로그인**: "로그인 정보 저장" 옵트인 사용자는 API 호출
  중 세션 만료(401)가 감지되면 저장된 SSO 로그인 정보로 **자동 재로그인 후 재시도**된다 —
  최초 1회 로그인 후에는 세션이 끊겨도 연결 테스트/가져오기/push 가 무중단으로 이어진다.
- **SSO 진단** (`POST /jira/sso/diagnose`): 로그인이 실패할 때 **백엔드 파드가 실제로 보는
  로그인 페이지**(최종 URL·HTTP 상태·폼/password 입력 개수·JS·meta 리다이렉트 대상·
  WWW-Authenticate)를 표로 보여준다. 폐쇄망 IdP 는 외부에서 열어볼 수 없어 원인 추정이
  어렵던 문제를 해결한다. 설정 ▸ 연동에 "SSO 진단" 버튼 추가.
- **IdP 로그인 URL 직접 지정** (공통 설정): 자동 탐색이 실패하는 SSO 구성을 위해 브라우저에서
  확인한 IdP 로그인 페이지 주소(예: `https://login.example.com/sso/am/jira/login.jsp`)를
  지정하면 SSO 로그인이 그 주소부터 진입한다.

### Fixed
- **SSO 자동 로그인이 "로그인 폼을 찾지 못했습니다"로 실패하던 문제**: 기존 구현은 Jira
  루트(`/`) 한 곳만 확인해, ① 익명 접근이 열려 루트가 대시보드를 주는 배포 ② IdP 중계가
  HTTP 302 가 아니라 `<meta refresh>`/`location.href` 같은 **클라이언트 리다이렉트**로
  이뤄지는 배포(사내 SSO 게이트웨이 hook)에서 IdP 로그인 페이지에 도달하지 못했다. 이제
  **여러 진입 경로**(루트·로그인 페이지·보호 자원)를 시도하고 **JS/meta 리다이렉트를
  추적**하며, IdP 에서 먼저 로그인하는 구성(OpenAM/SiteMinder 류)을 위해 로그인 후 제품
  재진입으로 토큰 교환까지 마친다. 폼 탐색이 모두 실패하면 **Jira REST 세션 로그인**
  (`/rest/auth/1/session`)과 **제품 자체 로그인 폼** POST 로 폴백한다. 비밀번호 오답은
  즉시 중단해 AD 계정 잠금을 방지한다. `<button type=submit>` 폼과 `Accept: text/html`
  요청 헤더도 함께 보완.
- **OpenAM 계열 SSO 에서 올바른 계정인데 "비밀번호가 올바르지 않습니다"로 실패하던 문제**:
  로그인 폼에 `encoded=true` hidden 필드가 있으면 브라우저 스크립트가 계정/비밀번호를
  **base64 로 인코딩해 제출**한다. 평문으로 보내면 IdP 가 로그인 폼을 다시 표시해 오답과
  구분되지 않았다. 이제 해당 폼은 자동으로 base64 인코딩해 제출한다. 함께 보완: 폼 제출 시
  `Referer`/`Origin` 헤더 전송(CSRF 방어로 흐름이 되감기던 배포 대응), `IDToken1` 을 계정
  필드로 인식, **다단계 로그인**(계정 화면 → 비밀번호 화면)을 폼 재표시로 오판하지 않도록
  폼 필드 구성 비교로 구분.
- **로그인 실패 사유가 항상 "아이디 또는 비밀번호가 올바르지 않습니다"로 뭉개지던 문제**:
  이제 IdP 가 화면에 표시한 오류 문구를 그대로 전달하고, 오류 문구가 없으면 "같은 로그인
  폼이 다시 표시됨 — 자격 오류이거나 추가 인증 단계 요구"로 구분해 안내한다. SSO 진단에도
  폼의 hidden 필드 목록을 노출해 `encoded=true` 같은 단서를 확인할 수 있다.
- **수동 세션 쿠키 등록 시 값만 붙여넣으면 인증되지 않던 문제**: `JSESSIONID=<값>` 이 아니라
  값만 넣으면 `Cookie` 헤더에 이름이 없어 서버가 익명으로 취급해 401 이 됐다. 이제 이름이
  없는 입력은 `JSESSIONID=` 를 자동으로 붙이고, 앞에 붙은 `Cookie:` 접두어도 제거한다.
  입력 안내 문구에도 형식 경고를 추가.

## [1.15.1] - 2026-07-28

### Added
- **화면별 노출 관리 (Settings → 접근 제어)**: admin 이 각 화면을 일반 사용자(operator·viewer)에게
  열지 말지 체크 하나로 결정한다. 기본값은 열림. 비활성화하면 **사이드바 메뉴 숨김 + Your Island
  화면추가 목록 제외 + 이미 담긴 Island 패널 접근 차단 + 직접 URL 접근 차단**이 동시에 적용된다
  (admin 은 항상 예외). 목록 UI는 Your Island 화면추가 피커와 그룹·검색 렌더링을 공유하는
  `ScreenCatalogList` 공용 컴포넌트를 재사용했다.
  Backend: 기존 `feature_access`(`/ui-settings/feature-access`)에 `enabled` 필드를 추가하고,
  키를 라우트 경로로 통일(레거시 `wbs` 키는 `/wbs` 로 자동 승격).
  Frontend: `canAccessFeature` 가 모든 라우트 경로에 범용 적용되도록 일반화(기존엔 `/wbs` 하나만
  하드코딩)했고, 전 라우트에 적용되는 `RouteAccessGate`(`App.tsx`)를 새로 추가해 메뉴에서 숨긴
  화면을 주소로 직접 열어도 막히게 했다(기존엔 WBS 만 라우트 가드가 있었다).

### Changed
- WBS(`/wbs`)의 전용 라우트 가드(`RequireFeature`)를 제거하고 위 범용 `RouteAccessGate` 로
  대체 — 동작은 동일하되 화면별 특수 처리가 사라졌다. Settings "접근 제어" 탭에는 기존 세부
  역할/사용자 제한(WBS 전용) 위에 새 "화면별 노출" 섹션이 추가돼, 하나의 저장 버튼으로 두
  설정을 함께 관리한다.

### Changed
- **Your Island 진입점 재배치**: 사이드바 최상단(로고 바로 아래)에 있던 버튼을 **푸터 개인 존**
  (테마 아래, 사용자 아이콘 위)으로 옮겼다. 개인 커스터마이즈 기능이 조직 공용 그룹 레일과
  같은 줄기로 읽히던 문제를 없애고, 사용자 메뉴·VOC·릴리즈 노트와 같은 성격끼리 묶었다.
  푸터는 발견성이 낮으므로 **홈 상단 KPI 필 그룹 맨 앞("내 할일" 바로 왼쪽)에 진입 필**을
  추가해 보완한다(마지막에 보던 아일랜드로 이동, 없으면 "만들기"). 아이콘은 `Sparkles` →
  `Palmtree` — 기본 테마의 테마 토글 아이콘이 `Sparkles` 라 푸터에서 나란히 놓이면
  구분되지 않았다.

### Added
- **Your Island 편집 기능 보강**: 관리 패널에서 **아일랜드 순서를 드래그로 변경**할 수 있고
  (1.15.0 에서 API 만 있고 UI 가 없던 부분), **설명(description)** 을 입력할 수 있다.
  탭·레일 항목의 연필 아이콘으로 **패널별 표시 이름과 아이콘을 개별 지정**할 수 있으며,
  비우면 사이드바 기본값으로 되돌아간다. 사이드바 "Your Island" flyout 에 **팀 공유 아일랜드
  섹션**이 추가되어 관리 패널을 열지 않고도 바로 이동할 수 있다.

### Fixed
- **아일랜드에서 튕겨나가던 클러스터 선택형 화면 (심각)**: 운영 점검 / K8S 상세 관리 /
  K8S 자원 관리 / 파드 로그를 아일랜드 패널로 열면, 이 화면들이 마운트 직후
  `/ops-checks/:clusterId` 같은 자기 라우트로 `navigate` 하면서 **앱 전체가 아일랜드 밖으로
  빠져나가** 패널이 열리지 않았다. 클러스터가 1개 이상 등록된 환경에서만 재현되던 버그.
  이제 `IslandEmbedContext` 로 임베드 여부를 알려주고, 공통 훅
  `useClusterRouteParam(basePath, clusters)` 이 임베드 상태에서는 URL 대신 로컬 state 로
  클러스터를 고른다 — 일반 라우트 동작은 그대로다.
- **패널 상한(20개) 안내**: 21개째 추가 시 서버가 422 로 거절하고 프론트는 이유 없는 "패널 저장
  실패" 토스트만 띄우던 문제. 이제 상한에 도달하면 피커 상단에 안내가 뜨고 "화면 추가" 버튼이
  비활성화된다. 상한값은 `panelRegistry.MAX_PANELS` 로 프론트에도 명시했다.

### Changed
- **island 라우터 테스트 추가** (`backend/tests/test_island.py`, 21 케이스): 소유자 외 수정·삭제
  403, 비공개 아일랜드 404, 공유 아일랜드 복제 시 소유권 이전 및 공유 해제, `_normalize_panels()`
  의 깨진 입력 방어, reorder 가 남의 아일랜드를 건드리지 않음을 회귀 검사한다.

## [1.15.0] - 2026-07-27

### Added
- **Your Island — 사용자 커스텀 화면 (`/island`)**: 자주 쓰는 PEP 화면을 하나에 모아
  **탭 또는 좌측 아이콘 레일**로 즉시 전환하는 개인 화면. 패널은 새 위젯이 아니라 **기존 페이지를
  그대로 임베드**하므로 담은 화면의 기능이 원본과 동일하다. 아일랜드를 여러 개 만들고 팀에
  읽기 전용으로 공유하거나 남의 아일랜드를 복제할 수 있다. 진입은 사이드바 최상단 "Your Island"
  버튼(아일랜드가 여러 개면 flyout 으로 선택).
  Backend: `islands` 테이블 + `island.py` 라우터(소유자만 쓰기, 공유는 읽기·복제만),
  패널 배열은 읽기·쓰기 양쪽에서 방어적 정규화.
  Frontend: `IslandPage` + `components/island/`(`panelRegistry.ts` 가 임베드 가능 화면 등록부,
  `/k9s`·admin 전용 화면은 denylist), `.island-embed` CSS 스코프가 페이지의 전체화면 셸을
  무력화해 페이지 파일 수정 없이 임베드된다. 패널 카탈로그는 사이드바와 같은 소스
  (`useNavCatalog`)를 써서 관리자가 바꾼 메뉴명·숨긴 기능이 그대로 반영된다.

### Fixed
- **Batch Job 슬라이드오버 빌드 실패**: `BatchJobSlideOver.tsx` 에 병합 사고로 남아 있던 중복
  import 2줄을 제거. `tsc --noEmit` / `npm run build` 가 레포 전체에서 실패하던 문제를 해결한다.
- **클러스터 정보 수정 — 미저장 변경 보호 · 저장 알림 · 탭 링크 (D-037·D-038)**: 22개 필드짜리
  장문 폼에서 입력 중 실수로 나가면 경고 없이 전부 사라지던 것을 막았다. 변경이 있는 상태로
  **취소·뒤로가기를 누르면 확인 창**이 뜨고, 새로고침·탭 닫기는 브라우저 경고로 막는다(앱 내
  사이드바 이동은 라우터 구조상 아직 차단되지 않는다). 저장에 성공하면 **알림 토스트**로 반영
  사실을 알린다. 아울러 활성 탭이 주소(`?tab=`)에 남아 **새로고침·공유·저장 실패 후에도 보던
  탭이 유지**된다(탭 전환은 히스토리에 쌓이지 않아 뒤로가기가 탭을 되짚지 않는다).

### Changed
- **클러스터 정보 수정 화면 정비 — 테마 정합·표준 컴포넌트·키보드 접근성 (D-034·D-035·D-036)**:
  N/W CIDR 탭의 세 네트워크 도메인(INTERNAL_IP·Pod·Service)과 Prometheus 섹션이 쓰던 고정
  팔레트(sky/emerald/violet/cyan)를 **테마별 categorical 토큰**으로 바꿔, 라이트·기본 테마에서
  섹션 라벨 대비가 떨어지던 문제를 해소했다(다크 전용 톤 사용분 포함). 손수 만든 카드 컨테이너를
  공용 `MacCard` 로, 취소/저장/재시도 버튼을 공용 `Button` 으로 교체하고 입력 모서리를 앱 표준으로
  맞춰 다른 화면과의 시각 차이를 없앴다. 3개 탭에는 표준 탭 접근성(스크린리더 인식, **←/→·Home/End
  키 이동**)을 적용했다.

### Fixed
- **클러스터 정보 수정 — 입력값을 지워서 저장할 수 없던 문제 (D-031)**: 클러스터 정보 수정
  화면에서 이미 입력된 CIDR·NIC·호스트명·설명 등을 비우고 저장해도, 화면만 비워질 뿐 실제로는
  이전 값이 그대로 남아 있던 문제를 수정했다. 빈 입력을 서버에 보내지 않아(`undefined` 직렬화
  누락) 백엔드가 "변경 없음"으로 처리하던 것이 원인으로, 이제 빈 입력을 `null` 로 전송해
  **값 해제가 정상 반영**된다(24개 필드). 잘못 입력한 네트워크 정보를 되돌릴 수 있다.
- **클러스터 정보 수정 — 로딩 중 입력이 사라지고 저장이 먹통이던 문제 (D-032)**: 클러스터 목록이
  도착하기 전에 빈 폼이 그대로 표시돼, 그 상태에서 입력하면 목록 수신 시 입력값이 서버값으로
  덮어써지고 저장 버튼은 아무 반응이 없던 문제를 수정했다(딥링크·느린 응답 시 재현). 이제
  데이터가 확정되기 전에는 **폼 대신 skeleton** 을 표시하고, 목록 조회에 실패하면 빈 폼 대신
  **오류 안내와 "다시 시도"** 버튼을 보여 준다.
- **클러스터 정보 수정 — 다른 클러스터의 값이 표시될 수 있던 문제 (D-039)**: 주소를 직접 바꾸거나
  브라우저 앞/뒤로 이동해 **다른 클러스터의 수정 화면으로 바로 넘어가면**, 폼이 이전 클러스터의
  값을 그대로 보여 주고 그 상태로 저장할 수 있던 문제를 수정했다. 이제 클러스터가 바뀌면 폼이
  새로 채워진다(편집 중 자동 갱신에 입력이 덮어써지지 않는 기존 동작은 그대로 유지).
- **클러스터 정보 수정 — 저장 실패 사유가 보이지 않던 문제 (D-033)**: 저장 실패 시 실제 서버
  오류를 버리고 "저장에 실패했습니다"라는 고정 문구만 보여 주던 것을 **실제 오류 메시지 노출**로
  바꾸고, CIDR·IPv4·MAC·AS Number **입력 형식 검증(15개 필드)** 을 추가했다. 형식이 틀린 필드는
  테두리 강조와 함께 사유가 바로 아래 표시되고, 다른 탭에 오류가 있으면 **해당 탭으로 자동
  전환**된다. 검증 규칙은 클러스터 관리 화면의 CIDR 겹침 검사와 같은 형식이라, 통과한 값은
  CIDR 계산기에서도 정상 인식된다.

### Fixed
- **Apple Silicon Vagrant 테스트 클러스터 — Mac 절전 후 복구 불능 문제**: Mac 이 절전에 들어가면
  VirtualBox 가 VM 을 `HostSuspend` 로 일시정지하는데 Apple Silicon 빌드는 resume 이
  `VM is paused due to host power management` 로 실패하고, 그 VM 을 붙잡은 VBoxSVC 가 교착에
  빠져 이후 `vagrant`/`VBoxManage` 명령이 전부 무한 대기했다(→ `192.168.10.100:6443` 도달 불가로
  PEP 클러스터 등록이 `pending` 에서 멈춤). `vagrant/up.sh` 에 자가진단·복구 단계(`vbox_doctor`)를
  추가해 교착된 VBoxSVC/클라이언트를 정리하고 `paused`/`aborted`/`saved` VM 을 poweroff 로
  내린 뒤 다시 부팅하도록 했다. macOS 에 없는 `timeout(1)` 대체 래퍼(`vbox_t`)로 진단 단계가
  스스로 멈추지 않게 했고, VM 잔존 폴더 정리 경로에 실제 그룹 경로(`VirtualBox VMs/Cilium-Lab/<vm>`)를
  추가했다.
- **Vagrant 워커 노드가 NAT IP(10.0.2.15)로 등록되던 문제**: `k8s-w.sh` 가 kubelet NodeIP 를
  고정하지 않아 워커가 default route 인 NAT eth0 주소로 노드 등록됐고, VirtualBox NAT 는 모든 VM 에
  같은 `10.0.2.15` 를 주므로 워커들의 InternalIP 가 중복됐다(→ `kubectl logs/exec` 오작동, Cilium
  native routing 의 `autoDirectNodeRoutes` 노드간 경로 실패, PEP 노드 메트릭 중복). `k8s-w.sh` /
  `k8s-ctr.sh` 가 host-only(eth1) 주소로 `--node-ip` 을 고정하도록 수정.
- **문서**: `vagrant/README.md` 에 "1분 진단" 3줄 + 증상별 트러블슈팅 표 + 절전 후 수동 복구 /
  NodeIP 수동 교정 절차를 추가하고, `docs/MAC_LOCAL_TEST_GUIDE.md` 트러블슈팅 표에 절전·NodeIP
  관련 행 5개를 보강했다.

## [1.14.0] - 2026-07-24

### Changed
- **Settings "관리 서비스" 탭 통합 (D-030 ③)**: 최상위 "서비스"(PEP 서비스) 탭을 없애고,
  서비스 카탈로그 편집기(`ServiceCatalogManager`, 업무/이슈 태그·통합지식 사이드바 출처)를
  "관리 서비스" 탭 안의 서브탭으로 옮김. 이제 "관리 서비스" 탭은 **서비스 타입**(헬스체크
  대상 LakeServiceType 카탈로그)과 **서비스 카탈로그**(ui_settings.serviceCatalog) 두 서브탭으로
  구성된다. 레거시 `?tab=service` 딥링크는 관리 서비스 탭으로 리다이렉트.

### Fixed
- **접근성·반응형 잔여분 마무리 (D-015·D-023·D-025·D-028)**: 점검 이력 히트맵에 색+라벨을
  병기한 상시 범례를 추가해 색맹·스크린리더 사용자도 상태를 판별할 수 있게 하고(D-015),
  K8s 상세관리 리소스 상세 드로어에 Escape·포커스 트랩·`role=dialog` 를 적용(D-023),
  K8s 자원관리 노드 카드 그리드를 `minmax(min(220px,100%),1fr)`+가로 스크롤로 좁은 폭에서도
  짓눌리지 않게 하고(D-025), 자원관리의 hover 전용 설명 툴팁(통계/배치 가능 노드)을
  `<button>`+`group-focus-within` 으로 바꿔 키보드·터치에서도 열리도록 접근화했다(D-028).
- **로딩 skeleton 구조화 (D-017)**: 플랫폼 상태 매트릭스의 "불러오는 중…" 텍스트를 실제
  매트릭스(항목 라벨 + 클러스터 셀)를 흉내낸 skeleton 으로, 업무 보드 칸반 로딩을 실제 5개
  컬럼(헤더+카드 스택) 구조 skeleton 으로 교체하고, 전체 헬스 히어로 skeleton 의 `rounded-2xl`
  을 카드와 같은 `rounded-md` 토큰으로 맞춰 로드 전환 시 레이아웃 시프트를 줄였다.
- **반응형·접근성 잔여분 (D-019)**: 홈 업무 모드에서 xl 미만일 때 패널이 짓눌려 발생하던
  이중 스크롤을, 높이 채움을 xl 이상에서만 적용하고 그 미만에서는 패널에 최소 높이를 주어
  바깥 컨테이너 하나만 스크롤하도록 정리했다. 운영점검 콘솔 목록 테이블을 `overflow-x-auto`
  로 감싸 좁은 폭에서 가로 스크롤되게 하고, WIP 한도 초과 배지의 ⚠ 이모지를 `AlertTriangle`
  아이콘(aria-label)으로 교체했다(칸반 WIP 배지의 고정 팔레트도 status 토큰으로 전환).
- **K8s 상세관리·일일점검 리뷰 로딩 skeleton (D-027)**: "불러오는 중…" 텍스트 로더를 실제
  콘텐츠 구조를 흉내낸 skeleton 으로 교체 — K8s 상세관리의 리소스/노드/파드/Helm/CRD 패널은
  헤더 그리드 아래 행 skeleton, 개요 패널은 3-스탯 카드 skeleton, 일일점검 리뷰의 AI 리뷰
  섹션은 텍스트 라인 skeleton 으로 바꿔 로드 전환 시 레이아웃 점프를 줄였다.
- **모달 접근성 전면 확산 (D-026)**: 앱 전역의 폼/다이얼로그형 전용 모달 20종에 공용
  `useModalA11y`(Escape 닫기·포커스 트랩·초점 이동/복원)를 적용하고 `role="dialog"`·`aria-modal`
  ·`aria-labelledby`(또는 aria-label)를 부여했다 — LAKE/서비스 등록, 프로젝트·스프린트·미완료
  이월, 사용자 생성·비밀번호 재설정, 인프라 노드 폼·삭제확인, 클러스터·관리서버 설정, 노드
  스펙 Host Facts, 마인드맵 노드 편집, 서비스 타입·카테고리 관리, 배치잡 위저드·슬라이드오버,
  클러스터 diff·이미지 배포·플레이북 로그, 그리고 공용 우측 슬라이드 패널(SidePane)까지. 기존의
  수동 Escape 리스너는 훅으로 통합해 중복을 제거했고, 남은 `fixed inset-0` 사용처는 모두
  드롭다운/팝오버·터미널·Dialog 프리미티브로 모달이 아니어서 포커스 트랩 대상에서 제외했다.

## [1.13.0] - 2026-07-24

### Added
- **K8s Job 정리 배치잡 (`k8s_job_cleanup`)**: 완료(Complete)/실패(Failed) 상태로 남아 리소스만 차지하는 K8s Job 을 정리하는 새 배치잡 타입. SSH 없이 클러스터에 등록된 kubeconfig 로 백엔드/워커에서 kubectl 을 직접 실행하는 **클러스터 스코프(non-SSH) 실행 모델**을 배치잡 프레임워크에 도입(`BatchJobExecutor.requires_ssh`) — 이 타입은 호스트/SSH 자격증명 없이 등록·cron 스케줄·일괄 실행이 모두 가능하다. dry_run 기본 활성(삭제 대상만 미리 확인), 실행 중(active) Job 보호, 종료 후 경과시간(`older_than_hours`)·네임스페이스 제외·라벨 셀렉터 필터 지원. Backend: `services/batch_jobs/k8s_job_cleanup.py` + 프레임워크/라우터/디스패처 non-SSH 분기. Frontend: 잡 등록 위저드·실행 폼·편집 폼이 non-SSH 타입에서 호스트/자격증명 입력을 자동 생략.
- **Batch Jobs — 클러스터 단위 그룹 뷰**: "전체" 모드에서 flat 테이블 대신 잡이 등록된 클러스터별 collapsible 섹션(클러스터명·등급·잡 통계 헤더 + 개별 테이블 + 미등록 타입 칩)으로 표시 — 클러스터가 늘어나도 어디에 무엇이 등록됐는지 한눈에 파악 가능. Frontend: `BatchJobClusterGroup` 신설.
- **Batch Jobs — mc 대시보드 스타일 로그 상세 카드**: 잡 상세 패널에 "최근 실행 로그"를 mc 클라이언트 콘솔과 동일한 형태(상태/트리거/실행자/호스트/exit/소요시간 sticky 헤더 + 실행 명령 + `ExecOutputTabs`)로 항상 노출 — 실행 이력을 펼치지 않아도 방금 실행이 어떻게 됐는지 바로 확인 가능. 실행 폼 결과와 실행 이력 상세도 같은 컴포넌트(`BatchJobLogDetail`)로 통일해 stdout/stderr 를 stack 하지 않고 탭으로 전환(CLAUDE.md 콘솔 표준 패턴 준수).
- **Batch Jobs — admin 실행 추적성**: "방금 실행이 정확히 어떤 방법으로 이뤄졌는지" 확인 불가능하던 문제를 해소 — `BatchJobRun` 에 실행자 스냅샷(`triggered_by_username`, 수동/일괄만 채워짐)과 그 실행에 실제로 사용된 merge 후 파라미터 스냅샷(`params_snapshot` — 예: k8s_job_cleanup 의 dry_run 여부)을 추가해 로그 상세 카드에서 확인 가능. 등록/수정/삭제/수동 실행/일괄 실행을 감사 로그(`audit_logs`, action=`batch_job.*`)에 기록해 Settings 의 감사 로그 조회(admin 전용)에서도 추적 가능.

### Changed
- **Batch Jobs 실행 이력 개선**: 슬라이드오버의 실행 이력이 15초 주기로 자동 갱신되어 스케줄/일괄(백그라운드) 실행 결과가 새로고침 없이 반영되고, 이력 항목에 실행 트리거 배지(수동/스케줄/일괄)가 표시된다. 일괄 실행은 이제 trigger="bulk" 로 구분 기록.

### Fixed
- **Batch Jobs 편집 폼에서 cron/설명/기본 호스트 해제 불가**: 값을 지우고 저장해도 빈 값이 "변경 없음"으로 직렬화되어 실제로는 해제되지 않던 문제 수정 — 빈 입력을 null 로 전송해 스케줄 해제(수동 전용 전환)가 정상 동작한다.
- **잡 등록 위저드의 cron 필수값 사전 검증 보강**: cron 을 설정했지만 기본 호스트가 비어 있으면 등록 시 백엔드 422 를 받고서야 알 수 있던 흐름을 마지막 단계에서 미리 차단·안내하고, "등록 후 추가하면 된다"는 실제 동작(등록 차단)과 모순된 자격증명 안내 문구를 바로잡음.

## [1.12.0] - 2026-07-24

### Added
- **서비스 아키텍처 자동 생성·현행화 (`/service-architecture`)**: Settings 에 등록된 서비스 모듈(cluster+namespace) 단위로 K8s 리소스를 자동 탐색해 **아키텍처 다이어그램과 서비스 플로우 도식을 영속 문서로 생성**하고, 수동 "동기화" 버튼 + Celery 주기 스케줄(cron 설정 가능)로 **현행화**한다. 사라진 리소스는 삭제 대신 stale(점선 ghost) 표시 + 드리프트(±변경) 배지로 보고하며, 수동 편집 — 외부 시스템 노드 추가, 노드 간 수동 연결(뷰/순서 지정), 노드별 주석, 드래그 배치(뷰별 영속 저장), 요약 직접 수정 — 은 현행화가 절대 덮어쓰지 않는다. LLM(Ollama) 이 연결돼 있으면 아키텍처 요약·컴포넌트 역할·플로우 스텝을 자동 서술(오프라인이어도 기능 전체 정상 동작). PNG/SVG 내보내기 지원. Backend: `architecture_docs` 라우터 + `architecture_doc_service`(기존 `collect_topology`/`build_traffic` 재사용, `TopologyAuditLog` 감사) + `service_arch_docs` 모델 3종 + Celery `arch-doc-sync-dispatcher`. Frontend: `ServiceArchitecturePage` + `components/serviceArch/` + `useArchDoc` 훅.

### Changed
- **업무 현황 화면 색상 디자인 토큰화(테마 정합)**: 홈 업무 위젯들이 쓰던 고정 팔레트(`text-red-500`·`bg-blue-500`·emerald/amber/slate/violet 등)를 semantic status(`--status-healthy/warning/critical/info/unknown`)·categorical chart(`--chart-N`) 토큰으로 교체 — light/dark/default 테마 전환 시 톤이 어긋나던 문제 해소(CLAUDE.md 디자인 규칙 준수). 대상: WorkCalendar·MemberTodayTodos·WorkAlarmBell·QuickAddTaskModal(우선순위/필수표시/경고) 및 DayScheduleBoard 담당자 아바타 팔레트. 담당자별 진행 현황의 '메모지' 종이 질감(warm paper)은 의도된 장식이라 유지.
- **당일 스케줄 — 완료 업무 유지(흐리게) & 지연 집계에서 backlog 제외**: 업무를 완료(done)하면 '당일 스케줄'에서 즉시 사라지던 것을, 완료일까지는 **흐림+취소선**으로 남겨 하루 회고가 가능하게 변경. 아울러 '담당자별 오늘 요약'의 **지연(overdue)** 집계에서 backlog('언젠가 할 일', 아직 착수 약정 아님)를 제외해 지연 뱃지 인플레이션을 줄였다(Backend `today/summary` + Frontend 공통 카드 동일 규칙).

### Fixed
- **'내 할일' KPI 와 오늘 할일 페이지 숫자 불일치 + 날짜 정합**: 홈 '내 할일' KPI 와 `/todo-today` 가 서로 다른 정의로 집계해 숫자가 어긋나던 문제 수정 — 공용 셀렉터(`lib/workItems.ts` 의 `isMyDueTodo`/`isAssignedTo`/`itemDateKey`)로 "내 담당 or 공통 + 미완료 + 시작일 오늘 이하" 정의를 일원화. 그 과정에서 `/todo-today` 의 날짜 버킷도 `.slice(0,10)`(UTC 앞자리) → KST 변환으로 교정(이른 아침 업무가 전날 버킷으로 새던 문제 해소), '오늘' 기준도 자정 자동 갱신(`useToday`).
- **주간 타임라인 막대 텍스트 가독성**: 막대 투명도를 낮추거나(라이트 테마) 상태색이 밝을 때 흰색 라벨이 배경에 묻히던 문제 완화 — 사용자가 고른 텍스트 색은 그대로 두고, 밝기에 따라 반대 색 그림자를 넣어 대비를 보강.
- **업무 현황(홈) '오늘' 상시 갱신 + 잔여 표기 버그**: 홈을 상시 띄워두면 마운트 시각에 '오늘' 이 고정돼 자정 이후 KPI·오늘 하이라이트·지연 판정·당일 스케줄 now 라인이 어긋나던 문제 수정 — 공용 `useToday()` 훅(자정 감지 자동 갱신)으로 HomePage·주간 타임라인·월간 달력·담당자 탭·당일 스케줄의 '오늘' 기준을 통일하고, 당일 스케줄 now 라인은 30초 주기로 갱신. 아울러 주간 타임라인에서 **같은 날 마일스톤이 여러 건이면 서로 겹쳐 그려지던 문제**를 요일 컬럼 안에 세로로 쌓도록 수정, 당일 스케줄 담당자 순환(◀▶)이 목록 밖 이름에서 첫 담당자를 건너뛰던 인덱스 버그도 수정.
- **업무 날짜 규약 KST 통일 (UTC 저장 + KST 표시)**: 정식 업무 폼(`WorkItemForm`)이 날짜/시간을 naive 로컬 문자열로 저장해, 리더가 UTC 로 간주하며 화면에 **+9시간 시프트**되던 문제와, 이른 아침(00:00~08:59 KST) 업무가 전날로 분류되던 문제를 근본 수정. 규약을 앱 canonical(UTC 저장 + KST 표시, QuickAdd·`utcnow` 자동 타임스탬프와 동일)로 일원화. Frontend: `WorkItemForm.toApiDatetime` 을 `toISOString()`(UTC) 직렬화로 변경, 공용 `toLocalDateKey()`(UTC→KST 날짜) 헬퍼로 홈 위젯의 `.slice(0,10)` 날짜 비교를 전부 교체(HomePage/WorkAlarmBell/WeeklyStatusTimeline/MemberTodayTodos). Backend: `today/summary` 의 '오늘' 경계를 KST 자정 기준(`_local_day_bounds_utc`)으로 계산. 기존 데이터 중 구 폼으로 저장된 항목은 편집 시 자동으로 UTC 로 정규화된다(대부분은 이미 정상).
- **업무 현황(홈) 위젯 데이터 100건 잘림 완화**: 홈 KPI·업무 알람 벨·당일 스케줄·주간/월간 뷰가 `GET /work-items` 기본 상한(100건, `started_at` 내림차순)을 그대로 받아, 업무가 100건을 넘으면 가장 오래된(=지연되기 쉬운) 건부터 조용히 잘려 미해결 이슈 KPI 과소집계·지연 알람 누락·과거 달/주 공백이 생기던 문제를 완화. Frontend: 홈 위젯 공용 `useHomeWorkItems()`(상한 500) 도입해 여러 위젯이 캐시를 공유하도록 통일(근본 해법인 화면별 기간 스코프 쿼리는 후속).
- **홈 KPI "미해결 이슈"/"다음 일정" 링크가 죽은 경로(`/items`)로 이동**: 존재하지 않는 라우트라 클릭 시 홈으로 되돌아오던 문제를 `/tasks-mgmt` 로 수정.
- **홈 "내 할일" KPI·업무 알람이 복수 담당자 업무를 누락**: 담당자 필드에 쉼표로 여러 명("A,B")이 들어간 업무를 정확 일치로만 판정해 KPI/알람에서 빠지던 문제 수정 — 공용 `assigneeNames()` 헬퍼로 분리 매칭. Frontend: `HomePage`, `WorkAlarmBell`, `DayScheduleBoard` 가 같은 헬퍼 사용.
- **정식 폼(PUT)으로 업무를 '완료'로 저장해도 완료일이 자동 세팅되지 않음**: `PATCH /status` 만 done 이동 시 `closed_at` 을 채워, 폼 수정으로 done 저장 시 `closed_at` 이 비어 미해결 이슈 KPI 에 완료 항목이 남거나 주간 막대가 무한 연장되던 문제 수정. 재오픈(done 이탈) 시에는 명시 입력이 없으면 완료일을 해제. Backend: `work_items.update_work_item`.
- **홈에서 업무 등록 후 담당자 탭 미갱신**: 업무 생성/수정/삭제/상태변경이 담당자·오늘 요약(`items/today`) 쿼리를 무효화하지 않아 최대 60초 지연되던 문제 수정. Frontend: 뮤테이션 성공 시 요약 쿼리도 함께 무효화.
- **홈 "다음 일정" KPI 부정확**: 지난 24시간 내 시작 업무까지 후보에 넣어 어제 업무가 "다음 일정"으로 표기되고, 회의/교육 유형 일정은 제외되던 문제 수정 — 미래 시작(작업/회의/교육/기타) 건만 대상으로 변경.
- **월간 달력(WorkCalendar) 표기 불일치**: 제목(`title`)을 무시하고 본문만 표기하던 것을 제목 우선으로 통일하고, 이슈를 작업과 다르게(UTC 앞자리) 버킷팅해 같은 날 등록분이 다른 칸에 놓이던 문제를 로컬 날짜 기준으로 일치시킴.

## [1.11.1] - 2026-07-23

### Added
- **콘솔 화면 stdout/stderr 탭 분리 (`ExecOutputTabs`)**: 노드 일괄 실행·mc 클라이언트·etcdctl 콘솔의 실행 결과에서 stdout 과 stderr 를 위아래로 쌓지 않고 **탭으로 전환**하도록 개선 — 세로 공간을 아끼고 스크롤을 줄인다. 탭 라벨에 **결과 유무 dot(초록=stdout/빨강=stderr)과 라인 수**가 표기되어 클릭 전에 어느 스트림에 내용이 있는지 보이고, 내용이 있는 쪽이 기본 활성 탭이 된다. Frontend: 공용 `ExecOutputTabs` 컴포넌트 신설 + 3개 화면 적용. Cilium BPF Trace 의 raw/직접명령 출력도 plain `<pre>` 에서 `LogViewer` 로 교체(Appearance·필터·복사 툴바 일괄 적용). 콘솔 화면 공통 규칙은 CLAUDE.md "콘솔 화면 표준 패턴" 섹션으로 명문화.

### Changed
- **터미널 Appearance 클러스터 운영등급 자동 적용 확대**: 선택 클러스터가 개발이면 개발 프로파일(기본 **Monokai**), 운영(prod/dr)이면 운영 프로파일이 로그 화면에 자동 적용되도록 개선. 기존에는 mc 클라이언트만 동작하던 것을 공용 훅(`useTerminalEnvSync`)으로 묶어 노드 일괄 실행(다중 선택은 하나라도 운영이면 운영)·etcdctl·Cilium BPF Trace·커널 파라미터에도 적용, 페이지 이탈 시 초기화. 신규 사용자 기본값도 개발=Monokai / 운영=기본(테마 색상)으로 변경(백엔드 `terminal_appearance` 기본값) — Settings → 터미널 Appearance 에서 프로파일별로 저장한 개인 설정이 있으면 그 값이 우선한다.
- **k9s 콘솔 — "연결" 터미널을 드래그 이동형 플로팅 창으로**: "연결" 로 생성되는 인라인 k9s 터미널이 페이지에 고정되지 않고, **헤더를 드래그해 원하는 위치로 옮기고 우하단 모서리로 크기를 조절할 수 있는 플로팅 창**으로 열린다("새 창으로 열기" 없이도 창 이동 가능). 페이지 본문에는 플로팅 창 사용 안내 카드가 남는다. Frontend: `K9sTerminal` 헤더 드래그 핸들(pointer capture) + CSS `resize`, `K9sPage` 세션 안내 카드.

### Fixed
- **k9s "새 창으로 열기" HTTP 접속에서 TypeError**: HTTP(NodePort 등 비보안 컨텍스트)로 접속하면 `crypto.randomUUID` 가 존재하지 않아 "새 창으로 열기" 가 `TypeError: randomUUID is not a function` 으로 실패하던 버그 수정 — 폴백(getRandomValues/Math.random) 있는 `generateUUID()` 를 사용하도록 변경. Frontend: `lib/k9sPopout.ts`.

## [1.11.0] - 2026-07-23

### Added
- **k9s 콘솔 — 별도 창(팝업) 열기**: k9s 콘솔(`/k9s`)에 "새 창으로 열기" 를 추가. 접속 폼의 버튼 또는 터미널 헤더의 pop-out 버튼으로 k9s 세션을 별도 브라우저 창(`/k9s/popup`, 사이드바/네비 없는 전체창)으로 띄워, 메인 화면에서는 다른 페이지로 전환하며 k9s 를 나란히 사용할 수 있다. 접속정보는 URL 이 아닌 `localStorage` 1회용 handoff(팝업이 읽는 즉시 삭제)로 넘긴다. Frontend: `K9sPopupPage` + `lib/k9sPopout.ts`, `K9sTerminal` 에 `onPopOut`/`fill` prop, `App.tsx` 에서 팝업 라우트를 `AppShell` 바깥으로 분기.
- **버그 픽스 로그 패널 (사이드바)**: 사이드바 하단 레일에 "버그 픽스 로그" 아이콘(벌레 아이콘)을 추가. 클릭하면 릴리즈 노트와 동일한 우측 SidePane 이 열리고, `CHANGELOG.md` 의 각 버전 `Fixed` 항목만 모아 버전·날짜별로 나열한다. "무슨 버그가 언제 고쳐졌는지"만 빠르게 훑는 용도. Frontend: `BugFixLogPanel`(release-notes API 재사용) + `Sidebar` 레일 아이콘/SidePane 배선.

### Changed
- **Cilium BPF Trace (`/cilium-trace`) 레이아웃 개편**: mc 클라이언트 콘솔처럼 3개 탭(BPF Inspector / Cilium Monitor / Hubble Flows) 모두 **좌(컨트롤 4) / 우(결과·로그 6)** 10컬럼 그리드로 배치. 조회 결과·스트림 로그 카드가 더 이상 컨트롤 아래로 흐르지 않고 항상 우측 같은 라인에 고정되며(실행 전엔 플레이스홀더), lg 이상에서 로그 영역 내부 스크롤 높이를 화면 높이에 맞춰 키워 세로 공간을 활용한다. Frontend: `CiliumTracePage` 탭 3곳 그리드 래핑 + Hubble 필터 그리드 반응형 조정.
- **노드 일괄 실행 (`/bulk-exec`) 레이아웃 개편**: mc 클라이언트 콘솔처럼 **[타겟 노드 | 명령 메뉴 | 실행 결과]** 를 한 로우(12컬럼 3:4:5 그리드)에 나란히 배치. 실행 결과가 더 이상 아래로 흐르지 않고 항상 우측 같은 자리에 고정되며(실행 전엔 플레이스홀더), 결과 패널 내부에서만 스크롤되어 세 컬럼이 한 화면 폭 안에 들어온다. 카드 padding·행 간격을 줄여 공간 효율을 높였다.

### Fixed
- **k9s 콘솔 — `e`(edit) 셸아웃 에디터 hang·커서 안 먹힘 수정**: k9s 의 `e`(edit)/`v`(view) 는 kubectl edit 처럼 `$KUBE_EDITOR`/`$EDITOR` 로 같은 터미널에 에디터를 셸아웃한다. (1) 에디터 변수가 없거나 서버에 에디터가 없어 **멈춘 것처럼** 보이던 문제 → 세션 시작 시 에디터 보장(운영자 지정 `KUBE_EDITOR`/`EDITOR` 존중, 없으면 종료법이 화면에 보이는 `nano` 우선·없으면 `vi`). (2) 에디터에서 **방향키/커서가 안 먹히던** 문제 → k9s 자체는 tcell 내장 terminfo 로 뜨지만 셸아웃 에디터는 시스템 terminfo(ncurses)를 쓰므로 서버에 `xterm-256color` terminfo 가 없으면(최소/폐쇄망 서버) 방향키 해석 실패. PTY·`TERM` 을 거의 모든 서버에 있는 **`xterm`** 으로 고정하고 k9s 색상은 `COLORTERM=truecolor` 로 유지. Backend: `k9s_ssh._build_k9s_command` prelude + `invoke_shell(term="xterm")`.
- **노드 이미지 배포 "성공했는데 실제 배포 안 됨" 수정 (K8s 1.34 / containerd)**: 배포(prepull) 시 대상 노드에서 pull 이 exit 0 이면 실제 적재 여부와 무관하게 "완료"로 표시되던 문제를 수정. 이제 pull 직후 **런타임에서 실제 존재를 검증**(crictl `inspecti` / nerdctl `image inspect` / ctr `images ls`)해 검증까지 통과해야 성공으로 보고한다. 기본 런타임도 K8s(containerd) 표준인 crictl 로 변경(ctr 폴백 시 namespace 불일치로 kubelet 에 안 보이는 문제 회피). 또한 비대화형 SSH 세션의 최소 PATH 로 `crictl`/`ctr`/`nerdctl` 를 못 찾던 문제를 **PATH 보강**(/usr/local/bin·RKE2/k3s 경로 등)으로 해소. 배포 성공 후 대상 클러스터 이미지 스냅샷을 무효화해 보유/미보유 배지를 갱신하고, K8s API `node.status.images` 는 kubelet 갱신 주기로 지연될 수 있음을 결과 화면에 안내. Backend: `node_images._build_pull_command` 재작성. Frontend: `ImageDistributeDialog` 캐시 무효화 + 안내.
- **로그 뷰어 Appearance(프로파일) 팝오버 잘림**: 로그 출력 툴바의 색상/글꼴(팔레트) 버튼을 누르면 드롭다운이 `LogViewer` 의 `overflow-hidden` 컨테이너(테이블 셀 등 좁은 곳)에 의해 잘려 보이던 버그 수정. Frontend: `LogThemeButton` 의 패널을 `createPortal` 로 `document.body` 에 fixed 앵커링(스크롤/리사이즈 추적)해 클리핑을 회피 — `SearchableSelect`(menuPortal)와 동일 패턴.

## [1.10.0] - 2026-07-21

### Added
- **k9s 콘솔 (`/k9s`)**: 클러스터 control-plane 서버에 내장된 `k9s` TUI 를 SSH 로 실행해 브라우저 웹 터미널로 그대로 스트리밍하는 화면 추가. 좌측 클러스터 사이드바에서 클러스터를 고르고 master 노드·SSH 자격증명(비밀번호/Private Key)을 입력하면 xterm.js 로 실제 k9s 를 조작할 수 있다. 네임스페이스 지정·읽기 전용(`--readonly`) 옵션 지원. Backend: 신규 WebSocket 라우터 `k9s_ssh`(paramiko PTY `invoke_shell` 브리지, admin/operator 만 허용, 세션 감사 로그, `PEP_K9S_SSH_ENABLED` 로 비활성화, 명령은 검증된 조각으로만 조립). Frontend: `K9sPage` + `K9sTerminal` 컴포넌트, `k8sStreamUrls.k9s`.

### Fixed
- **버전 필드 중복 해소**: 릴리스 병합 과정에서 `frontend/package.json` 과 `backend/app/main.py` 에 `version` 필드가 중복(1.9.0/1.8.2)으로 남아 백엔드가 `SyntaxError`(keyword argument repeated)로 기동 불가하던 문제 수정 — 최신 릴리스 값 1.9.0 으로 정리.
- **K8S 노드 이미지 배포 (다른 노드로 prepull)**: 노드 이미지 화면에서 특정 노드가 가진
  이미지를 골라, 아직 그 이미지가 없는 다른 노드로 배포하는 기능. `노드별(Table)` /
  `이미지별` 뷰의 각 이미지 행에 **배포** 버튼이 생기고, 대상 클러스터(출처와 동일 또는
  다른 클러스터)를 선택하면 노드 목록에 **보유/미보유** 배지가 표시되며 기본으로 미보유
  노드가 선택된다. 실행하면 대상 노드에 SSH 접속 후 컨테이너 런타임(crictl/nerdctl/ctr,
  auto 감지)으로 이미지를 레지스트리에서 pull 하고 노드별 결과(stdout/stderr/exit)를 표로
  보여준다. 대용량 tar 전송 없이 병렬로 동작한다(대상 노드가 레지스트리에 도달 가능해야 함).
  - Backend: `node_images` 라우터에 `POST /clusters/{id}/node-images/distribute` 추가 —
    이미지 참조 정규식 검증(shell 인젝션 차단) 후 `ssh_runner.run_bulk` 로 pull 명령
    일괄 실행, `require_operator` 권한 + 감사 로그(`node_image.distribute`). SSH 자격증명은
    요청에만 존재하고 저장되지 않는다.
  - Frontend: `ImageDistributeDialog`(대상 클러스터/노드 선택 · 보유 여부 배지 · 런타임/
    sudo/자격증명 · 결과 표), `nodeImagesApi.distribute`.

## [1.9.0] - 2026-07-21
1.8.2 이후 main 에 병합된 변경 (다음 릴리스 후보).

## [1.8.2] - 2026-07-21

### Added
- **전역 뒤로가기 버튼 (DESIGN.md D-029)**: 사이드바 로고 아래에 어느 화면에서나 이전
  화면으로 돌아가는 뒤로가기 버튼을 추가. 브라우저 히스토리 기반(`navigate(-1)`)으로
  동작하고, 딥링크로 바로 진입해 히스토리가 없을 땐 홈으로 이동하며, 홈 화면에선 숨겨진다.
  (그동안 앱이 사이드바 내비게이션만 있어 전역 뒤로가기 수단이 없던 문제 해소)
- **뒤로가기로 모달 닫기 (D-029 후속)**: `useModalA11y` 에 `historyClose` 옵션을 추가해
  브라우저/폰 뒤로가기 제스처가 열린 모달만 닫고 화면은 유지하도록 연동(운영 점검 상세,
  일일 점검 스냅샷 주기/추적 항목 모달). React Router 히스토리와 협조하는 방식이라 전역
  뒤로가기 버튼의 히스토리 추적과 충돌하지 않는다.
- **모달 접근성 일괄 개선 (D-029 확산)**: 전용 모달 32개(클러스터/애드온/메트릭 추가,
  노드 스펙·버전 수집, 업무 등록, 서비스·토폴로지·플레이북·Isilon 편집 등)에 공통
  접근성 훅을 적용해, 그동안 대다수 모달이 Escape 키로도 닫히지 않고 포커스가 배경으로
  새던 문제를 해소. 모든 모달이 Escape 로 닫히고 포커스가 모달 안에 갇히며(Tab 순환),
  `role="dialog"`/`aria-modal`/제목 라벨을 갖춰 스크린리더 지원이 개선됐다.

### Fixed
- **모달 접근성 공통화 (DESIGN.md R-4 D-026)**: 재사용 훅 `useModalA11y`(Escape 닫기·포커스
  트랩·열릴 때 초점 이동·닫힐 때 복원)를 신설하고, 앱 전역 확인 다이얼로그(`ConfirmDialog`)와
  운영 점검 상세·일일 점검(스냅샷 주기/추적 항목) 모달에 적용 — 키보드로 모달을 닫을 수 없고
  배경으로 포커스가 새어나가던 문제를 해소하고 `role="dialog"`/`aria-modal`/`aria-labelledby`
  를 부여. 남은 자체 모달은 이 훅으로 점진 확산 예정.

### Changed
- **Settings 탭 "LAKE 타입" → "관리 서비스" 개칭**: "LAKE" 는 PEP 서비스 전반에 일반적인
  용어가 아니라 특정 활용 관점에서 붙은 이름이라 탭 라벨/ID(`lake-types`→`mgmt-service`)를
  변경. 딥링크 안내 문구(서비스 인스턴스 등록 모달)와 `docs/SCREENS.md` 도 함께 갱신.
  내부 데이터 모델(`LakeServiceType`)과 백엔드 API 는 변경하지 않음.
- **PEP/APP 서비스 카탈로그 도메인 재편**: PEP 서비스는 DevOps 엔지니어가 운영하는 플랫폼
  인프라(K8s/Cilium/Linux/Keycloak/Nexus/CI-CD/Prometheus/Grafana/AIStor/Network 10종,
  카테고리 없는 평면 목록)로, APP 서비스는 K8s 내부에 배포되는 사용자 서비스(Runtime/
  Catalog/Workbench/AI Ready 카테고리)로 재정의. 그동안 domain='pep' 로 잘못 시드되던
  데이터 플랫폼 8종(Airflow/Spark/Trino/StarRocks/Iceberg/JupyterLab/Superset/Polaris)을
  domain='app' 으로 재배정하고 DataHub 를 추가. Backend: `_seed_default_service_categories`
  를 멱등 마이그레이션으로 재작성(domain='pep' 인 것만 1회 전환해 재시작 시 강제 되돌리던
  문제 제거) + 레거시 pep 카테고리 정리.

## [1.8.1] - 2026-07-21

### Added
- **K8S 자원 관리 요약에 Pod 용량/상태 카드 추가 (카드별 개별 새로고침 지원)**: 클러스터
  선택 시 `클러스터 요약` 아래에 ① **POD 용량 카드** — 스케줄 가능한 Pod 수(Ready·
  비cordon 노드의 allocatable 남은 슬롯) / 전체 Pod 수 / 전체 할당 가능 Pod 수(노드
  `allocatable.pods` 합계), ② **POD 상태 카드** — Running/Pending/Error(CrashLoop
  BackOff 등 포함)/Failed/Succeeded/Unknown 종류별 수치를 상태 색 토큰으로 표시. 각
  카드 헤더에 개별 새로고침 버튼을 둬 필요할 때만 재조회 가능. `클러스터 요약`의
  **파드 (활성)** 스탯도 `활성 / 전체 max-pods 합계`와 여유 스케줄 슬롯 수를 함께
  표기하도록 보강.
  - Backend: `k8s_resources` 라우터에 `GET /k8s/{id}/pods-summary`(노드+파드 병렬
    조회, 용량·상태 버킷 집계) 추가.
  - Frontend: `K8sAllocationPage`에 `PodCapacityStatusCards`(+카드별 `CardHeader`
    새로고침 버튼), `usePodsSummary`(`hooks/useK8sAllocation.ts`), `k8sResourcesApi.
    podsSummary`, `K8sPodsSummaryResponse` 타입.
- **K8S 자원 관리 CPU 할당효율/사용효율 툴팁에 관점 설명 보강**: CPU·MEM 할당효율은
  "쿠버네티스 스케줄러 기준(배치 여유)", CPU 사용효율은 "노드 실사용(모니터링) 기준"
  임을 물음표 툴팁 상단에 한 줄로 먼저 안내해 두 지표의 관점 차이를 바로 이해하도록 함.

### Fixed
- **클러스터 삭제 500 에러 (`deep_check_results` 컬럼 누락, `status`→`message` 순차 발견)**:
  일부 구버전 DB에서 `deep_check_results` 테이블이 모델 대비 `status`/`message`/`details`
  컬럼 없이 생성돼, 클러스터 삭제 시 ORM 이 연관 결과 행의 FK 를 정리하려 컬럼을
  조회하다 `UndefinedColumn` 500 에러가 발생하던 문제를 수정. 세 컬럼 모두
  `_run_migrations()` 에 `_safe_add_column` 으로 보강.
  - **재발 방지 (근본 대응)**: 테이블마다 "새로 생긴 컬럼"을 사람이 직접 나열해 챙기는
    기존 방식은 하나라도 빠지면 배포 후 조용히 있다가 그 컬럼을 건드리는 요청에서만
    500 으로 드러난다(이번 건도 `status` 를 고치고 나니 `message` 가 또 나옴). 앞으로
    같은 유형의 드리프트를 개별 대응하지 않도록, 부팅마다 `Base.metadata` 전체
    테이블/컬럼을 실제 DB 스키마와 비교해 모델에는 있지만 DB에는 없는 컬럼을
    자동으로(nullable 로) 보강하는 안전망 `_sync_missing_model_columns()` 을 추가하고
    startup 시퀀스(`migrations` 다음 단계)에 편입.
  - Backend: `main.py` `_run_migrations()`, `_sync_missing_model_columns()`(신규),
    `lifespan()` startup steps.

## [1.8.0] - 2026-07-21

### Added
- **Jira SSO 파드 내 자동 로그인 (브라우저 불필요) — K8s 배포에서도 원클릭**: 백엔드가
  K8s/컨테이너로 배포되면 파드에 화면이 없어 서버측 Playwright SSO 로그인이 동작할 수
  없던 문제를, **순수 ID/PW 폼 SSO(2차 인증 없음)** 에 한해 브라우저 없이 해결. 설정 ▸
  Jira 연동에서 사내 SSO 아이디/비밀번호를 입력하면 서버(파드)가 httpx 로 SSO 리다이렉트
  체인을 따라가 로그인 폼을 제출하고(Keycloak/CAS/ADFS forms·Jira 자체 login.jsp 대응),
  SAML/OIDC auto-submit 폼도 자동 제출한 뒤 세션 쿠키를 캡처해 `auth_type='sso'` 로
  저장한다 — **playwright·브라우저·이미지 변경 전혀 불필요**(기본 Alpine 이미지 그대로).
  "로그인 정보 저장"(옵트인)을 체크하면 로그인 정보를 암호화 저장해 세션 만료 시
  원클릭 재로그인이 된다. JS 필수 IdP·2차 인증 환경은 아래 로컬 도우미로 폴백.
  - Backend: `services/jira_sso_http.py`(폼 파싱 + 리다이렉트 체인 로그인, 전 예외
    fail-safe), `POST /jira/sso/login` 이 username/password·use_saved·save_login 지원,
    `UserJiraCredential.sso_login_encrypted` 컬럼(암호화, 백업 export 마스킹 대상) +
    마이그레이션, `GET /jira/credential` 에 `has_sso_login` 노출.
  - Frontend: `JiraIntegrationPanel` SSO 블록을 아이디/비밀번호 입력 + 저장 체크박스 +
    (저장 시) 원클릭 재로그인 버튼 중심으로 개편.
- **Jira SSO 로컬 로그인 도우미 (JS 기반 SSO·2차 인증 폴백)**: 파드 내 폼 로그인이
  통하지 않는 환경(JS 필수 IdP 등)을 위해, 참고 프로젝트(lake-task-manager)의 "사용자
  PC 에서 브라우저 실행" 패턴을 도우미 스크립트로 제공. 설정 ▸ Jira 연동에서
  `jira_sso_helper.py` 를 내려받아 본인 PC 에서 실행하면 — PEP 로그인 → 로컬 Chromium
  창에서 SSO 로그인 → 완료 자동 감지(`/rest/api/2/myself` 폴링) → 캡처한 세션 쿠키를
  PEP 자격증명 API 로 자동 등록 + 연결 테스트까지 진행된다. 표준 라이브러리 +
  playwright 만 사용.
  - Backend: `app/resources/jira_sso_helper.py`(도우미 스크립트, 이미지 동봉),
    `GET /jira/sso/helper`(다운로드), `PUT /jira/credential` 이 `auth_type='sso'` 허용.
  - Frontend: `JiraIntegrationPanel` 의 접이식 폴백 섹션에 도우미 다운로드 + 실행명령
    복사 + 안내, 화면 있는 소스 실행 배포용 서버측 브라우저 버튼 포함.

- **개성있는 웹폰트 옵션 (Outfit / Geist)**: 설정 → 화면 UI 설정 → 페이지별 화면 스타일에서
  폰트로 `Outfit`/`Geist` 를 선택할 수 있다. 두 폰트 모두 `@fontsource-variable/*` 로
  빌드 산출물에 직접 번들되어 CDN 요청 없이 동작(폐쇄망 배포 안전). 라틴 문자만
  포함하므로 한글은 자동으로 스택의 한글 폴백 폰트로 렌더링된다.
  - Frontend: `frontend/src/lib/pageStyles.ts`(`PAGE_FONT_OPTIONS`), `frontend/src/main.tsx`
    (폰트 CSS 전역 import).

### Fixed
- **`__default__` 전체 기본 화면 스타일이 항상 무시되던 문제**: API 응답의 camelCase 자동
  변환(`services/api.ts` `convertKeys`)이 `pageStyles` 맵의 센티널 키 `__default__` 를
  일반 필드명으로 오인해 `_Default__` 로 깨뜨려, "전체 기본(모든 페이지)" 로 저장한
  폰트/글자색/배경색 설정이 서버에는 정상 저장되지만 화면에는 절대 반영되지 않던 버그를
  수정. `__...__` 형태의 dunder 키는 camelCase/snake_case 변환에서 제외한다.
- **클러스터 대시보드(`/cluster-overview`) UX 감사 후속 정리 9건**:
  - 툴바에 "Metric" 추가 버튼이 operator/admin 로그인 시 중복 렌더되던 버그 수정
    (`Dashboard.tsx`).
  - 삭제 확인이 브라우저 네이티브 `confirm()`(스타일 불가, 접근성 열악)으로 처리되던
    4곳(점검 항목/애드온/메트릭 카드/플레이북 삭제)을 프로젝트 표준 `ConfirmDialog` 로
    전환.
  - "리포트 다운로드" 실패 시 콘솔 로그만 남고 사용자에게 아무 피드백이 없던 문제를
    토스트 에러로 노출.
  - `purple-500`/`amber-500` 등 테마 비인지 고정 Tailwind 팔레트 색상을 토큰으로 전환:
    새 `--brand-ai`(AI 기능 배지) 토큰 추가, 클러스터 provider 선택 색상은 기존
    `--chart-N` 카테고리 토큰으로, "임시 가등록" 경고 계열은 `--status-warning` 으로
    통일(`index.css`, `tailwind.config.js`, `Dashboard.tsx`, `ClusterItemCard.tsx`,
    `AddClusterModal.tsx`, `ConfirmDialog.tsx`).
  - 툴바 버튼 라운딩(`rounded-lg`/`rounded-xl` 혼용)과 차트 툴팁의 하드코딩
    `rgba(255,255,255,0.05)`(라이트 테마에서 사실상 안 보임)를 테마 토큰 기준으로 통일.
  - 애드온/현황 아이템 카드에 섞여 있던 장식용 이모지(👑📋⏱⚠)를 같은 카드에서 이미 쓰는
    lucide 아이콘으로 통일(사용자 지정 아이콘 데이터 필드는 유지).
  - 툴바 버튼 라벨과 일부 카드 empty-state 문구의 영어/한글 혼용을 한글로 통일.
  - "전체 현황" 클러스터 카드의 hover 모션(`shadow-md`)을 다른 카드와 동일한
    `-translate-y-0.5` 로 정렬(라이트/다크 테마의 "그림자 없음" 원칙과도 합치).

## [1.7.4] - 2026-07-20

### Fixed
- **CD 백엔드 이미지 빌드 실패 (playwright ↔ Alpine 비호환)**: PR #489 가 Jira SSO 자동
  로그인용 `playwright` 를 `requirements.txt` 에 추가하면서, 백엔드 기본 이미지
  (`backend/Dockerfile`, `python:3.11-alpine`)의 `pip install -r requirements.txt` 가
  매 커밋마다 100% 실패해 `main` 의 모든 배포가 막혀 있던 문제를 수정. `playwright` 는
  musllinux(Alpine) wheel 을 배포하지 않아 어떤 버전을 pin 해도 Alpine 위에서는 설치
  자체가 불가능하다(버전 문제가 아니라 근본적 비호환). 참고 프로젝트(lake-task-manager)도
  이 optional 의존성을 별도 파일로 분리하고 컨테이너가 아닌 소스 실행으로 배포하는
  것을 확인 — 동일 패턴으로 `playwright` 를 `requirements.txt` 에서 빼 신설
  `backend/requirements-sso.txt` 로 분리했다. 기본 배포 이미지는 이 파일을 설치하지
  않으며, `services/jira_sso_service.py` 가 이미 `ImportError` 를 fail-safe 로 처리하므로
  SSO 자동 로그인만 "Playwright 미설치" 에러로 비활성화되고 기존 PAT/수동 쿠키 등록
  경로와 앱 기동 자체는 영향받지 않는다.

### Fixed
- **Jira SSO 자동 로그인 — 다른 탭에서 로그인해도 세션 감지**: SSO 가 새 탭에서 완료되거나
  사용자가 초기 탭이 아닌 다른 탭에서 Jira 에 로그인하면, 초기 페이지 하나만 폴링하던 기존
  로직이 로그인을 감지하지 못해 세션이 저장되지 않던 문제 수정. 이제 브라우저 컨텍스트의
  **모든 탭**을 순회해 Jira 오리진 탭에서 in-page fetch 로 세션을 확인하고, 실패 시 진단
  메시지에 열린 탭 호스트 목록을 노출한다.
  - Backend: `jira_sso_service.capture_sso_session` 의 `_probe_page` → `_probe_pages`
    (context.pages 전체 순회), 진단값 `tab_hosts` 추가.

## [1.7.3] - 2026-07-20

### Fixed
- **main CI 회귀 수정 (#485/#486 머지 후)**: 두 PR 을 잇따라 병합하는 과정에서 발생한
  텍스트 레벨 자동 병합 오류를 바로잡음(브랜치 히스토리상 실제 충돌 마커는 없었지만
  같은 위치를 건드린 두 변경이 잘못 겹쳐써짐).
  - **프런트 lint 파싱 에러**: `OpsCheckConsolePage.tsx` 의 "마지막 실행 상태" 셀에
    `StatusDot`(구버전, import 없음)+`parseUTC` 블록과 `StatusBadge`(디자인 토큰
    수렴 결과)+`new Date` 블록이 태그가 안 닫힌 채 중복 삽입돼 있던 것을 정리 —
    `StatusBadge`(디자인 컨벤션) + `parseUTC`(KST 정확한 시각 표시) 로 통합.
  - **백엔드 테스트 실패**: 배치잡 cron 등록 시 `default_host` 를 요구하는 가드(H-9)를
    추가하면서, 자격증명만 검증하던 기존 `_require_cron_credentials` 단위 테스트 3건이
    `default_host` 를 넘기지 않아 422 로 실패하던 것을 테스트에 `default_host` 를
    포함하도록 갱신하고, `default_host` 누락 케이스를 검증하는 테스트를 추가.

### Fixed
- **최상단 시스템(설정) 아이콘 원클릭 진입**: 사이드바 푸터의 시스템 아이콘이 하위 경로가
  1개(`/settings`)뿐인데도 플라이아웃을 먼저 열어 한 번 더 클릭해야 이동되던 불필요한
  hop 을 제거 — 상단 그룹 레일과 동일하게 단일 경로면 바로 이동하도록 통일.
- **클러스터 삭제 500 에러 (`deep_check_results.check_type` 컬럼 누락)**: 구버전 DB 에서
  `deep_check_results` 테이블에 `check_type` 컬럼이 마이그레이션되지 않아, 클러스터 삭제 시
  SQLAlchemy 가 연관 로우를 조회하며 `UndefinedColumn` 500 을 던지던 문제 수정 — 마이그레이션에
  `check_type` 컬럼 보강(backfill 포함)을 추가하고, 클러스터 삭제 라우터가 `deep_check_results`
  를 명시적으로 먼저 삭제하도록 변경.
- **주요 화면 상태색 테마 정합·접근성·안정성 (DESIGN.md R-4 1차: 홈·대시보드·운영점검·업무)**:
  홈/대시보드/업무/운영점검 콘솔의 상태색 고정 팔레트(`-400/-500`)를 `--status-*` 토큰으로
  전환해 라이트/다크 테마에서 상태 대비가 일관되게 유지되도록 함. 홈 KPI·당일 일정·주간
  타임라인·운영점검 카탈로그에 **에러 상태 분기(재시도 버튼)** 를 추가해 API 실패가
  "0건/빈 목록"으로 위장되던 문제를 해소. 업무 게시판 인라인 편집 셀·담당자 칩을 **키보드로
  열 수 있도록**(role/tabindex/Enter·Space) 개선하고, 운영점검 "마지막 실행 상태"를 색 단독
  전달에서 아이콘+텍스트 배지로 교체. 점검 이력 히트맵의 날짜 버킷을 KST 기준으로 바로잡아
  심야 점검이 전날 칸으로 밀리던 오배치를 수정. 업무 삭제 확인 문구 정정.
- **운영 점검 실행 전 확인 다이얼로그**: 운영 점검 콘솔의 개별·선택 실행을 모두 운영 위험
  레벨로 간주해, 실행 전 대상 클러스터·항목 수와 소스별(SSH/Ansible/점검/애드온) 목록을
  요약한 확인 다이얼로그를 거치도록 변경 — 실서버로 원격 명령이 오클릭으로 나가던 위험 차단.
- **주요 화면 상태색 테마 정합·접근성·안정성 2차 (DESIGN.md R-4 2차: K8s 상세관리·K8s 자원관리·
  일일점검 리뷰·LAKE)**: 네 화면의 상태색 고정 팔레트를 `--status-*` 토큰으로 전환(라이트/다크
  대비 정합), K8s 상세관리 개요·K8s 자원관리 요약·일일점검 리뷰/추이에 **에러 상태 분기**를
  추가해 장애를 "빈 상태"로 위장하던 문제를 해소. K8s 상세관리의 scale/restart/delete/drain
  위험 동작을 브라우저 native 팝업에서 **테마·포커스가 확보된 확인 다이얼로그**(대상 리소스
  강조, scale 은 정수 입력)로 교체. K8s 자원관리 드릴다운 행·LAKE 서비스 카드를 키보드로 조작
  가능하게 하고, 노드 Ready/컨테이너 상태를 색 단독에서 아이콘+라벨 병행으로 개선. 점검 추이
  차트 라인을 토큰화하고 색 외에 실선/파선/점선으로 구분.

### Changed
- **주요 화면 반응형·정합 정리 2차 (R-4)**: K8s 상세관리의 다열 리소스 테이블에 가로 스크롤
  컨테이너를 적용하고, LAKE 서비스의 인라인 그리드 스타일·비표준 그림자·버튼 라운딩을 표준에
  맞춰 정리. LAKE HealthBadge 를 공용 StatusBadge 로 통합.

### Changed
- **Settings "서비스" 탭을 "PEP 서비스"로 이름 변경 + 사이드바 "PEP 서비스" 진입점을 서비스
  카탈로그로 재연결**: 사이드바 "PEP 서비스" 아이콘이 지금까지는 LakeService 기반 카탈로그
  (`/pep-services` — Runtime/Catalog/Workflow/JupyterLab 인스턴스 그리드)를 가리켰는데, 이는
  Settings "서비스" 탭(`ui_settings.serviceCatalog` — k8s/keycloak/nexus/jenkins/argocd 등
  devops 인프라 서비스 카탈로그)과는 무관한 별개 데이터였다. 이제 사이드바 "PEP 서비스"는
  서비스 카탈로그 / 통합지식(`/services` → `/services/:service`)으로 연결되어, 클릭 시 서비스별
  작업 계획서·업무 소개·이슈 대응·구축 작업 노트와 연관 업무를 바로 확인할 수 있다. 기존
  `/pep-services`(LakeService) 화면은 라우트/데이터 그대로 유지되나 사이드바 노출은 종료(`/docs`와
  동일하게 직접 URL 접근만 가능). Frontend: `pages/SettingsPage.tsx`,
  `components/layout/navConfig.ts`, `pages/ServicesCatalogPage.tsx`,
  `components/settings/ServiceCatalogManager.tsx`.

- **홈 "담당자별 진행 현황" 최상단 행/카드를 "전체"→"공통"으로 변경**: 지금까지 최상단
  행(`WeeklyStatusTimeline`)은 이번 주 모든 업무를 단순 병합해 보여줘 "전체 = 모든 업무
  목록"처럼 보였다. 이제 파트 전체 대상 업무(업무 등록 시 "공통업무" 체크,
  `allAttendees=true` — 예: 파트 회의)만 모아 "공통" 행/카드로 표시한다. `MemberTodayTodos`
  (담당자 탭)는 원래도 `allAttendees` 기준으로 동작했으나 라벨만 "전체"→"공통"으로 맞춤.
  Frontend: `components/dashboard/WeeklyStatusTimeline.tsx`,
  `components/dashboard/MemberTodayTodos.tsx`.

- **디자인 컨벤션 정리 2차 (DESIGN.md D-009·D-010)**: 수제 카드 페이지 9개
  (NodeLabels/KernelParams/McClient/TrendDigest/TodoToday/Versions/EtcdCtl/
  KnowledgeHub/JiraExcelImport)의 섹션 카드 28건을 MacCard 로 수렴하고, pages/
  전체 아이콘 전용 버튼에 `aria-label` 83건 병행(K8sManage 공용 IconBtn 은
  aria-label 기본 배선) — 보드/캔버스형 페이지는 구조 리스크로 보류 기록.
- **주요 화면 카드/레이아웃 표준화 (R-4)**: 업무 게시판의 수제 카드 3곳을 MacCard 로
  수렴하고, 클러스터 대시보드 컨테이너 행의 센터링/좌측 패딩을 제거해 보조 사이드바가
  메인 사이드바에 flush 되도록 정렬 표준을 맞춤.

### Fixed
- **상용 출시 전 보안/안정성 점검 후속 조치 (Low 5건)**: Blocker/High/Medium 조치에 이어
  잔여 Low 등급 항목을 마저 반영.
  - **SSH 호스트 키 무검증**: 배치잡/명령 실행이 `paramiko.AutoAddPolicy()` 로 첫 접속
    시 호스트 키를 무조건 신뢰하고 이후에도 검증 없이 재사용하던 것을, Redis 에
    최초 접속 시 키를 기록(TOFU, 90일 TTL)하고 이후 접속에서 paramiko 자체 검증으로
    불일치 시 접속을 거부하도록 전환(`ssh_host_keys.py` 신규). Redis 장애 시에는
    기존 동작으로 fail-open(재배포/Redis 재시작 시 기록된 키는 초기화됨 — 알려진
    한계).
  - **PromQL 카드 관리 권한 노출**: `/promql/cards` 생성/수정/삭제와 임의 PromQL 즉시
    실행 프로브(`test_query`)가 인증만으로 접근 가능해 viewer 도 내부 Prometheus 를
    정찰/수정할 수 있던 것을 operator 이상으로 제한(조회 계열 엔드포인트는 viewer
    유지). 프런트 Dashboard 도 operator 미만에게 카드 추가/편집/삭제 아이콘을 숨김.
  - **DB 커넥션 풀 크기 고정**: backend/celery worker/beat 가 동일 engine 코드를
    공유하면서 각각 기본 풀(10+20)을 쓰면 replica 합계가 Postgres 기본
    `max_connections`(100)를 쉽게 넘던 것을, `DB_POOL_SIZE`/`DB_MAX_OVERFLOW`
    환경변수로 설정 가능하게 하고 celery worker(3+5)/beat(2+3) 매니페스트에 더 작은
    값을 오버라이드.
  - **리치 텍스트 렌더링 방어 강화**: `RichContent` 의 DOMPurify sanitize 이후 단계에
    후처리 훅을 추가 — `target="_blank"` 링크에 `rel="noopener noreferrer"` 를 강제해
    reverse-tabnabbing 을 막고, `style` 속성을 색상/정렬 등 화이트리스트 속성만
    남기도록 필터링해 `position:fixed` 오버레이 등을 이용한 UI 위장(피싱 배너 흉내)을
    차단.
  - **감사 로그 기록 경로 점검**: 주요 변경 작업의 audit log 기록이 실패해도 본 요청이
    막히지 않는 fail-safe 패턴을 재확인(코드 변경 없음).

- **상용 출시 전 보안/안정성 점검 후속 조치 (Medium 8건)**: Blocker/High 조치에 이어
  Medium 등급 항목을 마저 반영.
  - **kubewatch ingest fail-closed**: `KUBEWATCH_TOKEN` 미설정 시 무인증으로 웹훅을
    수락하던 것을 deep_check ingest 와 동일하게 fail-closed(503)로 전환 +
    `secrets.compare_digest` 적용.
  - **로그인 무차별 대입 방어**: `/auth/login` 에 Redis 기반 rate limit 추가 — IP 단위
    (창 5분/20회) + 계정 단위(창 15분/5회) 이중 방어. Redis 불가 시 로그인 자체는
    막지 않는 fail-open(다른 외부 서비스와 동일 컨벤션).
  - **PromQL 카드 조회 성능**: `/promql/query/all` 이 카드를 직렬 실행하고 매 호출
    새 httpx 클라이언트를 만들던 것을 병렬 실행(`asyncio.gather`) + 클라이언트 재사용
    + 15초 TTL 캐시로 개선 — 대시보드 탭 여러 개가 동시에 폴링해도 Prometheus 부하가
    상수화된다.
  - **점검 이력 N+1 + CSV 무제한 export**: `history.py` 의 `log.cluster.name`/addon
    조회가 행마다 별도 쿼리를 날리던 것을 `joinedload` 로 묶고, CSV export 에 상한
    (기본 5000, 최대 20000행)을 추가.
  - **멀티 replica 마이그레이션 직렬화**: backend/celery 여러 replica 가 동시에 부팅
    시 스키마 마이그레이션이 카탈로그 레벨 race 로 드물게 스킵될 수 있던 것을 세션
    advisory lock 으로 부팅 시퀀스 전체를 직렬화하도록 수정(pgvector 확장 생성은 기존
    xact-lock 그대로 유지).
  - **배치잡 디스패처 중복 실행 방지**: cron 잡을 큐잉만 하고 워커가 늦게 시작하면
    다음 분 디스패처가 같은 잡을 또 큐잉하던 문제를, 큐잉 시점에 바로 anchor
    (`last_run_at`)를 전진시키도록 수정.
  - **저장 모달 에러 처리**: `AddMetricCardModal`/`AddAddonModal`/`ClusterItemModal`
    이 `mutate()` 를 fire-and-forget 으로 호출하고 결과와 무관하게 즉시 모달을 닫던
    것을, `mutateAsync` + 실패 시 모달 유지 + 에러 토스트로 통일.
  - **kubeconfig 저장 암호화**: `clusters.kubeconfig_content` 를 평문으로 저장하던
    것을 `secret_box` 로 투명 암호화하는 SQLAlchemy 컬럼 타입(`EncryptedText`)으로
    전환. 기존 평문 행은 복호화 실패 시 그대로 반환(lazy migration)해 별도 백필
    없이 다음 저장 시 자동으로 암호화된다.

- **상용 출시 전 보안/안정성 점검 후속 조치 (High 11건)**: Blocker 조치에 이어 High
  등급 항목을 마저 반영.
  - **인증/인가**: `ui-settings` 의 앱 설정/클러스터 링크/담당자/운영레벨 PUT 엔드포인트가
    인증만으로 접근 가능하던 것을 admin 전용으로 강제(feature-access 와 동일 패턴).
  - **클러스터 삭제 500 수정**: deep_check_results/batch_jobs(+runs)/ops_check_runs/
    os_param_changes/ansible_inventories 를 선삭제하지 않아 FK 위반으로 실패하던
    `DELETE /clusters/{id}` 를 수정 — deep check 가 한 번이라도 돈 클러스터는 삭제가
    불가능했다.
  - **멀티클러스터 점검 격리**: deep checker 가 `config.load_kube_config()`(프로세스
    전역 상태)를 사용해 동시 실행 시 한 클러스터의 kubeconfig 로 다른 클러스터를
    점검할 수 있던 race 를 `new_client_from_config()` 격리로 수정(daily_checker.py 와
    동일 패턴).
  - **배치잡 재시도 스톰 방지**: `default_host` 없이 cron 이 걸린 배치잡이 매분 실패
    → 재큐잉을 반복하던 문제를 저장 시점 검증(운영자) + 실패 시에도 `last_run_at`
    갱신(자가 치유)으로 이중 차단.
  - **K8s SDK 타임아웃/이벤트 루프 블로킹**: daily checker 의 K8s SDK 호출에 클라이언트
    타임아웃(`_request_timeout`)이 없어 무응답 클러스터가 디스패처를 무기한 붙잡던
    문제, 그리고 `POST /daily-check/run` 이 동기 SDK 호출로 FastAPI 이벤트 루프 자체를
    막던 문제(`asyncio.to_thread` 로 오프로드)를 수정.
  - **Celery 안정성**: Redis 브로커의 `allkeys-lru` eviction 정책이 예약 점검/배치잡
    큐 자체를 지울 수 있던 것을 `noeviction` + 메모리 여유로 수정, 결과를 아무도
    조회하지 않는 매분 디스패처류 태스크 10개에 `ignore_result=True` 적용.
  - **AI 리뷰 큐 부하 완화**: core_bundle 점검마다 무조건 Ollama 리뷰를 큐잉하던 것을
    상태 변화가 있거나 healthy 가 아닐 때만 큐잉하도록 게이팅 — 작은 워커 동시성이
    Ollama 대기로 계속 점유돼 배치잡/수동 점검이 밀리던 문제 완화.
  - **로그 테이블 리텐션**: `daily_check_logs`/`check_logs`/`k8s_events`/`audit_logs`/
    `user_notifications` 가 purge 대상이 아니어서 무기한 증가하던 것을 청크 삭제
    리텐션(각 21~365일)으로 정리, 관련 조회 인덱스도 보강.
  - **Pod exec/SSE 안정성**: nginx `proxy_read_timeout` 60s 로 대화형 터미널이 끊기던
    문제를 exec/스트림 경로 전용 location(3600s)으로 수정, 파드 로그·이벤트 SSE 응답에
    `X-Accel-Buffering: no` 를 추가해 nginx 버퍼링으로 실시간성이 사라지던 문제 수정.
    frontend nginx 설정에 CSP 등 보안 헤더도 추가(docker-compose/k8s 두 설정 동기화).
  - **시각 표시 오류**: `parseUTC` 유틸을 거치지 않고 `new Date()`로 API 타임스탬프를
    직접 파싱해 9시간(KST) 어긋나게 표시되던 지점 20여 곳(감사 로그, 점검 이력, VOC,
    트렌드, Lake 서비스, Isilon, 홈 "다음 마감" 등)을 일괄 수정.

## [1.7.1] - 2026-07-20

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

### Added
- **Jira SSO 자동 로그인 — 세션 쿠키 자동 캡처 (수동 복사 제거)**: 참고 프로젝트
  (lake-task-manager)의 "Playwright SSO 세션 재사용"을 PEP 에 구현. 설정 ▸ Jira 연동의
  **"브라우저로 SSO 로그인"** 버튼을 누르면 백엔드가 브라우저를 띄우고, 사용자가 평소처럼
  사내 SSO 로그인만 마치면 세션 쿠키를 자동으로 캡처·저장한다(토큰/쿠키 직접 복사 불필요).
  캡처한 쿠키는 기존 `auth_type='sso'` REST 경로로 가져오기·되쓰기에 그대로 쓰인다. 기존
  PAT/수동 쿠키 등록은 "수동 등록" 대체 수단으로 유지.
  - Backend: `services/jira_sso_service.py`(`capture_sso_session` — Playwright 헤디드 로그인 +
    myself 폴링 + 호스트 범위 쿠키 헤더 빌드, 전 예외 fail-safe), `POST /jira/sso/login`
    (`asyncio.to_thread` 로 블로킹 로그인 실행 후 쿠키 검증·저장), `auth_type` 에 'sso' 추가,
    `requirements-sso.txt`(optional) 에 playwright 추가 — 기본 배포 이미지에는
    설치하지 않는다(아래 Fixed 참고).
  - Frontend: `JiraIntegrationPanel` 에 SSO 로그인(권장) 블록 + 수동 등록 접이식 섹션.
  - 배포 주의: 헤디드 브라우저라 백엔드 호스트에 표시 가능한 디스플레이 필요(헤드리스
    K8s 면 Xvfb/noVNC 등 원격 화면 계층이 추가로 필요).
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

## [1.5.1] - 2026-07-16

### Added
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
