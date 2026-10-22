import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RefreshCw, ExternalLink, ChevronDown, ChevronRight, Settings2, AlertCircle, AlertTriangle, Loader2,
  CheckCircle2, Clock, Plus, Pencil, Trash2, X, Check, PowerOff, SlidersHorizontal, Square,
} from 'lucide-react';
import {
  useTrendDigests, useTrendItems, useTrendSources, useTriggerCollect, useToggleSource, useCreateSource,
  useUpdateSource, useDeleteSource, useInvalidateTrends, useTrendSettings, useUpdateTrendSettings,
  isDigestInProgress,
} from '@/hooks/useTrends';
import { MacCard } from '@/components/ui/MacCard';
import {
  ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell, RunLogPanel, useToast,
} from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRunLog, runLogged, streamLogged, type RunLogEntry, type RunLoggedResult } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useAuthStore } from '@/stores/authStore';
import { PageHeader } from '@/components/common/PageHeader';
import { trendsApi } from '@/services/api';
import type { TrendDigest, TrendItem, TrendItemType, TrendSettings, TrendSource, TrendSourceCreate } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

// ── 카테고리 색상 ────────────────────────────────────────────────
// 알려진 4종은 고정 색, 사용자가 추가한 카테고리는 이름 해시로 --chart-* 중 하나를 고른다(§12.12 카테고리 색).
const CATEGORY_COLORS: Record<string, string> = {
  k8s:    'bg-chart-1/15 text-chart-1-text',
  cilium: 'bg-chart-7/15 text-chart-7-text',
  linux:  'bg-chart-3/15 text-chart-3-text',
  cncf:   'bg-chart-2/15 text-chart-2-text',
};
const CHART_COLORS = [
  'bg-chart-1/15 text-chart-1-text', 'bg-chart-2/15 text-chart-2-text', 'bg-chart-3/15 text-chart-3-text',
  'bg-chart-4/15 text-chart-4-text', 'bg-chart-5/15 text-chart-5-text', 'bg-chart-6/15 text-chart-6-text',
  'bg-chart-7/15 text-chart-7-text', 'bg-chart-8/15 text-chart-8-text',
];

function categoryCls(cat: string): string {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  let h = 0;
  for (const ch of cat) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHART_COLORS[h % CHART_COLORS.length];
}

const CATEGORY_LABEL: Record<string, string> = {
  k8s: 'Kubernetes', cilium: 'Cilium', linux: 'Linux', cncf: 'CNCF',
};
const KNOWN_CATEGORIES = ['k8s', 'cilium', 'linux', 'cncf'];

function categoryLabel(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat.toUpperCase();
}

const ITEM_TYPE_LABEL: Record<string, string> = {
  release: '릴리즈', blog: '블로그', news: '뉴스',
};
const ITEM_TYPES: TrendItemType[] = ['blog', 'news', 'release'];

const STATUS_INFO: Record<string, { icon: ReactNode; label: string; cls: string }> = {
  pending:     { icon: <Clock className="w-3.5 h-3.5" aria-hidden />, label: '대기',   cls: 'text-muted-foreground' },
  collecting:  { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />, label: '수집 중', cls: 'text-status-info' },
  summarizing: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />, label: '요약 중', cls: 'text-status-info' },
  done:        { icon: <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />, label: '완료',   cls: 'text-muted-foreground' },
  partial:     { icon: <AlertTriangle className="w-3.5 h-3.5" aria-hidden />, label: '일부 실패', cls: 'text-status-warning' },
  failed:      { icon: <AlertCircle className="w-3.5 h-3.5" aria-hidden />, label: '실패',   cls: 'text-status-critical' },
};

const INPUT_CLS =
  'mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60';
const BTN_SECONDARY =
  'inline-flex items-center gap-1 px-2.5 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-secondary/80 disabled:opacity-50';
const BTN_PRIMARY =
  'inline-flex items-center gap-1 px-2.5 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50';

