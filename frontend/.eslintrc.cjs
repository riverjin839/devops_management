/* 상태 의미 고정 팔레트 금지 (P1) — 정상/경고/장애/정보 색은 테마를 따라가는 status 토큰만 쓴다
   (text-status-healthy · bg-status-critical/10 · border-status-warning/30 …). emerald/red/amber 같은
   고정 팔레트는 테마마다 대비가 깨진다(예: text-emerald-400 은 라이트 테마에서 1.9:1).
   slate/zinc 콘솔(터미널) 배경은 대상이 아니다. */
const STATUS_PALETTE_RE = String.raw`/(^|[^\w-])(text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration|placeholder|accent|caret|shadow)(-[a-z]+)?-(emerald|green|red|rose|amber|yellow|sky)-\d{2,3}/`;
/* 장식·카테고리 고정 팔레트 금지 (D-120, DESIGN_SYSTEM §12.12-7) — 예전엔 "장식용 계열은 대상이 아니다" 로
   뒀더니 blue·orange·violet·indigo·cyan·pink 가 329건까지 자라 Tailwind 기본 팔레트(= AI 템플릿 룩)가 됐다.
   종류 구분 색은 --chart-1..8 토큰, 상태는 status 토큰만 쓴다. 래칫 allowlist(61파일)를 2026-10-15 에 0 으로
   비우고 예외 없이 막는다. 캔버스·WebGL 처럼 클래스를 못 쓰는 렌더러는 lib/chartTokens.ts cssVarColor 를 쓴다. */
const DECO_PALETTE_RE = String.raw`/(^|[^\w-])(text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration|placeholder|accent|caret|shadow)(-[a-z]+)?-(blue|orange|purple|violet|indigo|cyan|pink|fuchsia|teal|lime)-\d{2,3}/`;
const DECO_PALETTE_MSG = '장식·카테고리 색도 고정 팔레트를 쓰지 않는다 — 종류 구분은 --chart-1..8 토큰, 상태는 status 토큰 (DESIGN_SYSTEM §12.12-7, D-120)';
/* 장식 효과·대비 우회 금지 (Phase 2, D-119·D-121·D-125·D-132, DESIGN_SYSTEM §12.12-4·8) — 전량 0 으로 만든 뒤 회귀 방지로 켠다.
   hover-lift(hover:-translate-y·hover:scale·active:scale), 그라데이션, transition-all, 장식 ping/bounce,
   상태 글자색 arbitrary 값(text-[hsl(var(--status-*))] — 4.5:1 대비 토큰 text-status-* 를 우회한다). */
const FX_RE = String.raw`/(^|[^\w-])(hover:-translate-y-|hover:scale-|active:scale-|bg-gradient-to-|transition-all(?![\w-])|animate-ping|animate-bounce)|text-\[hsl\(var\(--status/`;
const FX_MSG = '장식 효과 금지 — hover-lift·그라데이션·transition-all(→ transition-colors)·장식 ping/bounce·text-[hsl(var(--status-*))](→ text-status-*) (DESIGN_SYSTEM §12.12-4, D-121·D-132)';
/* 대문자 아이브로우 금지 (D-125, §12.12-8) — 예외 없음(Phase 3 에서 MacCard·Card 헤더의 uppercase 도 걷었다). */
const EYEBROW_RE = String.raw`/(^|\s)uppercase(\s.*)?\stracking-(wide|wider|widest)|(^|\s)tracking-(wide|wider|widest)(\s.*)?\suppercase(\s|$)/`;
const EYEBROW_MSG = '대문자 아이브로우(uppercase + tracking-wide*) 금지 — 라벨은 text-xs font-medium text-muted-foreground (DESIGN_SYSTEM §12.12-8, D-125)';
/* 페이지 폭 임의값 금지 (D-123, §12.12-5) — 본문 폭은 PageShell 밀도 3종(console·hub 1600·doc 4xl)만.
   1200~2999px 고정 폭(max-w-[1400px] 등)은 PageShell 밖에서 막는다. 모달·팝오버 폭은 대개 3자리라 걸리지 않는다. */
