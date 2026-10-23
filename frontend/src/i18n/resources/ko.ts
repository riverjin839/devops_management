/**
 * 한국어 리소스 — **원천 로케일**. 키 구조는 여기서 정하고 `en.ts` 가 같은 모양을 빠짐없이 따른다
 * (`TranslationResource` 타입이 강제 — en 에 키가 빠지거나 남으면 tsc 가 실패한다).
 *
 * 키 규칙(DESIGN_SYSTEM.md §12 i18n):
 *  - 최상위는 영역 접두 — `nav.*`(메뉴·그룹), `shell.*`(사이드바·상단바·flyout), `home.*`(홈), `login.*`(로그인),
 *    `common.*`(공용 확인창·빈/로딩/오류 상태), `apps.*`(앱 추가 카탈로그), `palette.*`(커맨드 팔레트),
 *    `theme.*`(테마 갤러리 — 테마·강조색 이름은 `shell.theme.*`·`shell.accent.*`), `settings.*`(Settings 화면).
 *  - 그 아래는 화면 요소 단위 camelCase 묶음(`shell.help.releaseNotes`). 문장 그대로를 키로 쓰지 않는다.
 *  - 변수는 `{{name}}` 보간. 문자열을 이어 붙여 문장을 만들지 않는다(어순이 언어마다 다르다).
 */