function Field({ label, help, className, children }: { label: string; help?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block text-xs ${className ?? ''}`}>
      <span className="text-muted-foreground">{label}</span>
      {children}
      {help && <span className="block text-xs text-muted-foreground mt-0.5 leading-snug">{help}</span>}
    </label>
  );
}

// ── 항목 요약 판정 ───────────────────────────────────────────────
// 구 서버는 요약 실패 문구("[제목] 요약을 생성할 수 없습니다.")를 summary_ko 에 그대로 저장했다(A-8 ②).
// summaryStatus 가 없는 응답에서 이 문구면 실패로 본다 — 실패 문구를 정상 요약처럼 보여주지 않는다.
const LEGACY_SUMMARY_FAIL = /요약을 생성할 수 없습니다\.?\s*$/;

type SummaryView = { kind: 'ok'; text: string } | { kind: 'failed'; reason: string | null } | { kind: 'pending' };

function summaryView(item: TrendItem): SummaryView {
  if (item.summaryStatus === 'failed') return { kind: 'failed', reason: item.summaryError?.trim() || null };
  if (item.summaryStatus === 'pending') return { kind: 'pending' };
  const text = item.summaryKo?.trim();
  if (!text) return { kind: 'pending' };
  if (!item.summaryStatus && LEGACY_SUMMARY_FAIL.test(text)) return { kind: 'failed', reason: null };
  return { kind: 'ok', text };
}

// ── 개별 아이템 카드 ─────────────────────────────────────────────
function TrendItemCard({ item, inProgress }: { item: TrendItem; inProgress: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const summary = summaryView(item);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden>
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${categoryCls(item.category)}`}>
              {categoryLabel(item.category)}
            </span>
            <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
              {ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}
            </span>
            {item.version && (
              <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {item.version}
              </span>
            )}
            {summary.kind === 'failed' && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-status-critical/30 bg-status-critical/10 text-status-critical">
                요약 실패
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {parseUTC(item.publishedAt).toLocaleDateString('ko-KR')}
            </span>
          </div>
          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
          <p className="text-xs text-muted-foreground">{item.sourceName}</p>
        </div>
      </button>

      {open && (
        <div id={bodyId} className="px-4 pb-4 border-t border-border bg-secondary/10">
          {summary.kind === 'ok' ? (
            <div className="mt-3">
              <p className="text-sm font-semibold text-muted-foreground mb-1.5">AI 요약 (한국어)</p>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{summary.text}</p>
            </div>
          ) : summary.kind === 'failed' ? (
            <p className="mt-3 text-sm text-status-critical break-words">
              요약 실패 — {summary.reason ?? '사유가 기록되지 않았습니다'}
              <span className="block text-xs text-muted-foreground mt-0.5">다음 수집 때 다시 요약합니다.</span>
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground italic">
              {inProgress ? '요약 생성 중…' : '아직 요약이 없습니다 — 다음 수집 때 생성됩니다.'}
            </p>
          )}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            원문 보기 <ExternalLink className="w-3 h-3" aria-hidden />
          </a>
        </div>
      )}
    </div>
  );
}

