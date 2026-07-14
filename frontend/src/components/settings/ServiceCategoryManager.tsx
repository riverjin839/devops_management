import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Lock, AlertCircle, X, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import {
  useServiceCategories,
  useCreateServiceCategory,
  useUpdateServiceCategory,
  useDeleteServiceCategory,
} from '@/hooks/useServiceCategories';
import type { ServiceCategory, ServiceCategoryInput, ServiceCategoryUpdate, ServiceDomain } from '@/types';

const DOMAINS: { id: ServiceDomain; label: string }[] = [
  { id: 'pep', label: 'PEP 서비스' },
  { id: 'app', label: 'APP 서비스' },
];

function CategoryIcon({ icon, className = 'w-4 h-4' }: { icon?: string | null; className?: string }) {
  const resolved = resolveClusterIcon(icon);
  if (resolved?.kind === 'lucide') { const Icon = resolved.Component; return <Icon className={className} />; }
  if (resolved?.kind === 'text') return <span aria-hidden>{resolved.value}</span>;
  return <span className="text-muted-foreground/50">—</span>;
}

/** PEP/APP 서비스 상위 카테고리(Runtime/Catalog/Workflow/JupyterLab 등) 관리 — Settings → "서비스 카테고리" 탭 본문. */
export function ServiceCategoryManager() {
  const [domain, setDomain] = useState<ServiceDomain>('pep');
  const { data, isLoading, error } = useServiceCategories(domain);
  const del = useDeleteServiceCategory();
  const [editing, setEditing] = useState<ServiceCategory | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ServiceCategory | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const rows = data?.data ?? [];

  const doDelete = async () => {
    if (!confirmDelete) return;
    setErrorMsg(null);
    try {
      await del.mutateAsync(confirmDelete.id);
      setConfirmDelete(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold">서비스 카테고리</h2>
          <p className="text-sm text-muted-foreground">
            PEP 서비스/APP 서비스 사이드바의 상위 카테고리(Runtime/Catalog/Workflow/JupyterLab 등) — builtin 4개(PEP)는 비활성화만, custom 은 자유 추가/삭제
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="카테고리 추가"
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-semibold hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" />
          카테고리 추가
        </button>
      </div>

      {/* Domain tabs */}
      <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
        {DOMAINS.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => setDomain(d.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              domain === d.id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 flex items-start gap-2 text-sm text-red-500">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">카테고리 조회 실패</div>
            <div className="text-sm text-muted-foreground mt-0.5">{error instanceof Error ? error.message : 'API 오류'}</div>
          </div>
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">{errorMsg}</div>
          <button type="button" onClick={() => setErrorMsg(null)} aria-label="알림 닫기"><X className="w-3 h-3" /></button>
        </div>
      )}
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />)}
        </div>
      )}

      {!isLoading && rows.length === 0 && !error && (
        <p className="text-sm text-muted-foreground/70 py-6 text-center">
          {domain === 'app' ? 'APP 서비스는 기본 카테고리가 없습니다 — "카테고리 추가"로 직접 등록하세요.' : '등록된 카테고리가 없습니다.'}
        </p>
      )}

      {!isLoading && rows.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-sm text-muted-foreground bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">아이콘</th>
                <th className="px-3 py-2 text-left font-medium">key</th>
                <th className="px-3 py-2 text-left font-medium">label</th>
                <th className="px-3 py-2 text-center font-medium">유형</th>
                <th className="px-3 py-2 text-center font-medium">활성</th>
                <th className="px-3 py-2 text-center font-medium">정렬</th>
                <th className="px-3 py-2 text-center font-medium">액션</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="text-sm hover:bg-secondary/40">
                  <td className="px-3 py-2"><CategoryIcon icon={r.icon} /></td>
                  <td className="px-3 py-2 font-mono">{r.key}</td>
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2 text-center">
                    {r.isBuiltin ? (
                      <span className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 bg-primary/10 text-primary border border-primary/30">
                        <Lock className="w-2.5 h-2.5" />builtin
                      </span>
                    ) : (
                      <span className="text-xs rounded-full px-2 py-0.5 bg-secondary text-muted-foreground border border-border">custom</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-xs rounded-full px-2 py-0.5 ${r.enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-secondary text-muted-foreground'}`}>
                      {r.enabled ? '활성' : '비활성'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-muted-foreground">{r.sortOrder}</td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button type="button" onClick={() => setEditing(r)} aria-label={`${r.key} 편집`}
                        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button" onClick={() => !r.isBuiltin && setConfirmDelete(r)} disabled={r.isBuiltin}
                        aria-label={`${r.key} 삭제`}
                        title={r.isBuiltin ? 'builtin 은 영구 삭제 불가 — 비활성화만 가능' : '삭제'}
                        className="p-1 rounded text-red-500 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <CategoryFormModal mode="create" domain={domain} onClose={() => setAdding(false)} onError={setErrorMsg} />}
      {editing && <CategoryFormModal mode="edit" domain={domain} row={editing} onClose={() => setEditing(null)} onError={setErrorMsg} />}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="카테고리 삭제"
        description={confirmDelete ? `"${confirmDelete.label}" (${confirmDelete.key}) 카테고리를 삭제하시겠습니까? 이 카테고리에 속한 서비스 타입이 있으면 차단됩니다.` : ''}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

// ─── Add/Edit Modal ────────────────────────────────────────────────────

interface CategoryFormModalProps {
  mode: 'create' | 'edit';
  domain: ServiceDomain;
  row?: ServiceCategory;
  onClose: () => void;
  onError: (msg: string) => void;
}

function CategoryFormModal({ mode, domain, row, onClose, onError }: CategoryFormModalProps) {
  const create = useCreateServiceCategory();
  const update = useUpdateServiceCategory();

  const isBuiltin = row?.isBuiltin ?? false;
  const isEdit = mode === 'edit';

  const [key, setKey] = useState(row?.key ?? '');
  const [label, setLabel] = useState(row?.label ?? '');
  const [icon, setIcon] = useState(row?.icon ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 100);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async () => {
    setLocalError(null);
    try {
      if (mode === 'create') {
        if (!key.trim() || !label.trim()) { setLocalError('key + label 필수'); return; }
        const payload: ServiceCategoryInput = {
          domain, key: key.trim(), label: label.trim(),
          icon: icon.trim() || null, enabled, sortOrder,
        };
        await create.mutateAsync(payload);
      } else if (row) {
        const payload: ServiceCategoryUpdate = {};
        if (label !== row.label) payload.label = label.trim();
        if (icon !== (row.icon ?? '')) payload.icon = icon.trim() || null;
        if (enabled !== row.enabled) payload.enabled = enabled;
        if (sortOrder !== row.sortOrder) payload.sortOrder = sortOrder;
        await update.mutateAsync({ id: row.id, data: payload });
      }
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : '저장 실패');
      onClose();
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-label="카테고리 폼">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">
            {mode === 'create' ? `카테고리 추가 (${domain === 'pep' ? 'PEP' : 'APP'} 서비스)` : `카테고리 편집 — ${row?.key}`}
            {isBuiltin && <span className="ml-2 text-xs text-primary">builtin (key readonly)</span>}
          </h2>
          <button type="button" onClick={onClose} aria-label="닫기" className="p-1 rounded hover:bg-secondary text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className={`block ${isEdit ? 'opacity-70' : ''}`}>
            <span className="text-sm font-semibold text-muted-foreground">key (slug) *</span>
            <input
              type="text" value={key} onChange={(e) => setKey(e.target.value)}
              placeholder="runtime" aria-label="category key" disabled={isEdit}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground mt-1">영문 소문자/숫자/하이픈. 등록 후 변경 불가</p>
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">Label *</span>
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Runtime" aria-label="label"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-semibold text-muted-foreground">Icon (lucide-react 이름)</span>
              <input
                type="text" value={icon} onChange={(e) => setIcon(e.target.value)}
                placeholder="Cpu, Database, Workflow..." aria-label="icon"
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono"
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-muted-foreground">Sort Order</span>
              <input
                type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
                aria-label="sort order"
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="enabled" className="w-4 h-4" />
            <span className="text-sm">활성화 (사이드바 카테고리 레일에 표시)</span>
          </label>

          {localError && <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">{localError}</div>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">취소</button>
          <button
            type="button" onClick={handleSubmit} disabled={pending} autoFocus
            className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {pending && <Loader2 className="w-3 h-3 animate-spin" />}
            {mode === 'create' ? '추가' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
