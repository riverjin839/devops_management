// 운영타입 커스텀 색상을 빠르게 고를 수 있도록 준비한 3가지 큐레이션 배색 프리셋
// (OperationLevelsManager 의 커스텀 색상 선택기 + 클러스터 아이콘 빌더 테마에서 사용).
//
// HEX 값은 Figma 색상 조합 라이브러리(https://www.figma.com/ko-kr/resource-library/color-combinations/)
// 의 "Burnt sienna" / "Tuscan sunset"(조합 27) / "Electropop"(조합 42) 페이지 원본 값을 그대로 옮겼다.

export interface ColorPattern {
  key: string;
  label: string;
  /** hex 목록 — 첫 번째가 운영타입 색으로 적용할 대표 시드 색상 */
  colors: string[];
}

export const COLOR_PATTERNS: ColorPattern[] = [
  { key: 'burnt-sienna',  label: 'Burnt Sienna',  colors: ['#E35336', '#F5F5DC', '#F4A460', '#A0522D'] },
  { key: 'tuscan-sunset', label: 'Tuscan Sunset', colors: ['#E35336', '#FFD3AC', '#9988A1', '#8A2B0E'] },
  { key: 'electropop',    label: 'Electropop',    colors: ['#CCFF00', '#FF6B00', '#F900FF', '#5200FF'] },
];
