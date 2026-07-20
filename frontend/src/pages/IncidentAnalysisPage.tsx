import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle, Info, Loader2, Search, Zap,
  Server, Layers, Package, RefreshCw, Download, Play, Square, Filter, X,
} from 'lucide-react';
import { SearchableSelect, LogViewTabs } from '@/components/common';
import {
  useAnalyzeIncident, useAnalyzerHealth,
  useAnalyzeNamespaces, useAnalyzePods, useFetchIncidentContext,
} from '@/hooks/useIncidentAnalysis';
import { useClusters } from '@/hooks/useCluster';
import type {
  IncidentAnalysisRequest, IncidentAnalysisResult, KubeEvent, AnalyzePodItem,
} from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

const SEVERITY_STYLE: Record<string, { icon: typeof AlertTriangle; bg: string; border: string; text: string; badge: string }> = {
  critical: { icon: AlertTriangle, bg: 'bg-red-500/10',    border: 'border-red-500/40',    text: 'text-red-400',    badge: 'bg-red-500/15 text-red-400 border-red-500/30' },
  warning:  { icon: AlertTriangle, bg: 'bg-amber-500/10',  border: 'border-amber-500/40',  text: 'text-amber-400',  badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  info:     { icon: Info,          bg: 'bg-blue-500/10',   border: 'border-blue-500/40',   text: 'text-blue-400',   badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
};

const BACKEND_LABEL: Record<string, string> = {
  claude:     'Claude AI',
  local_llm:  'Local LLM',
  rule_based: 'Rule-Based',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-secondary rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-muted-foreground w-8 text-right">{pct}%</span>
    </div>
  );
}

function ResultPanel({ result }: { result: IncidentAnalysisResult }) {
  const st = SEVERITY_STYLE[result.severity] ?? SEVERITY_STYLE.info;
  const SeverityIcon = st.icon;

  return (
    <div className={`rounded-xl border ${st.border} ${st.bg} p-5 space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <SeverityIcon className={`w-5 h-5 flex-shrink-0 ${st.text}`} />
          <span className={`text-sm font-bold ${st.text} uppercase tracking-wide`}>{result.severity}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${st.badge}`}>
            {BACKEND_LABEL[result.analyzedBy] ?? result.analyzedBy}
          </span>
          <span className="text-xs text-muted-foreground">
            {parseUTC(result.analyzedAt).toLocaleTimeString('ko-KR')}
          </span>
        </div>
      </div>

      <div className="rounded-lg bg-background/60 border border-border px-4 py-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">근본 원인</p>
        <p className="text-sm text-foreground">{result.rootCause}</p>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">신뢰도</p>
        <ConfidenceBar value={result.confidence} />
      </div>

      {result.suggestedActions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">조치 방안</p>
          <ol className="space-y-1.5">
            {result.suggestedActions.map((action, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${st.badge} border`}>
                  {i + 1}
                </span>
                {action}
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.relatedRunbooks && result.relatedRunbooks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">관련 런북</p>
          <div className="flex flex-wrap gap-1.5">
            {result.relatedRunbooks.map((rb) => (
              <span key={rb} className="text-xs px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground">
                {rb}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ event, index }: { event: KubeEvent; index: number }) {
  return (
    <div className={`grid grid-cols-[80px_70px_60px_1fr] gap-2 py-1.5 px-3 text-sm ${index % 2 === 0 ? 'bg-secondary/20' : ''}`}>
      <span className={`font-medium truncate ${event.type === 'Warning' ? 'text-amber-400' : 'text-muted-foreground'}`}>{event.type ?? 'Normal'}</span>
      <span className="font-mono text-muted-foreground truncate">{event.reason}</span>
      <span className="text-muted-foreground text-center">x{event.count}</span>
      <span className="text-foreground truncate">{event.message}</span>
    </div>
  );
}

function podOptionLabel(pod: AnalyzePodItem): string {
  const restart = pod.restartCount > 0 ? ` ↻${pod.restartCount}` : '';
  const node = pod.node ? ` @ ${pod.node}` : '';
  const issue = pod.issueReason ? ` — ${pod.issueReason}` : '';
  return `${pod.hasIssue ? '⚠ ' : ''}${pod.name}  [${pod.ready} ${pod.phase}${restart}]${node}${issue}`;
}

export function IncidentAnalysisPage() {
  const { data: health } = useAnalyzerHealth();
  const { mutate: analyze, isPending: analyzing, data: response } = useAnalyzeIncident();
  const fetchCtx = useFetchIncidentContext();

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // ── 클러스터 / namespace / pod 선택 상태 ──
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [podName, setPodName] = useState('');
  // 거대 클러스터(수천 namespace) 에서도 첫 응답이 즉시 오도록 기본은 false (빠른 경로).
  // 백엔드의 list_namespaces 가 with_counts/only_with_issues 둘 다 false 면 pod 조회를 생략한다.
  // 사용자가 토글 켜면 느린 경로 (전체 pod fetch) 가 발동되며 axios 타임아웃도 2분 30초로 확장됨.
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [nsPattern, setNsPattern] = useState('');
  const [podPattern, setPodPattern] = useState('');

  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  // ns 가 이미 선택돼 있으면 클러스터 전체 스캔은 불필요 — pod 쿼리에서만 onlyIssues 적용.
  const effectiveOnlyIssues = onlyIssues && !namespace;
  const nsQ = useAnalyzeNamespaces(
    clusterId, effectiveOnlyIssues, false, nsPattern, podPattern,
  );
  const podsQ = useAnalyzePods(clusterId, namespace, onlyIssues);

  // 클러스터 변경 시 ns/pod 초기화
  useEffect(() => { setNamespace(''); setPodName(''); }, [clusterId]);
  // namespace 변경 시 pod 초기화
  useEffect(() => { setPodName(''); }, [namespace]);

  // 첫 namespace 자동 선택 (이슈 있는 ns 우선)
  useEffect(() => {
    if (!nsQ.data) return;
    if (namespace) return;
    const first = nsQ.data.namespaces[0];
    if (first) setNamespace(first.name);
  }, [nsQ.data, namespace]);

  // 첫 pod 자동 선택 (이슈 있는 pod 우선)
  useEffect(() => {
    if (!podsQ.data) return;
    if (podName) return;
    const first = podsQ.data.pods[0];
    if (first) setPodName(first.name);
  }, [podsQ.data, podName]);

  const selectedPod = useMemo(
    () => podsQ.data?.pods.find((p) => p.name === podName),
    [podsQ.data, podName],
  );

  // ── 페이로드 (자동 채워졌거나 사용자가 붙여넣은 텍스트) ──
  const [currentLogs, setLogs] = useState('');
  const [previousLogs, setPreviousLogs] = useState('');
  const [describeOut, setDescribe] = useState('');
  const [rawEvents, setRawEvents] = useState('');
  const [structuredEvents, setStructuredEvents] = useState<KubeEvent[]>([]);
  const [autofilledFor, setAutofilledFor] = useState<string>('');

  const ic = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const lc = 'block text-sm font-medium text-muted-foreground mb-1';

  const parseEventsFromText = (): KubeEvent[] => {
    if (!rawEvents.trim()) return [];
    return rawEvents
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s{2,}|\t/);
        return {
          type:      parts[0]?.trim() ?? 'Normal',
          reason:    parts[1]?.trim() ?? 'Unknown',
          count:     parseInt(parts[2] ?? '1', 10) || 1,
          message:   parts.slice(3).join(' ').trim() || line,
          firstTime: '',
          lastTime:  '',
        };
      });
  };

  const events = structuredEvents.length > 0 ? structuredEvents : parseEventsFromText();

  const handleAutofill = () => {
    if (!clusterId || !namespace || !podName) return;
    fetchCtx.mutate(
      { clusterId, namespace, podName, tailLines: 200 },
      {
        onSuccess: (data) => {
          setLogs(data.currentLogs ?? '');
          setPreviousLogs(data.previousLogs ?? '');
          setDescribe(data.describeOutput ?? '');
          setStructuredEvents(data.events ?? []);
          setRawEvents(''); // 구조화된 events 가 우선이므로 raw 는 비움
          setAutofilledFor(`${clusterId}/${namespace}/${podName}`);
        },
      },
    );
  };

  const currentSelection = `${clusterId}/${namespace}/${podName}`;
  const autofillStale = autofilledFor && autofilledFor !== currentSelection;

  // ── 실시간 로그 스트리밍 ──
  // 백엔드는 SSE/WebSocket 미지원이라 동일 fetch-context 엔드포인트를 N초마다 폴링.
  // 폴링은 탭이 활성일 때만, 사용자 textarea 편집 직후 짧게 정지(아래 hover/focus).
  const [streaming, setStreaming] = useState(false);
  const [streamIntervalSec, setStreamIntervalSec] = useState(5);
  const [lastStreamAt, setLastStreamAt] = useState<number | null>(null);
  const editingRef = useRef(false);   // textarea focus 시 true → 폴링 일시 정지

  useEffect(() => {
    if (!streaming) return;
    if (!clusterId || !namespace || !podName) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (editingRef.current) return;     // 사용자 입력중이면 갱신 미루기
      fetchCtx.mutate(
        { clusterId, namespace, podName, tailLines: 200 },
        {
          onSuccess: (data) => {
            if (cancelled) return;
            setLogs(data.currentLogs ?? '');
            setPreviousLogs(data.previousLogs ?? '');
            setDescribe(data.describeOutput ?? '');
            setStructuredEvents(data.events ?? []);
            setRawEvents('');
            setAutofilledFor(`${clusterId}/${namespace}/${podName}`);
            setLastStreamAt(Date.now());
          },
          // 실패해도 폴링 자체는 계속 — 일시적 오류에 사용자가 수동 개입할 필요 없도록.
        },
      );
    };
    tick();   // 즉시 한 번
    const id = window.setInterval(tick, Math.max(1, streamIntervalSec) * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
    // fetchCtx 객체 자체는 mutation 이라 dep 에 넣지 않음 — 무한 루프 회피.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, streamIntervalSec, clusterId, namespace, podName]);

  // 선택이 바뀌면 스트리밍 정지 (다른 pod 의 로그가 섞이는 사고 방지)
  useEffect(() => { setStreaming(false); }, [clusterId, namespace, podName]);

  // ── 로그 라인 필터 ──
  // 필터가 있으면 별도 read-only 패널에 매칭 라인만 보여준다 (textarea 편집 가능성 보존).
  const [logFilter, setLogFilter] = useState('');
  const filterLines = (text: string): { lines: string[]; total: number } => {
    if (!text) return { lines: [], total: 0 };
    const all = text.split('\n');
    if (!logFilter.trim()) return { lines: [], total: all.length };
    const q = logFilter.toLowerCase();
    return { lines: all.filter((l) => l.toLowerCase().includes(q)), total: all.length };
  };
  const curFiltered = useMemo(() => filterLines(currentLogs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentLogs, logFilter]);
  const prevFiltered = useMemo(() => filterLines(previousLogs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previousLogs, logFilter]);

  const handleSubmit = () => {
    if (!podName.trim() || !namespace.trim()) return;
    const payload: IncidentAnalysisRequest = {
      podName:       podName.trim(),
      namespace:     namespace.trim(),
      timestamp:     new Date().toISOString(),
      events,
      currentLogs,
      previousLogs:  previousLogs || undefined,
      describeOutput: describeOut,
    };
    analyze(payload);
  };

  const canAutofill = !!clusterId && !!namespace && !!podName;

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1500px] mx-auto px-6 py-8">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Zap className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">K8s 로그 — AI 분석</h1>
            <LogViewTabs current="analysis" />
          </div>
          {health && (
            <div className="flex items-center gap-2 text-sm">
              {health.available
                ? <CheckCircle className="w-4 h-4 text-emerald-400" />
                : <AlertTriangle className="w-4 h-4 text-amber-400" />}
              <span className="text-muted-foreground">
                {BACKEND_LABEL[health.backend] ?? health.backend}
                {health.available ? ' 연결됨' : ' 오프라인'}
              </span>
            </div>
          )}
        </div>

        {/* ── 드릴다운 선택 (Cluster → Namespace → Pod) ── */}
        <div className="bg-card border border-border rounded-xl p-5 mb-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              대상 선택
            </p>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
              title="OFF: namespace 이름만 빠르게 조회 (큰 클러스터 권장). ON: 클러스터 전체 pod 를 스캔해 비정상 ns/pod 만 추림 (느림 — 큰 클러스터에서 1분 이상 소요 가능). ns 가 이미 선택돼 있으면 그 ns 만 스캔.">
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(e) => setOnlyIssues(e.target.checked)}
                className="w-3.5 h-3.5 accent-primary"
              />
              이슈 있는 항목만 보기 (느림)
            </label>
          </div>

          {/* 이슈만 + ns 미선택일 때 — glob 패턴으로 스캔 범위 좁히기 */}
          {onlyIssues && !namespace && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <label htmlFor={f('nsPattern')} className={lc}>
                    Namespace 패턴 (선택)
                  </label>
                  <input
                    id={f('nsPattern')}
                    value={nsPattern}
                    onChange={(e) => setNsPattern(e.target.value)}
                    placeholder="kube-*,monitoring,argocd"
                    className={`${ic} font-mono text-sm`}
                  />
                </div>
                <div>
                  <label htmlFor={f('podPattern')} className={lc}>
                    Pod 이름 패턴 (선택)
                  </label>
                  <input
                    id={f('podPattern')}
                    value={podPattern}
                    onChange={(e) => setPodPattern(e.target.value)}
                    placeholder="*nginx*,*api*"
                    className={`${ic} font-mono text-sm`}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                💡 콤마 구분, <code>*</code> <code>?</code> 와일드카드. 비워두면 전체 ns 스캔.
                Namespace 를 선택하면 이 입력은 사라지고 그 ns 만 스캔합니다.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Cluster */}
            <div>
              <label htmlFor={f('cluster')} className={lc}>
                <Server className="w-3 h-3 inline mr-1" />
                Kubernetes 클러스터
              </label>
              <select
                id={f('cluster')}
                value={clusterId}
                onChange={(e) => setClusterId(e.target.value)}
                className={ic}
              >
                <option value="">— 클러스터 선택 —</option>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Namespace */}
            <div>
              <label className={lc}>
                <Layers className="w-3 h-3 inline mr-1" />
                Namespace
                {nsQ.isLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                {nsQ.data && (
                  <span className="ml-1 text-xs opacity-60">
                    ({nsQ.data.namespaces.length})
                  </span>
                )}
              </label>
              <SearchableSelect
                value={namespace}
                onChange={setNamespace}
                options={nsQ.data?.namespaces ?? []}
                getKey={(n) => n.name}
                getLabel={(n) =>
                  `${n.hasUnhealthy ? '⚠ ' : ''}${n.name}` +
                  (typeof n.podCount === 'number' ? ` (${n.podCount} pods)` : '')
                }
                placeholder="namespace 검색..."
                disabled={!clusterId || nsQ.isLoading}
                loading={nsQ.isLoading}
                emptyText="namespace 없음"
              />
              {nsQ.isError && (
                <p className="text-xs text-red-400 mt-1">
                  {formatApiError(nsQ.error)}
                </p>
              )}
            </div>

            {/* Pod */}
            <div>
              <label className={lc}>
                <Package className="w-3 h-3 inline mr-1" />
                Pod
                {podsQ.isLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                {podsQ.data && (
                  <span className="ml-1 text-xs opacity-60">
                    ({podsQ.data.pods.length})
                  </span>
                )}
              </label>
              <SearchableSelect
                value={podName}
                onChange={setPodName}
                options={podsQ.data?.pods ?? []}
                getKey={(p) => p.name}
                getLabel={podOptionLabel}
                placeholder="pod 검색..."
                disabled={!namespace || podsQ.isLoading}
                loading={podsQ.isLoading}
                emptyText="pod 없음"
                className="font-mono text-sm"
              />
              {podsQ.isError && (
                <p className="text-xs text-red-400 mt-1">
                  {formatApiError(podsQ.error)}
                </p>
              )}
            </div>
          </div>

          {/* 선택된 Pod 요약 + 자동 채우기 버튼 */}
          {selectedPod && (
            <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-border">
              <div className="text-sm space-y-0.5">
                <p className="font-mono text-foreground">
                  {namespace}/<span className="text-primary">{selectedPod.name}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedPod.phase} · ready {selectedPod.ready} · restart {selectedPod.restartCount}
                  {selectedPod.node && ` · node ${selectedPod.node}`}
                  {selectedPod.issueReason && (
                    <span className="text-amber-500 ml-1">· {selectedPod.issueReason}</span>
                  )}
                </p>
              </div>
              <button
                onClick={handleAutofill}
                disabled={!canAutofill || fetchCtx.isPending}
                title="kubectl logs / events / describe 를 자동으로 가져와 아래 입력란을 채웁니다."
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg disabled:opacity-50"
              >
                {fetchCtx.isPending
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />수집 중...</>
                  : <><Download className="w-3.5 h-3.5" />로그/이벤트/Describe 자동 채우기</>}
              </button>
            </div>
          )}

          {fetchCtx.isError && (
            <p className="text-xs text-red-400">
              자동 수집 실패: {formatApiError(fetchCtx.error)}
            </p>
          )}
          {autofilledFor && !autofillStale && fetchCtx.isSuccess && (
            <p className="text-xs text-emerald-500 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              자동 수집 완료 — events {events.length}건, logs {currentLogs.length} 자.
            </p>
          )}
          {autofillStale && (
            <p className="text-xs text-amber-500 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              선택이 변경되었습니다. 다시 자동 채우기를 누르세요.
            </p>
          )}
        </div>

        {/* ── 입력 (전폭) ── */}
        {/* 전폭으로 펼쳐 textarea 폭이 "대상 선택" 패널과 동일. 결과 패널은 아래로. */}
        <div className="space-y-4">
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              이벤트 ({events.length}건)
            </p>
            {events.length > 0 ? (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="grid grid-cols-[80px_70px_60px_1fr] gap-2 px-3 py-1.5 bg-secondary/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <span>Type</span><span>Reason</span><span className="text-center">Count</span><span>Message</span>
                </div>
                {events.slice(0, 20).map((ev, i) => <EventRow key={i} event={ev} index={i} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                자동 채우기를 누르거나, 아래에 직접 붙여넣으세요.
              </p>
            )}
            <div>
              <label htmlFor={f('rawEvents')} className={lc}>kubectl get events 출력 (선택, 직접 입력 시)</label>
              <textarea
                id={f('rawEvents')}
                value={rawEvents}
                onChange={(e) => { setRawEvents(e.target.value); setStructuredEvents([]); }}
                placeholder={'Warning  BackOff  3  Back-off restarting failed container'}
                rows={3}
                className={`${ic} font-mono text-sm resize-none`}
              />
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">로그 / Describe</p>

              {/* 실시간 스트리밍 + 로그 라인 필터 컨트롤 */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* 라인 필터 */}
                <div className="relative">
                  <Filter className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                  <input
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                    placeholder="로그 라인 필터 (예: ERROR, OOMKilled)"
                    className="pl-7 pr-7 py-1.5 text-xs font-mono bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary w-72"
                  />
                  {logFilter && (
                    <button
                      onClick={() => setLogFilter('')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="필터 지우기"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* 폴링 간격 */}
                <label className="flex items-center gap-1 text-xs text-muted-foreground"
                  title="실시간 로그 갱신 간격 (초)">
                  매
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={streamIntervalSec}
                    onChange={(e) => setStreamIntervalSec(Number(e.target.value) || 5)}
                    className="w-12 px-1 py-0.5 text-xs font-mono bg-background border border-border rounded text-center"
                  />초
                </label>

                {/* 실시간 토글 */}
                {streaming ? (
                  <button
                    onClick={() => setStreaming(false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-md"
                    title="실시간 갱신 중지"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    LIVE 중지
                  </button>
                ) : (
                  <button
                    onClick={() => setStreaming(true)}
                    disabled={!canAutofill}
                    title="N초마다 fetch-context 를 다시 호출해 로그/이벤트/describe 를 갱신"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-md disabled:opacity-50"
                  >
                    <Play className="w-3 h-3" />
                    실시간 시작
                  </button>
                )}
              </div>
            </div>

            {streaming && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
                </span>
                <span>LIVE · 매 {streamIntervalSec}초 갱신</span>
                {lastStreamAt && (
                  <span className="text-muted-foreground/70">
                    마지막 {Math.max(0, Math.round((Date.now() - lastStreamAt) / 1000))}초 전
                  </span>
                )}
                {fetchCtx.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              </div>
            )}

            <div>
              <label className={lc}>
                현재 컨테이너 로그
                {logFilter && (
                  <span className="ml-2 text-primary">
                    필터 일치 {curFiltered.lines.length} / {curFiltered.total}
                  </span>
                )}
              </label>
              <textarea value={currentLogs} onChange={(e) => setLogs(e.target.value)}
                onFocus={() => { editingRef.current = true; }}
                onBlur={() => { editingRef.current = false; }}
                placeholder="자동 채우기를 누르거나 직접 붙여넣으세요..."
                rows={12} className={`${ic} font-mono text-sm resize-y`} />
              {logFilter && curFiltered.lines.length > 0 && (
                <pre className="mt-1 text-xs font-mono bg-muted/30 border border-border rounded-md p-2 max-h-64 overflow-auto whitespace-pre-wrap">
                  {curFiltered.lines.join('\n')}
                </pre>
              )}
            </div>
            <div>
              <label className={lc}>
                이전 컨테이너 로그 (재시작 직전)
                {logFilter && previousLogs && (
                  <span className="ml-2 text-primary">
                    필터 일치 {prevFiltered.lines.length} / {prevFiltered.total}
                  </span>
                )}
              </label>
              <textarea value={previousLogs} onChange={(e) => setPreviousLogs(e.target.value)}
                onFocus={() => { editingRef.current = true; }}
                onBlur={() => { editingRef.current = false; }}
                placeholder="kubectl logs --previous 출력 (재시작이 있을 때만)"
                rows={8} className={`${ic} font-mono text-sm resize-y`} />
              {logFilter && prevFiltered.lines.length > 0 && (
                <pre className="mt-1 text-xs font-mono bg-muted/30 border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                  {prevFiltered.lines.join('\n')}
                </pre>
              )}
            </div>
            <div>
              <label htmlFor={f('describeOut')} className={lc}>kubectl describe pod 출력</label>
              <textarea id={f('describeOut')} value={describeOut} onChange={(e) => setDescribe(e.target.value)}
                onFocus={() => { editingRef.current = true; }}
                onBlur={() => { editingRef.current = false; }}
                placeholder="kubectl describe pod 출력을 붙여넣으세요..."
                rows={10} className={`${ic} font-mono text-sm resize-y`} />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={analyzing || !podName.trim() || !namespace.trim()}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {analyzing
              ? <><Loader2 className="w-4 h-4 animate-spin" />분석 중...</>
              : <><Search className="w-4 h-4" />장애 분석 시작</>}
          </button>

          {/* 결과 — 입력 아래로 이동 (입력 영역이 전폭이라 결과는 stack) */}
          <div>
            {response?.result ? (
              <ResultPanel result={response.result} />
            ) : response?.error ? (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-400">
                분석 실패: {response.error}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center min-h-[160px] text-muted-foreground/50 rounded-xl border border-dashed border-border">
                <Zap className="w-10 h-10 mb-2" />
                <p className="text-sm">로그 / 이벤트 / describe 입력 후 분석을 시작하세요</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
