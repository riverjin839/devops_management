import { Link } from 'react-router-dom';
import { Dog, ExternalLink, TerminalSquare, type LucideIcon } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common/EmptyState';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useK8sHub } from '@/lib/k8sHub';

interface TerminalEntry {
  navKey: string;
  icon: LucideIcon;
  description: string;
}

const TERMINALS: readonly TerminalEntry[] = [
  { navKey: '/k9s', icon: Dog, description: 'control-plane 서버의 k9s 를 웹 터미널로 연다. 새 창으로 띄우기도 그 화면에서 한다.' },
  { navKey: '/node-ssh', icon: TerminalSquare, description: '이 클러스터의 노드 하나에 로그인 셸을 연다. 자격증명은 저장하지 않는다.' },
];

const OPEN_BTN = 'inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm';

/**
 * K8s 클러스터 허브 ▸ 콘솔 ▸ 터미널 — k9s 콘솔·노드 SSH 터미널을 **여는** 카드(D-240 2단계).
 *
 * 두 화면은 전체 높이 웹 터미널(xterm + WebSocket, 새 창 handoff)이라 허브 탭 안에 임베드하지 않고
 * 기존 단독 화면(`/k9s/:clusterId`, `/node-ssh/:clusterId`)을 허브가 고른 클러스터로 연다 — 아일랜드 덴리스트와 같은 판단.
 * 접근 제어로 꺼진 쪽은 카드를 빼고, 접속은 operator 이상이라 viewer 에게는 숨기지 않고 비활성 + 사유를 보인다(§12.9).
 * 이동 링크라 실행 로그 대상이 아니다 — 접속·명령 로그는 각 터미널 화면이 남긴다.
 */
export function HubTerminalsView() {
  const hub = useK8sHub();
  const clusterId = hub?.clusterId ?? '';
  const { featureAllowed, getLabel } = useNavCatalog();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);

  const entries = TERMINALS.filter((t) => featureAllowed(t.navKey));
  if (entries.length === 0) {
    return <EmptyState title="열 수 있는 터미널이 없습니다" description="k9s 콘솔과 노드 SSH 터미널이 접근 제어로 꺼져 있습니다. 관리자에게 문의하세요." />;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entries.map((t) => {
        const label = getLabel(t.navKey);
        const openLabel = `${label} 열기`;
        return (
          <MacCard
            key={t.navKey}
            title={label}
            icon={t.icon}
            actions={canOperate ? (
              <Link to={`${t.navKey}/${clusterId}`} className={`${OPEN_BTN} hover:bg-muted`} aria-label={openLabel}>
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> 열기
              </Link>
            ) : (
              <button type="button" disabled className={`${OPEN_BTN} opacity-50 cursor-not-allowed`}
                title={withHint(openLabel)} aria-label={ariaWithHint(openLabel)}>
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> 열기
              </button>
            )}
          >
            <p className="text-sm text-muted-foreground">
              {t.description} 허브를 벗어나 전체 화면 터미널로 이동하며, 뒤로가기로 돌아옵니다.
            </p>
          </MacCard>
        );
      })}
    </div>
  );
}
