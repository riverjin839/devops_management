import { useEffect, useState } from 'react';
import { Loader2, UploadCloud, AlertTriangle, MessageSquare } from 'lucide-react';
import { useJiraPush } from '@/hooks/useJira';
import { useToast, RunLogPanel } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { KANBAN_STATUS_LABEL } from './workItemKanbanUtils';
import type { JiraPushResult, WorkItem } from '@/types';

interface JiraPushDialogProps {
  open: boolean;
  onClose: () => void;
  item: WorkItem;
}

const PRIORITY_LABEL: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' };
const FIELD_LABEL: Record<string, string> = { summary: '제목', description: '설명', duedate: '마감일', priority: '우선순위' };

/** 반영 응답 → 실행 로그 줄. 필드·필드 오류·전이 후보는 한 건당 한 줄(절삭 없음). */
function pushLogLines(res: JiraPushResult, wantComment: boolean, pushFields: boolean): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  for (const f of res.fieldsUpdated ?? []) out.push(['info', `필드 반영 · ${FIELD_LABEL[f] ?? f}(${f})`]);
  for (const e of res.fieldErrors ?? []) out.push(['error', `필드 반영 실패 — ${e}`]);
  if (pushFields && res.status === 'ok' && !(res.fieldsUpdated?.length) && !(res.fieldErrors?.length)) {
    out.push(['info', '반영된 필드 없음']);
  }
  if (res.status === 'ok') {
    out.push(['info', res.transitioned ? '상태 전이 완료' : '상태 전이 불필요(이미 같은 상태)']);
    if (wantComment) {
      out.push(res.commentAdded ? ['info', '코멘트 추가 완료'] : ['warn', '코멘트 추가 실패']);
    }
  }
  for (const t of res.availableTransitions ?? []) out.push(['info', `가용 전이 · ${t}`]);
  if (res.jiraStatus) out.push(['info', `Jira 현재 상태 ${res.jiraStatus}`]);
  if (res.status === 'ok') {
    const partial = (res.fieldErrors?.length ?? 0) > 0 || (wantComment && !res.commentAdded);
    out.push([partial ? 'warn' : 'info', `${partial ? '일부 반영' : '반영 완료'} — ${res.detail}`]);
  } else if (res.status === 'conflict') {
    out.push(['warn', `충돌 — ${res.detail}`]);
  } else {
    out.push(['error', `반영 실패(${res.status}) — ${res.detail || '사유 없음'}`]);
  }
  return out;
}

/**
 * PEP work item 의 편집 내용을 연결된 Jira 이슈에 반영하는 확인 다이얼로그.
 * 제목(summary)/설명(description)/우선순위(priority) + 칸반 상태(transition) + 선택 코멘트를
 * `POST /jira/push/{id}` 로 전송한다. Jira 쪽이 더 최신이면 서버가 conflict 를 돌려주고,
 * 이때 "강제 반영"으로 다시 시도한다(force). assignee 는 역매핑 불안정으로 반영 대상에서 제외.
 */
export function JiraPushDialog({ open, onClose, item }: JiraPushDialogProps) {
  const toast = useToast();
  const pushJira = useJiraPush();
  const [comment, setComment] = useState('');
  const [pushFields, setPushFields] = useState(true);
  const [conflict, setConflict] = useState<string | null>(null);
  // 반영 실행 로그 — 요청·대기·필드별 결과·필드 오류·전이·코멘트(D-136). 정상 완료 시에만 자동으로 닫는다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('jira-push');
  const clearLog = runLog.clear;

  useEffect(() => {
    if (open) { setComment(''); setPushFields(true); setConflict(null); clearLog(); }
  }, [open, clearLog]);

  const busy = pushJira.isPending;
  const key = item.jiraIssueKey ?? '';

  const run = async (force: boolean) => {
    setConflict(null);
    const text = comment.trim();
    const what = [pushFields ? '필드' : null, '상태', text ? '코멘트' : null].filter(Boolean).join(' · ');
    const r = await runLogged(runLog, {
      title: force ? 'Jira 강제 반영' : 'Jira 반영',
      first: `${key} — ${what} 반영 요청${force ? '(강제)' : ''}`,
      fn: async () => (await pushJira.mutateAsync({
        itemId: item.id, data: { comment: text || undefined, pushFields, force },
      })).data,
      summarize: (res) => pushLogLines(res, Boolean(text), pushFields),
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('Jira 반영 실패', formatApiError(r.error));
      return;
    }
    const data = r.data;
    if (data.status === 'conflict') { setConflict(data.detail); return; }
    if (data.status === 'ok') {
      const partial = (data.fieldErrors?.length ?? 0) > 0 || (Boolean(text) && !data.commentAdded);
      if (partial) {
        // 필드 오류·코멘트 실패가 있으면 닫지 않고 실행 로그로 사유를 보여준다.
        toast.warning('Jira 일부 반영', data.detail);
        return;
      }
      toast.success('Jira 반영', data.detail + (data.jiraStatus ? ` (현재: ${data.jiraStatus})` : ''));
      onClose();
      return;
    }
    toast.error('Jira 반영 실패', data.detail);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader className="flex-row items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-brand-jira/10 flex items-center justify-center flex-shrink-0">
            <UploadCloud className="w-5 h-5 text-brand-jira" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>Jira 반영</DialogTitle>
            <DialogDescription>
              편집 내용을 <span className="font-mono">{key}</span> 이슈에 씁니다.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-3.5">
          {/* 반영 대상 미리보기 */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pushFields} onChange={(e) => setPushFields(e.target.checked)} disabled={busy} />
              <span className="font-medium">제목 · 설명 · 마감일 · 우선순위 반영</span>
            </label>
            <p className="text-xs text-muted-foreground ml-6 mt-0.5">담당자(assignee)는 반영되지 않습니다.</p>
          </div>

          {pushFields && (
            <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm space-y-1.5">
              <div className="flex gap-2">
                <span className="text-muted-foreground w-16 flex-shrink-0">제목</span>
                <span className="truncate">{item.title || '—'}</span>
              </div>
              {item.dueDate && (
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-16 flex-shrink-0">마감일</span>
                  <span>{item.dueDate}</span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-muted-foreground w-16 flex-shrink-0">우선순위</span>
                <span>{PRIORITY_LABEL[item.priority] ?? item.priority}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground w-16 flex-shrink-0">상태</span>
                <span>{KANBAN_STATUS_LABEL[item.kanbanStatus] ?? item.kanbanStatus} <span className="text-muted-foreground">(transition 시도)</span></span>
              </div>
            </div>
          )}

          {/* 코멘트 */}
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" /> 코멘트 (선택)
            </span>
            <textarea
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50 min-h-[64px] resize-y"
              placeholder="Jira 이슈에 남길 코멘트"
              value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
          </div>

          {/* 충돌 경고 */}
          {conflict && (
            <div className="rounded-xl bg-status-warning/10 text-status-warning px-3 py-2 text-sm flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{conflict}</span>
            </div>
          )}

          {/* 실행 로그 — "로그 보기" 는 사용자가 정한다. */}
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
        </div>

        <DialogFooter className="pt-0">
          {conflict ? (
            <Button type="button" variant="destructive" onClick={() => void run(true)} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
              강제 반영
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void run(false)}
              disabled={busy}
              className="bg-brand-jira text-white hover:bg-brand-jira/90"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
              반영
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="ml-auto">
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
