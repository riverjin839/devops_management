import { useEffect, useState } from 'react';
import { Loader2, Link2, Link2Off, AlertTriangle, Trash2, ExternalLink } from 'lucide-react';
import { useJiraUnlink, useJiraRelink } from '@/hooks/useJira';
import { useToast, ConfirmDialog, RunLogPanel } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { WorkItem } from '@/types';

interface JiraLinkDialogProps {
  open: boolean;
  onClose: () => void;
  item: WorkItem | null;
  /** 다시 가져오기가 "Jira 에 없음"으로 끝나 열린 경우 — 상단에 사유를 띄운다. */
  missingDetail?: string;
}

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

/**
 * 업무의 Jira **연결 관리** — 해제 / 다른 이슈로 변경 / 업무까지 삭제.
 *
 * Jira 에서 이슈를 직접 지웠거나 잘못된 프로젝트에 만들었을 때 PEP 에 남는 죽은 링크를
 * 화면에서 정리하는 유일한 경로다. 표시용 `jiraUrl` 만 고쳐서는 실제 연결
 * (`jiraIssueKey`/`jiraIssueId`)이 바뀌지 않으므로 여기서 서버 검증을 거쳐 갈아끼운다.
 *
 * 연결을 해제하면 `jiraIssueKey` 가 비어 **Jira·Confluence 자동 생성이 다시 열린다** —
 * 잘못된 프로젝트에 만든 이슈를 지우고 올바른 곳에 재생성하는 흐름이 이걸로 완성된다.
 */
export function JiraLinkDialog({ open, onClose, item, missingDetail }: JiraLinkDialogProps) {
  const toast = useToast();
  const unlink = useJiraUnlink();
  const relink = useJiraRelink();
  const [keyOrUrl, setKeyOrUrl] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 연결 변경·해제·삭제 실행 로그(D-136). 성공하면 기존처럼 닫히고, 실패하면 열린 채 error 줄을 보여준다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('jira-link');
  const clearLog = runLog.clear;

  useEffect(() => {
    if (open) { setKeyOrUrl(''); setConfirmDelete(false); clearLog(); }
  }, [open, clearLog]);

  if (!item) return null;
  const busy = unlink.isPending || relink.isPending;
  const currentKey = item.jiraIssueKey ?? '';

  const runUnlink = async (deleteWorkItem: boolean) => {
    const r = await runLogged(runLog, {
      title: deleteWorkItem ? '연결 해제 · 업무 삭제' : '연결 해제',
      first: `${currentKey || '연결 없음'} — ${deleteWorkItem ? '연결 해제 후 업무 삭제' : '연결 해제'} 요청`,
      fn: async () => (await unlink.mutateAsync({ itemId: item.id, data: { deleteWorkItem } })).data,
      summarize: (res): RunLogEntry[] => {
        if (res.status !== 'ok') return [['error', `연결 해제 실패 — ${res.detail || '사유 없음'}`]];
        const out: RunLogEntry[] = [['info', `연결 해제 완료 — ${res.detail}`]];
        if (deleteWorkItem) {
          out.push(res.workItemDeleted
            ? ['info', '업무 삭제 완료']
            : ['warn', '업무 삭제 안 됨 — 연결만 해제됨']);
        }
        return out;
      },
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('연결 해제 실패', formatApiError(r.error));
      return;
    }
    if (r.data.status !== 'ok') {
      toast.error('연결 해제 실패', r.data.detail);
      return;
    }
    toast.success(deleteWorkItem ? '업무 삭제됨' : '연결 해제됨', r.data.detail);
    onClose();
  };

  const runRelink = async () => {
    const value = keyOrUrl.trim();
    if (!value) return;
    const r = await runLogged(runLog, {
      title: '연결 변경',
      first: `${currentKey || '연결 없음'} → ${value} 연결 변경 요청`,
      fn: async () => (await relink.mutateAsync({ itemId: item.id, data: { keyOrUrl: value } })).data,
      summarize: (res): RunLogEntry[] => {
        if (res.status === 'ok') {
          const out: RunLogEntry[] = [['info', `연결 변경 완료 — ${res.jiraKey ?? value} · ${res.detail}`]];
          if (res.jiraUrl) out.push(['info', `Jira URL ${res.jiraUrl}`]);
          return out;
        }
        const level = res.status === 'missing' ? 'warn' : 'error';
        return [[level, `연결 변경 실패(${res.status}) — ${res.detail || '사유 없음'}`]];
      },
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('연결 변경 실패', formatApiError(r.error));
      return;
    }
    if (r.data.status !== 'ok') {
      toast.error('연결 변경 실패', r.data.detail);
      return;
    }
    toast.success('연결 변경됨', r.data.detail);
    onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader className="flex-row items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-brand-jira/10 flex items-center justify-center flex-shrink-0">
              <Link2 className="w-5 h-5 text-brand-jira dark:text-blue-300" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>Jira 연결 관리</DialogTitle>
              <DialogDescription className="truncate">
                {item.title || item.content}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="px-5 pb-5 space-y-3.5">
            {missingDetail && (
              <div className="rounded-xl bg-status-warning/10 text-status-warning px-3 py-2 text-sm flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{missingDetail}</span>
              </div>
            )}

            {/* 현재 연결 */}
            <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm space-y-1.5">
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 flex-shrink-0">현재 연결</span>
                {currentKey ? (
                  item.jiraUrl ? (
                    <a href={item.jiraUrl} target="_blank" rel="noreferrer"
                      className="font-mono text-brand-jira dark:text-blue-300 hover:underline inline-flex items-center gap-1">
                      {currentKey} <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : <span className="font-mono">{currentKey}</span>
                ) : <span className="text-muted-foreground">연결 없음</span>}
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 flex-shrink-0">마지막 동기화</span>
                <span>{item.jiraSyncedAt ? new Date(item.jiraSyncedAt).toLocaleString() : '—'}</span>
              </div>
            </div>

            {/* 연결 변경 */}
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-1 block">
                다른 이슈로 연결 변경
              </span>
              <input
                className={inputCls}
                placeholder="DL-42 또는 https://jira.example.com/browse/DL-42"
                value={keyOrUrl}
                onChange={(e) => setKeyOrUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && keyOrUrl.trim()) { e.preventDefault(); void runRelink(); } }}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Jira 에 실제로 있는 이슈인지 확인한 뒤 연결하고, 제목·상태·Epic 을 바로 가져옵니다.
              </p>
            </div>

            {/* 업무까지 삭제 */}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-status-critical/30 text-sm text-status-critical hover:bg-status-critical/10 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              연결 해제하고 이 업무도 삭제
            </button>

            {/* 실행 로그 — "로그 보기" 는 사용자가 정한다. */}
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          </div>

          <DialogFooter className="pt-0">
            <Button
              type="button"
              onClick={() => void runRelink()}
              disabled={busy || !keyOrUrl.trim()}
              className="bg-brand-jira text-primary-foreground hover:bg-brand-jira/90"
            >
              {relink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              연결 변경
            </Button>
            <Button type="button" variant="outline" onClick={() => void runUnlink(false)} disabled={busy || !currentKey}>
              {unlink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2Off className="w-4 h-4" />}
              연결만 해제
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="ml-auto">
              닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title="업무 삭제"
        description={`"${item.title || item.category}" 업무를 Jira 연결과 함께 삭제합니다. Jira 이슈는 지우지 않습니다.`}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={() => { setConfirmDelete(false); void runUnlink(true); }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
