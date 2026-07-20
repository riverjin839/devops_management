import { useState } from 'react';
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight, Settings2, AlertCircle, Loader2, CheckCircle2, Clock, Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { useTrendDigests, useTrendItems, useTrendSources, useTriggerCollect, useToggleSource, useCreateSource, useUpdateSource, useDeleteSource } from '@/hooks/useTrends';
import { MacCard } from '@/components/ui/MacCard';
import type { TrendDigest, TrendItem, TrendSource } from '@/types';

// ── 카테고리 색상 ────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  k8s:    'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  cilium: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  linux:  'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  cncf:   'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
};

const CATEGORY_LABEL: Record<string, string> = {
  k8s: 'Kubernetes', cilium: 'Cilium', linux: 'Linux', cncf: 'CNCF',
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  release: '릴리즈', blog: '블로그', news: '뉴스',
};

const STATUS_INFO: Record<string, { icon: import('react').ReactNode; label: string; cls: string }> = {
  pending:     { icon: <Clock className="w-3.5 h-3.5" />, label: '대기',   cls: 'text-muted-foreground' },
  collecting:  { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, label: '수집 중', cls: 'text-blue-500' },
  summarizing: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, label: '요약 중', cls: 'text-purple-500' },
  done:        { icon: <CheckCircle2 className="w-3.5 h-3.5" />, label: '완료',   cls: 'text-green-500' },
  failed:      { icon: <AlertCircle className="w-3.5 h-3.5" />, label: '실패',   cls: 'text-red-500' },
};

