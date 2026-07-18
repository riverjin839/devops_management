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
  },
};
