import { create } from 'zustand';

/**
 * 메인 레일 활성 표시 스타일 — 사용자 메뉴 ▸ "네비게이션 스타일"에서 고른다.
 * - `classic`   : 예전 방식. 버튼 배경 + 왼쪽 막대, 이동 애니메이션 없음.
 * - `spotlight` : **기본값** — 왼쪽 빛 막대에서 오른쪽으로 퍼지는 빛 원뿔이 활성 아이콘을 비춘다.
 * - `notch`     : 레일 오른쪽 테두리가 빛나는 선이 되고, 활성 아이콘 자리에서 안쪽으로 굽어 감싼다.
 *
 * spotlight/notch 는 레일 메뉴 영역 안에서 마우스를 따라 연속으로 움직이고(멈추면 가까운 아이콘에
 * 붙는다), 벗어나면 현재 페이지 위치로 돌아간다 — `components/layout/RailIndicator.tsx`.
 * 값은 `k8s:nav-style` 개인 키라 개인 설정 내보내기·기기 간 동기화(localPrefsSync)에 같이 실린다.
 */
export type NavStyle = 'classic' | 'spotlight' | 'notch';

export const NAV_STYLES: readonly NavStyle[] = ['classic', 'spotlight', 'notch'];

const NAV_STYLE_KEY = 'k8s:nav-style';
const DEFAULT_NAV_STYLE: NavStyle = 'spotlight';

function readInitial(): NavStyle {
  try {
    const v = localStorage.getItem(NAV_STYLE_KEY);
    if (v && (NAV_STYLES as readonly string[]).includes(v)) return v as NavStyle;
  } catch { /* storage 차단 — 기본값 */ }
  return DEFAULT_NAV_STYLE;
}

interface NavStyleState {
  navStyle: NavStyle;
  setNavStyle: (s: NavStyle) => void;
}

export const useNavStyleStore = create<NavStyleState>((set) => ({
  navStyle: readInitial(),
  setNavStyle: (navStyle) => {
    try { localStorage.setItem(NAV_STYLE_KEY, navStyle); } catch { /* ignore */ }
    set({ navStyle });
  },
}));
