// 운영타입 커스텀 색상을 빠르게 고를 수 있도록 준비한 5가지 큐레이션 배색 프리셋
// (OperationLevelsManager 의 커스텀 색상 선택기에서 사용).
//
// ⚠ 이 실행 환경의 아웃바운드 네트워크 정책이 figma.com 접속을 차단해 다음 URL의 원본
//   HEX 값을 직접 가져올 수 없었다 — 조합명이 통상 연상시키는 톤(대지색/네온 팝 등)을
//   참고해 큐레이션한 근사값이다:
//   https://www.figma.com/ko-kr/resource-library/color-combinations/
//   정확한 원본 값이 필요하면 위 페이지에서 확인해 이 배열만 갱신하면 된다(다른 코드는
//   COLOR_PATTERNS 배열 형태만 따르면 되므로 영향받지 않는다).

export interface ColorPattern {
  key: string;
  label: string;
  /** hex 목록 — 첫 번째가 운영타입 색으로 적용할 대표 시드 색상 */
  colors: string[];
}

export const COLOR_PATTERNS: ColorPattern[] = [
  { key: 'burnt-sienna',   label: 'Burnt Sienna',   colors: ['#A44A3F', '#EA7317', '#D8973C', '#4A3933', '#F2E8CF'] },
  { key: 'tuscan-sunset',  label: 'Tuscan Sunset',  colors: ['#E07A5F', '#F2CC8F', '#81B29A', '#3D405B', '#EDE0D4'] },
  { key: 'electropop',     label: 'Electropop',     colors: ['#FF3CAC', '#784BA0', '#2B86C5', '#FFD400', '#00F5D4'] },
  { key: 'pop-art',        label: 'Pop Art',        colors: ['#E63946', '#FFD60A', '#023E8A', '#1B1B1B', '#F1FAEE'] },
  { key: 'urban-graffiti', label: 'Urban Graffiti', colors: ['#FF0080', '#00FFAB', '#FFEA00', '#7B2FF7', '#1B1B1B'] },
];
