import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle, Info, Loader2, Search, Zap,
  Layers, Package, RefreshCw, Download, Square, Filter, X, Box, ScrollText,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ClusterSidebar, EmptyState, LogViewer, SearchableSelect, LogViewTabs, PageHeader, PageShell, RunLogPanel,
} from '@/components/common';
import { PodLogStream } from '@/components/k8s';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { MacCard } from '@/components/ui/MacCard';
import {
  useAnalyzeIncident, useAnalyzerHealth, useAnalyzePodContainers,
  useAnalyzeNamespaces, useAnalyzePods, useFetchIncidentContext,
} from '@/hooks/useIncidentAnalysis';
import { useClusters } from '@/hooks/useCluster';
import type {
  IncidentAnalysisRequest, IncidentAnalysisResult, KubeEvent, AnalyzePodItem, RagCitation,
} from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

// 심각도 신호는 아이콘 + 라벨 글자색 하나만 — 카드 면·보더·배지는 중립 (§12.12-3, D-119).
const SEVERITY_STYLE: Record<string, { icon: typeof AlertTriangle; text: string; label: string }> = {
  critical: { icon: AlertTriangle, text: 'text-status-critical', label: '위험' },
  warning:  { icon: AlertTriangle, text: 'text-status-warning',  label: '경고' },
  info:     { icon: Info,          text: 'text-status-info',     label: '정보' },
};

/** 분석기 표시명 — `analyzedBy`/`health.backend` 는 접두사로 판정한다(D-115).
 *  `local_llm:<profile>:<model>` 의 model 에는 `qwen2.5-coder:7b` 처럼 콜론이 들어갈 수 있다. */
function analyzerLabel(by: string | null | undefined): string {
  if (!by) return '분석기';
  if (by.startsWith('local_llm')) {
    const [, profile = '', ...rest] = by.split(':');
    const model = rest.join(':');
    const detail = [profile, model].filter(Boolean).join(' · ');
    return detail ? `로컬 LLM (${detail})` : '로컬 LLM';
  }
  if (by.startsWith('claude')) return 'Claude AI';
  if (by.startsWith('rule_based')) return '규칙 기반';
  return by;
}

const CITATION_KIND: Record<string, string> = {
  work_guide:     '업무 가이드',
  work_item:      '업무 항목',
  ops_note:       '운영 노트',
  ontology_event: '온톨로지 이벤트',
};

function isCanceled(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || e?.name === 'AbortError';
}

/** `kubectl get events` 붙여넣기 파서(D-115).
 *  첫 줄이 헤더(TYPE·REASON·MESSAGE 포함 — LAST SEEN/OBJECT/COUNT 등은 있으면 사용)면 헤더의 열 시작 위치로
 *  각 줄을 자른다(kubectl 은 열을 공백으로 정렬해 출력). 헤더가 없으면 예전 순서 TYPE·REASON·COUNT·MESSAGE. */
function parseEventsText(text: string): KubeEvent[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0];
  const upper = header.toUpperCase();
  const isHeader = /\bTYPE\b/.test(upper) && /\bREASON\b/.test(upper) && /\bMESSAGE\b/.test(upper);

  if (isHeader) {
    // 헤더 열 = 공백 1칸까지 포함한 토큰("LAST SEEN"), 열 사이는 2칸 이상.
    const cols: { name: string; start: number }[] = [];
    const re = /\S+(?: \S+)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(upper)) !== null) cols.push({ name: m[0], start: m.index });
    const idx = (name: string) => cols.findIndex((c) => c.name === name);
    const iType = idx('TYPE');
    const iReason = idx('REASON');
    const iCount = idx('COUNT');
    const iMsg = idx('MESSAGE');
    const iLast = idx('LAST SEEN');
    const iFirst = idx('FIRST SEEN');
    return lines.slice(1).map((line) => {
      const cell = (i: number): string => {
        if (i < 0) return '';
        const end = i + 1 < cols.length ? cols[i + 1].start : undefined;
        return line.slice(cols[i].start, end).trim();
      };
      // MESSAGE 가 마지막 열이면 줄 끝까지(-o wide 처럼 뒤에 열이 더 있으면 다음 열 앞까지).
      const message = cell(iMsg);
      return {
        type:      cell(iType) || 'Normal',
        reason:    cell(iReason) || 'Unknown',
        count:     parseInt(cell(iCount) || '1', 10) || 1,
        message:   message || line.trim(),
        firstTime: cell(iFirst),
        lastTime:  cell(iLast),
      };
    });
  }

  return lines.map((line) => {
    const parts = line.split(/\s{2,}|\t/);
    return {
      type:      parts[0]?.trim() || 'Normal',
      reason:    parts[1]?.trim() || 'Unknown',
      count:     parseInt(parts[2] ?? '1', 10) || 1,
      message:   parts.slice(3).join(' ').trim() || line,
      firstTime: '',
      lastTime:  '',
    };
  });
}

