import { useId, useState } from 'react';
import { History, Pin } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import type { OpsNote, OpsNoteCreate, OpsNoteColor, OpsNoteUpdate } from '@/types';
import { ConfluenceUrlInput } from '@/components/common';
import { RichTextEditor } from '@/components/editor';

const SERVICES = [
  { value: 'k8s',       label: 'Kubernetes', icon: '☸' },
  { value: 'keycloak',  label: 'Keycloak',   icon: '🔑' },
  { value: 'cilium',    label: 'Cilium',     icon: '🐝' },
  { value: 'jenkins',   label: 'Jenkins',    icon: '🏗' },
  { value: 'argocd',    label: 'ArgoCD',     icon: '🔄' },
  { value: 'nexus',     label: 'Nexus',      icon: '📦' },
  { value: 'etc',       label: '기타',        icon: '📋' },
];

const COLOR_OPTIONS: { value: OpsNoteColor; label: string; swatch: string }[] = [
  { value: 'yellow', label: '노랑', swatch: 'bg-amber-300' },
  { value: 'green',  label: '초록', swatch: 'bg-emerald-300' },
  { value: 'blue',   label: '파랑', swatch: 'bg-sky-300' },
  { value: 'pink',   label: '분홍', swatch: 'bg-pink-300' },
  { value: 'purple', label: '보라', swatch: 'bg-purple-300' },
];

interface OpsNoteFormProps {
  initial?: OpsNote | null;
  defaultService?: string;
  onCancel: () => void;
  onSaved: (savedId?: string) => void;
}

export function OpsNoteForm({ initial, defaultService, onCancel, onSaved }: OpsNoteFormProps) {
  const qc = useQueryClient();
  const isEdit = Boolean(initial);

  const [service, setService]         = useState(initial?.service ?? defaultService ?? 'k8s');
  const [title, setTitle]             = useState(initial?.title ?? '');
  const [content, setContent]         = useState(initial?.content ?? '');
  const [backContent, setBackContent] = useState(initial?.backContent ?? '');
  const [color, setColor]             = useState<OpsNoteColor>(initial?.color ?? 'yellow');
  const [author, setAuthor]           = useState(initial?.author ?? '');
  const [pinned, setPinned]           = useState(initial?.pinned ?? false);
  const [confluenceUrl, setConfluenceUrl] = useState(initial?.confluenceUrl ?? '');
  const [dlUrl, setDlUrl]             = useState(initial?.dlUrl ?? '');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('질문 제목은 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      const payload: OpsNoteCreate = {
        service,
        title: title.trim(),
        content: content.trim() || undefined,
        backContent: backContent.trim() || undefined,
        color,
        author: author.trim() || undefined,
        pinned,
        confluenceUrl: confluenceUrl.trim() || undefined,
        dlUrl: dlUrl.trim() || undefined,
      };
      let savedId: string | undefined;
      if (isEdit && initial) {
        await opsNotesApi.update(initial.id, payload as OpsNoteUpdate);
        savedId = initial.id;
      } else {
        const res = await opsNotesApi.create(payload);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        savedId = (res.data as any)?.id ?? (res.data as any)?.data?.id;
      }
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
      onSaved(savedId);
    } catch {
      setError('저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
  const labelCls = 'block text-sm font-medium mb-1.5';

  return (
    <>
      {error && (
        <div className="mb-4 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 서비스 */}
        <div>
          <p className={labelCls}>대상 서비스</p>
          <div className="flex gap-2 flex-wrap">
            {SERVICES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setService(s.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border transition-colors ${
                  service === s.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                }`}
              >
                <span>{s.icon}</span>{s.label}
              </button>
            ))}
          </div>
        </div>

        {/* 질문 제목 */}
        <div>
          <label htmlFor={f('title')} className={labelCls}>
            <span className="text-primary font-bold mr-1">Q.</span>질문 / 제목 *
          </label>
          <input
            id={f('title')}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예) coreDNS 가 NXDOMAIN 을 반환할 때 어떻게 점검하나요?"
            className={inputCls}
          />
        </div>

        {/* 색상 + 고정 */}
        <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
          <div>
            <p className={labelCls}>카드 색상</p>
            <div className="flex gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setColor(c.value)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${c.swatch} ${
                    color === c.value ? 'border-foreground scale-110 shadow' : 'border-transparent hover:scale-105'
                  }`}
                  title={c.label}
                  aria-label={`색상 ${c.label}`}
                />
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none px-3 py-2 rounded-xl border border-border hover:bg-secondary/40 transition-colors">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <Pin className="w-3.5 h-3.5 text-primary" />
            <span className="text-sm font-medium">상단 고정</span>
          </label>
        </div>

        {/* 답변 */}
        <div>
          <label htmlFor={f('front')} className={labelCls}>
            <span className="text-emerald-500 font-bold mr-1">A.</span>답변 / 핵심 요약
          </label>
          <div id={f('front')}>
            <RichTextEditor
              value={content}
              onChange={setContent}
              placeholder="해결 절차, 명령어, 핵심 포인트를 적어주세요."
              minHeight="160px"
            />
          </div>
        </div>

        {/* 히스토리 */}
        <div>
          <label htmlFor={f('back')} className={labelCls}>
            <History className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5 text-muted-foreground" />
            상세 / 히스토리 <span className="text-muted-foreground font-normal text-sm">(선택)</span>
          </label>
          <div id={f('back')}>
            <RichTextEditor
              value={backContent}
              onChange={setBackContent}
              placeholder="배경, 시도 / 실패 이력, 참고 링크 등"
              minHeight="120px"
            />
          </div>
        </div>

        {/* 작성자 */}
        <div>
          <label htmlFor={f('author')} className={labelCls}>작성자</label>
          <input
            id={f('author')}
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="이름 또는 팀명"
            className={inputCls}
          />
        </div>

        {/* Confluence 링크 */}
        <ConfluenceUrlInput
          id={f('confluence')}
          value={confluenceUrl}
          onChange={setConfluenceUrl}
        />

        {/* DL 링크 */}
        <ConfluenceUrlInput
          id={f('dl')}
          value={dlUrl}
          onChange={setDlUrl}
          label="DL 링크"
          placeholder="https://..."
          hint="관련 DL(Data Lake 등) 문서/대시보드가 있다면 URL 을 붙여넣으세요. (선택)"
        />

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-60"
          >
            {saving ? '저장 중…' : isEdit ? '저장' : '등록'}
          </button>
        </div>
      </form>
    </>
  );
}
