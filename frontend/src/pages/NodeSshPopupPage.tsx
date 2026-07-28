import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TerminalSquare } from 'lucide-react';
import { NodeSshTerminal } from '@/components/k8s';
import { consumeNodeSshPopout, type NodeSshPopoutPayload } from '@/lib/nodeSshPopout';

/**
 * 노드 SSH 팝업 창 — 메인 UI 와 분리된 별도 브라우저 창에서 셸 세션을 전체창으로 실행한다.
 * 메인 창의 "새 창으로 열기" 가 localStorage 로 넘긴 1회용 handoff(`?h=`)를 최초 1회
 * 소비해 접속 정보를 얻는다(k9s 팝업과 동일 구조). 사이드바/네비 없이 터미널만 채운다.
 */
export function NodeSshPopupPage() {
  const [sp] = useSearchParams();
  const key = sp.get('h') || '';
  // 최초 렌더에서 1회 소비 (키는 즉시 삭제됨 — 새로고침하면 사라진다).
  const [payload] = useState<NodeSshPopoutPayload | null>(() => (key ? consumeNodeSshPopout(key) : null));

  useEffect(() => {
    if (payload) {
      document.title = `ssh · ${payload.params.username}@${payload.params.host}`;
    }
  }, [payload]);

  if (!payload) {
    return (
      <div className="h-screen w-screen bg-zinc-900 text-zinc-200 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <TerminalSquare className="w-8 h-8 text-primary" />
        <p className="text-sm">SSH 팝업 세션 정보를 찾을 수 없습니다.</p>
        <p className="text-xs text-zinc-400 leading-relaxed">
          이 창을 닫고 메인 화면의 <b className="text-zinc-200">노드 SSH 터미널</b> 에서 다시 “새 창으로 열기” 를 눌러주세요.
          <br />(새로고침 시 세션 정보가 사라집니다.)
        </p>
        <button
          onClick={() => window.close()}
          className="mt-2 px-3 py-1.5 text-sm rounded-xl bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
        >
          창 닫기
        </button>
      </div>
    );
  }

  return <NodeSshTerminal params={payload.params} onClose={() => window.close()} fill />;
}