const EVENTS_PLACEHOLDER = [
  'LAST SEEN   TYPE      REASON    OBJECT                    MESSAGE',
  '2m          Warning   BackOff   pod/api-7d9f8c6b5-x2kq4   Back-off restarting failed container api in pod api-7d9f8c6b5-x2kq4',
  '5m          Normal    Pulled    pod/api-7d9f8c6b5-x2kq4   Container image "registry/api:1.4.2" already present on machine',
].join('\n');

function ConfidenceBar({ value }: { value: number }) {
  // 서버가 0~1 로 clamp 하지만 구버전·이상값(85 등)에도 폭이 넘치지 않게 한 번 더 막는다(D-115).
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const pct = Math.round(v * 100);
  const color = pct >= 80 ? 'bg-muted-foreground/60' : pct >= 50 ? 'bg-status-warning' : 'bg-status-critical';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-secondary rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-muted-foreground w-8 text-right">{pct}%</span>
    </div>
  );
}

/** 분석 요청 시점의 대상 스냅샷 — 결과가 어느 대상의 것인지 결과 옆에 남긴다(D-110). */
interface AnalysisTarget {
  clusterName: string;
  namespace: string;
  podName: string;
  /** 비면 서버가 고른 컨테이너(자동 채우기 응답에 이름이 없을 때). */
  container: string;
  submittedAt: string;
}

