import { NAV_WIDTH } from '@/stores/sidebarStore';
import type { NavStyle } from '@/stores/navStyleStore';

// 노치 path 는 아이콘 중심(y=0) 기준으로 그리고 그룹을 translateY 로 옮긴다. 레일 오른쪽 선은 x = 폭 - 0.75.
const X = NAV_WIDTH - 0.75;
const IN = 5;
const BUMP = `C${X},-22 ${IN},-30 ${IN},0 C${IN},30 ${X},22 ${X},40`;
const BUMP_LINE = `M${X},-40 ${BUMP}`;
const BUMP_FILL = `${BUMP_LINE} Z`;
const EDGE_LINE = `M${X},0 L${X},10000`;

/** 메인 레일 활성 표시자(스포트라이트 원뿔 / 글로우 노치 SVG). 위치·마우스 따라가기는 `useRailIndicator`.
 *  레일 `<aside>` 첫 자식으로 둔다(이후 형제 버튼이 위에 그려진다). classic 은 그리지 않는다. */
export function RailIndicator({ navStyle }: { navStyle: NavStyle }) {
  if (navStyle === 'spotlight') return <div aria-hidden className="nav-ind-spot" />;
  if (navStyle === 'notch') {
    return (
      <svg aria-hidden className="nav-notch" width={NAV_WIDTH} focusable="false">
        <path className="nav-notch-line" d={EDGE_LINE} />
        <g className="nav-notch-bump">
          {/* 굽은 구간 뒤의 직선 테두리를 가린다 */}
          <rect className="nav-notch-cover" x={X - 1.5} y={-40} width={3} height={80} />
          <path className="nav-notch-fill" d={BUMP_FILL} />
          <path className="nav-notch-line" d={BUMP_LINE} />
        </g>
      </svg>
    );
  }
  return null;
}
