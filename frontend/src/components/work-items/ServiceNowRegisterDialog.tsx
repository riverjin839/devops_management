import { useEffect, useState } from 'react';
import { Loader2, Ticket, ExternalLink, AlertTriangle } from 'lucide-react';
import { useServiceNowRegister } from '@/hooks/useServiceNow';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useToast, RunLogPanel } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ServiceNowRegisterResult, WorkItem } from '@/types';

interface ServiceNowRegisterDialogProps {
  open: boolean;
  onClose: () => void;
  item: WorkItem | null;
}

// 등록 응답 → 실행 로그 줄. 단계(steps)는 한 건당 한 줄(절삭 없음), 이어서 티켓 번호·URL,
// 인증 문제 경고, 마지막에 결과 요약 줄(로그를 접어 두면 이 줄이 보인다).
function registerLogLines(res: ServiceNowRegisterResult): RunLogEntry[] {
  const out: RunLogEntry[] = res.steps.map((s) => [
    s.status === 'ok' ? 'info' : 'error',
    `${s.step} · ${s.status === 'ok' ? '완료' : '실패'}${s.message ? ` — ${s.message}` : ''}`,
  ]);
  if (res.ticketNumber) out.push(['info', `티켓 번호 ${res.ticketNumber}`]);
  if (res.ticketUrl) out.push(['info', `티켓 URL ${res.ticketUrl}`]);
  if (res.authIssue) {
    out.push(['warn', '인증 문제 — 설정 → 연동(Jira)에서 SSO 자동 로그인 후 다시 시도하세요.']);
  }
  out.push(res.status === 'ok'
    ? ['info', `등록 완료 — ${res.ticketNumber ?? res.detail}`]
    : ['error', `등록 실패 — ${res.detail || '사유 없음'}`]);
  return out;
}

/** 단계 이름을 칩 id 로 — 같은 이름이 반복돼도 칩이 겹치지 않게 순번을 붙인다. */
const stepId = (i: number, step: string) => `${i}-${step}`;

/**
 * 업무의 ServiceNow ITSM **수동 등록** — Jira 와 이미 연동된 업무만 대상.
 *
 * 등록은 짧은(수 초) 다단계 서버 호출이라 표준 실행 로그(`RunLogPanel`, DESIGN_SYSTEM.md §12.9.1)로
 * 요청·대기·응답의 단계별 구조화 로그(steps → 단계 칩 + 줄)·티켓·인증 경고를 보여준다.
 * 펼침 여부("로그 보기")는 `servicenow-register` 키로 기억한다.
 */
export function ServiceNowRegisterDialog({ open, onClose, item }: ServiceNowRegisterDialogProps) {
  const toast = useToast();
  const register = useServiceNowRegister();
  const [result, setResult] = useState<ServiceNowRegisterResult | null>(null);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('servicenow-register');
  const clearLog = runLog.clear;

  useEffect(() => {
    if (open) { setResult(null); clearLog(); }
  }, [open, clearLog]);

  if (!item) return null;
  const busy = register.isPending;
  const alreadyRegistered = Boolean(item.servicenowNumber);

  const runRegister = async () => {
    setResult(null);
    const label = item.jiraIssueKey || item.title || item.id;
    const r = await runLogged(runLog, {
      title: 'ServiceNow 등록',
      first: `${label} — ServiceNow ITSM 티켓 ${alreadyRegistered ? '재등록' : '등록'} 요청`,
      fn: async () => (await register.mutateAsync(item.id)).data,
      summarize: (res) => {
        res.steps.forEach((s, i) => runLog.setStep(stepId(i, s.step), s.step, s.status === 'ok' ? 'done' : 'failed'));
        return registerLogLines(res);
      },
    });
    if (r.ok) {
      setResult(r.data);
      if (r.data.status === 'ok') {
        toast.success('ServiceNow 등록됨', `${r.data.ticketNumber ?? ''} 생성됨`);
      } else {
        toast.warning('ServiceNow 등록 실패', r.data.detail || '아래 로그를 확인하세요.');
      }
    } else if (!r.aborted) {
      toast.error('ServiceNow 등록 실패', formatApiError(r.error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader className="flex-row items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-brand-servicenow/10 flex items-center justify-center flex-shrink-0">
            <Ticket className="w-5 h-5 text-brand-servicenow" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>ServiceNow ITSM 등록</DialogTitle>
            <DialogDescription className="truncate">
              {item.title || item.content}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-3.5">
          <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm space-y-1.5">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">Jira 연동</span>
              <span className="font-mono">{item.jiraIssueKey ?? '—'}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">ServiceNow</span>
              {item.servicenowNumber ? (
                item.servicenowUrl ? (
                  <a href={item.servicenowUrl} target="_blank" rel="noreferrer"
                    className="font-mono text-brand-servicenow hover:underline inline-flex items-center gap-1">
                    {item.servicenowNumber} <ExternalLink className="w-3 h-3" />
                  </a>
                ) : <span className="font-mono">{item.servicenowNumber}</span>
              ) : <span className="text-muted-foreground">미등록</span>}
            </div>
            {item.servicenowRegisterError && !result && (
              <div className="flex items-start gap-1.5 text-status-warning">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>마지막 시도 실패: {item.servicenowRegisterError}</span>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Jira 에 이미 등록된 제목/본문/우선순위를 그대로 사용해 사내 ServiceNow 에 티켓을
            생성합니다. 인증은 현재 로그인된 Jira/SSO 세션을 재사용합니다.
          </p>

          {result?.authIssue && (
            <div className="rounded-xl bg-status-warning/10 text-status-warning px-3 py-2 text-sm flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>설정 → 연동(Jira)에서 &apos;SSO 자동 로그인&apos; 후 다시 시도하세요.</span>
            </div>
          )}

          {/* 실행 로그 — 요청·대기·단계(steps)·티켓·인증 경고. "로그 보기" 는 사용자가 정한다. */}
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-64" />
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={() => void runRegister()}
            disabled={busy}
            className="bg-brand-servicenow text-primary-foreground hover:bg-brand-servicenow/90"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ticket className="w-4 h-4" />}
            {alreadyRegistered ? '다시 등록' : '등록 실행'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="ml-auto">
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
