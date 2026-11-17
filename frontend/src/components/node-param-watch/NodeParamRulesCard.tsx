// 감시 규칙 목록 — 공통 규칙(모든 클러스터, admin)과 이 클러스터 규칙(operator). 같은 파라미터면 클러스터 규칙이 이긴다.
import { useMemo, useState } from 'react';
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteNodeParamRule } from '@/hooks/useNodeParamWatch';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import type { NodeParamRule } from '@/types';
import { NodeParamRuleDialog } from './NodeParamRuleDialog';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2 align-top';
const OP_LABEL: Record<string, string> = { any: '변경만 추적', eq: '=', ne: '≠', gte: '≥', lte: '≤', in: '다음 중 하나' };
const SEV_LABEL: Record<string, string> = { info: '정보', warning: '경고', critical: '위험' };
const COMMON_HINT = '공통 규칙은 관리자만 고칠 수 있습니다';
const ICON_BTN = 'inline-flex items-center justify-center w-7 h-7 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40';

interface Props {
  clusterId: string;
  clusterName: string;
  rules: NodeParamRule[];
}

export function NodeParamRulesCard({ clusterId, clusterName, rules }: Props) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const del = useDeleteNodeParamRule();
  const [editing, setEditing] = useState<NodeParamRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<NodeParamRule | null>(null);

  // 이 클러스터 규칙에 가려진 공통 규칙 — 화면에서 왜 안 쓰이는지 보이게 표시한다.
  const overridden = useMemo(() => {
    const scoped = new Set(rules.filter((r) => r.clusterId && r.enabled).map((r) => r.param));
    return new Set(rules.filter((r) => !r.clusterId && scoped.has(r.param)).map((r) => r.id));
  }, [rules]);

  const canEdit = (r: NodeParamRule) => canOperate && (r.clusterId !== null || isAdmin);
  const editHint = (r: NodeParamRule, action: string) =>
    !canOperate ? withHint(action) : (r.clusterId === null && !isAdmin ? COMMON_HINT : action);

  const onDelete = async () => {
    if (!deleting) return;
    try {
      await del.mutateAsync(deleting.id);
      toast.success(`${deleting.param} 규칙을 지웠습니다`);
      setDeleting(null);
    } catch (e) {
      toast.error('규칙 삭제 실패', formatApiError(e));
    }
  };

  return (
    <MacCard
      title="감시 규칙"
      titleExtra={<span className="text-xs text-muted-foreground">{rules.length}개</span>}
      description="에이전트가 읽어 오는 파라미터와 기준값"
      actions={(
        <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => setCreating(true)}
          title={withHint('규칙 추가')} aria-label={ariaWithHint('규칙 추가')}>
          <Plus /> 규칙 추가
        </Button>
      )}
      bodyPadding="p-0"
    >
      {rules.length === 0 ? (
        <EmptyState icon={ListChecks} compact title="감시 규칙이 없습니다" description="규칙을 추가하면 에이전트가 다음 보고부터 그 값을 읽어 온다." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>파라미터</th>
                <th className={TH}>범위</th>
                <th className={TH}>적용 노드</th>
                <th className={TH}>기준</th>
                <th className={TH}>심각도</th>
                <th className={TH}>알람</th>
                <th className={TH}>사용</th>
                <th className={`${TH} w-20`}><span className="sr-only">동작</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const muted = !r.enabled || overridden.has(r.id);
                return (
                  <tr key={r.id} className={`border-b border-border last:border-0 ${muted ? 'text-muted-foreground' : ''}`}>
                    <td className={TD}>
                      <span className="font-mono text-xs">{r.param}</span>
                      {r.description && <span className="block mt-0.5 text-xs text-muted-foreground">{r.description}</span>}
                    </td>
                    <td className={`${TD} text-xs`}>
                      {r.clusterId ? '이 클러스터' : '공통'}
                      {overridden.has(r.id) && <span className="block text-muted-foreground">클러스터 규칙에 가려짐</span>}
                    </td>
                    <td className={`${TD} font-mono text-xs`}>{r.nodePattern || <span className="font-sans text-muted-foreground">모든 노드</span>}</td>
                    <td className={`${TD} font-mono text-xs`}>{r.operator === 'any' ? <span className="font-sans">{OP_LABEL.any}</span> : `${OP_LABEL[r.operator]} ${r.expected ?? ''}`}</td>
                    <td className={`${TD} text-xs`}>{SEV_LABEL[r.severity] ?? r.severity}</td>
                    <td className={`${TD} text-xs`}>
                      {[r.alertOnChange && '변경', r.checkPersistent && '영구 설정 불일치', r.operator !== 'any' && '기준 위반']
                        .filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className={`${TD} text-xs`}>{r.enabled ? '사용' : '꺼짐'}</td>
                    <td className={TD}>
                      <div className="flex gap-1 justify-end">
                        <button type="button" className={ICON_BTN} disabled={!canEdit(r)} onClick={() => setEditing(r)}
                          title={editHint(r, '편집')} aria-label={`${r.param} 규칙 편집`}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" className={ICON_BTN} disabled={!canEdit(r)} onClick={() => setDeleting(r)}
                          title={editHint(r, '삭제')} aria-label={`${r.param} 규칙 삭제`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <NodeParamRuleDialog
        open={creating || !!editing}
        rule={editing}
        clusterId={clusterId}
        clusterName={clusterName}
        canEditCommon={isAdmin}
        onClose={() => { setCreating(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={!!deleting}
        danger
        title="감시 규칙을 지울까요?"
        description={deleting ? `${deleting.param} (${deleting.clusterId ? '이 클러스터' : '모든 클러스터 공통'}) — 에이전트는 다음 보고부터 이 값을 읽지 않는다. 변경 이력은 남는다.` : undefined}
        confirmLabel="삭제"
        busy={del.isPending}
        onConfirm={() => { void onDelete(); }}
        onCancel={() => setDeleting(null)}
      />
    </MacCard>
  );
}
