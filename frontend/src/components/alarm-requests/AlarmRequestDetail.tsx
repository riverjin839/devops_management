import { useState } from 'react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { formatDateTime } from '@/lib/utils';
import type { CanOperate } from '@/hooks/useCanOperate';
import type { AlarmRequest, AlarmRequestActionKind } from '@/types';
import { ThresholdTable } from './ThresholdTable';
import { ACTION_LABEL, BTN, BTN_DANGER, BTN_PRIMARY, INPUT, STATUS_LABEL, STATUS_VARIANT } from './styles';

interface Props {
  req: AlarmRequest;
  username: string;
  perm: CanOperate;
  busy: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onCancel: () => void;
  onAct: (action: AlarmRequestActionKind, comment?: string) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 min-w-0">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="text-sm min-w-0">{children}</div>
    </div>
  );
}

const NEXT_ACTIONS: Record<string, AlarmRequestActionKind[]> = {
  requested: ['reviewing', 'rejected', 'approved'],
  reviewing: ['rejected', 'approved'],
  approved: ['rejected', 'applied'],
};

export function AlarmRequestDetail({ req, username, perm, busy, onEdit, onCopy, onCancel, onAct }: Props) {
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState<null | 'cancel' | 'applied'>(null);
  const [commentErr, setCommentErr] = useState(false);
  const mine = req.requestedBy === username;
  const editable = req.status === 'requested' && (mine || perm.canOperate);
  const adminActions = NEXT_ACTIONS[req.status] ?? [];

  const act = (a: AlarmRequestActionKind) => {
    if (a === 'rejected' && !comment.trim()) { setCommentErr(true); return; }
    if (a === 'applied') { setConfirm('applied'); return; }
    onAct(a, comment.trim() || undefined);
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
          <Field label={`검토 의견 — ${req.reviewedBy ?? ''}`}>
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

        {adminActions.length > 0 && (
          <label className="grid gap-1">
            <span className="text-xs font-semibold">검토 의견 <span className="font-normal text-muted-foreground">(반려 시 필수)</span></span>
            <textarea id="ar-review-comment" className={INPUT} rows={2} value={comment} disabled={!perm.canOperate}
              title={perm.withHint('검토 의견')} aria-invalid={commentErr || undefined}
              placeholder="요청자에게 전달됩니다"
              onChange={(e) => { setComment(e.target.value); setCommentErr(false); }} />
            {commentErr && <span role="alert" className="text-xs text-status-critical">반려 사유를 입력하세요.</span>}
          </label>
        )}
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
          {!editable && !(mine && req.status === 'rejected') && adminActions.length === 0 && (
            <span className="text-xs text-muted-foreground">
              {req.status === 'applied' ? '클러스터 알람 규칙에 반영된 요청입니다.' : '처리가 끝난 요청입니다.'}
            </span>
          )}
        </div>
        {adminActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {adminActions.map((a) => {
              const label = a === 'applied' ? '반영 완료 처리' : ACTION_LABEL[a];
              return (
                <button key={a} type="button" disabled={busy || !perm.canOperate}
                  title={perm.withHint(label)} aria-label={perm.ariaWithHint(label)}
                  className={a === 'rejected' ? BTN_DANGER : a === 'approved' || a === 'applied' ? BTN_PRIMARY : BTN}
                  onClick={() => act(a)}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
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
      <ConfirmDialog
        open={confirm === 'applied'}
        title={`${req.code} 반영 완료로 처리할까요?`}
        description="알람 규칙(PrometheusRule 등)에 반영을 마친 뒤 누르세요. 이 화면은 클러스터에 명령을 보내지 않습니다. 수정 임계치가 이 알람의 기본 임계치(카탈로그)로 저장됩니다."
        confirmLabel="반영 완료"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); onAct('applied', comment.trim() || undefined); setComment(''); }}
      >
        <p className="text-xs text-muted-foreground">대상 클러스터: {req.clusters.map((c) => c.name).join(', ')}</p>
      </ConfirmDialog>
    </MacCard>
  );
}
