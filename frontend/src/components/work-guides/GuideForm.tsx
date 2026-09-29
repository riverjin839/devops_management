import { useId, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { workGuidesApi } from '@/services/api';
import type { WorkGuide, WorkGuideCreate, WorkGuideUpdate } from '@/types';
import { ConfluenceUrlInput, TenantScopeSelect } from '@/components/common';
import { RichTextEditor } from '@/components/editor';

const CATEGORIES = ['배포', '트러블슈팅', '모니터링', '보안', '기타'];

interface GuideFormProps {
  initial?: WorkGuide | null;
  allGuides: WorkGuide[];
  defaultParentId?: string | null;
  onCancel: () => void;
  onSaved: (savedId?: string) => void;
}

export function GuideForm({ initial, allGuides, defaultParentId, onCancel, onSaved }: GuideFormProps) {
  const qc = useQueryClient();
  const isEdit = Boolean(initial);

  const [title, setTitle]       = useState(initial?.title ?? '');
  const [content, setContent]   = useState(initial?.content ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 'medium');
  const [tags, setTags]         = useState(initial?.tags ?? '');
  const [status, setStatus]     = useState(initial?.status ?? 'draft');
  const [author, setAuthor]     = useState(initial?.author ?? '');
  const [confluenceUrl, setConfluenceUrl] = useState(initial?.confluenceUrl ?? '');
  const [tenantId, setTenantId] = useState<string | null>(initial?.tenantId ?? null);
  const [parentId, setParentId] = useState<string>(
    initial?.parentId ?? defaultParentId ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const getDescendantIds = (id: string): string[] => {
    const kids = allGuides.filter((g) => g.parentId === id);
    return [id, ...kids.flatMap((k) => getDescendantIds(k.id))];
  };
  const excludeIds = isEdit && initial ? new Set(getDescendantIds(initial.id)) : new Set<string>();
  const parentOptions = allGuides.filter((g) => !excludeIds.has(g.id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('제목은 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      const payload: WorkGuideCreate = {
        title: title.trim(),
        content: content.trim() || undefined,
        category: category || undefined,
        priority,
        tags: tags.trim() || undefined,
        status,
        author: author.trim() || undefined,
        parentId: parentId || null,
        confluenceUrl: confluenceUrl.trim() || undefined,
        tenantId,
      };
      if (isEdit && initial) {
        await workGuidesApi.update(initial.id, payload as WorkGuideUpdate);
        await qc.invalidateQueries({ queryKey: ['work-guides'] });
        onSaved(initial.id);
      } else {
        const res = await workGuidesApi.create(payload);
        await qc.invalidateQueries({ queryKey: ['work-guides'] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newId = (res.data as any)?.id ?? (res.data as any)?.data?.id;
        onSaved(newId);
      }
    } catch {
      setError('저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const labelCls = 'block text-sm font-medium mb-1';

  return (
    <>
      {error && (
        <div className="mb-4 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor={f('title')} className={labelCls}>제목 *</label>
          <input
            id={f('title')}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="페이지 제목"
            className={inputCls}
            autoFocus
          />
        </div>

        <div>
          <label htmlFor={f('parent')} className={labelCls}>상위 페이지</label>
          <select id={f('parent')} value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputCls}>
            <option value="">— 최상위 페이지 —</option>
            {parentOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.title}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor={f('category')} className={labelCls}>카테고리</label>
            <select id={f('category')} value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              <option value="">— 선택 —</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={f('priority')} className={labelCls}>우선순위</label>
            <select id={f('priority')} value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
              <option value="high">높음</option>
              <option value="medium">보통</option>
              <option value="low">낮음</option>
            </select>
          </div>
          <div>
            <label htmlFor={f('status')} className={labelCls}>상태</label>
            <select id={f('status')} value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="draft">초안</option>
              <option value="active">활성</option>
              <option value="archived">보관</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={f('author')} className={labelCls}>작성자</label>
            <input id={f('author')} type="text" value={author} onChange={(e) => setAuthor(e.target.value)}
              placeholder="이름 또는 팀명" className={inputCls} />
          </div>
          <div>
            <label htmlFor={f('tags')} className={labelCls}>태그 (쉼표 구분)</label>
            <input id={f('tags')} type="text" value={tags} onChange={(e) => setTags(e.target.value)}
              placeholder="예: k8s, nginx, 긴급" className={inputCls} />
          </div>
        </div>

        <TenantScopeSelect value={tenantId} onChange={setTenantId} labelClassName={labelCls} selectClassName={inputCls} />

        <ConfluenceUrlInput
          id={f('confluence')}
          value={confluenceUrl}
          onChange={setConfluenceUrl}
        />

        <div>
          <label htmlFor={f('content')} className="text-sm font-medium block mb-2">내용</label>
          <div id={f('content')}>
            <RichTextEditor
              value={content}
              onChange={setContent}
              placeholder="페이지 내용을 작성하세요. 서식 도구모음을 사용하여 Confluence처럼 편집할 수 있습니다."
              minHeight="320px"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t border-border">
          <button type="button" onClick={onCancel}
            className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors">
            취소
          </button>
          <button type="submit" disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-60">
            {saving ? '저장 중...' : isEdit ? '저장' : '등록'}
          </button>
        </div>
      </form>
    </>
  );
}
