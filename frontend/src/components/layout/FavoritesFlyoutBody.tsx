import { useLocation } from 'react-router-dom';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { isHubAbsorbed } from './navConfig';
import { useFavorites } from '@/hooks/useFavorites';
import { useRecentPathsStore } from '@/stores/recentPathsStore';
import { FlyoutLink } from './NavFlyout';

/**
 * 즐겨찾기 드롭다운 본문 — 사이드바(플랫폼 도메인)와 상단바(업무 도메인) 양쪽 ★ 진입점이
 * 공유한다. 즐겨찾기(서버 저장, `pinnedPaths`)와 최근 방문(기기 로컬,
 * `recentPathsStore`) 두 섹션으로 구성되며, 각 항목의 별 아이콘으로 바로 추가/해제한다.
 */
export function FavoritesFlyoutBody({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const { pinnedPaths, isPinned, togglePin } = useFavorites();
  const recentPaths = useRecentPathsStore((s) => s.paths);

  // 허브에 흡수된 옛 화면(D-240)은 숨긴다 — 서버가 고정 경로를 `/k8s` 로 바꾸지만 기기 로컬 최근 방문엔 옛 경로가 남아 있을 수 있다.
  const visiblePinned = pinnedPaths.filter((p) => navMap[p] && featureAllowed(p) && !isHubAbsorbed(p));
  const visibleRecent = recentPaths.filter(
    (p) => !pinnedPaths.includes(p) && navMap[p] && featureAllowed(p) && !isHubAbsorbed(p),
  );

  const renderItem = (p: string) => {
    const entry = navMap[p];
    return (
      <FlyoutLink
        key={p}
        to={p}
        label={getLabel(p)}
        Icon={entry.icon}
        iconColor={entry.iconColor}
        iconSize={entry.iconSize}
        active={location.pathname === p}
        onSelect={onClose}
        isPinned={isPinned(p)}
        onTogglePin={() => togglePin(p)}
      />
    );
  };

  if (!visiblePinned.length && !visibleRecent.length) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground text-center leading-relaxed">
        즐겨찾기한 화면이 없습니다.
        <br />
        메뉴 항목에 마우스를 올려 별표를 눌러보세요.
      </div>
    );
  }

  return (
    <div className="space-y-1 pb-2">
      {visiblePinned.length > 0 && (
        <>
          <p className="px-2.5 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
            즐겨찾기
          </p>
          {visiblePinned.map(renderItem)}
        </>
      )}
      {visibleRecent.length > 0 && (
        <>
          {visiblePinned.length > 0 && <div className="mx-2 my-1 border-t border-border" />}
          <p className="px-2.5 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
            최근 방문
          </p>
          {visibleRecent.map(renderItem)}
        </>
      )}
    </div>
  );
}
