import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Dog, Loader2 } from 'lucide-react';
import { K9sTerminal } from '@/components/k8s';
import { requestK9sPopout, type K9sPopoutPayload } from '@/lib/k9sPopout';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';

type Handoff =
  | { phase: 'loading' }
  | { phase: 'ready'; payload: K9sPopoutPayload }
  | { phase: 'failed' };

/**
 * k9s 팝업 창 — 메인 UI 와 분리된 별도 브라우저 창에서 k9s 세션을 전체창으로 실행한다.
 * 메인 창의 "새 창으로 열기" 가 연 1회용 handoff(`?h=<id>`)로 원래 창에 접속 정보를
 * `postMessage` 로 요청한다(저장소 없음 — `lib/terminalPopout.ts`). 받지 못하면(원래 창이
 * 닫힘·새로고침) "다시 열기" 를 안내한다. 이 창을 열어두면 메인 창은 다른 페이지로 이동해도 된다.
 */
export function K9sPopupPage() {
  const [sp] = useSearchParams();
  const id = sp.get('h') || '';
  const [handoff, setHandoff] = useState<Handoff>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    requestK9sPopout(id).then((payload) => {
      if (!alive) return;
      setHandoff(payload ? { phase: 'ready', payload } : { phase: 'failed' });
    });
    return () => { alive = false; };
  }, [id]);

  const payload = handoff.phase === 'ready' ? handoff.payload : null;

  // 별도 창은 터미널 환경 스토어가 비어 있다 — 클러스터 운영등급으로 운영/개발 프로파일을 맞춘다(D-175).
  const { data: clusters = [] } = useClusters();
  useTerminalEnvSync(clusters, payload?.clusterId ?? null);

  useEffect(() => {
    if (payload) {
      document.title = `k9s · ${payload.params.username}@${payload.params.host}`;
    }
  }, [payload]);

  if (handoff.phase === 'loading') {
    return (
      <div className="h-screen w-screen bg-background text-muted-foreground flex items-center justify-center gap-2 text-sm" role="status">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 접속 정보를 받는 중…
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="h-screen w-screen bg-background text-foreground flex flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
        <Dog className="w-8 h-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm">k9s 접속 정보를 받지 못했습니다.</p>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-md">
          접속 정보는 보안을 위해 저장하지 않고 메인 창에서 한 번만 넘겨받습니다. 메인 창을 닫았거나 이 창을 새로고침하면
          다시 받을 수 없습니다. 이 창을 닫고 메인 화면의 <b className="text-foreground">k9s 콘솔</b>에서
          <b className="text-foreground"> 새 창으로 열기</b>(또는 안내된 <b className="text-foreground">다시 열기</b>)를 눌러 주세요.
        </p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-2 px-3 py-1.5 text-sm rounded-xl border border-border bg-secondary text-foreground hover:bg-secondary/80"
        >
          창 닫기
        </button>
      </div>
    );
  }

  return (
    <K9sTerminal
      clusterId={payload.clusterId}
      params={payload.params}
      onClose={() => window.close()}
      fill
    />
  );
}