/** 필터 칩 카테고리 — 소스에 등록된 카테고리에서 만든다(A-19). 소스를 못 읽으면 기본 4종. */
function useCategoryOptions(sources: TrendSource[] | undefined, selected: string): string[] {
  return useMemo(() => {
    const set = new Set<string>();
    for (const s of sources ?? []) if (s.category?.trim()) set.add(s.category.trim());
    if (set.size === 0) KNOWN_CATEGORIES.forEach((c) => set.add(c));
    if (selected !== 'all') set.add(selected);
    const rank = (c: string) => {
      const i = KNOWN_CATEGORIES.indexOf(c);
      return i < 0 ? KNOWN_CATEGORIES.length : i;
    };
    return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [sources, selected]);
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-sm px-2.5 py-1 rounded-full border transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'border-border text-muted-foreground hover:bg-secondary'
      }`}
    >
      {children}
    </button>
  );
}

// ── 다이제스트 날짜 패널 ─────────────────────────────────────────
function DigestPanel({ digest, onOpenSources }: { digest: TrendDigest; onOpenSources: () => void }) {
  const [selCategory, setSelCategory] = useState<string>('all');
  const [selType, setSelType] = useState<string>('all');
  const inProgress = isDigestInProgress(digest);

  const itemsQ = useTrendItems(
    digest.digestDate,
    selCategory !== 'all' ? selCategory : undefined,
    selType !== 'all' ? selType : undefined,
    inProgress,
  );
  const items = itemsQ.data ?? [];
  const { data: sources } = useTrendSources();
  const categories = useCategoryOptions(sources, selCategory);
  const failedSources = (sources ?? []).filter((s) => s.enabled && s.lastStatus === 'error');

  const statusInfo = STATUS_INFO[digest.status] ?? STATUS_INFO.pending;
  const types = ['all', 'release', 'blog', 'news'];

  return (
    <div className="space-y-4">
      {/* 상태 + 종합 요약 */}
      {/* D-122: 상태·건수 수제 헤더 행 → MacCard 슬롯 */}
      <MacCard
        title="기술 동향 요약"
        titleExtra={
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className={`flex items-center gap-1 text-xs font-medium ${statusInfo.cls}`}>
              {statusInfo.icon} {statusInfo.label}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">· {digest.itemCount}건 수집</span>
            {digest.errorMessage && (
              <span className="text-xs text-status-critical truncate" title={digest.errorMessage}>{digest.errorMessage}</span>
            )}
          </span>
        }
      >
        {digest.overallSummaryKo ? (
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{digest.overallSummaryKo}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {inProgress
              ? '요약 생성 중…'
              : digest.status === 'failed'
                ? '수집이 실패해 종합 요약이 없습니다.'
                : '종합 요약 없음'}
          </p>
        )}
      </MacCard>

      {/* 일부 실패 안내 — 실패를 "없음"으로 보이게 하지 않는다(A-8) */}
      {digest.status === 'partial' && (
        <div role="status" className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-status-warning">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden />
            일부 소스 수집 또는 항목 요약이 실패했습니다.
          </p>
          <p className="mt-0.5 text-muted-foreground">
            아래 목록은 성공한 소스의 항목만 담았습니다. 요약이 실패한 항목은 &quot;요약 실패&quot; 표시와 사유를 보여주며 다음 수집 때 다시 요약합니다.
          </p>
          {failedSources.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {failedSources.map((s) => (
                <li key={s.id} className="text-xs text-foreground break-words">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-status-critical"> — {s.lastMessage?.trim() || '사유가 기록되지 않았습니다'}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={onOpenSources} className="mt-1.5 text-xs text-primary hover:underline">
            소스 관리에서 확인
          </button>
        </div>
      )}

      {/* 필터 */}
      <div className="flex flex-wrap gap-3">
        <div role="group" aria-label="카테고리 필터" className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-muted-foreground" aria-hidden>카테고리:</span>
          {['all', ...categories].map((c) => (
            <FilterChip key={c} active={selCategory === c} onClick={() => setSelCategory(c)}>
              {c === 'all' ? '전체' : categoryLabel(c)}
            </FilterChip>
          ))}
        </div>
        <div role="group" aria-label="유형 필터" className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-muted-foreground" aria-hidden>유형:</span>
          {types.map((t) => (
            <FilterChip key={t} active={selType === t} onClick={() => setSelType(t)}>
              {t === 'all' ? '전체' : (ITEM_TYPE_LABEL[t] ?? t)}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* 아이템 목록 */}
      {itemsQ.isLoading ? (
        <LoadingState compact />
      ) : itemsQ.isError ? (
        <ErrorState compact error={itemsQ.error} title="항목을 불러오지 못했습니다" onRetry={() => void itemsQ.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          compact
          title={inProgress ? '아직 모인 항목이 없습니다.' : '해당 조건의 항목이 없습니다.'}
          description={inProgress ? '수집이 진행 중입니다 — 목록이 5초마다 갱신됩니다.' : '카테고리·유형 필터를 바꾸거나 수집 기간을 늘려 다시 수집하세요.'}
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <TrendItemCard key={item.id} item={item} inProgress={inProgress} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 소스 관리 패널 ───────────────────────────────────────────────

const SOURCE_STATUS_CLS: Record<string, string> = {
  ok:    'bg-secondary text-muted-foreground border-border',
  empty: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',
  error: 'bg-status-critical/10 text-status-critical border-status-critical/30',
};

function formatDateTimeShort(iso?: string | null): string {
  if (!iso) return '—';
  const d = parseUTC(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type SourceForm = Required<Pick<TrendSourceCreate, 'name' | 'sourceType' | 'url' | 'category'>> & { itemType: TrendItemType };

/** 저장 본문 — 종류(itemType)는 RSS 에만 의미가 있어 RSS 일 때만 보낸다. */
function toPayload(f: SourceForm): TrendSourceCreate {
  return {
    name: f.name.trim(),
    sourceType: f.sourceType,
    url: f.url.trim(),
    category: f.category.trim(),
    ...(f.sourceType === 'rss' ? { itemType: f.itemType } : {}),
  };
}

/** 소스 추가·편집 공용 입력 — 모든 입력에 라벨을 붙인다(A-25). */
function SourceFields({
  form, onChange, categories, disabled,
}: { form: SourceForm; onChange: (f: SourceForm) => void; categories: string[]; disabled?: boolean }) {
  const listId = useId();
  const set = <K extends keyof SourceForm>(k: K, v: SourceForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      <Field label="이름">
        <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="예: Istio 블로그"
          disabled={disabled} className={INPUT_CLS} />
      </Field>
      <Field label="카테고리" help="필터 칩은 소스 카테고리에서 만들어집니다.">
        <input value={form.category} onChange={(e) => set('category', e.target.value)} list={listId}
          placeholder="k8s / cilium / linux / cncf …" disabled={disabled} className={INPUT_CLS} />
        <datalist id={listId}>
          {categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </datalist>
      </Field>
      <Field label="수집 방식">
        <select value={form.sourceType} onChange={(e) => set('sourceType', e.target.value as SourceForm['sourceType'])}
          disabled={disabled} className={INPUT_CLS}>
          <option value="rss">RSS 피드 (URL 입력)</option>
          <option value="github_release">GitHub Releases (owner/repo 입력)</option>
        </select>
      </Field>
      <Field label="항목 종류" help={form.sourceType === 'rss' ? '이 피드의 글을 어떤 종류로 분류할지 고릅니다.' : 'GitHub Releases 는 항상 릴리즈로 분류됩니다.'}>
        <select value={form.sourceType === 'rss' ? form.itemType : 'release'}
          onChange={(e) => set('itemType', e.target.value as TrendItemType)}
          disabled={disabled || form.sourceType !== 'rss'} className={INPUT_CLS}>
          {ITEM_TYPES.map((t) => <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      <Field
        label={form.sourceType === 'rss' ? '피드 URL' : '저장소 (owner/repo)'}
        className="md:col-span-2"
        help={form.sourceType === 'rss'
          ? 'http(s) 주소만 받습니다. 사설·내부 주소는 admin 이 "수집 설정"의 허용 호스트에 등록해야 수집됩니다.'
          : '예: cilium/cilium — 슬래시 하나로 구분한 저장소 이름만 받습니다.'}
      >
        <input value={form.url} onChange={(e) => set('url', e.target.value)}
          placeholder={form.sourceType === 'rss' ? 'https://example.com/feed.xml' : 'owner/repo'}
          disabled={disabled} className={`${INPUT_CLS} font-mono`} />
      </Field>
    </div>
  );
}

function SourceRow({ s, categories }: { s: TrendSource; categories: string[] }) {
  const toggle = useToggleSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const toast = useToast();
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate();
  const isAdmin = useAuthStore((st) => st.user?.role === 'admin');

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SourceForm>(() => ({
    name: s.name, sourceType: s.sourceType, url: s.url, category: s.category, itemType: s.itemType ?? 'blog',
  }));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [hardDelete, setHardDelete] = useState(false);

  const statusKey = s.lastStatus || '';
  const statusCls = SOURCE_STATUS_CLS[statusKey] ?? 'bg-muted text-muted-foreground';
  const canSave = form.name.trim() && form.url.trim() && form.category.trim();

  const startEdit = () => {
    setForm({ name: s.name, sourceType: s.sourceType, url: s.url, category: s.category, itemType: s.itemType ?? 'blog' });
    update.reset();
    setEditing(true);
  };

  // 이미 꺼진 소스에 남는 동작은 admin 의 완전 삭제뿐이다.
  const onlyHard = !s.enabled;
  const removeDisabledReason = !canOperate
    ? (hint ?? null)
    : onlyHard && !isAdmin
      ? '완전 삭제는 admin 권한이 필요합니다 (이미 비활성 상태)'
      : null;
  const removeLabel = onlyHard ? '완전 삭제' : '비활성화';
  const doHard = onlyHard || hardDelete;

  if (editing) {
    return (
      <div className="p-3 border border-primary/40 rounded-md bg-card space-y-2">
        <SourceFields form={form} onChange={setForm} categories={categories} disabled={update.isPending} />
        {update.isError && (
          <p role="alert" className="text-sm text-status-critical">저장 실패: {formatApiError(update.error)}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setEditing(false)} className={BTN_SECONDARY}>
            <X className="w-3 h-3" aria-hidden />취소
          </button>
          <button
            type="button"
            onClick={() => update.mutate(
              { id: s.id, data: toPayload(form) },
              { onSuccess: () => setEditing(false) },
            )}
            disabled={!canOperate || !canSave || update.isPending}
            title={withHint('저장')}
            className={BTN_PRIMARY}>
            {update.isPending ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Check className="w-3 h-3" aria-hidden />}저장
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 border border-border rounded-md bg-card">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`text-sm font-medium ${s.enabled ? '' : 'text-muted-foreground'}`}>{s.name}</p>
            <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
              {s.sourceType === 'github_release' ? 'GitHub' : 'RSS'}
            </span>
            {s.sourceType === 'rss' && s.itemType && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                {ITEM_TYPE_LABEL[s.itemType] ?? s.itemType}
              </span>
            )}
            {!s.enabled && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">비활성</span>
            )}
            {s.lastStatus && (
              <span className={`text-xs px-1.5 py-0.5 rounded border ${statusCls}`}>
                {s.lastStatus === 'ok' ? `최근 +${s.lastItemCount ?? 0}` : s.lastStatus === 'empty' ? '수집 없음' : '실패'}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground font-mono truncate mt-0.5">{s.url}</p>
          {s.lastStatus === 'error' ? (
            <p className="text-xs mt-1 break-all text-status-critical" title={s.lastMessage ?? undefined}>
              실패 사유 — {s.lastMessage?.trim() || '사유가 기록되지 않았습니다'}
            </p>
          ) : s.lastMessage ? (
            <p className="text-xs mt-1 break-all text-muted-foreground" title={s.lastMessage}>
              {s.lastMessage}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground mt-0.5">
            마지막 수집: {formatDateTimeShort(s.lastCollectedAt)}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            aria-label={ariaWithHint(`${s.name} 수집 사용`)}
            title={withHint(s.enabled ? '수집 사용 중 — 누르면 끕니다' : '수집 꺼짐 — 누르면 켭니다')}
            disabled={!canOperate || toggle.isPending}
            onClick={() => toggle.mutate(
              { id: s.id, enabled: !s.enabled },
              { onError: (e) => toast.error('수집 사용 변경 실패', formatApiError(e)) },
            )}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              s.enabled ? 'bg-primary' : 'bg-secondary border border-border'
            }`}
          >
            <span aria-hidden className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-background shadow transform transition-transform ${
              s.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
          <button
            type="button"
            onClick={startEdit}
            disabled={!canOperate}
            aria-label={ariaWithHint(`${s.name} 편집`)}
            title={withHint('편집')}
            className="p-1.5 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground disabled:opacity-50">
            <Pencil className="w-3.5 h-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => { setHardDelete(false); setConfirmOpen(true); }}
            disabled={!!removeDisabledReason}
            aria-label={removeDisabledReason ? `${s.name} ${removeLabel} — ${removeDisabledReason}` : `${s.name} ${removeLabel}`}
            title={removeDisabledReason ?? removeLabel}
            className="p-1.5 hover:bg-status-critical/10 rounded-xl text-muted-foreground hover:text-status-critical disabled:opacity-50">
            {onlyHard ? <Trash2 className="w-3.5 h-3.5" aria-hidden /> : <PowerOff className="w-3.5 h-3.5" aria-hidden />}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        danger
        busy={remove.isPending}
        title={doHard ? `"${s.name}" 소스를 완전히 삭제할까요?` : `"${s.name}" 소스를 비활성화할까요?`}
        description={doHard
          ? '소스와 지난 다이제스트의 관련 항목이 모두 삭제되며 되돌릴 수 없습니다.'
          : '더 이상 수집하지 않습니다. 지난 다이제스트의 항목은 그대로 남고, 수집 사용 스위치로 다시 켤 수 있습니다.'}
        confirmLabel={doHard ? '완전 삭제' : '비활성화'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => remove.mutate(
          { id: s.id, hard: doHard },
          {
            onSuccess: () => {
              setConfirmOpen(false);
              toast.success(doHard ? '소스 삭제됨' : '소스 비활성화됨', s.name);
            },
            onError: (e) => toast.error(doHard ? '삭제 실패' : '비활성화 실패', formatApiError(e)),
          },
        )}
      >
        {isAdmin && !onlyHard && (
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={hardDelete} onChange={(e) => setHardDelete(e.target.checked)} className="accent-primary mt-0.5" />
            <span>
              완전 삭제
              <span className="block text-xs text-muted-foreground">admin 전용 — 지난 다이제스트 항목까지 함께 지웁니다.</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}

function AddSourceForm({ onClose, categories }: { onClose: () => void; categories: string[] }) {
  const create = useCreateSource();
  const { canOperate, withHint } = useCanOperate();
  const [form, setForm] = useState<SourceForm>({ name: '', sourceType: 'rss', url: '', category: 'k8s', itemType: 'blog' });
  const canSubmit = form.name.trim() && form.url.trim() && form.category.trim();

  return (
    <MacCard
      title="새 소스 추가"
      bodyPadding="p-3"
      className="space-y-2"
      actions={
        <button type="button" onClick={onClose} aria-label="닫기" title="닫기" className="p-1 rounded-xl text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      }
    >
      <SourceFields form={form} onChange={setForm} categories={categories} disabled={create.isPending} />
      {create.isError && (
        <p role="alert" className="text-sm text-status-critical">등록 실패: {formatApiError(create.error)}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={BTN_SECONDARY}>취소</button>
        <button
          type="button"
          onClick={() => create.mutate(
            { ...toPayload(form), enabled: true },
            { onSuccess: () => onClose() },
          )}
          disabled={!canOperate || !canSubmit || create.isPending}
          title={withHint('추가')}
          className={BTN_PRIMARY}>
          {create.isPending ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Plus className="w-3 h-3" aria-hidden />}
          추가
        </button>
      </div>
    </MacCard>
  );
}

// ── 수집 설정(admin) — GitHub API 주소·허용 호스트·토큰 (A-19, 정책 ⑤) ─────────
const ADMIN_REQUIRED_HINT = 'admin 권한이 필요합니다';

function parseHosts(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean))];
}

function TrendSettingsForm({ initial, onClose }: { initial: TrendSettings; onClose: () => void }) {
  const isAdmin = useAuthStore((st) => st.user?.role === 'admin');
  const save = useUpdateTrendSettings();
  const toast = useToast();
  const [apiUrl, setApiUrl] = useState(initial.githubApiUrl ?? '');
  const [hosts, setHosts] = useState((initial.allowedHosts ?? []).join('\n'));
  const [token, setToken] = useState('');
  const locked = !isAdmin || save.isPending;

  const onSave = () => {
    save.mutate(
      { githubApiUrl: apiUrl.trim(), allowedHosts: parseHosts(hosts), ...(token.trim() ? { githubToken: token.trim() } : {}) },
      {
        onSuccess: () => { toast.success('수집 설정 저장됨'); onClose(); },
        onError: (e) => toast.error('수집 설정 저장 실패', formatApiError(e)),
      },
    );
  };

  return (
    <>
      <div className="space-y-3 px-5 pb-3">
        {!isAdmin && (
          <p className="text-xs text-muted-foreground">조회만 가능합니다 — 변경은 {ADMIN_REQUIRED_HINT}.</p>
        )}
        <Field label="GitHub API 주소" help="GitHub Releases 수집에 쓰는 API 주소. 폐쇄망 GitHub Enterprise 면 https://<호스트>/api/v3 형식입니다.">
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.github.com"
            disabled={locked} className={`${INPUT_CLS} font-mono`} />
        </Field>
        <Field label="허용 호스트" help="사설·내부 대역이라 기본 차단되는 RSS·GitHub 미러 호스트. 한 줄에 하나씩(쉼표 구분도 가능).">
          <textarea value={hosts} onChange={(e) => setHosts(e.target.value)} rows={4}
            placeholder={'mirror.internal.example\n10.0.0.15'} disabled={locked} className={`${INPUT_CLS} font-mono`} />
        </Field>
        <Field label="GitHub 토큰" help="쓰기 전용 — 저장된 값은 다시 보여주지 않습니다. 바꿀 때만 입력하고, 비워 두면 기존 토큰을 유지합니다.">
          <span className="mt-0.5 flex items-center gap-2">
            <input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={initial.tokenSet ? '설정됨 — 바꿀 때만 입력' : '미설정'} disabled={locked}
              className={`${INPUT_CLS} mt-0 font-mono`} />
            <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">
              {initial.tokenSet ? '설정됨' : '미설정'}
            </span>
          </span>
        </Field>
      </div>
      <DialogFooter className="justify-end">
        <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={save.isPending}>닫기</button>
        <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={locked}
          title={isAdmin ? '저장' : ADMIN_REQUIRED_HINT}
          aria-label={isAdmin ? '저장' : `저장 — ${ADMIN_REQUIRED_HINT}`}>
          {save.isPending && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}저장
        </button>
      </DialogFooter>
    </>
  );
}

function TrendSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useTrendSettings(open);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>수집 설정</DialogTitle>
          <DialogDescription>GitHub API 주소, 내부 미러 허용 호스트, GitHub 토큰을 정합니다.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <div className="px-5 pb-5"><LoadingState compact /></div>
        ) : q.isError || !q.data ? (
          <div className="px-5 pb-5">
            <ErrorState compact error={q.error} title="수집 설정을 불러오지 못했습니다" onRetry={() => void q.refetch()} />
          </div>
        ) : (
          <TrendSettingsForm key={q.dataUpdatedAt} initial={q.data} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourcesPanel() {
  const sourcesQ = useTrendSources();
  const sources = useMemo(() => sourcesQ.data ?? [], [sourcesQ.data]);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { canOperate, withHint } = useCanOperate();
  const categories = useCategoryOptions(sources, 'all');

  const grouped = sources.reduce<Record<string, TrendSource[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  const totalErrors = sources.filter((s) => s.enabled && s.lastStatus === 'error').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm text-muted-foreground">
          {sourcesQ.isSuccess && (
            <>
              총 {sources.length}개 · 활성 {sources.filter((s) => s.enabled).length}개
              {totalErrors > 0 && (
                <span className="ml-2 inline-flex items-center gap-1 text-status-critical">
                  <AlertCircle className="w-3.5 h-3.5" aria-hidden /> 수집 실패 {totalErrors}개
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border bg-card hover:bg-secondary rounded-xl transition-colors"
            title="GitHub API 주소·허용 호스트·토큰 (변경은 admin)"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
            수집 설정
          </button>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={!canOperate}
              title={withHint('소스 추가')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-xl transition-colors disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              소스 추가
            </button>
          )}
        </div>
      </div>

      {adding && <AddSourceForm onClose={() => setAdding(false)} categories={categories} />}

      {sourcesQ.isLoading ? (
        <LoadingState compact />
      ) : sourcesQ.isError ? (
        <ErrorState compact error={sourcesQ.error} title="소스 목록을 불러오지 못했습니다" onRetry={() => void sourcesQ.refetch()} />
      ) : sources.length === 0 ? (
        <EmptyState compact title="등록된 소스가 없습니다." description="소스 추가로 RSS 피드나 GitHub 저장소를 등록하세요." />
      ) : (
        Object.entries(grouped).map(([cat, srcs]) => (
          <div key={cat}>
            <p className={`text-sm font-semibold px-2 py-1 rounded mb-2 w-fit ${categoryCls(cat)}`}>
              {categoryLabel(cat)}
            </p>
            <div className="space-y-1.5">
              {srcs.map((s) => <SourceRow key={s.id} s={s} categories={categories} />)}
            </div>
          </div>
        ))
      )}

      <TrendSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────
const LOOKBACK_OPTIONS: { value: number; label: string }[] = [
  { value: 7,   label: '최근 7일' },
  { value: 30,  label: '최근 30일' },
  { value: 90,  label: '최근 90일' },
  { value: 180, label: '최근 180일' },
  { value: 365, label: '최근 1년' },
];

function errorText(err: unknown): string {
  return err instanceof Error && !('response' in err) ? err.message : formatApiError(err);
}

/** 스트림 엔드포인트가 없는 구 서버(404/405) — 단건 수집으로 한 번 더 요청한다. */
function isMissingStreamEndpoint(err: unknown): boolean {
  return /^(Not Found|Method Not Allowed|서버 오류 40[45])$/.test(errorText(err).trim());
}

/** 수집 결과 다이제스트 → 실행 로그 줄. 성공·실패 판정은 상태 필드로 한다(A-8 — 문구로 판정하지 않는다). */
function summarizeDigest(d: TrendDigest): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  const st = STATUS_INFO[d.status]?.label ?? d.status;
  const level = d.status === 'failed' ? 'error' : d.status === 'partial' ? 'warn' : 'info';
  out.push([level, `${d.digestDate} 다이제스트 · 상태 ${st} · 항목 ${d.itemCount}건`]);
  if (d.errorMessage) out.push([d.status === 'failed' ? 'error' : 'warn', `사유 — ${d.errorMessage}`]);
  if (d.status === 'partial') out.push(['warn', '일부 소스 수집 또는 항목 요약이 실패했습니다 — 소스 관리의 실패 사유와 항목의 "요약 실패" 표시를 확인하세요']);
  const finished = d.status === 'done' || d.status === 'partial';
  if (finished && d.itemCount === 0) out.push(['warn', '수집된 항목 없음 — 기간을 늘리거나 소스 관리에서 활성 소스를 확인하세요']);
  if (finished) out.push(d.overallSummaryKo ? ['info', '종합 요약 생성 완료'] : ['warn', '종합 요약 없음']);
  return out;
}

export function TrendDigestPage() {
  const [activeTab, setActiveTab] = useState<'digest' | 'sources'>('digest');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState<number>(90);
  const [collecting, setCollecting] = useState(false);
  const collectAbort = useRef<AbortController | null>(null);

  const digestsQ = useTrendDigests(30);
  const digests = useMemo(() => digestsQ.data ?? [], [digestsQ.data]);
  const triggerCollect = useTriggerCollect();
  const invalidateTrends = useInvalidateTrends();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('trends-collect');
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate();

  const activeDigest = selectedDate
    ? digests.find((d) => d.digestDate === selectedDate)
    : digests[0];
  const rangeLabel = LOOKBACK_OPTIONS.find((o) => o.value === lookbackDays)?.label ?? `최근 ${lookbackDays}일`;

  /** 지금 수집 — 서버가 소스별 결과·요약 진행·합계를 SSE 로 흘린다(A-9). 구 서버면 단건 수집으로 폴백. */
  const handleCollect = async () => {
    if (collecting || !canOperate) return;
    collectAbort.current?.abort();
    const ctrl = new AbortController();
    collectAbort.current = ctrl;
    setCollecting(true);
    // 다이제스트가 "수집 중"으로 바뀌면 목록 폴링(5초)이 이어받는다.
    const refreshSoon = setTimeout(() => void invalidateTrends(), 2000);

    let r: RunLoggedResult<TrendDigest> = await streamLogged<TrendDigest>(runLog, {
      title: '기술 동향 수집',
      first: `${rangeLabel} 범위 수집 시작 — 소스별 결과와 요약 진행을 실시간으로 표시합니다`,
      url: trendsApi.collectStreamUrl(undefined, lookbackDays),
      body: { lookbackDays },
      signal: ctrl.signal,
      summarize: summarizeDigest,
    });

    if (!r.ok && !r.aborted && isMissingStreamEndpoint(r.error)) {
      r = await runLogged(runLog, {
        title: '기술 동향 수집 (단건)',
        first: '서버가 실시간 수집을 지원하지 않아 단건 수집으로 다시 요청 — 소스 수집과 요약이 끝나면 한 번에 응답합니다',
        fn: () => new Promise<TrendDigest>((resolve, reject) => {
          triggerCollect.mutateAsync({ lookbackDays }).then(resolve, reject);
          ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('중지'), { name: 'AbortError' })), { once: true });
        }),
        summarize: summarizeDigest,
      });
    }

    clearTimeout(refreshSoon);
    if (collectAbort.current === ctrl) {
      collectAbort.current = null;
      setCollecting(false);
    }
    void invalidateTrends();

    if (!r.ok) {
      if (r.aborted) return;
      const msg = errorText(r.error);
      if (/이미 수집 중/.test(msg)) toast.warning('이미 수집 중입니다', '진행 중인 수집이 끝나면 목록이 자동으로 갱신됩니다.');
      else toast.error('기술 동향 수집 실패', msg);
      return;
    }
    setSelectedDate(r.data.digestDate);
    if (r.data.status === 'failed') toast.error('기술 동향 수집 실패', r.data.errorMessage ?? undefined);
    else if (r.data.status === 'partial') toast.warning('일부 소스·요약 실패', '실행 로그와 소스 관리에서 사유를 확인하세요.');
  };

  /** 화면의 실시간 표시만 끊는다 — 서버 쪽 수집은 계속될 수 있고 목록 폴링이 이어서 보여준다. */
  const stopCollect = () => {
    collectAbort.current?.abort();
    collectAbort.current = null;
    setCollecting(false);
  };

  const collectTitle = withHint(`${rangeLabel} 범위로 수집`);

  // 실행 로그 — 실행 전엔 렌더되지 않는다(빈 여백도 남기지 않게 래퍼까지 조건부).
  const runLogPanel = (runLog.running || runLog.lines.length > 0) ? (
    <div className="mb-4">
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
    </div>
  ) : null;

  return (
    <div className="flex app-h-screen overflow-hidden bg-background">
      {/* 좌측: 날짜 목록 */}
      <aside className="w-56 flex-shrink-0 border-r border-border flex flex-col bg-card">
        <div className="px-4 py-4 border-b border-border">
          <h2 className="font-semibold text-sm">기술 동향</h2>
          <p className="text-xs text-muted-foreground mt-0.5">K8s · Cilium · Linux</p>
        </div>

        <div className="px-3 py-3 border-b border-border space-y-2">
          <select
            value={lookbackDays}
            onChange={(e) => setLookbackDays(Number(e.target.value) || 90)}
            disabled={collecting}
            aria-label="수집 기간"
            title="며칠 전까지의 릴리즈/블로그를 가져올지 — k8s/cilium 마이너 릴리즈 주기가 길어서 1~7일만 보면 거의 비어 있다."
            className="w-full text-sm px-2 py-1.5 bg-background border border-border rounded-xl disabled:opacity-60"
          >
            {LOOKBACK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleCollect()}
            disabled={collecting || !canOperate}
            title={collectTitle}
            className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${collecting ? 'animate-spin' : ''}`} aria-hidden />
            {collecting ? '수집 중…' : '지금 수집'}
          </button>
          {collecting && (
            <button
              type="button"
              onClick={stopCollect}
              title="실시간 표시 중지 (서버 수집은 계속될 수 있습니다)"
              className="w-full flex items-center justify-center gap-1.5 text-sm px-3 py-1.5 border border-border bg-secondary rounded-xl hover:bg-secondary/80"
            >
              <Square className="w-3.5 h-3.5" aria-hidden />
              중지
            </button>
          )}
        </div>

        <nav aria-label="다이제스트 날짜" className="flex-1 overflow-y-auto py-2">
          {digestsQ.isLoading ? (
            <LoadingState compact />
          ) : digestsQ.isError ? (
            <ErrorState compact error={digestsQ.error} title="다이제스트를 불러오지 못했습니다" onRetry={() => void digestsQ.refetch()} />
          ) : digests.length === 0 ? (
            <EmptyState compact title="수집된 동향이 없습니다." description="위 '지금 수집' 버튼으로 시작하세요." />
          ) : (
            digests.map((d) => {
              const si = STATUS_INFO[d.status] ?? STATUS_INFO.pending;
              const isActive = (selectedDate ?? digests[0]?.digestDate) === d.digestDate;
              return (
                <button
                  type="button"
                  key={d.id}
                  onClick={() => { setSelectedDate(d.digestDate); setActiveTab('digest'); }}
                  aria-current={isActive && activeTab === 'digest' ? 'true' : undefined}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  <p className="text-sm font-medium">{d.digestDate}</p>
                  <div className={`flex items-center gap-1 text-xs mt-0.5 ${si.cls}`}>
                    {si.icon}
                    <span>{si.label}</span>
                    {(d.status === 'done' || d.status === 'partial') && (
                      <span className="text-muted-foreground ml-1">({d.itemCount}건)</span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </nav>

        {/* 소스 관리 탭 */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => setActiveTab((t) => t === 'sources' ? 'digest' : 'sources')}
            aria-pressed={activeTab === 'sources'}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-xl transition-colors ${
              activeTab === 'sources'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-secondary'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" aria-hidden />
            소스 관리
          </button>
        </div>
      </aside>

      {/* 우측: 콘텐츠 */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <PageShell density="doc" as="div">
          {activeTab === 'sources' ? (
            <>
              <PageHeader title="수집 소스 관리" className="mb-4" />
              {runLogPanel}
              <SourcesPanel />
            </>
          ) : activeDigest ? (
            <>
              <PageHeader
                title={`${activeDigest.digestDate} 기술 동향`}
                className="mb-4"
                actions={
                <button
                  type="button"
                  onClick={() => void handleCollect()}
                  disabled={collecting || !canOperate}
                  className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-60"
                  title={withHint(`${rangeLabel} 범위로 다시 수집`)}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${collecting ? 'animate-spin' : ''}`} aria-hidden />
                  {rangeLabel} 다시 수집
                </button>
                }
              />
              {runLogPanel}
              <DigestPanel
                digest={activeDigest}
                onOpenSources={() => setActiveTab('sources')}
              />
            </>
          ) : (
            <>
              <PageHeader title="기술 동향" description="K8s · Cilium · Linux · CNCF 릴리즈와 블로그를 모아 요약합니다." />
              {runLogPanel}
              {digestsQ.isError ? null : (
                <EmptyState
                  icon={RefreshCw}
                  title="아직 수집된 동향이 없습니다."
                  description="수집 기간을 고른 뒤 지금 수집을 시작하세요."
                >
                  <button
                    type="button"
                    onClick={() => void handleCollect()}
                    disabled={collecting || !canOperate}
                    title={collectTitle}
                    className="mt-4 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 text-sm disabled:opacity-60"
                  >
                    <RefreshCw className={`w-4 h-4 ${collecting ? 'animate-spin' : ''}`} aria-hidden />
                    지금 수집 시작
                  </button>
                </EmptyState>
              )}
            </>
          )}
        </PageShell>
      </main>
    </div>
  );
}