function CitationList({ citations }: { citations: RagCitation[] }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground mb-1.5">근거</p>
      <ol className="space-y-1.5">
        {citations.map((c, i) => (
          <li key={`${c.sourceType}-${c.refId}-${i}`} className="text-sm flex items-start gap-2">
            <span className="text-xs text-muted-foreground tabular-nums pt-0.5">[{i + 1}]</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {c.route ? (
                  <Link to={c.route} className="text-foreground underline underline-offset-2 hover:text-primary">
                    {c.title || c.refId}
                  </Link>
                ) : (
                  <span className="text-foreground">{c.title || c.refId}</span>
                )}
                <span className="text-xs text-muted-foreground">{CITATION_KIND[c.sourceType] ?? c.sourceType}</span>
              </div>
              {c.snippet && <p className="text-xs text-muted-foreground line-clamp-2">{c.snippet}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ResultPanel({ result, target }: { result: IncidentAnalysisResult; target: AnalysisTarget }) {
  const degraded = !!result.degraded;
  const known = SEVERITY_STYLE[result.severity];
  const st = known ?? SEVERITY_STYLE.info;
  const SeverityIcon = st.icon;
  // 대체 결과는 성공 결과처럼 보이면 안 된다 — 심각도 색 강조 없이 중립색.
  const sevText = degraded ? 'text-muted-foreground' : st.text;
  const analyzedAt = parseUTC(result.analyzedAt);
  const when = Number.isNaN(analyzedAt.getTime()) ? new Date(target.submittedAt) : analyzedAt;

  return (
    <MacCard
      title="분석 결과"
      titleExtra={
        <span className="inline-flex items-center gap-1.5">
          <SeverityIcon className={`w-4 h-4 flex-shrink-0 ${sevText}`} />
          <span className={`text-sm font-semibold ${sevText}`}>{known ? st.label : result.severity}</span>
        </span>
      }
      actions={
        <span className="text-xs px-2 py-0.5 rounded-full border bg-secondary border-border text-muted-foreground">
          {analyzerLabel(result.analyzedBy)}
        </span>
      }
      bodyPadding="p-5"
      className="space-y-4"
    >
      <p className="text-xs text-muted-foreground font-mono break-all">
        {target.clusterName} · {target.namespace}/{target.podName}
        {' · '}컨테이너 {target.container || '서버 추천'}
        <span className="font-sans"> · 분석 시각 {when.toLocaleString('ko-KR')}</span>
      </p>

      {degraded && (
        <div className="flex items-start gap-2 rounded-md bg-status-warning/10 px-4 py-3 text-sm text-status-warning">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            분석기 응답을 해석하지 못해 대체 결과를 표시합니다 — {result.degradedReason || '사유 미상'}
          </span>
        </div>
      )}

      <div className="rounded-md bg-secondary/40 px-4 py-3">
        <p className="text-xs font-semibold text-muted-foreground mb-1">근본 원인</p>
        <p className="text-sm text-foreground">{result.rootCause}</p>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground mb-1.5">신뢰도</p>
        <ConfidenceBar value={result.confidence} />
      </div>

      {result.suggestedActions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground mb-2">조치 방안</p>
          <ol className="space-y-1.5">
            {result.suggestedActions.map((action, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-semibold bg-secondary border-border text-muted-foreground border">
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
          <p className="text-xs font-semibold text-muted-foreground mb-1.5">관련 런북</p>
          <div className="flex flex-wrap gap-1.5">
            {result.relatedRunbooks.map((rb) => (
              <span key={rb} className="text-xs px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground">
                {rb}
              </span>
            ))}
          </div>
        </div>
      )}

      {result.citations && result.citations.length > 0 && <CitationList citations={result.citations} />}
    </MacCard>
  );
}

function EventRow({ event, index }: { event: KubeEvent; index: number }) {
  return (
    <div className={`grid grid-cols-[80px_140px_50px_1fr] gap-2 py-1.5 px-3 text-sm ${index % 2 === 1 ? 'bg-background/50' : ''}`}>
      <span className={`font-medium truncate ${event.type === 'Warning' ? 'text-status-warning' : 'text-muted-foreground'}`}>{event.type ?? 'Normal'}</span>
      <span className="font-mono text-muted-foreground truncate" title={event.reason}>{event.reason}</span>
      <span className="text-muted-foreground text-center">x{event.count}</span>
      <span className="text-foreground truncate" title={event.message}>{event.message}</span>
    </div>
  );
}

function podOptionLabel(pod: AnalyzePodItem): string {
  const restart = pod.restartCount > 0 ? ` ↻${pod.restartCount}` : '';
  const node = pod.node ? ` @ ${pod.node}` : '';
  const issue = pod.issueReason ? ` — ${pod.issueReason}` : '';
  return `${pod.hasIssue ? '[이상] ' : ''}${pod.name}  [${pod.ready} ${pod.phase}${restart}]${node}${issue}`;
}

export function IncidentAnalysisPage() {
  const { data: health } = useAnalyzerHealth();
  const analyzeMut = useAnalyzeIncident();
  const { reset: resetAnalyze } = analyzeMut;
  const analyzing = analyzeMut.isPending;
  const fetchCtx = useFetchIncidentContext();
  const { reset: resetFetchCtx } = fetchCtx;
  // 실행 로그(D-089/D-135) — 자동 채우기(수집)와 장애 분석 각각. 펼침 여부는 사용자가 정한다.
  const autofillLog = useRunLog();
  const [showAutofillLog, setShowAutofillLog] = useLogPref('incident-analysis-autofill');
  const analyzeLog = useRunLog();
  const { log: logAnalyze } = analyzeLog;
  const [showAnalyzeLog, setShowAnalyzeLog] = useLogPref('incident-analysis-run');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // ── 클러스터 / namespace / pod 선택 상태 ──
  // 클러스터는 경로(`/incident-analysis/:clusterId`), namespace·pod 는 쿼리(`?namespace=&pod=`) — 딥링크 가능.
  const { data: clusters = [] } = useClusters();
  const { clusterId, selectCluster } = useClusterRouteParam('/incident-analysis', clusters);
  const [searchParams, setSearchParams] = useSearchParams();
  const [namespace, setNamespace] = useState(() => searchParams.get('namespace') ?? '');
  const [podName, setPodName] = useState(() => searchParams.get('pod') ?? '');
  // 비우면 "서버 추천"(default-container 어노테이션 → 실패·재시작 컨테이너 → 첫 컨테이너).
  const [container, setContainer] = useState('');
  // 거대 클러스터(수천 namespace) 에서도 첫 응답이 즉시 오도록 기본은 false (빠른 경로).
  // 백엔드의 list_namespaces 가 with_counts/only_with_issues 둘 다 false 면 pod 조회를 생략한다.
  // 사용자가 토글 켜면 느린 경로 (전체 pod fetch) 가 발동되며 axios 타임아웃도 2분 30초로 확장됨.
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [nsPattern, setNsPattern] = useState('');
  const [podPattern, setPodPattern] = useState('');

  // ns 가 이미 선택돼 있으면 클러스터 전체 스캔은 불필요 — pod 쿼리에서만 onlyIssues 적용.
  const effectiveOnlyIssues = onlyIssues && !namespace;
  const nsQ = useAnalyzeNamespaces(
    clusterId, effectiveOnlyIssues, false, nsPattern, podPattern,
  );
  const podsQ = useAnalyzePods(clusterId, namespace, onlyIssues);
  const containersQ = useAnalyzePodContainers(clusterId, namespace, podName);

  // 클러스터 변경 시 ns/pod 초기화 — 이전 값과 비교해 실제로 바뀐 경우만.
  // ''→첫 클러스터(최초 해석)는 변경으로 보지 않아 쿼리로 들어온 ns/pod 를 지우지 않는다.
  const prevClusterRef = useRef(clusterId);
  const clusterResetRef = useRef(false);
  useEffect(() => {
    const prev = prevClusterRef.current;
    prevClusterRef.current = clusterId;
    if (prev && prev !== clusterId) {
      clusterResetRef.current = true;
      setNamespace('');
      setPodName('');
    }
  }, [clusterId]);
  // namespace 변경 시 pod 초기화 (마운트 시 쿼리로 들어온 pod 는 유지)
  const prevNsRef = useRef(namespace);
  useEffect(() => {
    if (prevNsRef.current === namespace) return;
    prevNsRef.current = namespace;
    setPodName('');
  }, [namespace]);

  // ns/pod → URL 쿼리 동기화 (replace — 선택마다 히스토리를 쌓지 않음).
  // 클러스터 해석 전에는 쓰지 않는다(경로 이동이 쿼리를 덮어씀). 클러스터 전환 직후 커밋은
  // 아직 이전 ns/pod 를 들고 있으므로 건너뛰고, 초기화된 값으로 다음 커밋에서 쓴다.
  useEffect(() => {
    if (!clusterId) return;
    if (clusterResetRef.current) { clusterResetRef.current = false; return; }
    const curNs = searchParams.get('namespace') ?? '';
    const curPod = searchParams.get('pod') ?? '';
    if (curNs === namespace && curPod === podName) return;
    const next = new URLSearchParams(searchParams);
    if (namespace) next.set('namespace', namespace); else next.delete('namespace');
    if (podName) next.set('pod', podName); else next.delete('pod');
    setSearchParams(next, { replace: true });
  }, [clusterId, namespace, podName, searchParams, setSearchParams]);

  // 첫 namespace 자동 선택 (이슈 있는 ns 우선). "이슈 있는 항목만" 이 켜져 있으면 고르지 않는다 —
  // ns 를 채우는 순간 effectiveOnlyIssues 가 풀려 스캔 결과(이상 ns 목록)가 사라지기 때문(D-112).
  useEffect(() => {
    if (onlyIssues) return;
    if (!nsQ.data) return;
    if (namespace) return;
    const first = nsQ.data.namespaces[0];
    if (first) setNamespace(first.name);
  }, [nsQ.data, namespace, onlyIssues]);

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
  /** 자동 채우기를 한 대상 키 — 비어 있으면 자동 채우기를 안 했다(직접 붙여넣기만 한 경우 포함). */
  const [autofilledFor, setAutofilledFor] = useState('');
  /** 자동 채우기 응답이 알려준(서버가 고른) 컨테이너. */
  const [autofilledContainer, setAutofilledContainer] = useState('');
  const [staleAck, setStaleAck] = useState(false);
  const [analysis, setAnalysis] = useState<{ result: IncidentAnalysisResult; target: AnalysisTarget } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── 대상 키 변경 → 이전 대상의 입력·결과 비우기 (D-110) ──
  // 이전 키가 완전한 대상(pod 까지 선택)이었을 때만 비운다. 최초 해석(''→클러스터)·쿼리로 들어온 값·
  // 자동 선택(pod ''→첫 pod)은 비울 이전 대상이 없으므로 그대로 둔다 — 대상 고르기 전에 붙여넣은 텍스트도 보존.
  const targetKey = `${clusterId}/${namespace}/${podName}/${container}`;
  const podKey = `${clusterId}/${namespace}/${podName}`;
  const targetKeyRef = useRef(targetKey);
  const prevTargetRef = useRef({ key: targetKey, podKey, pod: podName });
  useEffect(() => {
    const prev = prevTargetRef.current;
    targetKeyRef.current = targetKey;
    if (prev.key === targetKey) return;
    prevTargetRef.current = { key: targetKey, podKey, pod: podName };
    // pod 가 바뀌면 컨테이너 선택은 "서버 추천" 으로 되돌린다.
    if (prev.podKey !== podKey) setContainer('');
    if (!prev.pod) return;
    if (abortRef.current) {
      logAnalyze('warn', '분석 대상이 바뀌어 진행 중인 분석을 중지합니다');
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLogs('');
    setPreviousLogs('');
    setDescribe('');
    setRawEvents('');
    setStructuredEvents([]);
    setAutofilledFor('');
    setAutofilledContainer('');
    setStaleAck(false);
    setAnalysis(null);
    resetAnalyze();
    resetFetchCtx();
  }, [targetKey, podKey, podName, logAnalyze, resetAnalyze, resetFetchCtx]);

  // 언마운트 시 진행 중 분석 요청 중지
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const ic = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const lc = 'block text-sm font-medium text-muted-foreground mb-1';

  const events = useMemo(
    () => (structuredEvents.length > 0 ? structuredEvents : parseEventsText(rawEvents)),
    [structuredEvents, rawEvents],
  );

  const handleAutofill = async () => {
    if (!clusterId || !namespace || !podName) return;
    const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
    const selKey = targetKey;
    const sel = { clusterId, namespace, podName, container };
    const r = await runLogged(autofillLog, {
      title: '컨텍스트 자동 수집',
      first: `${clusterName} · ${namespace}/${podName} · 컨테이너 ${container || '서버 추천'} — logs(tail 200) · previous logs · events · describe 수집 요청`,
      fn: () => fetchCtx.mutateAsync({ ...sel, tailLines: 200 }),
      summarize: (data): RunLogEntry[] => {
        const lines = (t?: string | null) => (t ? t.split('\n').filter(Boolean).length : 0);
        const evs = data.events ?? [];
        const warnEvents = evs.filter((e) => e.type === 'Warning').length;
        const used = data.container;
        return [
          ['info', `컨테이너 ${used || sel.container || '(응답에 이름 없음 — 서버 추천)'}`],
          ['info', `events ${evs.length}건${warnEvents ? ` (Warning ${warnEvents})` : ''}`],
          ['info', `현재 로그 ${lines(data.currentLogs)}줄 · 이전 컨테이너 로그 ${lines(data.previousLogs)}줄`],
          [data.describeOutput ? 'info' : 'warn', data.describeOutput ? `describe ${lines(data.describeOutput)}줄` : 'describe 출력 없음'],
        ];
      },
    });
    if (!r.ok) return;
    // 수집 중 대상이 바뀌었으면 이전 대상의 결과를 입력에 넣지 않는다.
    if (targetKeyRef.current !== selKey) {
      autofillLog.log('warn', '수집 중 대상이 바뀌어 결과를 입력에 반영하지 않았습니다');
      return;
    }
    const data = r.data;
    const used = data.container;
    setLogs(data.currentLogs ?? '');
    setPreviousLogs(data.previousLogs ?? '');
    setDescribe(data.describeOutput ?? '');
    setStructuredEvents(data.events ?? []);
    setRawEvents(''); // 구조화된 events 가 우선이므로 raw 는 비움
    setAutofilledFor(selKey);
    setAutofilledContainer(used || sel.container);
    setStaleAck(false);
  };

  // 자동 채우기를 한 적이 있고(autofilledFor) 그 대상이 지금 대상과 다를 때만 stale.
  // 직접 붙여넣기만 한 경우 autofilledFor 가 비어 있어 stale 이 아니다.
  const autofillStale = !!autofilledFor && autofilledFor !== targetKey;
  const blockedByStale = autofillStale && !staleAck;

  // ── 로그 라인 필터 ──
  // 필터가 있으면 별도 read-only 패널(LogViewer)에 매칭 라인만 보여준다 (textarea 편집 가능성 보존).
  const [logFilter, setLogFilter] = useState('');
  const countMatches = useCallback((text: string): { matched: number; total: number } => {
    if (!text) return { matched: 0, total: 0 };
    const all = text.split('\n');
    const q = logFilter.trim().toLowerCase();
    if (!q) return { matched: 0, total: all.length };
    return { matched: all.filter((l) => l.toLowerCase().includes(q)).length, total: all.length };
  }, [logFilter]);
  const curFiltered = useMemo(() => countMatches(currentLogs), [countMatches, currentLogs]);
  const prevFiltered = useMemo(() => countMatches(previousLogs), [countMatches, previousLogs]);

  const handleSubmit = async () => {
    if (!podName.trim() || !namespace.trim() || blockedByStale) return;
    const payload: IncidentAnalysisRequest = {
      clusterId:     clusterId || undefined,
      podName:       podName.trim(),
      namespace:     namespace.trim(),
      timestamp:     new Date().toISOString(),
      events,
      currentLogs,
      previousLogs:  previousLogs || undefined,
      describeOutput: describeOut,
    };
    const target: AnalysisTarget = {
      clusterName: clusters.find((c) => c.id === clusterId)?.name ?? (clusterId || '클러스터 미지정'),
      namespace:   payload.namespace,
      podName:     payload.podName,
      container:   autofilledFor === targetKey ? autofilledContainer : container,
      submittedAt: payload.timestamp,
    };
    const submitKey = targetKey;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    setAnalysis(null);
    const backend = health ? analyzerLabel(health.backend) : '분석기';
    const logLines = currentLogs ? currentLogs.split('\n').length : 0;
    // 동기 LLM 호출 — 수십 초 걸릴 수 있어 대기 중 경과를 남기고, 전송 오류·사용자 중지도 로그에 남긴다.
    const r = await runLogged(analyzeLog, {
      title: '장애 분석',
      first: `${target.clusterName} · ${payload.namespace}/${payload.podName} — ${backend}${health && !health.available ? '(오프라인)' : ''} 에 분석 요청 · events ${events.length}건 · 로그 ${logLines}줄${previousLogs ? ' · 이전 로그 포함' : ''}${describeOut ? ' · describe 포함' : ''}`,
      fn: () => analyzeMut.mutateAsync({ context: payload, signal: ac.signal }),
      summarize: (res): RunLogEntry[] => {
        const a = res.result;
        if (!a) return [['warn', '응답에 분석 결과가 없습니다']];
        const pct = Math.round(Math.min(1, Math.max(0, a.confidence || 0)) * 100);
        const head: RunLogEntry = a.degraded
          ? ['warn', `대체 결과 — ${a.degradedReason || '분석기 응답 해석 실패'} · 분석기 ${analyzerLabel(a.analyzedBy)}`]
          : [a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warn' : 'info',
            `심각도 ${a.severity} · 신뢰도 ${pct}% · 분석기 ${analyzerLabel(a.analyzedBy)}`];
        return [
          head,
          ['info', `조치 제안 ${a.suggestedActions.length}건 · 관련 런북 ${a.relatedRunbooks.length}건 · 근거 ${a.citations?.length ?? 0}건`],
        ];
      },
    });
    if (abortRef.current === ac) abortRef.current = null;
    if (r.ok && r.data.result && targetKeyRef.current === submitKey) {
      setAnalysis({ result: r.data.result, target });
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const canAutofill = !!clusterId && !!namespace && !!podName;
  const containers = containersQ.data?.containers ?? [];
  const normalContainers = containers.filter((c) => !c.init);
  const initContainers = containers.filter((c) => c.init);

  const submitDisabledReason = !podName.trim() || !namespace.trim()
    ? 'namespace 와 pod 를 선택하세요'
    : blockedByStale
      ? '입력 내용이 다른 대상의 것입니다 — 자동 채우기를 다시 하거나, 직접 붙여넣은 내용이면 아래에서 확인하세요'
      : undefined;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* 헤더 */}
          <PageHeader
            icon={Zap}
            title="K8s 로그 — AI 분석"
            titleExtra={<LogViewTabs current="analysis" />}
            actions={health && (
              <div className="flex items-center gap-2 text-sm">
                {health.available
                  ? <CheckCircle className="w-4 h-4 text-muted-foreground" />
                  : <AlertTriangle className="w-4 h-4 text-status-warning" />}
                <span className="text-muted-foreground">
                  {analyzerLabel(health.backend)}
                  {health.available ? ' 연결됨' : ' 오프라인'}
                </span>
              </div>
            )}
          />

          {/* ── 드릴다운 선택 (Namespace → Pod → 컨테이너, 클러스터는 좌측 레일) ── */}
          <MacCard
            title="대상 선택"
            bodyPadding="p-5"
            className="space-y-4"
            actions={
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                title="OFF: namespace 이름만 빠르게 조회 (큰 클러스터 권장). ON: 클러스터 전체 pod 를 스캔해 비정상 ns/pod 만 추림 (느림 — 큰 클러스터에서 1분 이상 소요 가능). 켜 두면 namespace 를 자동으로 고르지 않습니다. ns 가 이미 선택돼 있으면 그 ns 만 스캔.">
                <input
                  type="checkbox"
                  checked={onlyIssues}
                  onChange={(e) => setOnlyIssues(e.target.checked)}
                  className="w-3.5 h-3.5 accent-primary"
                />
                이슈 있는 항목만 보기 (느림)
              </label>
            }
          >

            {/* 이슈만 + ns 미선택일 때 — glob 패턴으로 스캔 범위 좁히기 */}
            {onlyIssues && !namespace && (
              <div className="rounded-md bg-secondary/40 p-3 space-y-2">
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
                      파드 이름 패턴 (선택)
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
                  콤마 구분, <code>*</code> <code>?</code> 와일드카드. 비워두면 전체 ns 스캔.
                  Namespace 를 선택하면 이 입력은 사라지고 그 ns 만 스캔합니다.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Namespace */}
              <div>
                <label htmlFor={f('namespace')} className={lc}>
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
                  id={f('namespace')}
                  value={namespace}
                  onChange={setNamespace}
                  options={nsQ.data?.namespaces ?? []}
                  getKey={(n) => n.name}
                  getLabel={(n) =>
                    `${n.hasUnhealthy ? '[이상] ' : ''}${n.name}` +
                    (typeof n.podCount === 'number' ? ` (${n.podCount} pods)` : '')
                  }
                  placeholder="namespace 검색..."
                  disabled={!clusterId || nsQ.isLoading}
                  loading={nsQ.isLoading}
                  emptyText="namespace 없음"
                />
                {nsQ.isError && (
                  <p className="text-xs text-status-critical mt-1">
                    {formatApiError(nsQ.error)}
                  </p>
                )}
              </div>

              {/* Pod */}
              <div>
                <label htmlFor={f('pod')} className={lc}>
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
                  id={f('pod')}
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
                  <p className="text-xs text-status-critical mt-1">
                    {formatApiError(podsQ.error)}
                  </p>
                )}
              </div>

              {/* 컨테이너 — 비우면 서버 추천 */}
              <div>
                <label htmlFor={f('container')} className={lc}>
                  <Box className="w-3 h-3 inline mr-1" />
                  컨테이너
                  {containersQ.isLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                </label>
                <select
                  id={f('container')}
                  value={container}
                  onChange={(e) => setContainer(e.target.value)}
                  disabled={!podName}
                  title={!podName ? 'pod 를 먼저 선택하세요' : '비우면 서버가 고릅니다(default-container 어노테이션 → 실패·재시작 컨테이너 → 첫 컨테이너)'}
                  className={`${ic} disabled:opacity-50`}
                >
                  <option value="">
                    서버 추천{containersQ.data?.defaultContainer ? ` (기본 ${containersQ.data.defaultContainer})` : ''}
                  </option>
                  {normalContainers.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}{c.restartCount > 0 ? ` (재시작 ${c.restartCount})` : ''}{c.state && c.state !== 'running' ? ` · ${c.state}` : ''}
                    </option>
                  ))}
                  {initContainers.length > 0 && (
                    <optgroup label="init 컨테이너">
                      {initContainers.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name} (init){c.restartCount > 0 ? ` · 재시작 ${c.restartCount}` : ''}{c.state ? ` · ${c.state}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {containersQ.isError && (
                  <p className="text-xs text-status-critical mt-1">
                    컨테이너 목록 조회 실패: {formatApiError(containersQ.error)}
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
                      <span className="text-status-warning ml-1">· {selectedPod.issueReason}</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAutofill}
                  disabled={!canAutofill || fetchCtx.isPending}
                  title="kubectl logs / events / describe 를 자동으로 가져와 아래 입력란을 채웁니다."
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-xl disabled:opacity-50"
                >
                  {fetchCtx.isPending
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />수집 중…</>
                    : <><Download className="w-3.5 h-3.5" />로그/이벤트/Describe 자동 채우기</>}
                </button>
              </div>
            )}

            {(autofillLog.running || autofillLog.lines.length > 0) && (
              <RunLogPanel run={autofillLog} show={showAutofillLog} onShowChange={setShowAutofillLog} maxHeight="max-h-48" />
            )}

            {fetchCtx.isError && (
              <p className="text-xs text-status-critical">
                자동 수집 실패: {formatApiError(fetchCtx.error)}
              </p>
            )}
            {autofilledFor && !autofillStale && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                자동 수집 완료 — 컨테이너 {autofilledContainer || '서버 추천'}, events {events.length}건, logs {currentLogs.length} 자.
              </p>
            )}
          </MacCard>

          {/* ── 실시간 로그 (SSE) — 보기 전용. 분석 입력은 자동 채우기·붙여넣기로만 채운다(D-112) ── */}
          <MacCard
            title="실시간 로그"
            description="보기 전용 — 분석 입력에는 들어가지 않습니다"
            bodyPadding="p-5"
          >
            {canAutofill ? (
              <PodLogStream
                key={targetKey}
                clusterId={clusterId}
                namespace={namespace}
                pod={podName}
                initialContainer={container || undefined}
                heightClass="h-80"
              />
            ) : (
              <EmptyState
                compact
                icon={ScrollText}
                title="스트림할 파드를 고르세요"
                description="namespace 와 pod 를 선택하면 로그를 실시간으로 받아 볼 수 있습니다."
              />
            )}
          </MacCard>

          {/* ── 입력 (전폭) ── */}
          {/* 전폭으로 펼쳐 textarea 폭이 "대상 선택" 패널과 동일. 결과 패널은 아래로. */}
          <div className="space-y-4">
            <MacCard
              title="이벤트"
              titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{events.length}건</span>}
              bodyPadding="p-5"
              className="space-y-4"
            >
              {events.length > 0 ? (
                <div className="rounded-md bg-secondary/40 overflow-hidden">
                  <div className="grid grid-cols-[80px_140px_50px_1fr] gap-2 px-3 py-1.5 border-b border-border text-xs font-semibold text-muted-foreground">
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
                <label htmlFor={f('rawEvents')} className={lc}>
                  kubectl get events 출력 (선택, 직접 입력 시 — 헤더 줄 포함 권장)
                </label>
                <textarea
                  id={f('rawEvents')}
                  value={rawEvents}
                  onChange={(e) => { setRawEvents(e.target.value); setStructuredEvents([]); }}
                  placeholder={EVENTS_PLACEHOLDER}
                  rows={4}
                  className={`${ic} font-mono text-sm resize-y`}
                />
              </div>
            </MacCard>

            <MacCard
              title="로그 / Describe"
              bodyPadding="p-5"
              className="space-y-4"
              actions={
                /* 로그 라인 필터 */
                <div className="relative">
                  <Filter className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                  <input
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                    placeholder="로그 라인 필터 (예: ERROR, OOMKilled)"
                    aria-label="로그 라인 필터"
                    className="pl-7 pr-7 py-1.5 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary w-72"
                  />
                  {logFilter && (
                    <button
                      type="button"
                      onClick={() => setLogFilter('')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded-xl text-muted-foreground hover:text-foreground"
                      title="필터 지우기"
                      aria-label="필터 지우기"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              }
            >
              <div>
                <label htmlFor={f('currentLogs')} className={lc}>
                  현재 컨테이너 로그
                  {logFilter && (
                    <span className="ml-2 text-primary">
                      필터 일치 {curFiltered.matched} / {curFiltered.total}
                    </span>
                  )}
                </label>
                <textarea
                  id={f('currentLogs')}
                  value={currentLogs}
                  onChange={(e) => setLogs(e.target.value)}
                  placeholder="자동 채우기를 누르거나 직접 붙여넣으세요..."
                  rows={12}
                  className={`${ic} font-mono text-sm resize-y`}
                />
                {logFilter && curFiltered.matched > 0 && (
                  <LogViewer text={currentLogs} filterOverride={logFilter} maxHeight="max-h-64" className="mt-1" />
                )}
              </div>
              <div>
                <label htmlFor={f('previousLogs')} className={lc}>
                  이전 컨테이너 로그 (재시작 직전)
                  {logFilter && previousLogs && (
                    <span className="ml-2 text-primary">
                      필터 일치 {prevFiltered.matched} / {prevFiltered.total}
                    </span>
                  )}
                </label>
                <textarea
                  id={f('previousLogs')}
                  value={previousLogs}
                  onChange={(e) => setPreviousLogs(e.target.value)}
                  placeholder="kubectl logs --previous 출력 (재시작이 있을 때만)"
                  rows={8}
                  className={`${ic} font-mono text-sm resize-y`}
                />
                {logFilter && prevFiltered.matched > 0 && (
                  <LogViewer text={previousLogs} filterOverride={logFilter} maxHeight="max-h-48" className="mt-1" />
                )}
              </div>
              <div>
                <label htmlFor={f('describeOut')} className={lc}>kubectl describe pod 출력</label>
                <textarea
                  id={f('describeOut')}
                  value={describeOut}
                  onChange={(e) => setDescribe(e.target.value)}
                  placeholder="kubectl describe pod 출력을 붙여넣으세요..."
                  rows={10}
                  className={`${ic} font-mono text-sm resize-y`}
                />
              </div>
            </MacCard>

            {/* 다른 대상의 입력이면 제출 차단 + 사유 (D-110) */}
            {autofillStale && (
              <div className="space-y-1.5 text-xs">
                <p className="text-status-warning flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" />
                  입력 내용이 다른 대상의 것입니다 — 자동 채우기를 다시 누르세요.
                </p>
                <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={staleAck}
                    onChange={(e) => setStaleAck(e.target.checked)}
                    className="w-3.5 h-3.5 accent-primary"
                  />
                  직접 붙여넣은 내용이며 현재 대상({namespace}/{podName})의 것임을 확인했습니다
                </label>
              </div>
            )}

            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={analyzing || !!submitDisabledReason}
                title={submitDisabledReason}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl text-sm font-semibold transition-colors disabled:opacity-60"
              >
                {analyzing
                  ? <><Loader2 className="w-4 h-4 animate-spin" />분석 중…</>
                  : <><Search className="w-4 h-4" />장애 분석 시작</>}
              </button>
              {analyzing && (
                <button
                  type="button"
                  onClick={handleStop}
                  title="분석 요청 중지"
                  aria-label="분석 요청 중지"
                  className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-border bg-secondary text-foreground text-sm font-medium hover:bg-muted"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  중지
                </button>
              )}
            </div>
            {!analyzing && submitDisabledReason && (
              <p className="text-xs text-muted-foreground">{submitDisabledReason}</p>
            )}

            <RunLogPanel run={analyzeLog} show={showAnalyzeLog} onShowChange={setShowAnalyzeLog} maxHeight="max-h-48" />

            {/* 결과 — 진행 중·실패·중지·결과를 모두 여기서 알린다(초기 안내로 되돌아가지 않음, D-109) */}
            <div role="status" aria-live="polite">
              {analysis ? (
                <ResultPanel result={analysis.result} target={analysis.target} />
              ) : (
                <MacCard title="분석 결과" bodyPadding="p-5">
                  {analyzing ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      분석기 응답을 기다리는 중입니다(최대 2분 30초). 중지하려면 "중지"를 누르세요.
                    </p>
                  ) : analyzeMut.isError ? (
                    isCanceled(analyzeMut.error) ? (
                      <p className="text-sm text-muted-foreground">분석을 중지했습니다. 다시 시작하려면 "장애 분석 시작"을 누르세요.</p>
                    ) : (
                      <div className="flex items-start gap-2 rounded-md bg-status-critical/10 px-4 py-3 text-sm text-status-critical">
                        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span>분석 실패 — {formatApiError(analyzeMut.error)}</span>
                      </div>
                    )
                  ) : analyzeMut.isSuccess ? (
                    <p className="text-sm text-status-warning">응답에 분석 결과가 없습니다. 다시 시도하세요.</p>
                  ) : (
                    <EmptyState
                      compact
                      icon={Zap}
                      title="분석 전"
                      description="로그 / 이벤트 / describe 입력 후 분석을 시작하세요"
                    />
                  )}
                </MacCard>
              )}
            </div>
          </div>
        </div>
      </PageShell>
    </div>
  );
}