export const ko = {
  nav: {
    /** NAV_MAP 의 `labelKey` — 경로를 camelCase 로 옮긴 이름(`/daily-check/review` → `dailyCheckReview`). */
    page: {
      home: '홈',
      island: '나의 아일랜드',
      k8sHub: 'K8s 클러스터',
      k8sManage: 'K8s 상세 관리',
      k8sAllocation: 'K8s 자원 관리',
      k9s: 'k9s 콘솔',
      clusterTrends: '클러스터 추이',
      clusters: '클러스터 상세',
      opsChecks: '운영 점검',
      k8sLogs: '파드 로그',
      dailyCheckReview: '점검 결과 리뷰',
      dailyCheckSettings: '점검 항목 관리',
      lakeServices: 'LAKE 서비스',
      podBottleneck: '파드 병목 진단',
      docs: '지식 허브 홈',
      playbooks: '플레이북',
      tasksMgmt: '업무 관리',
      todoToday: '오늘 할 일',
      sprints: '스프린트',
      members: '멤버별 업무',
      clusterManage: '클러스터 관리',
      versions: '버전 / 설정',
      bulkExec: '노드 일괄 실행',
      nodeSsh: '노드 SSH 터미널',
      etcdctl: 'etcdctl 콘솔',
      batchJobs: '배치잡',
      mc: 'mc 클라이언트',
      isilonNfs: 'NFS 모니터링',
      kernelParams: '커널 파라미터',
      infraTopology: '인프라 토폴로지',
      nodeSpecs: '노드 서버스펙',
      links: '클러스터 링크',
      nodeLabels: 'K8s 노드 라벨',
      k8sRbac: 'K8s 접근 권한',
      nsMigration: 'NS 마이그레이션',
      nodeImages: 'K8s 노드 이미지',
      cidr: 'CIDR 계산기',
      k8sEvents: 'K8s 실시간 이벤트',
      observability: '관측 지표',
      alerts: '알람 인박스',
      incidentAnalysis: 'K8s 로그 (분석·실시간)',
      packetFlow: '패킷 흐름 분석',
      ciliumTrace: 'Cilium BPF 추적',
      serviceTopology: '서비스 토폴로지',
      serviceArchitecture: '서비스 아키텍처',
      architecture: '서비스 모듈 관계도',
      ontology: '온톨로지 그래프',
      trends: '기술 동향',
      workGuides: '표준 작업 가이드',
      commands: '주요 명령어',
      scripts: '스크립트 라이브러리',
      opsNotes: '운영 노트보드',
      wbs: 'WBS 작업흐름',
      mindmap: '마인드맵',
      workflow: '워크플로',
      settings: '설정',
      jiraImport: 'Jira Excel 가져오기',
      weeklyReport: '주간보고',
      documents: '문서 관리',
    },
    /** GROUPS 의 `labelKey`(= 그룹 id). */
    group: {
      k8s: 'K8s 클러스터',
      observe: '관측',
      inspect: '점검·진단',
      operate: '운영 조작',
      configure: '구성·자산',
      topology: '토폴로지',
      automate: '자동화·도구',
      collab: '업무',
      documents: '지식·문서',
      system: '시스템',
    },
    /** GROUPS 의 `descriptionKey` — 설명이 있는 그룹만. */
    groupDesc: {
      k8s: '클러스터 하나를 골라 상세·리소스·자원·관측·로그·점검·구성·콘솔을 한 화면에서',
      observe: '상태를 본다 — 읽기 전용',
      inspect: '상태를 확인·기록하고 원인을 추적한다',
      operate: '클러스터·노드·스토리지에 명령을 보낸다 — 실행 전 대상을 확인할 것',
      configure: '클러스터 등록·자원·권한·노드 자산을 관리한다',
      topology: '인프라·서비스 구조를 지도로 본다',
      automate: '플레이북·스크립트·명령어·계산기',
    },
  },
  shell: {
    homeButton: '홈으로',
    mainNav: '메인 네비게이션',
    back: '뒤로가기',
    favorites: '즐겨찾기',
    aiAssistant: 'AI 어시스턴트',
    sidebarCatalog: {
      title: '사이드바에 앱 추가',
      description: '필요한 화면만 골라 레일에 추가한다.',
    },
    help: {
      title: '도움말·지원',
      searchScreens: '화면 검색',
      voc: '사용자 VOC 게시판',
      releaseNotes: '릴리즈 노트',
      bugFixLog: '버그 픽스 로그',
      bugFixLogHint: 'admin 전용 — 개발팀 내부 산출물',
    },
    user: {
      profile: '내 정보 · 담당 설정',
      changePassword: '비밀번호 변경',
      exportSettings: '개인 설정 내보내기',
      exportSettingsHint: '홈·사이드바·즐겨찾기·터미널 색상·테마 등 내 설정을 파일로 받는다(비밀번호 제외)',
      importSettings: '개인 설정 가져오기',
      importSettingsHint: '내보낸 파일로 내 설정을 바꾼다 — 새 환경·새 PC 로 옮길 때',
      theme: '테마',
      accent: '강조색',
      accentDisabledHint:
        '그림 테마(움버·플래스터·아침 식사·릴리프·할리퀸과 목걸이를 한 여인·오장팡 자개·김환기 창·피카소·후안 그리스)와 컴포트·고대비 바탕은 자체 색을 써서 강조색을 바꿀 수 없다',
      language: '언어',
      logout: '로그아웃',
    },
    logout: {
      title: '로그아웃',
      description: '작성 중인 내용은 저장되지 않습니다. 로그아웃할까요?',
      confirm: '로그아웃',
    },
    /** stores/themeStore.ts 의 THEMES 와 같은 id. */
    theme: {
      light: '라이트 (기본)',
      dark: '다크',
      comfort: '컴포트',
      'high-contrast': '고대비',
      umber: '움버',
      'umber-light': '움버 라이트',
      plaster: '플래스터',
      journal: '아침 식사',
      relief: '릴리프',
      harlequin: '할리퀸과 목걸이를 한 여인',
      ozenfant: '오장팡 자개',
      whanki: '김환기 창',
      'picasso-girl': '피카소 소녀의 머리',
      'picasso-portrait': '피카소 소녀의 초상',
      'picasso-violin': '피카소 바이올린',
      'gris-guitar': '후안 그리스 기타',
      system: '시스템',
    },
    /** stores/themeStore.ts 의 ACCENTS 와 같은 id. */
    accent: {
      blue: '블루',
      teal: '틸',
      green: '그린',
      amber: '앰버',
      coral: '코랄',
      violet: '바이올렛',
    },
    topbar: {
      greeting: '{{name}}님',
      workNav: '업무',
      menu: '메뉴',
      workMenu: '업무 메뉴',
      search: '화면 검색',
      searchHint: '화면 검색 (Ctrl/⌘+K)',
      noApps: '설치된 앱이 없습니다.',
      teamShared: '팀 공유',
      sharedFallback: '공유',
      catalog: {
        title: '상단바에 앱 추가',
        description: '이름 옆에 필요한 업무 화면만 골라 추가한다.',
      },
    },
    flyout: {
      close: '닫기',
      pin: '즐겨찾기 추가',
      unpin: '즐겨찾기 해제',
      pinLabel: '{{label}} 즐겨찾기 추가',
      unpinLabel: '{{label}} 즐겨찾기 해제',
    },
  },
  home: {
    title: '홈',
    tabsAria: '홈 화면 보기',
    tab: {
      work: '업무 현황',
      platform: '플랫폼 현황',
      badgeTitle: '위험 클러스터 {{clusters}}곳 · 위험 셀 {{cells}}개',
    },
    view: {
      matrix: '점검 매트릭스',
      batch: '배치잡',
    },
    card: {
      schedule: '당일 스케줄',
      progress: '담당자별 진행 현황',
    },
    range: {
      week: '주간',
      month: '월간',
      member: '담당자',
    },
  },
  /** 여러 화면이 함께 쓰는 공용 UI — ConfirmDialog·EmptyState 계열의 기본 문구. */
  common: {
    action: {
      save: '저장',
      cancel: '취소',
      run: '실행',
      close: '닫기',
      retry: '다시 시도',
    },
    status: {
      loading: '불러오는 중…',
      processing: '처리 중…',
    },
    selectCluster: {
      title: '클러스터를 선택하세요',
      description: '왼쪽 사이드바에서 클러스터를 고르면 이 화면의 내용이 표시됩니다.',
    },
    error: {
      loadFailed: '불러오지 못했습니다',
      forbiddenTitle: '이 화면을 볼 권한이 없습니다',
      forbiddenHint: '관리자에게 권한을 요청하세요.',
      /** `lib/utils.ts` `formatApiError` 의 기본 문구 — 호출부가 fallback 을 넘기면 그 값이 우선. */
      requestFailed: '요청 실패',
      canceled: '취소됨',
    },
    /** `common/ScreenCatalogList` — 아일랜드 화면 추가 피커·Settings 화면별 노출 관리가 함께 쓴다. */
    screenCatalog: {
      searchPlaceholder: '화면 이름으로 검색',
      searchLabel: '화면 검색',
      empty: '조건에 맞는 화면이 없습니다.',
      emptyHint: '검색어를 바꾸거나 지워 보세요.',
      ungrouped: '기타',
    },
    /** 오류 토스트의 요청 ID 동작(Toast — lib/requestId.ts). */
    requestId: {
      label: '요청 ID',
      copy: '요청 ID 복사',
      copied: '복사됨',
      openCause: '원인 보기',
    },
  },
  /** Settings ▸ 화면 UI 설정 — 조직 기본 앱 구성(`DefaultAppsManager`)·메뉴 이름 편집(`NavMenuManager`). */
  settings: {
    defaultApps: {
      title: '기본 앱 구성 (사이드바·상단바)',
      intro:
        '앱을 직접 고른 적이 없는 사용자의 사이드바·상단바 구성입니다. 이미 직접 고른 사용자는 바뀌지 않으며, 각자 "앱 추가" 창의 <b>기본값으로 초기화</b>로 이 구성을 따를 수 있습니다. 고른 순서가 표시 순서입니다.',
      sidebarSection: '사이드바 · {{group}}',
      topbarSection: '상단바 · {{group}}',
      revert: '되돌리기',
      save: '저장',
      saved: '조직 기본 앱 구성 저장됨',
      saveFailed: '저장 실패',
    },
    navMenu: {
      title: '메뉴 이름 편집',
      intro: '사이드바 메뉴 이름과 앱 타이틀을 변경합니다. 이름만 바뀌며 모든 사용자에게 적용됩니다. 바꾼 이름은 화면 언어와 상관없이 입력한 그대로 보입니다.',
      appTitle: '앱 타이틀',
      editTitle: '앱 타이틀 편집',
      editItem: '{{label}} 이름 편집',
    },
  },
  /** "앱 추가" 카탈로그(AddAppDialog·InstalledAppOrder) — leaf 화면 라벨은 `nav.page.*`, 그룹은 `nav.group.*`. */
  apps: {
    personalSection: '개인',
    /** installableApps.ts 의 SpecialAppId. */
    special: {
      back: { label: '뒤로가기', description: '이전 화면으로 돌아가는 버튼' },
      favorites: { label: '즐겨찾기', description: '자주 쓰는 화면을 별표로 모아본다' },
      island: { label: '나의 아일랜드', description: '내가 꾸민 커스텀 화면' },
    },
    order: {
      title: '표시 순서',
      dragHint: '끌어서 순서 변경',
      dragLabel: '{{label}} 순서 변경 — 끌어서 옮기거나, 스페이스 후 화살표 키',
    },
    accessNote:
      '설치는 내 메뉴에 보일지만 정합니다. 화면을 열 수 있는 권한은 관리자가 설정 → 접근 제어에서 정하며, 막힌 화면은 이 목록에 나오지 않습니다.',
    customizedNote: '직접 고른 구성이다. 초기화하면 사이드바·상단바 모두 조직 기본 구성으로 돌아간다.',
    defaultNote: '조직 기본 구성을 따르는 중이다. 앱을 추가·제거하면 내 구성으로 고정된다.',
    reset: '기본값으로 초기화',
    resetConfirm: '한 번 더 눌러 초기화',
  },
  /** 커맨드 팔레트(Ctrl/⌘+K). */
  palette: {
    dialogLabel: '화면 검색',
    placeholder: '화면 이름, 경로, 클러스터 이름으로 검색…',
    resultsLabel: '검색 결과',
    section: {
      recent: '최근 방문',
      screen: '화면',
      cluster: '클러스터',
    },
    otherGroup: '기타',
    clusterStatus: {
      critical: '위험',
      warning: '경고',
      healthy: '정상',
      unknown: '미판정',
    },
    noResults: '"{{query}}" 에 맞는 화면이나 클러스터가 없습니다.',
    noResultsHint: '화면 이름의 일부나 클러스터 이름으로 다시 검색해 보세요.',
    screenCount: '화면 {{count}}개',
    move: '이동',
    open: '열기',
  },
  /** Settings ▸ 테마 갤러리 — 테마·강조색 이름 자체는 `shell.theme.*`·`shell.accent.*` 를 쓴다. */
  theme: {
    gallery: {
      title: '테마 갤러리',
      intro: '미리보기를 클릭하면 바로 적용된다 — 사이드바 사용자 메뉴의 테마·강조색 목록과 같은 선택을 공유한다.',
      background: '바탕',
      accentIntro:
        '버튼·링크·선택 탭·활성 메뉴에만 쓰인다. 라이트·다크(시스템 포함) 바탕에 적용되고, 컴포트·고대비와 그림 테마(움버·플래스터·아침 식사·릴리프·할리퀸과 목걸이를 한 여인·오장팡 자개·김환기 창·피카소·후안 그리스)는 자체 색을 쓴다.',
    },
    switchTo: '{{name}} 테마로 변경',
    accentOption: '강조색 {{name}}',
  },
  /** 로그인 화면 — 키만 먼저 둔다(LoginPage 적용은 R-6 다음 트랜치). */
  login: {
    subtitle: 'Platform Engineering Portal',
    sessionExpiredReturn: '세션이 만료되어 로그아웃되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.',
    sessionExpiredContinue: '세션이 만료되어 로그아웃되었습니다. 다시 로그인하면 계속 이용할 수 있습니다.',
    passwordChangedReturn: '다른 탭에서 비밀번호가 변경되어 로그아웃되었습니다. 새 비밀번호로 다시 로그인하면 보던 화면으로 돌아갑니다.',
    passwordChangedContinue: '다른 탭에서 비밀번호가 변경되어 로그아웃되었습니다. 새 비밀번호로 다시 로그인하면 계속 이용할 수 있습니다.',
    username: '사용자명',
    password: '비밀번호',
    submitting: '로그인 중…',
    submit: '로그인',
    failed: '로그인에 실패했습니다.',
    or: '또는',
    sso: '{{name}}(으)로 로그인',
    ssoAria: '{{name}}(으)로 로그인 — 사내 인증 화면으로 이동',
    /** 서버 콜백·교환 실패 사유 코드(`/login?error=`) — 코드 목록은 backend oidc_service.ERROR_CODES. */
    ssoError: {
      unknown: 'SSO 로그인에 실패했습니다. 다시 시도하세요.',
      disabled: 'SSO 로그인이 꺼져 있습니다. 관리자에게 문의하세요.',
      rateLimited: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      stateInvalid: '로그인 요청이 만료됐거나 다른 브라우저에서 열렸습니다. 다시 시도하세요.',
      idpError: '사내 인증 서버에서 로그인이 취소되거나 거절됐습니다.',
      discoveryFailed: '사내 인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.',
      tokenExchangeFailed: '사내 인증 서버에서 로그인 확인에 실패했습니다. 다시 시도하세요.',
      idTokenInvalid: '사내 인증 서버의 응답을 검증하지 못했습니다. 관리자에게 문의하세요.',
      claimMissing: '사내 계정 정보에 사용자명이 없습니다. 관리자에게 문의하세요.',
      domainNotAllowed: '허용되지 않은 조직(이메일 도메인)의 계정입니다.',
      emailUnverified: '사내 인증 서버가 이메일 인증을 확인해 주지 않았습니다. 관리자에게 문의하세요.',
      userNotFound: 'PEP 에 등록되지 않은 계정입니다. 관리자에게 계정 등록을 요청하세요.',
      userInactive: '비활성화된 계정입니다. 관리자에게 문의하세요.',
      provisionFailed: '계정을 자동으로 만들지 못했습니다. 관리자에게 문의하세요.',
      exchangeFailed: '로그인 확인 시간이 지났습니다. 다시 시도하세요.',
    },
  },
};

/** 다른 로케일이 따라야 하는 모양 — 값은 전부 string, 키는 ko 와 정확히 같다. */
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type TranslationResource = Shape<typeof ko>;
export type NavPageKey = keyof typeof ko.nav.page;
export type NavGroupKey = keyof typeof ko.nav.group;
export type NavGroupDescKey = keyof typeof ko.nav.groupDesc;
