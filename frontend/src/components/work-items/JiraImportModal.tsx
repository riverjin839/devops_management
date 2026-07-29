import { useState } from 'react';
import { X, Loader2, DownloadCloud, AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import { useJiraImport } from '@/hooks/useJira';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { JiraImportResult } from '@/types';

interface JiraImportModalProps {
  open: boolean;
  onClose: () => void;
  defaultProjectKey?: string | null;
}

type Scope = 'me' | 'project' | 'filter' | 'jql';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'me', label: '내게 할당된 이슈', hint: 'assignee = currentUser()' },
  { id: 'project', label: '프로젝트 선택', hint: '프로젝트 키로 가져오기' },
  { id: 'filter', label: '조건 조합', hint: '프로젝트·라벨·컴포넌트·상태' },
  { id: 'jql', label: '직접 JQL', hint: '임의 JQL 입력' },
];

export function JiraImportModal({ open, onClose, defaultProjectKey }: JiraImportModalProps) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const importMut = useJiraImport();
  const [scope, setScope] = useState<Scope>('me');
  const [projectKey, setProjectKey] = useState(defaultProjectKey ?? '');
  const [jql, setJql] = useState('');
  // 조건 조합 (scope='filter') — 콤마 구분 입력.
  const [labels, setLabels] = useState('');
  const [components, setComponents] = useState('');
  const [statuses, setStatuses] = useState('');
  const [assignee, setAssignee] = useState('');
  const [sinceDays, setSinceDays] = useState('');
  const [preview, setPreview] = useState<JiraImportResult | null>(null);
  // 미리보기에서 사용자가 제외한 Jira 키 (기본은 전부 적용).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  if (!open) return null;

  const busy = importMut.isPending;

  const run = async (dryRun: boolean) => {
    setPreview(null);
    try {
      const applicable = (preview?.items ?? [])
        .filter((it) => it.action !== 'unchanged')
        .map((it) => it.jiraKey);
      const { data } = await importMut.mutateAsync({
        scope,
        projectKey: scope === 'project' || scope === 'filter' ? projectKey.trim() : undefined,
        jql: scope === 'jql' ? jql.trim() : undefined,
        labels: scope === 'filter' ? csv(labels) : undefined,
        components: scope === 'filter' ? csv(components) : undefined,
        statuses: scope === 'filter' ? csv(statuses) : undefined,
        assignee: scope === 'filter' && assignee.trim() ? assignee.trim() : undefined,
        updatedSinceDays: scope === 'filter' && sinceDays.trim() ? Number(sinceDays) : undefined,
        // 확정 적용 시, 미리보기에서 제외한 항목은 빼고 보낸다.
        onlyKeys: !dryRun && excluded.size > 0
          ? applicable.filter((k) => !excluded.has(k))
          : undefined,
        dryRun,
      });
      if (data.status !== 'ok') {
        toast.error('Jira ' + (data.status === 'offline' ? '연결 실패' : '오류'), data.detail || '가져오기에 실패했습니다.');
        setPreview(data);
        return;
      }
      setPreview(data);
      if (dryRun) setExcluded(new Set());
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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="jira-import-modal-title" className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-lg mx-4 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <DownloadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="jira-import-modal-title" className="text-base font-semibold leading-tight">Jira 가져오기</h2>
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
          {scope === 'filter' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">프로젝트 키</span>
                  <input className={inputCls} placeholder="PROJ" value={projectKey}
                    onChange={(e) => setProjectKey(e.target.value)} />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">라벨 (쉼표)</span>
                  <input className={inputCls} placeholder="infra, urgent" value={labels}
                    onChange={(e) => setLabels(e.target.value)} />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">컴포넌트 (쉼표)</span>
                  <input className={inputCls} placeholder="K8s, Network" value={components}
                    onChange={(e) => setComponents(e.target.value)} />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">상태 (쉼표)</span>
                  <input className={inputCls} placeholder="In Progress, Done" value={statuses}
                    onChange={(e) => setStatuses(e.target.value)} />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">담당자 (선택)</span>
                  <input className={inputCls} placeholder="jira 계정 또는 currentUser()" value={assignee}
                    onChange={(e) => setAssignee(e.target.value)} />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">최근 N일 변경분</span>
                  <input className={inputCls} type="number" min={1} placeholder="7" value={sinceDays}
                    onChange={(e) => setSinceDays(e.target.value)} />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">입력한 조건은 AND 로 묶이고, 쉼표로 나열한 값은 OR 로 처리됩니다.</p>
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
              {preview.dryRun && (
                <p className="text-xs text-muted-foreground mt-1">
                  미리보기 — 아직 저장되지 않았습니다. 아래에서 <b>적용할 항목만 체크</b>한 뒤 "가져오기"를 누르세요.
                  {excluded.size > 0 && <span className="text-amber-500"> ({excluded.size}건 제외됨)</span>}
                </p>
              )}
              {preview.items.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-border/40">
                  {preview.items.map((it) => (
                    <li key={it.jiraKey} className="py-1">
                      <div className="flex items-center gap-2">
                        {preview.dryRun && it.action !== 'unchanged' && (
                          <input type="checkbox" className="rounded border-border"
                            checked={!excluded.has(it.jiraKey)}
                            onChange={(e) => setExcluded((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(it.jiraKey);
                              else next.add(it.jiraKey);
                              return next;
                            })}
                            aria-label={`${it.jiraKey} 적용 여부`} />
                        )}
                        <span className={`text-[10px] font-semibold px-1 rounded ${
                          it.action === 'create' ? 'bg-emerald-500/15 text-emerald-500'
                            : it.action === 'update' ? 'bg-blue-500/15 text-blue-500'
                            : 'bg-secondary text-muted-foreground'
                        }`}>
                          {it.action === 'create' ? '신규' : it.action === 'update' ? '갱신' : '변경없음'}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">{it.jiraKey}</span>
                        <span className="truncate flex-1">{it.title}</span>
                      </div>
                      {(it.changes?.length ?? 0) > 0 && (
                        <ul className="ml-6 mt-0.5 space-y-0.5">
                          {(it.changes ?? []).map((c) => (
                            <li key={c.field} className="text-[11px] text-muted-foreground">
                              <span className="font-medium text-foreground">{c.label || c.field}</span>{' '}
                              <span className="line-through opacity-70">{c.old || '(없음)'}</span>
                              {' → '}
                              <span className="text-blue-500">{c.new || '(없음)'}</span>
                            </li>
                          ))}
                        </ul>
                      )}
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
