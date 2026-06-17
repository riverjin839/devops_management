import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, Plus, Trash2, RotateCcw, Save, Loader2, Megaphone, X } from 'lucide-react';
import { mcApi, type McPreset } from '@/services/api';
import type { McEffectivePreset, McPresetSource } from '@/types';

const SOURCE_BADGE: Record<McPresetSource, { label: string; cls: string }> = {
  builtin:  { label: '기본',  cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  shared:   { label: '공용',  cls: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  personal: { label: '개인',  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

interface EditRow {
  key: string;
  label: string;
  args: string;
  source: McPresetSource;
}

function slugify(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) base = 'custom';
  let key = base;
  let n = 2;
  while (taken.has(key)) { key = `${base}-${n}`; n += 1; }
  return key;
}

export function McPresetManager({
  clusterId, isAdmin, onPick,
}: {
  clusterId: string;
  isAdmin: boolean;
  onPick: (args: string) => void;
}) {
  const qc = useQueryClient();
  const [managing, setManaging] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  const presetsQ = useQuery({
    queryKey: ['mc', 'presets', clusterId],
    queryFn: () => mcApi.presets(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });
  const presets = useMemo<McEffectivePreset[]>(() => presetsQ.data?.presets ?? [], [presetsQ.data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">프리셋 — 클릭해서 args 에 채워넣기</p>
        <div className="flex items-center gap-1.5">
          {isAdmin && (
            <button
              onClick={() => setAdminOpen((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                adminOpen ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-secondary hover:bg-secondary/80'
              }`}
            >
              <Megaphone className="w-3 h-3" /> 공용 배포
            </button>
          )}
          <button
            onClick={() => setManaging((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
              managing ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-secondary hover:bg-secondary/80'
            }`}
          >
            <Settings2 className="w-3 h-3" /> 프리셋 관리
          </button>
        </div>
      </div>

      {/* chips */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => onPick(p.args)}
            className="group inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-border bg-secondary hover:bg-secondary/80"
            title={p.args}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${
              p.source === 'personal' ? 'bg-emerald-400' : p.source === 'shared' ? 'bg-sky-400' : 'bg-slate-400'
            }`} />
            {p.label}
          </button>
        ))}
        {presets.length === 0 && !presetsQ.isLoading && (
          <span className="text-xs text-muted-foreground">프리셋이 없습니다. '프리셋 관리' 에서 추가하세요.</span>
        )}
      </div>

      {managing && (
        <PersonalEditor clusterId={clusterId} presets={presets} onClose={() => setManaging(false)} qcInvalidate={() => qc.invalidateQueries({ queryKey: ['mc', 'presets'] })} />
      )}
      {adminOpen && isAdmin && (
        <SharedEditor onClose={() => setAdminOpen(false)} qcInvalidate={() => qc.invalidateQueries({ queryKey: ['mc', 'presets'] })} />
      )}
    </div>
  );
}

// ── 개인 프리셋 편집 ─────────────────────────────────────────────────────────
function PersonalEditor({
  clusterId, presets, onClose, qcInvalidate,
}: {
  clusterId: string;
  presets: McEffectivePreset[];
  onClose: () => void;
  qcInvalidate: () => void;
}) {
  void clusterId;
  const [rows, setRows] = useState<EditRow[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [resetKeys, setResetKeys] = useState<string[]>([]);

  const personalQ = useQuery({
    queryKey: ['mc', 'presets', 'personal'],
    queryFn: () => mcApi.getPersonalPresets().then((r) => r.data),
  });

  useEffect(() => {
    setRows(presets.map((p) => ({ key: p.key, label: p.label, args: p.args, source: p.source })));
  }, [presets]);
  useEffect(() => {
    if (personalQ.data) setHidden(personalQ.data.hidden ?? []);
  }, [personalQ.data]);

  const saveMut = useMutation({
    mutationFn: () => {
      const custom = rows
        .filter((r) => r.source === 'personal' && r.label.trim() && r.args.trim())
        .map((r) => ({ key: r.key, label: r.label.trim(), args: r.args.trim() }));
      const overrides: Record<string, McPreset> = {};
      rows
        .filter((r) => r.source !== 'personal' && !resetKeys.includes(r.key))
        .forEach((r) => { overrides[r.key] = { key: r.key, label: r.label.trim(), args: r.args.trim() }; });
      return mcApi.savePersonalPresets({ custom, overrides, hidden });
    },
    onSuccess: () => { qcInvalidate(); onClose(); },
  });

  const takenKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);

  const addRow = () => {
    const key = slugify('custom', takenKeys);
    setRows((prev) => [...prev, { key, label: '새 프리셋', args: '', source: 'personal' }]);
  };
  const updateRow = (key: string, changes: Partial<EditRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...changes } : r)));
  const removeRow = (row: EditRow) => {
    setRows((prev) => prev.filter((r) => r.key !== row.key));
    if (row.source !== 'personal') setHidden((prev) => Array.from(new Set([...prev, row.key])));
  };
  const toggleReset = (key: string) =>
    setResetKeys((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  const restoreHidden = (key: string) => setHidden((prev) => prev.filter((k) => k !== key));

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground">개인 프리셋 관리 (추가 · 변경 · 삭제)</p>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-secondary text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>

      <div className="space-y-1.5 max-h-80 overflow-auto">
        {rows.map((r) => {
          const isReset = resetKeys.includes(r.key);
          return (
            <div key={r.key} className="flex items-start gap-1.5">
              <span className={`mt-1.5 shrink-0 inline-flex px-1.5 py-0.5 text-[10px] rounded border ${SOURCE_BADGE[r.source].cls}`}>
                {SOURCE_BADGE[r.source].label}
              </span>
              <input
                value={r.label}
                disabled={isReset}
                onChange={(e) => updateRow(r.key, { label: e.target.value })}
                placeholder="라벨"
                className="w-32 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
              <input
                value={r.args}
                disabled={isReset}
                onChange={(e) => updateRow(r.key, { args: e.target.value })}
                placeholder="mc 인자 ({alias} 사용 가능)"
                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
              {r.source !== 'personal' && (
                <button
                  onClick={() => toggleReset(r.key)}
                  title={isReset ? '복원 취소' : '기본값으로 복원'}
                  className={`mt-0.5 p-1 rounded border border-border hover:bg-secondary ${isReset ? 'text-primary' : 'text-muted-foreground'}`}
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => removeRow(r)}
                title={r.source === 'personal' ? '삭제' : '숨김'}
                className="mt-0.5 p-1 rounded border border-border hover:bg-secondary text-muted-foreground"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {hidden.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="mr-1">숨긴 프리셋:</span>
          {hidden.map((k) => (
            <button key={k} onClick={() => restoreHidden(k)} className="mr-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-secondary hover:bg-secondary/80">
              {k} <RotateCcw className="w-2.5 h-2.5" />
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-border">
        <button onClick={addRow} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-secondary hover:bg-secondary/80">
          <Plus className="w-3 h-3" /> 프리셋 추가
        </button>
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded disabled:opacity-50"
        >
          {saveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 저장
        </button>
      </div>
    </div>
  );
}

// ── 공용 프리셋 배포 (admin) ─────────────────────────────────────────────────
function SharedEditor({ onClose, qcInvalidate }: { onClose: () => void; qcInvalidate: () => void }) {
  const [rows, setRows] = useState<McPreset[]>([]);
  const sharedQ = useQuery({
    queryKey: ['mc', 'presets', 'shared'],
    queryFn: () => mcApi.getSharedPresets().then((r) => r.data),
  });
  useEffect(() => { if (sharedQ.data) setRows(sharedQ.data.presets ?? []); }, [sharedQ.data]);

  const saveMut = useMutation({
    mutationFn: () => mcApi.saveSharedPresets(
      rows.filter((r) => r.label.trim() && r.args.trim())
        .map((r, i) => ({ key: r.key || slugify(r.label || `shared-${i}`, new Set()), label: r.label.trim(), args: r.args.trim() })),
    ),
    onSuccess: () => { qcInvalidate(); onClose(); },
  });

  const update = (i: number, changes: Partial<McPreset>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...changes } : r)));

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-sky-500 flex items-center gap-1"><Megaphone className="w-3.5 h-3.5" /> 공용 프리셋 배포 (모든 사용자에게 '공용'으로 표시)</p>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-secondary text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="space-y-1.5 max-h-72 overflow-auto">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="라벨"
              className="w-32 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary" />
            <input value={r.args} onChange={(e) => update(i, { args: e.target.value })} placeholder="mc 인자"
              className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              className="p-1 rounded border border-border hover:bg-secondary text-muted-foreground"><Trash2 className="w-3 h-3" /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-1 border-t border-sky-500/20">
        <button onClick={() => setRows((prev) => [...prev, { key: '', label: '', args: '' }])}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-secondary hover:bg-secondary/80">
          <Plus className="w-3 h-3" /> 항목 추가
        </button>
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-600/90 text-white rounded disabled:opacity-50">
          {saveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 배포
        </button>
      </div>
    </div>
  );
}
