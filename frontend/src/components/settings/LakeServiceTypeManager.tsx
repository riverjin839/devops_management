import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Lock, AlertCircle, X, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common';
import { ServiceTypeIcon } from '@/components/lake-services';
import {
  useLakeServiceTypeRows,
  useCreateLakeServiceType,
  useUpdateLakeServiceType,
  useToggleLakeServiceType,
  useDeleteLakeServiceType,
} from '@/hooks/useLakeServices';
import { useServiceCategories } from '@/hooks/useServiceCategories';
import type {
  LakeServiceTypeInput, LakeServiceTypeRow, LakeServiceTypeUpdate, ServiceDomain,
} from '@/types';

const CATEGORIES = ['catalog', 'runtime', 'analytics', 'other'] as const;
const DOMAINS: { id: ServiceDomain | 'all'; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'pep', label: 'PEP 서비스' },
  { id: 'app', label: 'APP 서비스' },
];

/** LAKE service type 카탈로그 관리 — Settings → "LAKE 타입" 탭 본문. */
export function LakeServiceTypeManager() {
  const [domainFilter, setDomainFilter] = useState<ServiceDomain | 'all'>('all');
  const { data, isLoading, error } = useLakeServiceTypeRows({
    limit: 200, domain: domainFilter === 'all' ? undefined : domainFilter,
  });
  const { data: pepCategoriesResp } = useServiceCategories('pep');
  const { data: appCategoriesResp } = useServiceCategories('app');
  const allCategories = [...(pepCategoriesResp?.data ?? []), ...(appCategoriesResp?.data ?? [])];
  const categoryLabelMap = Object.fromEntries(allCategories.map((c) => [c.id, c.label]));
  const toggle = useToggleLakeServiceType();
  const del = useDeleteLakeServiceType();
  const [editing, setEditing] = useState<LakeServiceTypeRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LakeServiceTypeRow | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const rows = data?.data ?? [];

  const doDelete = async () => {
    if (!confirmDelete) return;
    setErrorMsg(null);
    try {
      await del.mutateAsync(confirmDelete.id);
      setConfirmDelete(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '삭제 실패';
      setErrorMsg(msg);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header + Add button */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold">LAKE 서비스 타입</h2>
          <p className="text-sm text-muted-foreground">
            8 builtin (airflow/spark/...) 은 비활성화만 가능, 커스텀 타입은 자유 추가/삭제
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="커스텀 타입 추가"
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-semibold hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" />
          커스텀 추가
        </button>
      </div>

      {/* Domain tabs */}
      <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
        {DOMAINS.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => setDomainFilter(d.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              domainFilter === d.id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Error/loading/empty */}
      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 flex items-start gap-2 text-sm text-red-500">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">LAKE 타입 조회 실패</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              {error instanceof Error ? error.message : 'API 오류'}
            </div>
          </div>
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">{errorMsg}</div>
          <button type="button" onClick={() => setErrorMsg(null)} aria-label="알림 닫기">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />
          ))}
        </div>
      )}

      {/* Table */}
      {!isLoading && rows.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-sm text-muted-foreground bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">아이콘</th>
                <th className="px-3 py-2 text-left font-medium">slug</th>
                <th className="px-3 py-2 text-left font-medium">label</th>
                <th className="px-3 py-2 text-left font-medium">category</th>
                <th className="px-3 py-2 text-left font-medium">PEP/APP 카테고리</th>
                <th className="px-3 py-2 text-left font-medium">default_path</th>
                <th className="px-3 py-2 text-center font-medium">유형</th>
                <th className="px-3 py-2 text-center font-medium">활성</th>
                <th className="px-3 py-2 text-center font-medium">정렬</th>
                <th className="px-3 py-2 text-center font-medium">액션</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="text-sm hover:bg-secondary/40">
                  <td className="px-3 py-2">
                    <ServiceTypeIcon serviceType={r.serviceType} className="w-4 h-4" />
                  </td>
                  <td className="px-3 py-2 font-mono">{r.serviceType}</td>
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.category}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <span className="text-xs rounded-full px-2 py-0.5 bg-secondary border border-border mr-1">
                      {r.domain === 'app' ? 'APP' : 'PEP'}
                    </span>
                    {r.categoryId ? (categoryLabelMap[r.categoryId] ?? '—') : <span className="text-muted-foreground/50">미분류</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.defaultPath}</td>
                  <td className="px-3 py-2 text-center">
                    {r.isBuiltin ? (
                      <span className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 bg-primary/10 text-primary border border-primary/30">
                        <Lock className="w-2.5 h-2.5" />
                        builtin
                      </span>
                    ) : (
                      <span className="text-xs rounded-full px-2 py-0.5 bg-secondary text-muted-foreground border border-border">
                        custom
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <label className="inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                        aria-label={`${r.serviceType} 활성화 토글`}
                        className="w-4 h-4"
                      />
                    </label>
                  </td>
                  <td className="px-3 py-2 text-center text-muted-foreground">{r.sortOrder}</td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        aria-label={`${r.serviceType} 편집`}
                        title={r.isBuiltin ? 'builtin — label/category/default_path 는 readonly' : '편집'}
                        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => !r.isBuiltin && setConfirmDelete(r)}
                        disabled={r.isBuiltin}
                        aria-label={`${r.serviceType} 삭제`}
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

      {/* Add custom modal */}
      {adding && (
        <TypeFormModal
          mode="create"
          onClose={() => setAdding(false)}
          onError={setErrorMsg}
        />
      )}

      {/* Edit modal */}
      {editing && (
        <TypeFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onError={setErrorMsg}
        />
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="LAKE 타입 삭제"
        description={
          confirmDelete
            ? `"${confirmDelete.label}" (${confirmDelete.serviceType}) 타입을 삭제하시겠습니까? 이 타입으로 등록된 LakeService 인스턴스가 있으면 차단됩니다.`
            : ''
        }
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

interface TypeFormModalProps {
  mode: 'create' | 'edit';
  row?: LakeServiceTypeRow;
  onClose: () => void;
  onError: (msg: string) => void;
}

function TypeFormModal({ mode, row, onClose, onError }: TypeFormModalProps) {
  const create = useCreateLakeServiceType();
  const update = useUpdateLakeServiceType();

  const isBuiltin = row?.isBuiltin ?? false;
  const isEdit = mode === 'edit';

  const [serviceType, setServiceType] = useState(row?.serviceType ?? '');
  const [label, setLabel] = useState(row?.label ?? '');
  const [category, setCategory] = useState(row?.category ?? 'other');
  const [defaultPath, setDefaultPath] = useState(row?.defaultPath ?? '/health');
  const [description, setDescription] = useState(row?.description ?? '');
  const [icon, setIcon] = useState(row?.icon ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 100);
  const [domain, setDomain] = useState<ServiceDomain>((row?.domain as ServiceDomain) ?? 'pep');
  const [categoryId, setCategoryId] = useState(row?.categoryId ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const { data: domainCategoriesResp } = useServiceCategories(domain);
  const domainCategories = domainCategoriesResp?.data ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async () => {
    setLocalError(null);
    try {
      if (mode === 'create') {
        if (!serviceType.trim() || !label.trim()) {
          setLocalError('service_type slug + label 필수');
          return;
        }
        const payload: LakeServiceTypeInput = {
          serviceType: serviceType.trim(),
          label: label.trim(),
          category,
          defaultPath: defaultPath.trim(),
          description: description.trim() || null,
          icon: icon.trim() || null,
          enabled,
          sortOrder,
          domain,
          categoryId: categoryId || null,
        };
        await create.mutateAsync(payload);
      } else if (row) {
        const payload: LakeServiceTypeUpdate = {};
        // builtin: enabled/sort_order/description/icon/categoryId 만 — label/category/default_path/domain readonly
        if (!isBuiltin) {
          if (label !== row.label) payload.label = label.trim();
          if (category !== row.category) payload.category = category;
          if (defaultPath !== row.defaultPath) payload.defaultPath = defaultPath.trim();
          if (domain !== row.domain) payload.domain = domain;
        }
        if (description !== (row.description ?? '')) payload.description = description.trim() || null;
        if (icon !== (row.icon ?? '')) payload.icon = icon.trim() || null;
        if (enabled !== row.enabled) payload.enabled = enabled;
        if (sortOrder !== row.sortOrder) payload.sortOrder = sortOrder;
        if ((categoryId || null) !== (row.categoryId ?? null)) payload.categoryId = categoryId || null;
        await update.mutateAsync({ id: row.id, data: payload });
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '저장 실패';
      onError(msg);
      onClose();
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-label="LAKE 타입 폼">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">
            {mode === 'create' ? '커스텀 LAKE 타입 추가' : `LAKE 타입 편집 — ${row?.serviceType}`}
            {isBuiltin && <span className="ml-2 text-xs text-primary">builtin (일부 readonly)</span>}
          </h2>
          <button type="button" onClick={onClose} aria-label="닫기"
                  className="p-1 rounded hover:bg-secondary text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <Field label="service_type slug *" disabled={isEdit}>
            <input
              type="text" value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              placeholder="my-custom-svc"
              aria-label="service type slug"
              disabled={isEdit}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground mt-1">
              영문 소문자/숫자/하이픈 1-32자. 등록 후 변경 불가
            </p>
          </Field>

          <Field label="Label *">
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="My Custom Service"
              aria-label="label"
              disabled={isBuiltin}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select
                value={category} onChange={(e) => setCategory(e.target.value)}
                aria-label="category"
                disabled={isBuiltin}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Sort Order">
              <input
                type="number" value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
                aria-label="sort order"
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="PEP/APP 도메인" disabled={isBuiltin}>
              <select
                value={domain}
                onChange={(e) => { setDomain(e.target.value as ServiceDomain); setCategoryId(''); }}
                aria-label="domain"
                disabled={isBuiltin}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="pep">PEP 서비스</option>
                <option value="app">APP 서비스</option>
              </select>
            </Field>
            <Field label="상위 카테고리">
              <select
                value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                aria-label="상위 카테고리"
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">— 미분류 —</option>
                {domainCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                PEP 서비스/APP 서비스 사이드바에서 이 타입이 속할 상위 카테고리 (Settings → "서비스 카테고리"에서 추가)
              </p>
            </Field>
          </div>

          <Field label="Health endpoint path">
            <input
              type="text" value={defaultPath}
              onChange={(e) => setDefaultPath(e.target.value)}
              placeholder="/health"
              aria-label="default path"
              disabled={isBuiltin}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground mt-1">
              custom 타입의 GenericHealthzChecker 가 GET probe 할 경로 (예: /health, /healthz, /api/v1/status)
            </p>
          </Field>

          <Field label="Icon (lucide-react 이름)">
            <input
              type="text" value={icon} onChange={(e) => setIcon(e.target.value)}
              placeholder="Database, Workflow, ..."
              aria-label="icon"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>

          <Field label="Description">
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="서비스 간략 설명"
              aria-label="description"
              rows={2}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm resize-y"
            />
          </Field>

          <label className="flex items-center gap-2">
            <input
              type="checkbox" checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="enabled"
              className="w-4 h-4"
            />
            <span className="text-sm">활성화 (LakeServicesPage 등록 모달에 표시)</span>
          </label>

          {localError && (
            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">
              {localError}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button type="button" onClick={onClose}
                  className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
            취소
          </button>
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

function Field({ label, children, disabled }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={`block ${disabled ? 'opacity-70' : ''}`}>
      <span className="text-sm font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
