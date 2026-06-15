import { useNavigate } from 'react-router-dom';
import { Zap, ScrollText } from 'lucide-react';

/**
 * K8s 로그 화면 전환 탭 — "AI 분석"(IncidentAnalysisPage, /incident-analysis) 과
 * "실시간 로그"(K8sLogsPage, /k8s-logs) 를 한 곳에서 오가도록 통합.
 * 두 페이지의 제목 옆에 동일하게 배치한다.
 */
export function LogViewTabs({ current }: { current: 'analysis' | 'stream' }) {
  const navigate = useNavigate();

  const Tab = ({
    id, to, Icon, label,
  }: { id: 'analysis' | 'stream'; to: string; Icon: typeof Zap; label: string }) => (
    <button
      type="button"
      onClick={() => navigate(to)}
      aria-pressed={current === id}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
        current === id
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  return (
    <div className="inline-flex items-center gap-1.5">
      <Tab id="analysis" to="/incident-analysis" Icon={Zap} label="AI 분석" />
      <Tab id="stream" to="/k8s-logs" Icon={ScrollText} label="실시간 로그" />
    </div>
  );
}
