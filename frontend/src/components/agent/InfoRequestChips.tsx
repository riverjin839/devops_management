import { useState } from 'react';
import { Code2, History, ScrollText, Settings2, Loader2, Search } from 'lucide-react';
import { llmApi } from '@/services/api';
import type { AgentInfoRequest, RagCitation } from '@/types';

const KIND_META: Record<AgentInfoRequest['kind'], { label: string; icon: typeof Code2 }> = {
  github_code: { label: '코드 붙여넣기', icon: Code2 },
  troubleshooting_history: { label: '트러블슈팅 이력 첨부', icon: History },
  logs: { label: '로그 추가 제공', icon: ScrollText },
  config: { label: '설정 값 제공', icon: Settings2 },
};

/**
 * AI 의 추가 정보 요청을 운영자 액션 칩으로 렌더 — **자율 실행이 아니다**.
 * 어떤 정보를 제공할지는 항상 사람이 결정하고, 제공한 내용은 다음 사용자
 * 메시지로 첨부된다 (무실행 보증 유지).
 */
export function InfoRequestChips({
  requests,
  onProvide,
}: {
  requests: AgentInfoRequest[];
  /** 운영자가 제공한 정보를 다음 메시지로 보낸다 */
  onProvide: (text: string) => void;
}) {
  const [active, setActive] = useState<AgentInfoRequest | null>(null);

  if (!requests?.length) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">AI 가 추가 정보를 요청했습니다 — 제공 여부는 직접 결정하세요.</p>
      <div className="flex flex-wrap gap-1.5">
        {requests.map((r, i) => {
          const meta = KIND_META[r.kind];
          const Icon = meta.icon;
          return (
            <button
              key={`${r.kind}-${i}`}
              type="button"
              onClick={() => setActive(r)}
              title={r.detail}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-primary/40 text-primary hover:bg-primary/10"
            >
              <Icon className="w-3.5 h-3.5" aria-hidden /> {meta.label}
            </button>
          );
        })}
      </div>
      {active && (
        active.kind === 'troubleshooting_history'
          ? <HistorySearchModal request={active} onClose={() => setActive(null)} onProvide={onProvide} />
          : <PasteModal request={active} onClose={() => setActive(null)} onProvide={onProvide} />
      )}
    </div>
  );
}

function PasteModal({
  request, onClose, onProvide,
}: {
  request: AgentInfoRequest;
  onClose: () => void;
  onProvide: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const meta = KIND_META[request.kind];
  const label = request.kind === 'github_code' ? '관련 코드' : request.kind === 'logs' ? '로그' : '설정 값';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label={meta.label}>
      <div className="bg-card border border-border rounded-md shadow-lg w-full max-w-lg p-5 space-y-3">
        <h3 className="text-sm font-semibold">{meta.label}</h3>
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">요청 사유: {request.detail || '(설명 없음)'}</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={`${label}를 붙여넣으세요 — 민감정보(비밀번호/토큰)는 제거하고 제공하세요.`}
          className="w-full bg-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:bg-secondary">취소</button>
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => {
              onProvide(`요청하신 ${label}입니다:\n\`\`\`\n${text.trim()}\n\`\`\``);
              onClose();
            }}
            className="px-3 py-1.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            대화에 첨부
          </button>
        </div>
      </div>
    </div>
  );
}

function HistorySearchModal({
  request, onClose, onProvide,
}: {
  request: AgentInfoRequest;
  onClose: () => void;
  onProvide: (text: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RagCitation[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await llmApi.ragSearch(q.trim(), 8);
      setResults(res.data.data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="트러블슈팅 이력 첨부">
      <div className="bg-card border border-border rounded-md shadow-lg w-full max-w-lg p-5 space-y-3 max-h-[80vh] overflow-y-auto">
        <h3 className="text-sm font-semibold">트러블슈팅 이력 첨부</h3>
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">요청 사유: {request.detail || '(설명 없음)'}</p>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder="증상/키워드로 사내 지식 검색 (가이드·업무 이력·운영 노트)"
            className="flex-1 bg-secondary border border-border rounded-xl px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={loading || !q.trim()}
            aria-label="검색"
            className="px-3 py-2 rounded-xl bg-secondary border border-border hover:bg-muted disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </button>
        </div>
        {results.length > 0 ? (
          <ul className="divide-y divide-border">
            {results.map((r) => (
              <li key={`${r.sourceType}-${r.refId}`} className="py-2">
                <button
                  type="button"
                  onClick={() => {
                    onProvide(
                      `과거 트러블슈팅 이력을 첨부합니다 — "${r.title}":\n${r.snippet}`,
                    );
                    onClose();
                  }}
                  className="text-left w-full hover:bg-secondary rounded-xl px-2 py-1"
                >
                  <p className="text-sm text-primary">{r.title}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">{r.snippet}</p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">검색 결과가 여기 표시됩니다. 항목을 클릭하면 대화에 첨부됩니다.</p>
        )}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:bg-secondary">닫기</button>
        </div>
      </div>
    </div>
  );
}
