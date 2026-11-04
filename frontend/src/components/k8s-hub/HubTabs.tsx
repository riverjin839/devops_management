import { useNavigate } from 'react-router-dom';
import { SegTabs } from '@/components/common/SegTabs';
import { useHubTabShortcuts } from './useHubTabShortcuts';
import { HUB_CATEGORIES, type HubCategory, type HubView } from './hubViews';

interface HubTabsProps {
  clusterId: string;
  /** 접근 제어를 통과한 뷰만. */
  views: readonly HubView[];
  active: HubView;
}

/**
 * 허브 탭바 — 1행 카테고리, 2행은 그 카테고리에 뷰가 둘 이상일 때만 세그먼트.
 * 뷰 전환은 **path** 이동(`/k8s/:clusterId/:view`)이라 뒤로가기가 이전 뷰로 돌아온다.
 * 쿼리는 넘기지 않는다 — 뷰마다 `?tab=`·`?view=` 같은 자기 키를 쓰므로 새지 않게.
 * `[` `]` 단축키로 이전/다음 화면(`useHubTabShortcuts`).
 * 허브 헤더·탭바는 sticky 가 아니다(K8s 상세 관리의 2차 사이드바, 자원 관리의 sticky 탭바와 겹치지 않게).
 */
export function HubTabs({ clusterId, views, active }: HubTabsProps) {
  const navigate = useNavigate();
  const go = (id: string) => navigate(`/k8s/${clusterId}/${id}`);
  // [ ] 로 이전/다음 화면 — 카테고리 순서대로 이어 붙인 순서
  const order = HUB_CATEGORIES.flatMap((c) => views.filter((v) => v.category === c.id).map((v) => v.id));
  useHubTabShortcuts(order, active.id, go);

  const categories = HUB_CATEGORIES.filter((c) => views.some((v) => v.category === c.id));
  const siblings = views.filter((v) => v.category === active.category);
  const catOptions = categories.map((c) => [c.id, c.label] as const);
  const subOptions = siblings.map((v) => {
    const Icon = v.icon;
    return [v.id, <><Icon className="w-3.5 h-3.5" aria-hidden="true" />{v.label}</>] as const;
  });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SegTabs<HubCategory>
        mode="tabs" size="md" label="허브 카테고리"
        value={active.category} options={catOptions}
        onChange={(cat) => { const first = views.find((v) => v.category === cat); if (first) go(first.id); }}
      />
      {siblings.length > 1 && (
        <SegTabs
          mode="tabs" label={`${categories.find((c) => c.id === active.category)?.label ?? ''} 화면`}
          value={active.id} options={subOptions}
          onChange={go}
        />
      )}
      <span className="text-xs text-muted-foreground hidden md:inline" title="입력창 밖에서 [ 는 이전 화면, ] 는 다음 화면으로 이동합니다">
        <kbd className="font-mono">[</kbd> <kbd className="font-mono">]</kbd> 화면 이동
      </span>
    </div>
  );
}
