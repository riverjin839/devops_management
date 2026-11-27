import { useState } from 'react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { formatDateTime } from '@/lib/utils';
import type { CanOperate } from '@/hooks/useCanOperate';
import { cn } from '@/lib/utils';
import type { AlarmRequest, AlarmRequestStatus } from '@/types';
import { RuleApplyPanel } from './RuleApplyPanel';
import { ThresholdTable } from './ThresholdTable';
import { ACTION_LABEL, BTN, BTN_DANGER, BTN_PRIMARY, INPUT, STATUS_LABEL, STATUS_ORDER, STATUS_VARIANT } from './styles';

interface Props {
  req: AlarmRequest;
  username: string;
  perm: CanOperate;
  busy: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onCancel: () => void;
  onSetStatus: (status: AlarmRequestStatus, comment?: string) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 min-w-0">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="text-sm min-w-0">{children}</div>
    </div>
  );
}

export function AlarmRequestDetail({ req, username, perm, busy, onEdit, onCopy, onCancel, onSetStatus }: Props) {
  const [next, setNext] = useState<AlarmRequestStatus>(req.status);
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState<null | 'cancel'>(null);
  const [commentErr, setCommentErr] = useState(false);
  const mine = req.requestedBy === username;
  const editable = req.status === 'in_progress' && (mine || perm.canOperate);
  const changed = next !== req.status;

  const saveStatus = () => {
    if (next === 'rejected' && !comment.trim()) { setCommentErr(true); return; }
    onSetStatus(next, comment.trim() || undefined);
    setComment('');
  };

  return (
    <MacCard
      title={`${req.code} · ${req.metricName}`}
      titleExtra={<StatusBadge variant={STATUS_VARIANT[req.status]} label={STATUS_LABEL[req.status]} size="sm" />}
      bodyPadding="p-0"
    >
      <div className="p-4 grid gap-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="요청자">
            {req.requesterName || req.requestedBy}
            <span className="text-xs text-muted-foreground"> · {formatDateTime(req.createdAt)}</span>
          </Field>
          <Field label="서비스 명">
            <span className="text-xs font-mono border border-border rounded-md px-1.5 py-0.5">{req.service}</span>
            <span className="text-xs text-muted-foreground ml-2">{req.catalogItemId ? '기존 알람' : '신규 알람'}</span>
          </Field>
        </div>
        <Field label="알람 의미"><p className="whitespace-pre-wrap">{req.meaning}</p></Field>
        <Field label="임계치"><ThresholdTable rows={req.thresholds} /></Field>
        <Field label={`적용 클러스터 (${req.clusters.length})`}>
          <div className="flex flex-wrap gap-1.5">
            {req.clusters.map((c) => (
              <span key={c.id} className={`text-xs px-2 py-0.5 rounded-full border border-border bg-secondary/60 ${c.hidden ? 'text-muted-foreground italic' : ''}`}>
                {c.name}
              </span>
            ))}
          </div>
        </Field>
        <Field label="비고">
          {req.note ? <p className="whitespace-pre-wrap">{req.note}</p> : <span className="text-muted-foreground">없음</span>}
        </Field>
        {req.reviewComment && (
          <Field label={`처리 메모 — ${req.reviewedBy ?? ''}`}>
            <p className={`whitespace-pre-wrap ${req.status === 'rejected' ? 'text-status-critical' : ''}`}>{req.reviewComment}</p>
          </Field>
        )}
        <div className="border-t border-border pt-3">
          <Field label="처리 이력">
            <ol className="grid gap-1.5">
              {req.history.map((h, i) => (
                <li key={i} className="grid grid-cols-[minmax(0,180px)_1fr] gap-2 text-xs">
                  <time className="text-muted-foreground tabular-nums whitespace-nowrap">{formatDateTime(h.at)}</time>
                  <span>
                    <span className="font-medium">{h.by}</span> {ACTION_LABEL[h.action] ?? h.action}
                    {h.comment && <span className="text-muted-foreground"> — {h.comment}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Field>
        </div>

        <RuleApplyPanel req={req} perm={perm} />

        <div className="grid gap-2 border-t border-border pt-3">
          <span className="text-xs font-semibold text-muted-foreground">상태</span>
          <div role="radiogroup" aria-label="상태" className="inline-flex w-fit rounded-xl border border-border bg-muted/20 p-0.5">
            {STATUS_ORDER.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={next === s} disabled={!perm.canOperate || busy}
                title={perm.withHint(STATUS_LABEL[s])}
                className={cn('px-3 py-1 text-sm rounded-lg', next === s ? 'bg-card text-foreground shadow-sm border border-border' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => { setNext(s); setCommentErr(false); }}>
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          {changed && (
            <label className="grid gap-1">
              <span className="text-xs font-semibold">
                처리 메모 <span className="font-normal text-muted-foreground">{next === 'rejected' ? '(반려 사유 — 필수)' : '(선택)'}</span>
              </span>
              <textarea id="ar-status-comment" className={INPUT} rows={2} value={comment} disabled={!perm.canOperate}
                aria-invalid={commentErr || undefined} placeholder="요청자에게 전달됩니다"
                onChange={(e) => { setComment(e.target.value); setCommentErr(false); }} />
              {commentErr && <span role="alert" className="text-xs text-status-critical">반려 사유를 입력하세요.</span>}
              {next === 'done' && (
                <span className="text-xs text-muted-foreground">
                  완료로 바꾸면 수정 임계치가 이 알람의 기본 임계치(알람 카탈로그)로 저장됩니다. 클러스터에는 아무것도 보내지 않습니다 — 자동 적용은 「클러스터에 적용」.
                </span>
              )}
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border">
        <div className="flex flex-wrap gap-2">
          {editable && (
            <>
              <button type="button" className={BTN} onClick={onEdit} disabled={busy}>수정</button>
              <button type="button" className={BTN_DANGER} onClick={() => setConfirm('cancel')} disabled={busy}>요청 취소</button>
            </>
          )}
          {mine && req.status === 'rejected' && (
            <button type="button" className={BTN} onClick={onCopy}>복사해서 다시 요청</button>
          )}
          {!editable && !(mine && req.status === 'rejected') && (
            <span className="text-xs text-muted-foreground">
              {req.status === 'done' ? '완료된 요청입니다.' : '「진행」 상태인 요청만 요청자가 수정·취소할 수 있습니다.'}
            </span>
          )}
        </div>
        {(() => {
          const label = changed ? `「${STATUS_LABEL[next]}」(으)로 저장` : '상태 저장';
          return (
            <button type="button" disabled={busy || !perm.canOperate || !changed}
              title={perm.withHint(label)} aria-label={perm.ariaWithHint(label)}
              className={next === 'rejected' && changed ? BTN_DANGER : BTN_PRIMARY}
              onClick={saveStatus}>
              {label}
            </button>
          );
        })()}
      </div>

      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`${req.code} 요청을 취소할까요?`}
        description="요청이 삭제되고 되돌릴 수 없습니다."
        confirmLabel="요청 취소"
        cancelLabel="닫기"
        danger
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); onCancel(); }}
      />
    </MacCard>
  );
}
