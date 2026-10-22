import { useNavigate, useParams } from 'react-router-dom';
import { Zap, ScrollText } from 'lucide-react';
import { useIsIslandEmbedded } from '@/lib/islandEmbed';
import { useK8sHub } from '@/lib/k8sHub';

/**
 * K8s 로그 화면 전환 탭 — "AI 분석"(IncidentAnalysisPage, /incident-analysis) 과
 * "실시간 로그"(K8sLogsPage, /k8s-logs — 메뉴·제목은 "파드 로그") 를 한 곳에서 오가도록 통합.
 * 두 페이지의 제목 옆에 동일하게 배치한다. 두 화면 모두 `/:clusterId` 를 받으므로 탭을 바꿔도
 * 선택한 클러스터를 이어 간다(D-113).
 *
 * 아일랜드 패널 임베드에서는 그리지 않는다(D-187 ⑥) — 여기서 `navigate` 하면 앱 전체가
 * 아일랜드 밖 라우트로 끌려 나가고, 임베드에는 경로 `clusterId` 도 없다.
 * K8s 클러스터 허브 안에서도 그리지 않는다(D-240) — 허브 "로그" 카테고리의 2행 탭이 같은 전환을 맡는다.
 */
export function LogViewTabs({ current }: { current: 'analysis' | 'stream' }) {
  const navigate = useNavigate();
  const { clusterId } = useParams<{ clusterId: string }>();
  const embedded = useIsIslandEmbedded();
  const hub = useK8sHub();
  if (embedded || hub) return null;

  const Tab = ({
    id, to, Icon, label,
  }: { id: 'analysis' | 'stream'; to: string; Icon: typeof Zap; label: string }) => (
    <button
      type="button"
      onClick={() => { if (current !== id) navigate(clusterId ? `${to}/${clusterId}` : to); }}
      aria-current={current === id ? 'page' : undefined}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border transition-colors ${
        current === id
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <nav aria-label="로그 화면 전환" className="inline-flex items-center gap-1.5">
      <Tab id="analysis" to="/incident-analysis" Icon={Zap} label="AI 분석" />
      <Tab id="stream" to="/k8s-logs" Icon={ScrollText} label="실시간 로그" />
    </nav>
  );
}
