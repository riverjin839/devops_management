import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { FlyoutShell } from '@/components/layout/NavFlyout';
import { K8sClusterFlyoutBody } from '@/components/layout/K8sClusterFlyoutBody';

/**
 * 허브 헤더의 「클러스터 전환」 — 사이드바 레일 "K8s 클러스터" flyout 과 **같은 목록**(`K8sClusterFlyoutBody`)을
 * 버튼 아래로 연다. 허브 안의 클러스터 레일을 없애고(D-243) 클러스터 선택 진입점을 이 둘로 모았다.
 * 레일에 K8s 아이콘을 설치하지 않은 사용자도 여기서 바꿀 수 있다. 고르면 현재 뷰를 유지한 채 이동한다.
 */
export function HubClusterSwitcher() {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const label = t('shell.k8sClusters.switch');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : btnRef.current?.getBoundingClientRect() ?? null)}
        className={`inline-flex items-center gap-1 rounded-xl border border-border px-2 py-0.5 text-sm transition-colors ${
          anchor ? 'bg-secondary text-foreground' : 'bg-card text-muted-foreground hover:bg-secondary hover:text-foreground'
        }`}
      >
        {label}
        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {anchor && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setAnchor(null)} aria-hidden />
          <FlyoutShell
            title={label}
            anchorRect={anchor}
            placement="bottom"
            wide
            autoFocus
            returnFocusTo={btnRef.current}
            onClose={() => setAnchor(null)}
          >
            <K8sClusterFlyoutBody onNavigate={() => setAnchor(null)} />
          </FlyoutShell>
        </>
      )}
    </>
  );
}