const WIDTH_RE = String.raw`/(^|[^\w-])max-w-\[(1[2-9]|2\d)\d\dpx\]/`;
const WIDTH_MSG = '페이지 폭은 PageShell density(console|hub|doc)로만 정한다 — max-w-[NNNNpx] 금지 (DESIGN_SYSTEM §12.12-5, D-123)';
/* P2 타이포 — 흐린 보조 글자(text-muted-foreground/50~90 → 라이트에서 1.96~3.23:1)와 11px 미만 글자 금지.
   placeholder: 변형은 입력 안내 글자라 예외. esquery 정규식은 '/' 를 못 쓰므로 슬래시 자리는 '.' 로 매칭. */
const TYPO_RE = String.raw`/((?<!placeholder:)(?<![\w-])text-muted-foreground.[5-9]\d(?!\d))|text-\[(8|9|10)px\]/`;
const TYPO_MSG = '보조 글자는 text-muted-foreground(투명도 없이), 최소 글자는 text-[11px] — 흐리게 하거나 더 작게 하지 않는다 (DESIGN_SYSTEM §12 타이포)';
/* raw hex 금지 (R-1, DESIGN_SYSTEM §12.12-7) — 색은 Tailwind 토큰 클래스, SVG/DOM 은 hsl(var(--x)),
   캔버스·WebGL·var() 를 못 푸는 export 는 lib/chartTokens.ts cssVarColor(+useThemeColorKey) 를 쓴다.
   문자열 전체가 hex 인 리터럴만 잡는다 — 템플릿 리터럴 속 hex 는 grep 으로 0 을 확인한다.
   허용 예외는 아래 HEX_ALLOWED_FILES(사용자 데이터·컬러 피커 기본값·export 흰 배경·외부 브랜드색·xterm 팔레트)뿐. */
const HEX_RE = String.raw`/^#[0-9a-fA-F]{3,8}$/`;
const HEX_MSG = 'raw hex 금지 — 토큰/cssVarColor 사용(DESIGN_SYSTEM §12.12-7)';
const HEX_RESTRICTED = [{ selector: `Literal[value=${HEX_RE}]`, message: HEX_MSG }];
const HEX_ALLOWED_FILES = [
  'src/lib/terminalThemes.ts', // xterm 팔레트·내장 템플릿(사용자 편집 가능한 hex 데이터)
  'src/lib/clusterIconBuilder.ts', // 클러스터 아이콘 SVG 생성(내보내는 이미지 자체)
  'src/lib/colorPatterns.ts', // 사용자 선택 패턴 색(저장 데이터)
  'src/lib/brandIcons.ts', // 외부 브랜드 고유색
  'src/lib/exportView.ts', // 이미지 export 흰 배경 폴백
  'src/components/serviceArch/exportDiagram.ts', // 다이어그램 export 흰 배경
  'src/components/editor/RichTextEditor.tsx', // 문서 배경 프리셋(저장 데이터)·컬러 input 기본값
  'src/stores/homeStore.ts', // 주간 막대 글자색 기본값(<input type=color> 는 hex 만 받는다)
  'src/components/settings/PageStyleManager.tsx', // 컬러 피커 기본값
  'src/components/settings/OperationLevelsManager.tsx', // 컬러 피커 기본값
  'src/components/settings/TerminalAppearanceSettings.tsx', // 터미널 팔레트 피커 기본값
  'src/components/work-items/WorkItemForm.tsx', // 에디터 기본 배경(저장 데이터)
  'src/pages/MindMapPage.tsx', // NODE_COLORS 피커(사용자 저장 색)·export 흰 배경·컬러 input 기본값
];

const STATUS_PALETTE_MSG = '상태색은 status 토큰을 쓴다 — text-status-healthy|warning|critical|info, bg-status-*/10, border-status-*/30 (DESIGN_SYSTEM §2.4)';