// ── 개별 아이템 카드 ─────────────────────────────────────────────
function TrendItemCard({ item }: { item: TrendItem }) {
  const [open, setOpen] = useState(false);
  const catCls = CATEGORY_COLORS[item.category] ?? 'bg-secondary text-muted-foreground';

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <button
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mt-0.5 flex-shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${catCls}`}>
              {CATEGORY_LABEL[item.category] ?? item.category.toUpperCase()}
            </span>
            <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
              {ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}
            </span>
            {item.version && (
              <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {item.version}
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {new Date(item.publishedAt).toLocaleDateString('ko-KR')}
            </span>
          </div>
          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
          <p className="text-xs text-muted-foreground">{item.sourceName}</p>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-border bg-secondary/10">
          {item.summaryKo ? (
            <div className="mt-3">
              <p className="text-sm font-semibold text-muted-foreground mb-1.5">AI 요약 (한국어)</p>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{item.summaryKo}</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground italic">요약 준비 중...</p>
          )}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            원문 보기 <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
}

// ── 다이제스트 날짜 패널 ─────────────────────────────────────────
function DigestPanel({ digest }: { digest: TrendDigest }) {
  const [selCategory, setSelCategory] = useState<string>('all');
  const [selType, setSelType] = useState<string>('all');

  const { data: items = [], isLoading } = useTrendItems(
    digest.digestDate,
    selCategory !== 'all' ? selCategory : undefined,
    selType !== 'all' ? selType : undefined,
  );

  const statusInfo = STATUS_INFO[digest.status] ?? STATUS_INFO.pending;
  const categories = ['all', 'k8s', 'cilium', 'linux', 'cncf'];
  const types = ['all', 'release', 'blog', 'news'];

  return (
    <div className="space-y-4">
      {/* 상태 + 종합 요약 */}
      <MacCard>
        <div className="flex items-center gap-2 mb-3">
          <span className={`flex items-center gap-1 text-sm font-medium ${statusInfo.cls}`}>
            {statusInfo.icon} {statusInfo.label}
          </span>
          <span className="text-sm text-muted-foreground">· {digest.itemCount}건 수집</span>
          {digest.errorMessage && (
            <span className="text-sm text-red-500 truncate ml-1">{digest.errorMessage}</span>
          )}
        </div>

        {digest.overallSummaryKo ? (
          <>
            <p className="text-sm font-semibold text-muted-foreground mb-1.5">오늘의 기술 동향 요약</p>
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{digest.overallSummaryKo}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {digest.status === 'done' ? '종합 요약 없음' : '요약 생성 중...'}
          </p>
        )}
      </MacCard>

      {/* 필터 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-muted-foreground">카테고리:</span>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setSelCategory(c)}
              className={`text-sm px-2.5 py-1 rounded-full border transition-colors ${
                selCategory === c
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {c === 'all' ? '전체' : (CATEGORY_LABEL[c] ?? c)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-muted-foreground">타입:</span>
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setSelType(t)}
              className={`text-sm px-2.5 py-1 rounded-full border transition-colors ${
                selType === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {t === 'all' ? '전체' : (ITEM_TYPE_LABEL[t] ?? t)}
            </button>
          ))}
        </div>
      </div>

      {/* 아이템 목록 */}
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">해당 조건의 항목이 없습니다</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <TrendItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 소스 관리 패널 ───────────────────────────────────────────────

const SOURCE_STATUS_CLS: Record<string, string> = {
  ok:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  empty: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  error: 'bg-red-500/10 text-red-400 border-red-500/30',
};

function formatDateTimeShort(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SourceRow({ s }: { s: TrendSource }) {
  const toggle = useToggleSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [url, setUrl] = useState(s.url);
  const [sourceType, setSourceType] = useState(s.sourceType);
  const [category, setCategory] = useState(s.category);

  const statusKey = s.lastStatus || '';
  const statusCls = SOURCE_STATUS_CLS[statusKey] ?? 'bg-muted text-muted-foreground';

  if (editing) {
    return (
      <div className="p-3 border border-primary/40 rounded-lg bg-card space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름"
            className="px-2 py-1 text-sm bg-background border border-border rounded" />
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="카테고리 (k8s / cilium / linux ...)"
            className="px-2 py-1 text-sm bg-background border border-border rounded" />
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as TrendSource['sourceType'])}
            className="px-2 py-1 text-sm bg-background border border-border rounded">
            <option value="github_release">GitHub Releases (owner/repo)</option>
            <option value="rss">RSS 피드 (URL)</option>
          </select>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="url 또는 repo slug"
            className="px-2 py-1 text-sm font-mono bg-background border border-border rounded md:col-span-2" />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)}
            className="flex items-center gap-1 px-2 py-1 text-sm bg-secondary border border-border rounded">
            <X className="w-3 h-3" />취소
          </button>
          <button
            onClick={() => update.mutate(
              { id: s.id, data: { name, url, sourceType, category } },
              { onSuccess: () => setEditing(false) },
            )}
            disabled={update.isPending}
            className="flex items-center gap-1 px-2 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50">
            <Check className="w-3 h-3" />저장
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 border border-border rounded-lg bg-card">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{s.name}</p>
            <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
              {s.sourceType === 'github_release' ? 'GitHub' : 'RSS'}
            </span>
            {s.lastStatus && (
              <span className={`text-xs px-1.5 py-0.5 rounded border ${statusCls}`}>
                {s.lastStatus === 'ok' ? `✓ 최근 +${s.lastItemCount ?? 0}` : s.lastStatus === 'empty' ? '· 수집 없음' : '✗ 실패'}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground font-mono truncate mt-0.5">{s.url}</p>
          {s.lastMessage && (
            <p className={`text-xs mt-1 break-all ${s.lastStatus === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}
               title={s.lastMessage}>
              {s.lastMessage}
            </p>
          )}
          {s.lastCollectedAt && (
            <p className="text-xs text-muted-foreground/70 mt-0.5">
              마지막: {formatDateTimeShort(s.lastCollectedAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
            className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
              s.enabled ? 'bg-primary' : 'bg-secondary border border-border'
            }`}
            title="활성/비활성"
            aria-label="활성/비활성"
          >
            <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transform transition-transform ${
              s.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
          <button onClick={() => setEditing(true)}
            aria-label="소스 편집"
            className="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              if (!confirm(`"${s.name}" 소스를 삭제하시겠습니까? 관련 아이템도 모두 삭제됩니다.`)) return;
              remove.mutate(s.id);
            }}
            aria-label="소스 삭제"
            className="p-1.5 hover:bg-red-500/10 rounded-md text-muted-foreground hover:text-red-400">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AddSourceForm({ onClose }: { onClose: () => void }) {
  const create = useCreateSource();
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<'github_release' | 'rss'>('rss');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('k8s');
  const canSubmit = name.trim() && url.trim() && category.trim();

  return (
    <div className="p-3 border border-primary/40 rounded-lg bg-card space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-primary">새 소스 추가</p>
        <button onClick={onClose} aria-label="닫기" className="p-1 text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: Istio 블로그)"
          className="px-2 py-1.5 text-sm bg-background border border-border rounded" />
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="카테고리 (k8s / cilium / linux / cncf ...)"
          className="px-2 py-1.5 text-sm bg-background border border-border rounded" />
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as 'github_release' | 'rss')}
          className="px-2 py-1.5 text-sm bg-background border border-border rounded">
          <option value="rss">RSS 피드 (URL 입력)</option>
          <option value="github_release">GitHub Releases (owner/repo 입력)</option>
        </select>
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={sourceType === 'rss' ? 'https://example.com/feed.xml' : 'owner/repo'}
          className="px-2 py-1.5 text-sm font-mono bg-background border border-border rounded md:col-span-2" />
      </div>
      {create.isError && (
        <p className="text-sm text-red-400">등록 실패: {(create.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (create.error as Error).message}</p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose}
          className="px-2.5 py-1 text-sm bg-secondary border border-border rounded">취소</button>
        <button
          onClick={() => create.mutate(
            { name, sourceType, url, category, enabled: true },
            { onSuccess: () => onClose() },
          )}
          disabled={!canSubmit || create.isPending}
          className="flex items-center gap-1 px-2.5 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50">
          {create.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          추가
        </button>
      </div>
    </div>
  );
}

function SourcesPanel() {
  const { data: sources = [] } = useTrendSources();
  const [adding, setAdding] = useState(false);

  const grouped = sources.reduce<Record<string, TrendSource[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  const totalErrors = sources.filter((s) => s.lastStatus === 'error').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          총 {sources.length}개 · 활성 {sources.filter((s) => s.enabled).length}개
          {totalErrors > 0 && <span className="ml-2 text-red-400">⚠ 수집 실패 {totalErrors}개</span>}
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            소스 추가
          </button>
        )}
      </div>

      {adding && <AddSourceForm onClose={() => setAdding(false)} />}

      {Object.entries(grouped).map(([cat, srcs]) => (
        <div key={cat}>
          <p className={`text-sm font-semibold px-2 py-1 rounded mb-2 w-fit ${CATEGORY_COLORS[cat] ?? 'bg-secondary'}`}>
            {CATEGORY_LABEL[cat] ?? cat.toUpperCase()}
          </p>
          <div className="space-y-1.5">
            {srcs.map((s) => <SourceRow key={s.id} s={s} />)}
          </div>
        </div>
      ))}
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

export function TrendDigestPage() {
  const [activeTab, setActiveTab] = useState<'digest' | 'sources'>('digest');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState<number>(90);

  const { data: digests = [], isLoading: digestsLoading } = useTrendDigests(30);
  const triggerCollect = useTriggerCollect();

  const displayDigests = digests;
  const activeDigest = selectedDate
    ? displayDigests.find((d) => d.digestDate === selectedDate)
    : displayDigests[0];

  const handleCollect = () => {
    triggerCollect.mutate({ lookbackDays });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
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
            disabled={triggerCollect.isPending}
            title="며칠 전까지의 릴리즈/블로그를 가져올지 — k8s/cilium 마이너 릴리즈 주기가 길어서 1~7일만 보면 거의 비어있다."
            className="w-full text-sm px-2 py-1.5 bg-background border border-border rounded-lg disabled:opacity-60"
          >
            {LOOKBACK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={handleCollect}
            disabled={triggerCollect.isPending}
            className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${triggerCollect.isPending ? 'animate-spin' : ''}`} />
            {triggerCollect.isPending ? '수집 중...' : '지금 수집'}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {digestsLoading ? (
            <div className="flex justify-center pt-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : displayDigests.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center pt-6 px-3">
              수집된 동향이 없습니다.<br />위 버튼을 눌러 시작하세요.
            </p>
          ) : (
            displayDigests.map((d) => {
              const si = STATUS_INFO[d.status] ?? STATUS_INFO.pending;
              const isActive = (selectedDate ?? displayDigests[0]?.digestDate) === d.digestDate;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelectedDate(d.digestDate)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  <p className="text-sm font-medium">{d.digestDate}</p>
                  <div className={`flex items-center gap-1 text-xs mt-0.5 ${si.cls}`}>
                    {si.icon}
                    <span>{si.label}</span>
                    {d.status === 'done' && (
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
            onClick={() => setActiveTab((t) => t === 'sources' ? 'digest' : 'sources')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
              activeTab === 'sources'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-secondary'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            소스 관리
          </button>
        </div>
      </aside>

      {/* 우측: 콘텐츠 */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {activeTab === 'sources' ? (
            <>
              <h1 className="text-lg font-bold mb-4">수집 소스 관리</h1>
              <SourcesPanel />
            </>
          ) : activeDigest ? (
            <>
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <h1 className="text-lg font-bold">
                  {activeDigest.digestDate} 기술 동향
                </h1>
                <button
                  onClick={handleCollect}
                  disabled={triggerCollect.isPending}
                  className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-secondary disabled:opacity-60"
                  title={`${LOOKBACK_OPTIONS.find((o) => o.value === lookbackDays)?.label ?? '최근'} 범위로 다시 수집`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${triggerCollect.isPending ? 'animate-spin' : ''}`} />
                  {LOOKBACK_OPTIONS.find((o) => o.value === lookbackDays)?.label ?? '재수집'} 다시 수집
                </button>
              </div>
              <DigestPanel digest={activeDigest} />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-muted-foreground text-sm mb-4">
                아직 수집된 동향이 없습니다.
              </p>
              <button
                onClick={handleCollect}
                disabled={triggerCollect.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 text-sm"
              >
                <RefreshCw className={`w-4 h-4 ${triggerCollect.isPending ? 'animate-spin' : ''}`} />
                지금 수집 시작
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
