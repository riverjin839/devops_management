import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { cn } from '@/lib/utils';
import type { AlarmCatalogItem, AlarmRequestThreshold, Cluster } from '@/types';
import { validateDraft, type AlarmRequestDraft } from './draft';
import { ThresholdTable } from './ThresholdTable';
import { BTN, BTN_PRIMARY, BTN_SM, INPUT, SEVERITY_ORDER } from './styles';

interface Props {
  draft: AlarmRequestDraft;
  onDraftChange: (d: AlarmRequestDraft) => void;
  services: string[];
  catalog: AlarmCatalogItem[];
  clusters: Cluster[];
  requesterName: string;
  saving: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

/** 카탈로그 항목 → 요청 임계치 행(수정 칸은 기본값으로 시작 — 바꾼 칸만 강조된다). */
function rowsFromCatalog(item: AlarmCatalogItem): AlarmRequestThreshold[] {
  return item.thresholds.map((t) => ({ severity: t.severity, baseExpr: t.expr, baseFor: t.for, newExpr: t.expr, newFor: t.for }));
}

export function AlarmRequestForm({
  draft, onDraftChange, services, catalog, clusters, requesterName, saving, onSubmit, onClose,
}: Props) {
  const [tried, setTried] = useState(false);
  const [clusterQuery, setClusterQuery] = useState('');
  const set = (patch: Partial<AlarmRequestDraft>) => onDraftChange({ ...draft, ...patch });

  const serviceItems = useMemo(() => catalog.filter((c) => c.service === draft.service), [catalog, draft.service]);
  const fromCatalog = draft.catalogItemId != null;
  const missing = validateDraft(draft);
  const visibleClusters = clusters.filter((c) => !clusterQuery || c.name.toLowerCase().includes(clusterQuery.toLowerCase()));

  const pickMetric = (name: string) => {
    const hit = serviceItems.find((c) => c.metricName === name.trim());
    if (hit) {
      set({ metricName: hit.metricName, catalogItemId: hit.id, meaning: draft.meaning || hit.meaning || '', thresholds: rowsFromCatalog(hit) });
    } else {
      // 카탈로그에 없는 이름 = 신규 알람. 카탈로그에서 왔던 행이면 기본 칸을 비운다.
      set({
        metricName: name, catalogItemId: null,
        thresholds: fromCatalog ? draft.thresholds.map((t) => ({ ...t, baseExpr: '', baseFor: '' })) : draft.thresholds,
      });
    }
  };
  const addRow = () => {
    const sev = SEVERITY_ORDER.find((s) => !draft.thresholds.some((t) => t.severity === s));
    if (!sev) return;
    set({ thresholds: [...draft.thresholds, { severity: sev, baseExpr: '', baseFor: '', newExpr: '', newFor: '5m' }] });
  };
  const toggleCluster = (id: string) =>
    set({ clusterIds: draft.clusterIds.includes(id) ? draft.clusterIds.filter((x) => x !== id) : [...draft.clusterIds, id] });

  const submit = () => {
    setTried(true);
    if (missing.length === 0) onSubmit();
  };

  return (
    <MacCard
      title={draft.editId ? '알람 등록 요청 수정' : '새 알람 등록 요청'}
      actions={<button type="button" className={BTN_SM} onClick={onClose}>닫기</button>}
      bodyPadding="p-0"
    >
      <form className="p-4 grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="grid gap-1 min-w-0">
            <span className="text-xs font-semibold">요청자</span>
            <div className="h-9 flex items-center text-sm px-2.5 rounded-xl border border-border bg-secondary/50">{requesterName}</div>
            <span className="text-xs text-muted-foreground">로그인 사용자로 자동 등록</span>
          </div>
          <label className="grid gap-1 min-w-0">
            <span className="text-xs font-semibold">서비스 명 <span className="text-status-critical">*</span></span>
            <select id="ar-service" className={cn(INPUT, 'h-9 py-0')} value={draft.service}
              onChange={(e) => set({ service: e.target.value, metricName: '', catalogItemId: null, thresholds: [] })}>
              {services.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <label className="grid gap-1 min-w-0">
          <span className="text-xs font-semibold">metric 명 (알람 항목) <span className="text-status-critical">*</span></span>
          <input id="ar-metric" className={cn(INPUT, 'font-mono')} list="ar-metric-list" value={draft.metricName}
            placeholder="예: CNPGReplicationLag" aria-invalid={(tried && !draft.metricName.trim()) || undefined}
            onChange={(e) => pickMetric(e.target.value)} />
          <datalist id="ar-metric-list">
            {serviceItems.map((c) => <option key={c.id} value={c.metricName}>{c.meaning ?? ''}</option>)}
          </datalist>
          <span className="text-xs text-muted-foreground">
            {serviceItems.length
              ? `등록된 알람 ${serviceItems.length}개 — 고르면 의미와 기본 임계치가 채워집니다. 새 이름이면 신규 알람으로 요청합니다.`
              : '이 서비스에 등록된 알람이 없습니다. 신규 알람으로 요청합니다.'}
            {draft.metricName.trim() && (fromCatalog ? ' (기존 알람)' : ' (신규 알람)')}
          </span>
        </label>

        <label className="grid gap-1 min-w-0">
          <span className="text-xs font-semibold">알람 의미 <span className="text-status-critical">*</span></span>
          <textarea id="ar-meaning" className={INPUT} rows={2} value={draft.meaning}
            placeholder="이 알람이 울리면 무엇을 뜻하는지, 담당자가 무엇을 확인해야 하는지"
            aria-invalid={(tried && !draft.meaning.trim()) || undefined}
            onChange={(e) => set({ meaning: e.target.value })} />
        </label>

        <div className="grid gap-1.5 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">임계치 <span className="text-status-critical">*</span></span>
            <button type="button" className={BTN_SM} onClick={addRow} disabled={draft.thresholds.length >= SEVERITY_ORDER.length}>
              <Plus className="w-3.5 h-3.5" /> 심각도 행 추가
            </button>
          </div>
          {draft.thresholds.length ? (
            <ThresholdTable rows={draft.thresholds} onChange={(rows) => set({ thresholds: rows })} baseEditable={!fromCatalog} />
          ) : (
            <p className="text-xs text-muted-foreground rounded-md border border-dashed border-border px-3 py-3">
              알람 항목을 고르거나 심각도 행을 추가하세요.
            </p>
          )}
          <span className="text-xs text-muted-foreground">
            기존 알람의 기본 임계치는 현재 운영 값(읽기 전용)입니다. 기본값과 다른 수정 칸은 노란색으로 표시됩니다.
          </span>
        </div>

        <div className="grid gap-1.5 min-w-0">
          <span className="text-xs font-semibold">적용 클러스터 <span className="text-status-critical">*</span></span>
          <div className="rounded-xl border border-border p-2.5 grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <input className={cn(INPUT, 'max-w-[200px] text-xs py-1')} value={clusterQuery} placeholder="클러스터 이름 검색"
                aria-label="클러스터 이름 검색" onChange={(e) => setClusterQuery(e.target.value)} />
              <button type="button" className={BTN_SM}
                onClick={() => set({ clusterIds: Array.from(new Set([...draft.clusterIds, ...visibleClusters.map((c) => c.id)])) })}>
                {clusterQuery ? '검색 결과 선택' : '전체 선택'}
              </button>
              <button type="button" className={BTN_SM} onClick={() => set({ clusterIds: [] })}>선택 해제</button>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{draft.clusterIds.length}개 선택</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {visibleClusters.map((c) => {
                const on = draft.clusterIds.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => toggleCluster(c.id)}
                    className={cn('text-xs px-2.5 py-1 rounded-full border transition-colors',
                      on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card hover:bg-secondary')}>
                    {c.name}
                  </button>
                );
              })}
              {visibleClusters.length === 0 && <span className="text-xs text-muted-foreground">일치하는 클러스터가 없습니다.</span>}
            </div>
          </div>
        </div>

        <label className="grid gap-1 min-w-0">
          <span className="text-xs font-semibold">비고</span>
          <textarea id="ar-note" className={INPUT} rows={3} value={draft.note ?? ''}
            placeholder="변경 사유, 오탐 사례, 적용 희망일, 알림 받을 채널 등"
            onChange={(e) => set({ note: e.target.value })} />
        </label>

        {tried && missing.length > 0 && (
          <p role="alert" className="text-xs text-status-critical">입력이 필요합니다: {missing.join(', ')}</p>
        )}
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {draft.editId ? '「진행」 상태인 동안 수정할 수 있습니다.' : '등록하면 「진행」 상태가 되고 처리 담당자에게 알림이 갑니다.'}
        </span>
        <div className="flex gap-2">
          <button type="button" className={BTN} onClick={onClose} disabled={saving}>취소</button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={saving}>
            {saving ? '저장 중…' : draft.editId ? '수정 저장' : '요청 제출'}
          </button>
        </div>
      </div>
    </MacCard>
  );
}