const BASE_RESTRICTED = [
  { selector: `Literal[value=${STATUS_PALETTE_RE}]`, message: STATUS_PALETTE_MSG },
  { selector: `TemplateElement[value.raw=${STATUS_PALETTE_RE}]`, message: STATUS_PALETTE_MSG },
  { selector: `Literal[value=${TYPO_RE}]`, message: TYPO_MSG },
  { selector: `TemplateElement[value.raw=${TYPO_RE}]`, message: TYPO_MSG },
];
const FX_RESTRICTED = [
  { selector: `Literal[value=${FX_RE}]`, message: FX_MSG },
  { selector: `TemplateElement[value.raw=${FX_RE}]`, message: FX_MSG },
  { selector: `Literal[value=${EYEBROW_RE}]`, message: EYEBROW_MSG },
  { selector: `TemplateElement[value.raw=${EYEBROW_RE}]`, message: EYEBROW_MSG },
];
const WIDTH_RESTRICTED = [
  { selector: `Literal[value=${WIDTH_RE}]`, message: WIDTH_MSG },
  { selector: `TemplateElement[value.raw=${WIDTH_RE}]`, message: WIDTH_MSG },
];
const DECO_RESTRICTED = [
  { selector: `Literal[value=${DECO_PALETTE_RE}]`, message: DECO_PALETTE_MSG },
  { selector: `TemplateElement[value.raw=${DECO_PALETTE_RE}]`, message: DECO_PALETTE_MSG },
];

module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh', 'jsx-a11y'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

    /* a11y — 운영 도구 키보드 우선 (DESIGN_SYSTEM §0).
       recommended 가 잡는 진짜 버그(빈 aria, label-without-control, 잘못된 role)는 error 유지.
       아래 3개 rule 은 본 코드베이스의 사용 맥락(모달 백드롭 / 카드행 클릭 /
       사용자-트리거 인라인 편집)에서 위반의 대부분이 정당한 케이스이고,
       max-warnings 0 정책 하에서 warn 강등은 사실상 error 와 동급이라
       정책 일관성을 위해 off. 신규 코드에서 div onClick 을 도입할 때는
       button 이 더 적절하지 않은지 케이스별로 판단할 것. */
    'jsx-a11y/click-events-have-key-events': 'off',
    'jsx-a11y/no-static-element-interactions': 'off',
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
    /* 한국어 lang 처리는 페이지 단위에서 따로 — autofix 충돌 방지로 off */
    'jsx-a11y/lang': 'off',
    /* autoFocus — 본 코드베이스의 모든 사용처가 사용자 트리거(모달 열기 /
       인라인 편집 시작 / "추가" 버튼) 직후의 첫 입력에 한정.
       no-autofocus 가 우려하는 "페이지 로드 시 예상치 못한 포커스 이동"
       시나리오가 없어 off. 새 코드에서는 항상 사용자 액션 직후에만 사용. */
    'jsx-a11y/no-autofocus': 'off',
    /* icon-only 버튼/빈 <th>/폼 컨트롤에 접근 가능한 이름이 있는지 — recommended
       프리셋엔 없지만 W4 접근성 패스에서 전수 검사 후 위반 54건을 모두 고쳤다(2026-07).
       회귀 방지를 위해 명시적으로 켜둔다. */
    'jsx-a11y/control-has-associated-label': 'warn',
    'no-restricted-syntax': ['error', ...BASE_RESTRICTED, ...DECO_RESTRICTED, ...FX_RESTRICTED, ...WIDTH_RESTRICTED, ...HEX_RESTRICTED],
  },
  overrides: [
    /* PageShell 은 허브 폭(max-w-[1600px])을 정의하는 유일한 곳. */
    { files: ['src/components/common/PageShell.tsx'], rules: { 'no-restricted-syntax': ['error', ...BASE_RESTRICTED, ...DECO_RESTRICTED, ...FX_RESTRICTED, ...HEX_RESTRICTED] } },
    /* raw hex 허용 예외 — HEX 규칙만 빼고 나머지 금지 규칙은 그대로 건다. */
    { files: HEX_ALLOWED_FILES, rules: { 'no-restricted-syntax': ['error', ...BASE_RESTRICTED, ...DECO_RESTRICTED, ...FX_RESTRICTED, ...WIDTH_RESTRICTED] } },
  ],
};
