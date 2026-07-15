import { useState } from 'react';
import { X, Loader2, DownloadCloud, AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import { useJiraImport } from '@/hooks/useJira';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { JiraImportResult } from '@/types';

interface JiraImportModalProps {
  open: boolean;
  onClose: () => void;
  defaultProjectKey?: string | null;
}

type Scope = 'me' | 'project' | 'jql';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'me', label: '내게 할당된 이슈', hint: 'assignee = currentUser()' },
  { id: 'project', label: '프로젝트 선택', hint: '프로젝트 키로 가져오기' },
  { id: 'jql', label: '직접 JQL', hint: '임의 JQL 입력' },
];

export function JiraImportModal({ open, onClose, defaultProjectKey }: JiraImportModalProps) {
  const toast = useToast();
  const importMut = useJiraImport();
  const [scope, setScope] = useState<Scope>('me');
  const [projectKey, setProjectKey] = useState(defaultProjectKey ?? '');
  const [jql, setJql] = useState('');
  const [preview, setPreview] = useState<JiraImportResult | null>(null);

  if (!open) return null;

  const busy = importMut.isPending;

  const run = async (dryRun: boolean) => {
    setPreview(null);
    try {
      const { data } = await importMut.mutateAsync({
        scope,
        projectKey: scope === 'project' ? projectKey.trim() : undefined,
        jql: scope === 'jql' ? jql.trim() : undefined,
        dryRun,
      });
      if (data.status !== 'ok') {
        toast.error('Jira ' + (data.status === 'offline' ? '연결 실패' : '오류'), data.detail || '가져오기에 실패했습니다.');
        setPreview(data);
        return;
      }
      setPreview(data);
      if (dryRun) {
        toast.info('미리보기 완료', `신규 ${data.imported} · 갱신 ${data.updated} · 건너뜀 ${data.skipped}`);
      } else {
        toast.success('Jira 가져오기 완료', `신규 ${data.imported} · 갱신 ${data.updated}`);
      }
    } catch (err) {
      toast.error('요청 실패', formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-lg mx-4 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <DownloadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight">Jira 가져오기</h2>
            <p className="text-xs text-muted-foreground">내 Jira 인증(PAT·세션 쿠키) 권한으로 이슈를 work item 으로 가져옵니다.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {/* 범위 */}
          <div className="flex items-stretch gap-1.5">
            {SCOPES.map((s) => (
              <button key={s.id} type="button" onClick={() => setScope(s.id)} aria-pressed={scope === s.id}
                className={`flex-1 px-2 py-2 rounded-xl border text-xs font-medium transition-colors ${
                  scope === s.id ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                }`}>
                {s.label}
              </button>
            ))}
          </div>

          {scope === 'project' && (
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-1 block">프로젝트 키</span>
              <input className={inputCls} placeholder="PROJ" value={projectKey} onChange={(e) => setProjectKey(e.target.value)} />
            </div>
          )}
          {scope === 'jql' && (
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-1 block">JQL</span>
              <input className={inputCls} placeholder='project = "PROJ" AND status != Done ORDER BY updated DESC'
                value={jql} onChange={(e) => setJql(e.target.value)} />
            </div>
          )}

          {/* 결과/미리보기 */}
          {preview && preview.status === 'ok' && (
            <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm">
              <div className="flex items-center gap-3 font-medium">
                <span className="text-emerald-500">신규 {preview.imported}</span>
                <span className="text-blue-500">갱신 {preview.updated}</span>
                <span className="text-muted-foreground">건너뜀 {preview.skipped}</span>
                <span className="text-muted-foreground ml-auto">검색 {preview.total}건{preview.truncated ? '+' : ''}</span>
              </div>
              {preview.dryRun && <p className="text-xs text-muted-foreground mt-1">미리보기 — 아직 저장되지 않았습니다.</p>}
              {preview.items.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-border/40">
                  {preview.items.map((it) => (
                    <li key={it.jiraKey} className="py-1 flex items-center gap-2">
                      <span className={`text-[10px] font-semibold px-1 rounded ${it.action === 'create' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-blue-500/15 text-blue-500'}`}>
                        {it.action === 'create' ? '신규' : '갱신'}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{it.jiraKey}</span>
                      <span className="truncate flex-1">{it.title}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.errors.length > 0 && (
                <div className="mt-2 text-xs text-red-500">
                  {preview.errors.slice(0, 5).map((e, i) => <div key={i}>⚠ {e}</div>)}
                </div>
              )}
            </div>
          )}
          {preview && preview.status !== 'ok' && (
            <div className="rounded-xl bg-red-500/10 text-red-500 px-3 py-2 text-sm flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> {preview.detail}
            </div>
          )}

          {/* 액션 */}
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={() => run(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
              미리보기
            </button>
            <button type="button" onClick={() => run(false)} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              가져오기
            </button>
            <button type="button" onClick={onClose} disabled={busy}
              className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground">닫기</button>
          </div>
        </div>
      </div>
    </div>
  );
}
