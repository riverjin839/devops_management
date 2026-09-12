import { useEffect, useState } from 'react';
import { Loader2, Ticket, ExternalLink, ScrollText, AlertTriangle } from 'lucide-react';
import { useServiceNowRegister } from '@/hooks/useServiceNow';
import { useToast, LogViewer } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ServiceNowRegisterResult, WorkItem } from '@/types';

interface ServiceNowRegisterDialogProps {
  open: boolean;
  onClose: () => void;
  item: WorkItem | null;
}

// 단계별 로그(steps)를 사람이 읽는 텍스트로 변환 — LogViewer 는 텍스트 블롭 하나만 받는다.
// CLAUDE.md: 모든 "실행" 버튼은 상세 로그 출력 + 로그 보기 옵션을 함께 제공해야 한다.
function buildRegisterLog(res: ServiceNowRegisterResult): string {
  return res.steps.map((s) => `[${s.status}] ${s.step} — ${s.message}`).join('\n');
}

/**
 * 업무의 ServiceNow ITSM **수동 등록** — Jira 와 이미 연동된 업무만 대상.
 *
 * 등록은 짧은(수 초) 다단계 서버 호출이라 SSH/exec 콘솔이 아니라, 응답에 담긴 단계별
 * 구조화 로그(steps)를 "로그 보기" 토글로 펼쳐 보여주는 패턴을 쓴다
 * (`NodeSpecPage.tsx` 의 Host Facts 수집 버튼과 동일).
 */
export function ServiceNowRegisterDialog({ open, onClose, item }: ServiceNowRegisterDialogProps) {
  const toast = useToast();
  const register = useServiceNowRegister();
  const [result, setResult] = useState<ServiceNowRegisterResult | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (open) { setResult(null); setLogOpen(false); }
  }, [open]);

  if (!item) return null;
  const busy = register.isPending;
  const alreadyRegistered = Boolean(item.servicenowNumber);

  const runRegister = async () => {
    try {
      const { data } = await register.mutateAsync(item.id);
      setResult(data);
      if (data.status === 'ok') {
        toast.success('ServiceNow 등록 완료', `${data.ticketNumber ?? ''} 생성됨`);
      } else {
        toast.warning('ServiceNow 등록 실패', data.detail || '아래 로그를 확인하세요.');
        setLogOpen(true);
      }
    } catch (err) {
      toast.error('ServiceNow 등록 실패', formatApiError(err));
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
              <span className="font-mono">{item.jiraIssueKey ?? '-'}</span>
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
            <div className="rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 px-3 py-2 text-sm flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Settings → 연동(Jira)에서 &apos;SSO 자동 로그인&apos; 후 다시 시도하세요.</span>
            </div>
          )}

          {/* 실행 결과 — 요약 + 상세 로그(사용자가 켜고 끄는 "로그 보기"). CLAUDE.md:
              모든 "실행" 버튼은 상세 로그 출력 + 로그 보기 옵션을 함께 제공해야 한다. */}
          {result && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                <span className={`text-sm ${result.status === 'ok' ? 'text-status-healthy' : 'text-status-critical'}`}>
                  {result.status === 'ok' ? `등록 완료 — ${result.ticketNumber}` : `등록 실패 — ${result.detail}`}
                </span>
                <button
                  type="button"
                  onClick={() => setLogOpen((v) => !v)}
                  className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  aria-expanded={logOpen}
                >
                  <ScrollText className="w-3.5 h-3.5" />
                  {logOpen ? '로그 숨기기' : `로그 보기 (${result.steps.length}단계)`}
                </button>
              </div>
              {logOpen && <LogViewer text={buildRegisterLog(result)} maxHeight="max-h-64" />}
            </div>
          )}
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
