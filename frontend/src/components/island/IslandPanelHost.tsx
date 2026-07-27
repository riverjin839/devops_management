import { AlertTriangle, Lock } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useFeatureAccess, canAccessFeature } from '@/hooks/useFeatureAccess';
import { PANEL_COMPONENTS, PANEL_FEATURE_GUARD, ISLAND_DENYLIST } from './panelRegistry';

interface IslandPanelHostProps {
  /** 렌더할 라우트 경로 (예: '/ops-checks'). */
  path: string;
  /** 표시용 라벨 — 오류 메시지에 사용. */
  label: string;
}

function Placeholder({ Icon, title, body }: {
  Icon: typeof AlertTriangle;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <Icon className="w-8 h-8 text-muted-foreground" />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground max-w-md">{body}</p>
    </div>
  );
}

/**
 * 아일랜드 패널 한 칸 — 등록된 페이지 컴포넌트를 그대로 렌더한다.
 *
 * `.island-embed` 래퍼가 페이지의 전체화면 셸(`min-h-screen`)을 무력화하고(index.css 참고),
 * 스크롤을 이 컨테이너가 소유해서 아일랜드 크롬(탭바/레일)이 고정되도록 한다.
 * App.tsx 의 `RequireFeature` 와 같은 권한 판정을 여기서도 적용해, 공유받은 아일랜드에
 * 권한 없는 화면이 들어 있어도 페이지가 깨지는 대신 안내가 나오게 한다.
 */
export function IslandPanelHost({ path, label }: IslandPanelHostProps) {
  const user = useAuthStore((s) => s.user);
  const { data: featureAccess, isLoading: accessLoading } = useFeatureAccess();

  const Component = PANEL_COMPONENTS[path];
  const feature = PANEL_FEATURE_GUARD[path];

  if (!Component || ISLAND_DENYLIST.has(path)) {
    return (
      <Placeholder
        Icon={AlertTriangle}
        title="이 화면은 아일랜드에 담을 수 없습니다"
        body={`"${label}" (${path}) 은 전체 화면 전용이거나 더 이상 존재하지 않는 화면입니다. 패널에서 제거해 주세요.`}
      />
    );
  }

  if (feature) {
    if (accessLoading) return null;
    if (!canAccessFeature(featureAccess, feature, user)) {
      return (
        <Placeholder
          Icon={Lock}
          title="접근 권한이 없습니다"
          body={`"${label}" 화면에 대한 접근 권한이 없습니다. 관리자에게 문의하세요.`}
        />
      );
    }
  }

  return (
    <div className="island-embed flex-1 min-w-0 overflow-auto">
      <Component />
    </div>
  );
}
