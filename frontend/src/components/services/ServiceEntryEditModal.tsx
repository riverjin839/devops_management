import { useEffect, useId, useState } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import type { Cluster, ServiceEntry, ServiceEntryCreate, ServiceEntryKind } from '@/types';
import { serviceEntriesApi } from '@/services/api';
import { useToast } from '@/components/common';
import { RichTextEditor } from '@/components/editor';
import { KIND_CATALOG } from './serviceCatalog';
import { formatApiError } from '@/lib/utils';

interface Props {
  mode: 'create' | 'edit';
  service: string;
  entry: ServiceEntry | null;
  defaultKind?: ServiceEntryKind;
  defaultClusterId: string | null;
  clusters: Cluster[];
  onClose: () => void;
  onSaved: () => void;
}

const SEVERITIES = [
  { value: '',         label: '미지정' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning',  label: 'Warning' },
  { value: 'info',     label: 'Info' },
];

type Form = Partial<ServiceEntryCreate>;

export function ServiceEntryEditModal({
  mode, service, entry, defaultKind, defaultClusterId, clusters, onClose, onSaved,
}: Props) {
  const toast = useToast();

  const [form, setForm] = useState<Form>(() => {
    if (entry) return { ...entry };
    return {
      service,
      kind: defaultKind ?? 'note',
      clusterId: defaultClusterId,
      pinned: false,
      tags: [],
    };
  });
  const [tagsText, setTagsText] = useState((entry?.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);

  const kindId = useId();
  const clusterScopeId = useId();
  const titleId = useId();
  const severityId = useId();
  const occurredAtId = useId();
  const urlId = useId();
  const tagsId = useId();
  const contentId = useId();
  const authorId = useId();

  useEffect(() => {
    if (entry) {
      setForm({ ...entry });
      setTagsText((entry.tags ?? []).join(', '));
    } else {
      setForm({
        service,
        kind: defaultKind ?? 'note',
        clusterId: defaultClusterId,
        pinned: false,
        tags: [],
      });
      setTagsText('');
    }
  }, [entry, service, defaultKind, defaultClusterId, mode]);

  const update = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.title?.trim()) {
      toast.warning('제목 필수', '제목을 입력하세요.');
      return;
    }
    setSaving(true);
    try {
      const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
      const payload: Form = { ...form, tags, service };
      // 빈 문자열 → undefined 정규화 (URL 같은 선택 필드)
      Object.keys(payload).forEach((k) => {
        const v = (payload as Record<string, unknown>)[k];
        if (v === '') (payload as Record<string, unknown>)[k] = undefined;
      });

      if (mode === 'create') {
        await serviceEntriesApi.create(payload as ServiceEntryCreate);
        toast.success('항목 등록됨', form.title);
      } else if (entry) {
        await serviceEntriesApi.update(entry.id, payload);
        toast.success('항목 수정됨', form.title);
      }
      onSaved();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !saving && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">
            {mode === 'create' ? `새 항목 — ${service}` : `수정 — ${entry?.title}`}
          </h2>
          <button onClick={onClose} disabled={saving}
            className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label htmlFor={kindId} className="text-xs text-muted-foreground mb-1 block">종류</label>
              <select id={kindId} value={form.kind ?? 'note'}
                onChange={(e) => update('kind', e.target.value as ServiceEntryKind)}
                className={inputCls}>
                {KIND_CATALOG.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={clusterScopeId} className="text-xs text-muted-foreground mb-1 block">클러스터 범위</label>
              <select id={clusterScopeId} value={form.clusterId ?? ''}
                onChange={(e) => update('clusterId', e.target.value || null)}
                className={inputCls}>
                <option value="">전역 (모든 클러스터 공통)</option>
                {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={!!form.pinned}
                  onChange={(e) => update('pinned', e.target.checked)} />
                상단 고정
              </label>
            </div>
          </div>

          <div>
            <label htmlFor={titleId} className="text-xs text-muted-foreground mb-1 block">제목 *</label>
            <input id={titleId} value={form.title ?? ''} onChange={(e) => update('title', e.target.value)}
              placeholder="예: Keycloak realm migration 절차"
              className={inputCls} />
          </div>

          {/* kind 별 부가 필드 */}
          {(form.kind === 'troubleshoot' || form.kind === 'history') && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor={severityId} className="text-xs text-muted-foreground mb-1 block">심각도</label>
                <select id={severityId} value={form.severity ?? ''} onChange={(e) => update('severity', e.target.value)}
                  className={inputCls}>
                  {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={occurredAtId} className="text-xs text-muted-foreground mb-1 block">
                  {form.kind === 'history' ? '발생/적용 일시' : '관찰 일시'}
                </label>
                <input id={occurredAtId} type="datetime-local"
                  value={form.occurredAt ? form.occurredAt.slice(0, 16) : ''}
                  onChange={(e) => update('occurredAt', e.target.value ? new Date(e.target.value).toISOString() : null)}
                  className={inputCls} />
              </div>
            </div>
          )}

          {form.kind === 'link' && (
            <div>
              <label htmlFor={urlId} className="text-xs text-muted-foreground mb-1 block">URL *</label>
              <input id={urlId} value={form.url ?? ''} onChange={(e) => update('url', e.target.value)}
                placeholder="https://..."
                className={`${inputCls} font-mono`} />
            </div>
          )}

          <div>
            <label htmlFor={tagsId} className="text-xs text-muted-foreground mb-1 block">태그 (쉼표 구분)</label>
            <input id={tagsId} value={tagsText} onChange={(e) => setTagsText(e.target.value)}
              placeholder="upgrade, 1.30, hotfix"
              className={`${inputCls} font-mono`} />
          </div>

          <div>
            <label htmlFor={contentId} className="text-xs text-muted-foreground mb-1 block">
              {form.kind === 'link' ? '메모/설명 (선택)' : '내용'}
            </label>
            <div id={contentId}>
              <RichTextEditor
                value={form.content ?? ''}
                onChange={(html) => update('content', html)}
                placeholder={
                  form.kind === 'guide' ? '운영 절차를 단계별로 정리하세요.'
                  : form.kind === 'troubleshoot' ? '증상 / 원인 / 해결 과정 / 재발 방지...'
                  : form.kind === 'history' ? '무엇을 변경/조치했는지 — 영향 범위, 결과, 후속...'
                  : form.kind === 'link' ? '이 리소스에 대한 짧은 설명...'
                  : '메모 내용...'
                }
              />
            </div>
          </div>

          <div>
            <label htmlFor={authorId} className="text-xs text-muted-foreground mb-1 block">작성자</label>
            <input id={authorId} value={form.author ?? ''} onChange={(e) => update('author', e.target.value)}
              placeholder="이름 또는 팀"
              className={inputCls} />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            취소
          </button>
          <button onClick={submit} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {mode === 'create' ? '등록' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
