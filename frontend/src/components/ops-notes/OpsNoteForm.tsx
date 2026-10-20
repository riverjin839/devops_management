import { useId, useState, type ComponentType } from 'react';
import { History, Pin, Ship, KeyRound, Bug, Hammer, RefreshCw, Package, Layers } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import type { OpsNote, OpsNoteCreate, OpsNoteColor, OpsNoteUpdate } from '@/types';
import { ConfluenceUrlInput, TenantScopeSelect } from '@/components/common';
import { RichTextEditor } from '@/components/editor';
import { useCanOperate } from '@/hooks/useCanOperate';
import { formatApiError } from '@/lib/utils';

/**
 * 수정 payload — 비운 선택 필드는 `null` 로 보내야 서버(`exclude_unset`)가 컬럼을 비운다(D-144).
 * `types` 의 `OpsNoteUpdate` 는 `null` 을 허용하지 않아 여기서만 넓힌다.
 */
export type OpsNotePatch = { [K in keyof OpsNoteCreate]?: OpsNoteCreate[K] | null };

/** 빈 문단(`<p></p>`·`<p><br></p>`·`&nbsp;`)만으로 된 리치 텍스트. */
const EMPTY_RICH_RE = /^\s*(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)*$/i;

const SERVICES: { value: string; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { value: 'k8s',      label: 'Kubernetes', Icon: Ship },
  { value: 'keycloak', label: 'Keycloak',   Icon: KeyRound },
  { value: 'cilium',   label: 'Cilium',     Icon: Bug },
  { value: 'jenkins',  label: 'Jenkins',    Icon: Hammer },
  { value: 'argocd',   label: 'ArgoCD',     Icon: RefreshCw },
  { value: 'nexus',    label: 'Nexus',      Icon: Package },
  { value: 'etc',      label: '기타',        Icon: Layers },
];

const COLOR_OPTIONS: { value: OpsNoteColor; label: string; swatch: string }[] = [
  { value: 'yellow', label: '노랑', swatch: 'bg-chart-3' },
  { value: 'green',  label: '초록', swatch: 'bg-chart-2' },
  { value: 'blue',   label: '파랑', swatch: 'bg-chart-1' },
  { value: 'pink',   label: '분홍', swatch: 'bg-chart-5' },
  { value: 'purple', label: '보라', swatch: 'bg-chart-4' },
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
  const { canOperate, withHint, ariaWithHint } = useCanOperate();

  const [service, setService]         = useState(initial?.service ?? defaultService ?? 'k8s');
  const [title, setTitle]             = useState(initial?.title ?? '');
  const [content, setContent]         = useState(initial?.content ?? '');
  const [backContent, setBackContent] = useState(initial?.backContent ?? '');
  const [color, setColor]             = useState<OpsNoteColor>(initial?.color ?? 'yellow');
  const [author, setAuthor]           = useState(initial?.author ?? '');
  const [pinned, setPinned]           = useState(initial?.pinned ?? false);
  const [confluenceUrl, setConfluenceUrl] = useState(initial?.confluenceUrl ?? '');
  const [dlUrl, setDlUrl]             = useState(initial?.dlUrl ?? '');
  const [tenantId, setTenantId]       = useState<string | null>(initial?.tenantId ?? null);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('질문 제목은 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      // 리치 에디터는 비워도 `<p></p>` 를 남긴다 — 빈 문단뿐이면 빈 값으로 본다(이미지·표만 있는 본문은 유지).
      const richOrEmpty = (html: string) => (EMPTY_RICH_RE.test(html) ? '' : html.trim());
      let savedId: string | undefined;
      if (isEdit && initial) {
        // 수정 모드에서 비운 필드는 null — undefined 면 JSON 에서 빠져 옛 값이 남는다(D-144).
        const patch: OpsNotePatch = {
          service,
          title: title.trim(),
          content: richOrEmpty(content) || null,
          backContent: richOrEmpty(backContent) || null,
          color,
          author: author.trim() || null,
          pinned,
          confluenceUrl: confluenceUrl.trim() || null,
          dlUrl: dlUrl.trim() || null,
          tenantId,
        };
        // null 은 "비우기" — api 시그니처가 null 을 모르는 타입이라 경계에서만 좁힌다.
        await opsNotesApi.update(initial.id, patch as OpsNoteUpdate);
        savedId = initial.id;
      } else {
        const payload: OpsNoteCreate = {
          service,
          title: title.trim(),
          content: richOrEmpty(content) || undefined,
          backContent: richOrEmpty(backContent) || undefined,
          color,
          author: author.trim() || undefined,
          pinned,
          confluenceUrl: confluenceUrl.trim() || undefined,
          dlUrl: dlUrl.trim() || undefined,
          tenantId,
        };
        const res = await opsNotesApi.create(payload);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        savedId = (res.data as any)?.id ?? (res.data as any)?.data?.id;
      }
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
      onSaved(savedId);
    } catch (err) {
      setError(formatApiError(err, '저장에 실패했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
  const labelCls = 'block text-sm font-medium mb-1.5';

  return (
    <>
      {error && (
        <div className="mb-4 px-3 py-2 bg-status-critical/10 border border-status-critical/30 rounded-lg text-sm text-status-critical">{error}</div>
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
                <s.Icon className="w-3.5 h-3.5" aria-hidden />{s.label}
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
                  className={`w-7 h-7 rounded-full border-2 transition-colors ${c.swatch} ${
                    color === c.value ? 'border-foreground' : 'border-transparent hover:border-border'
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
            <span className="text-foreground font-bold mr-1">A.</span>답변 / 핵심 요약
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

        {/* 공유 범위 (멀티테넌시) */}
        <TenantScopeSelect value={tenantId} onChange={setTenantId} labelClassName={labelCls} selectClassName={inputCls} />

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
            disabled={saving || !canOperate}
            title={withHint(isEdit ? '저장' : '등록')}
            aria-label={canOperate ? undefined : ariaWithHint(isEdit ? '저장' : '등록')}
            className="px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? '저장 중…' : isEdit ? '저장' : '등록'}
          </button>
        </div>
      </form>
    </>
  );
}
