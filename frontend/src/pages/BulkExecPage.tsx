import { useEffect, useId, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Terminal, RefreshCw, Play, Square, CheckCircle, XCircle, Key, Upload, ChevronDown, ChevronRight,
  Wifi, FileText, ShieldAlert, Zap, Clock, Download, LayoutList, Rows, Server, FolderInput, Loader2,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { ConfirmDialog, ExecOutputTabs, ClusterSidebar, DebugLogPanel, Skeleton, EmptyState, ResizeGrip, DoubleScrollX} from '@/components/common';
import { SavedScriptPanel } from '@/components/bulk-exec';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { bulkExecApi, type NodeSummary, type BulkExecResponse, type BulkExecResultItem } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type { ScriptLanguage } from '@/types';

// ── 상태 색상 ───────────────────────────────────────────────────────────────

const STATUS_META: Record<BulkExecResultItem['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',  icon: CheckCircle },
  error:         { label: '에러',     cls: 'bg-red-500/10 text-red-400 border-red-500/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',       icon: Wifi },
};

// ── Node row ────────────────────────────────────────────────────────────────

/** 필터가 있으면 필터에 매칭되는 라인만 join (대소문자 무시). 빈 필터면 원본 그대로.
 *  요약 테이블 / CSV 내보내기에서 공통으로 쓰는 유틸. */
function filteredText(text: string, filter: string): string {
  if (!filter.trim()) return text;
  const q = filter.toLowerCase();
  return text
    .split('\n')
    .filter((l) => l.toLowerCase().includes(q))
    .join('\n');
}

/** CSV 셀 이스케이프 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 결과 → CSV 변환.
 *  열: host, status, exit_code, duration_ms, error, stdout_lines, stderr_lines,
 *       stdout (필터 적용 시 매칭 라인만), stderr.
 */
function resultsToCsv(
  results: BulkExecResultItem[],
  filter: string,
  command: string,
): string {
  const cols = [
    'cluster', 'node', 'host', 'status', 'exit_code', 'duration_ms',
    'error', 'stdout_lines', 'stderr_lines', 'stdout', 'stderr',
  ];
  const lines: string[] = [];
  lines.push(`# command: ${command || '-'}`);
  if (filter.trim()) lines.push(`# filter: ${filter}`);
  lines.push(`# exported_at: ${new Date().toISOString()}`);
  lines.push(cols.join(','));
  for (const r of results) {
    const stdout = filteredText(r.stdout, filter);
    const stderr = filteredText(r.stderr, filter);
    lines.push([
      r.clusterName ?? '',
      r.name ?? '',
      r.host,
      r.status,
      r.exitCode ?? '',
      r.durationMs,
      r.error ?? '',
      stdout.split('\n').filter(Boolean).length,
      stderr.split('\n').filter(Boolean).length,
      stdout,
      stderr,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** 결과 → 텍스트 (host 마다 섹션). admin 한눈에 보기 좋음. */
function resultsToTxt(
  results: BulkExecResultItem[],
  filter: string,
  command: string,
): string {
  const lines: string[] = [];
  lines.push(`# command : ${command || '-'}`);
  if (filter.trim()) lines.push(`# filter  : ${filter}`);
  lines.push(`# exported: ${new Date().toISOString()}`);
  lines.push(`# total   : ${results.length} (ok=${results.filter((r) => r.status === 'ok').length})`);
  lines.push('');
  for (const r of results) {
    const label = r.name ? `${r.name}${r.clusterName ? `@${r.clusterName}` : ''} (${r.host})` : r.host;
    lines.push(`========== ${label}  [${r.status}]  exit=${r.exitCode ?? '-'}  ${r.durationMs}ms ==========`);
    if (r.error) lines.push(`!! error: ${r.error}`);
    const stdout = filteredText(r.stdout, filter);
    if (stdout.trim()) {
      lines.push('--- stdout ---');
      lines.push(stdout);
    }
    const stderr = filteredText(r.stderr, filter);
    if (stderr.trim()) {
      lines.push('--- stderr ---');
      lines.push(stderr);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadBlob(text: string, filename: string, mime: string) {
  const blob = new Blob(['﻿', text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyToClipboard(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
}

/** 클러스터 단위로 묶어 노드를 보여주는 collapsible 섹션.
 *  여러 클러스터를 한 화면에서 다룰 때 시각적 구분을 준다. */
function ClusterNodeGroup({
  clusterName, nodes, isLoading, isError, errorMsg, onRefetch,
  selectedCount, isNodeChecked, onToggleNode, onToggleAll,
}: {
  clusterName: string;
  nodes: NodeSummary[];
  isLoading: boolean;
  isError: boolean;
  errorMsg?: string;
  onRefetch: () => void;
  selectedCount: number;
  isNodeChecked: (name: string) => boolean;
  onToggleNode: (name: string) => void;
  onToggleAll: () => void;
}) {
  const [open, setOpen] = useState(true);
  const total = nodes.length;
  const allSelected = total > 0 && selectedCount === total;
  return (
    <div className="border-b border-border last:border-b-0">
      <header className="flex items-center gap-2 px-3 py-2 bg-muted/20 sticky top-0 z-[1]">
        <button
          onClick={() => setOpen((v) => !v)}
          className="p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={open ? '접기' : '펼치기'}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Server className="w-3.5 h-3.5 text-muted-foreground/80 flex-shrink-0" />
        <span className="text-sm font-semibold truncate flex-1">{clusterName}</span>
        <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
          {selectedCount}/{total}
        </span>
        <button
          onClick={onToggleAll}
          disabled={total === 0}
          className="text-xs text-primary hover:text-primary/80 disabled:opacity-40"
        >
          {allSelected ? '해제' : '모두'}
        </button>
      </header>
      {open && (
        <div>
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5">
                  <Skeleton width={14} height={14} />
                  <Skeleton width={140} height={12} />
                  <Skeleton width={90} height={10} />
                </div>
              ))}
            </div>
          ) : isError ? (
            <div className="px-3 py-2">
              <p className="text-xs text-red-400 mb-1">노드 조회 실패: {errorMsg ?? '연결 오류'}</p>
              <button
                onClick={onRefetch}
                className="text-xs text-primary hover:text-primary/80 underline"
              >다시 시도</button>
            </div>
          ) : total === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground/70">노드 없음</p>
          ) : (
            nodes.map((n) => (
              <NodeRow
                key={n.name}
                node={n}
                checked={isNodeChecked(n.name)}
                onToggle={() => onToggleNode(n.name)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({ node, checked, onToggle }: { node: NodeSummary; checked: boolean; onToggle: () => void }) {
  const host = node.internalIp || node.name;
  return (
    <label className={`flex items-center gap-3 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-muted/30 transition-colors ${
      checked ? 'bg-primary/5' : ''
    }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="w-4 h-4 accent-primary flex-shrink-0"
      />
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${node.ready ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="font-mono text-sm text-foreground truncate">{node.name}</span>
        <span className="text-sm font-mono text-muted-foreground">{host}</span>
        {node.roles.map((r) => (
          <span key={r} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{r}</span>
        ))}
      </div>
      {node.kubeletVersion && (
        <span className="text-xs font-mono text-muted-foreground">{node.kubeletVersion}</span>
      )}
    </label>
  );
}

// ── Result row ──────────────────────────────────────────────────────────────

function ResultRow({ result, globalFilter }: { result: BulkExecResultItem; globalFilter: string }) {
  const [expanded, setExpanded] = useState(result.status !== 'ok');
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  // 노드 이름이 있으면 그것을 주 식별자로, 호스트(IP)는 서브로 표기.
  // 사용자가 선택한 노드를 그대로 보여주는 것이 핵심 — 더 이상 IP 만 노출되지 않음.
  const primary = result.name || result.host;
  const subHost = result.name && result.name !== result.host ? result.host : null;

  return (
    <>
      <tr className="border-b border-border hover:bg-muted/20 transition-colors">
        <td className="px-3 py-2 w-7">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? '접기' : '펼치기'}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-sm">
          <div className="flex flex-col">
            <span>{primary}</span>
            {subHost && <span className="text-xs text-muted-foreground">{subHost}</span>}
            {result.clusterName && (
              <span className="text-xs text-muted-foreground/80">{result.clusterName}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
        </td>
        <td className="px-3 py-2 text-sm font-mono text-muted-foreground">
          {result.exitCode === null || result.exitCode === undefined ? '-' : result.exitCode}
        </td>
        <td className="px-3 py-2 text-sm font-mono text-muted-foreground">{result.durationMs}ms</td>
        <td className="px-3 py-2 text-sm text-muted-foreground max-w-[320px] truncate" title={result.error ?? ''}>
          {result.error ?? (result.stdout.split('\n')[0].slice(0, 80) || '-')}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/10">
          <td colSpan={6} className="px-5 py-3">
            <ExecOutputTabs
              stdout={result.stdout}
              stderr={result.stderr}
              maxHeight="max-h-72"
              filterOverride={globalFilter || undefined}
              hideToolbar={!!globalFilter.trim()}
            />
            {result.error && (
              <p className="text-sm text-red-400 mt-2">⚠ {result.error}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

/** Admin 요약 뷰 — 모든 노드를 한 행씩, 필터 적용된 결과만 압축해서 표시.
 *  상태 별 색 · 매칭 라인 수 badge · 대표 출력 1~3줄. */
function SummaryResultsTable({
  results, globalFilter,
}: { results: BulkExecResultItem[]; globalFilter: string }) {
  const maxPreviewLines = 3;
  const colW = useColumnWidths('bulk-exec-summary-table', {
    defaults: { node: 200, status: 130, exit: 130, output: 600 },
    min: 60, max: 1600,
  });

  return (
    <DoubleScrollX>
      <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
        <colgroup>
          {(['node', 'status', 'exit', 'output'] as const).map((k) => (
            <col key={k} style={{ width: `${colW.getWidth(k)}px` }} />
          ))}
        </colgroup>
        <thead className="bg-muted/30 sticky top-0">
          <tr className="text-left border-b border-border">
            <th className="relative px-3 py-2 text-xs font-semibold text-muted-foreground">실행 노드
              <ResizeGrip onMouseDown={(e) => colW.beginResize('node', e)} onDoubleClick={() => colW.autoFit('node')} />
            </th>
            <th className="relative px-3 py-2 text-xs font-semibold text-muted-foreground">수행 결과
              <ResizeGrip onMouseDown={(e) => colW.beginResize('status', e)} onDoubleClick={() => colW.autoFit('status')} />
            </th>
            <th className="relative px-3 py-2 text-xs font-semibold text-muted-foreground">exit · 소요
              <ResizeGrip onMouseDown={(e) => colW.beginResize('exit', e)} onDoubleClick={() => colW.autoFit('exit')} />
            </th>
            <th className="relative px-3 py-2 text-xs font-semibold text-muted-foreground">
              결과 {globalFilter.trim() ? `(필터: "${globalFilter.length > 20 ? globalFilter.slice(0, 20) + '…' : globalFilter}")` : ''}
              <ResizeGrip onMouseDown={(e) => colW.beginResize('output', e)} onDoubleClick={() => colW.autoFit('output')} />
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, idx) => {
            const meta = STATUS_META[r.status];
            const Icon = meta.icon;
            const filteredOut = filteredText(r.stdout, globalFilter);
            const filteredErr = filteredText(r.stderr, globalFilter);
            const outLines = filteredOut.split('\n').filter((l) => l.trim());
            const errLines = filteredErr.split('\n').filter((l) => l.trim());
            const preview = (outLines.length > 0 ? outLines : errLines).slice(0, maxPreviewLines);
            const moreCount = Math.max(0, outLines.length + errLines.length - preview.length);
            const matchBadge = globalFilter.trim()
              ? (outLines.length + errLines.length)
              : null;
            // 다중 클러스터에서 같은 host(IP) 가 중복 가능 — 안전한 키 = clusterId + host + idx
            const rowKey = `${r.clusterId ?? ''}|${r.host}|${idx}`;
            const primary = r.name || r.host;
            const subHost = r.name && r.name !== r.host ? r.host : null;

            return (
              <tr key={rowKey}
                className={`border-b border-border hover:bg-muted/20 align-top ${
                  r.status !== 'ok' ? 'bg-red-500/[0.02]' : ''
                }`}>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <p className="font-mono text-sm font-medium">{primary}</p>
                  {subHost && <p className="font-mono text-xs text-muted-foreground">{subHost}</p>}
                  {r.clusterName && (
                    <p className="text-xs text-muted-foreground/80">{r.clusterName}</p>
                  )}
                </td>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
                    <Icon className="w-3 h-3" />
                    {meta.label}
                  </span>
                  {matchBadge !== null && (
                    <span className={`ml-1 text-xs px-1.5 py-0.5 rounded-full border ${
                      matchBadge > 0
                        ? 'bg-sky-500/10 text-sky-500 border-sky-500/30'
                        : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                    }`}>
                      매칭 {matchBadge}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {r.exitCode ?? '-'} · {r.durationMs}ms
                </td>
                <td className="px-3 py-2 align-top">
                  {r.error && (
                    <p className="text-xs text-red-400 font-medium mb-0.5">⚠ {r.error}</p>
                  )}
                  {preview.length > 0 ? (
                    <div className="font-mono text-xs space-y-0.5">
                      {preview.map((line, i) => (
                        <p key={i} className={errLines.includes(line) ? 'text-red-400/90' : 'text-foreground/90'}
                          title={line}>
                          {line.length > 160 ? line.slice(0, 160) + '…' : line}
                        </p>
                      ))}
                      {moreCount > 0 && (
                        <p className="text-xs text-muted-foreground/70">+{moreCount} 라인 더</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">
                      {globalFilter.trim() ? '(필터 매칭 없음)' : '(출력 없음)'}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DoubleScrollX>
  );
}

// 다중 클러스터 모드에서 같은 노드명이 여러 클러스터에 존재할 수 있어
// (예: 모든 클러스터에 master-1 이 있음) 클러스터로 한정한 키로 식별한다.
const SEP = '::';
const makeKey = (clusterId: string, nodeName: string) => `${clusterId}${SEP}${nodeName}`;
const splitKey = (k: string): { clusterId: string; nodeName: string } => {
  const i = k.indexOf(SEP);
  return i < 0 ? { clusterId: '', nodeName: k } : { clusterId: k.slice(0, i), nodeName: k.slice(i + SEP.length) };
};

export function BulkExecPage() {
  const { data: clusters = [] } = useClusters();
  // 다중 클러스터 선택 — 사이드바에서 체크박스로 고른다
  const [clusterIds, setClusterIds] = useState<string[]>([]);
  const detailColW = useColumnWidths('bulk-exec-detail-table', {
    defaults: { expand: 28, host: 200, status: 130, exit: 80, dur: 100, summary: 500 },
    min: 60, max: 1200,
  });
  // 첫 진입 시 첫 클러스터를 기본 선택
  useEffect(() => {
    if (clusterIds.length === 0 && clusters.length > 0) setClusterIds([clusters[0].id]);
  }, [clusters, clusterIds.length]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용. 하나라도 운영이면 ops.
  useTerminalEnvSync(clusters, clusterIds);

  // 선택된 클러스터별로 병렬로 노드 목록을 조회
  const nodeQueries = useQueries({
    queries: clusterIds.map((cid) => ({
      queryKey: ['bulk-exec', 'nodes', cid],
      queryFn: () => bulkExecApi.nodeList(cid).then((r) => r.data),
      staleTime: 30_000,
      enabled: !!cid,
    })),
  });
  const refetchAllNodes = () => nodeQueries.forEach((q) => q.refetch());
  const isAnyFetching = nodeQueries.some((q) => q.isFetching);

  // 클러스터 ID -> 메타. 사이드바 순서를 그대로 따라 클러스터 섹션을 그린다.
  const clusterMetaById = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const c of clusters) m.set(c.id, { id: c.id, name: c.name });
    return m;
  }, [clusters]);

  // 노드 선택 — `${clusterId}::${nodeName}` 키 사용
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 선택 해제된 클러스터에 속한 노드 선택은 잘라낸다
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(clusterIds);
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        const { clusterId } = splitKey(k);
        if (allowed.has(clusterId)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [clusterIds]);

  const toggleNode = (clusterId: string, nodeName: string) => setSelected((prev) => {
    const next = new Set(prev);
    const key = makeKey(clusterId, nodeName);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const toggleClusterAll = (clusterId: string, nodeNames: string[]) => setSelected((prev) => {
    const next = new Set(prev);
    const allSelectedHere = nodeNames.every((n) => next.has(makeKey(clusterId, n)));
    if (allSelectedHere) {
      for (const n of nodeNames) next.delete(makeKey(clusterId, n));
    } else {
      for (const n of nodeNames) next.add(makeKey(clusterId, n));
    }
    return next;
  });
  const toggleAllAcrossClusters = () => setSelected((prev) => {
    // 현재 보여지는 모든 클러스터의 모든 노드
    const allKeys: string[] = [];
    nodeQueries.forEach((q, i) => {
      const cid = clusterIds[i];
      for (const n of q.data?.nodes ?? []) allKeys.push(makeKey(cid, n.name));
    });
    if (allKeys.length === 0) return prev;
    const everySelected = allKeys.every((k) => prev.has(k));
    return everySelected ? new Set() : new Set(allKeys);
  });

  // 클러스터별 총 노드 수 / 선택 노드 수
  const totalNodesShown = nodeQueries.reduce((acc, q) => acc + (q.data?.nodes?.length ?? 0), 0);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 실행 구성
  const [action, setAction] = useState<'ssh' | 'scp'>('ssh');
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [command, setCommand] = useState('');
  const [language, setLanguage] = useState<ScriptLanguage>('bash');
  const [scpContent, setScpContent] = useState('');
  const [scpRemotePath, setScpRemotePath] = useState('/tmp/uploaded.txt');
  const [mode, setMode] = useState<'sequential' | 'parallel'>('parallel');
  const [parallelism, setParallelism] = useState(10);
  const [connectTimeout, setConnectTimeout] = useState(8);
  const [execTimeout, setExecTimeout] = useState(60);
  const [chunkSize, setChunkSize] = useState(30);
  const [chunkPauseMs, setChunkPauseMs] = useState(200);

  // 선택된 클러스터별로 노드를 그룹화 → 화면 렌더 + 페이로드 빌드 양쪽에서 재사용
  const clusterSections = useMemo(() => {
    return clusterIds.map((cid, i) => {
      const meta = clusterMetaById.get(cid);
      const q = nodeQueries[i];
      return {
        clusterId: cid,
        clusterName: meta?.name ?? cid,
        query: q,
        nodes: q?.data?.nodes ?? [],
      };
    });
  }, [clusterIds, clusterMetaById, nodeQueries]);

  const selectedHosts = useMemo(() => {
    const byKey = new Map<string, { name: string; host: string; clusterId: string; clusterName: string }>();
    for (const sec of clusterSections) {
      const byName = new Map(sec.nodes.map((n) => [n.name, n]));
      for (const key of selected) {
        const { clusterId, nodeName } = splitKey(key);
        if (clusterId !== sec.clusterId) continue;
        const n = byName.get(nodeName);
        if (!n) continue;     // 노드가 사라졌으면 무시 (UI 가 곧 갱신)
        byKey.set(key, {
          name: nodeName,
          host: n.internalIp || n.name || nodeName,
          clusterId: sec.clusterId,
          clusterName: sec.clusterName,
        });
      }
    }
    return Array.from(byKey.values());
  }, [selected, clusterSections]);

  // SCP "다른 노드에서 불러오기" 원본 후보 — 선택 여부와 무관하게, 현재 화면에 로드된
  // (클러스터 사이드바에서 체크한) 모든 노드를 대상으로 한다. 업로드 대상(selectedHosts)과는
  // 별개 목적이라 굳이 노드 선택 여부에 종속시키지 않는다.
  const knownNodes = useMemo(() => {
    const list: { key: string; label: string; host: string }[] = [];
    for (const sec of clusterSections) {
      for (const n of sec.nodes) {
        list.push({
          key: makeKey(sec.clusterId, n.name),
          label: `${n.name} @ ${sec.clusterName}`,
          host: n.internalIp || n.name,
        });
      }
    }
    return list;
  }, [clusterSections]);

  const [runResponse, setRunResponse] = useState<BulkExecResponse | null>(null);

  const runMutation = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await bulkExecApi.run({
        // 단일 클러스터일 때만 루트 cluster_id 채움 (감사 로그/디버깅 용)
        clusterId: clusterIds.length === 1 ? clusterIds[0] : undefined,
        action,
        targets: selectedHosts.map((t) => ({
          host: t.host,
          // 결과를 노드 이름으로 표시하기 위해 메타를 그대로 전달
          name: t.name,
          clusterId: t.clusterId,
          clusterName: t.clusterName,
        })),
        username,
        port,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        command: action === 'ssh' ? command : undefined,
        language: action === 'ssh' ? language : undefined,
        scpContent: action === 'scp' ? scpContent : undefined,
        scpRemotePath: action === 'scp' ? scpRemotePath : undefined,
        mode,
        parallelism,
        connectTimeout,
        execTimeout,
        chunkSize,
        chunkPauseMs,
      }, signal);
      return res.data;
    },
    onSuccess: (data) => setRunResponse(data),
  });

  // SCP "다른 노드에서 불러오기"
  const [remoteFetchOpen, setRemoteFetchOpen] = useState(false);
  const [fetchSourceKey, setFetchSourceKey] = useState('');
  const [fetchRemotePath, setFetchRemotePath] = useState('');
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchFileMutation = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const node = knownNodes.find((n) => n.key === fetchSourceKey);
      if (!node) throw new Error('불러올 노드를 선택하세요.');
      if (!fetchRemotePath.trim()) throw new Error('원격 파일 경로를 입력하세요.');
      const res = await bulkExecApi.fetchFile({
        host: node.host,
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        remotePath: fetchRemotePath.trim(),
        connectTimeout,
      }, signal);
      return res.data;
    },
    onSuccess: (data) => {
      if (data.status === 'ok') {
        setScpContent(data.content);
        setFetchError(null);
      } else {
        setFetchError(data.error || '파일을 불러오지 못했습니다.');
      }
    },
    onError: (err) => setFetchError(formatApiError(err)),
  });

  const canRun =
    clusterIds.length > 0 &&
    selectedHosts.length > 0 &&
    (authMode === 'password' ? !!password : !!privateKey.trim()) &&
    (action === 'ssh' ? !!command.trim() : !!scpRemotePath.trim());

  const runError = runMutation.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [globalFilter, setGlobalFilter] = useState('');
  const [resultView, setResultView] = useState<'summary' | 'detail'>('summary');
  const [copyToast, setCopyToast] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        {/* 좌측: 클러스터 사이드바 — 다중 선택 모드 */}
        <ClusterSidebar
          clusters={clusters}
          // 단일선택 props 는 multiSelect 가 true 면 무시되지만 인터페이스 호환을 위해 채워둠
          selectedId={clusterIds[0] ?? null}
          onSelect={() => {}}
          iconOnly
          multiSelect
          selectedIds={clusterIds}
          onMultiSelectChange={setClusterIds}
        />

        <div className="flex-1 min-w-0">
        <DebugLogPanel pageKey="bulk-exec" extra={{ clusters: clusterIds.length, selected: selected.size, action, mode, pending: runMutation.isPending }} />
        {/* 헤더 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">노드 일괄 실행 (SSH / SCP)</h1>
            {clusterIds.length > 0 && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                클러스터 {clusterIds.length} · 노드 {selected.size} / {totalNodesShown}
              </span>
            )}
          </div>
          <button
            onClick={refetchAllNodes}
            disabled={clusterIds.length === 0}
            className="p-2 bg-secondary hover:bg-secondary/80 rounded-lg text-muted-foreground disabled:opacity-50"
            title="노드 목록 새로고침"
            aria-label="노드 목록 새로고침"
          >
            <RefreshCw className={`w-4 h-4 ${isAnyFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* mc 콘솔처럼 한 로우에 [타겟 노드 | 명령 메뉴 | 실행 결과] 를 나란히 배치.
            12컬럼 그리드 3:4:5 — 결과는 항상 우측 같은 자리에 고정된다. */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
          {/* 왼쪽: 노드 선택 — 클러스터별 그룹 */}
          <section className="lg:col-span-3 min-w-0 bg-card border border-border rounded-xl overflow-hidden">
            <header className="px-3 py-2 border-b border-border bg-muted/20 flex items-center justify-between">
              <h2 className="text-sm font-semibold">타겟 노드</h2>
              <button
                onClick={toggleAllAcrossClusters}
                disabled={totalNodesShown === 0}
                className="text-xs text-primary hover:text-primary/80 disabled:opacity-40"
              >
                {selected.size === totalNodesShown && totalNodesShown > 0 ? '전체 해제' : '전체 선택'}
              </button>
            </header>
            <div className="max-h-[calc(100vh-160px)] overflow-y-auto">
              {clusterIds.length === 0 ? (
                <EmptyState compact title="클러스터를 선택하세요"
                  description="왼쪽 사이드바에서 한 개 이상의 클러스터를 체크하세요." />
              ) : (
                clusterSections.map((sec) => {
                  const allHere = sec.nodes.map((n) => n.name);
                  const selectedHere = allHere.filter((n) => selected.has(makeKey(sec.clusterId, n))).length;
                  return (
                    <ClusterNodeGroup
                      key={sec.clusterId}
                      clusterName={sec.clusterName}
                      nodes={sec.nodes}
                      isLoading={sec.query?.isLoading ?? false}
                      isError={sec.query?.isError ?? false}
                      errorMsg={(sec.query?.error as Error | undefined)?.message}
                      onRefetch={() => sec.query?.refetch()}
                      selectedCount={selectedHere}
                      isNodeChecked={(name) => selected.has(makeKey(sec.clusterId, name))}
                      onToggleNode={(name) => toggleNode(sec.clusterId, name)}
                      onToggleAll={() => toggleClusterAll(sec.clusterId, allHere)}
                    />
                  );
                })
              )}
            </div>
          </section>

          {/* 가운데: 실행 구성 (명령 메뉴) */}
          <section className="lg:col-span-4 min-w-0 bg-card border border-border rounded-xl p-4 space-y-3">
            {/* Action 토글 */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['ssh', 'scp'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAction(a)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                      action === a
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {a === 'ssh' ? '명령 실행 (ssh)' : '파일 업로드 (scp)'}
                  </button>
                ))}
              </div>
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['parallel', 'sequential'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                      mode === m
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {m === 'parallel' ? <><Zap className="w-3 h-3 inline mr-1" />병렬</> : '순차'}
                  </button>
                ))}
              </div>
              {mode === 'parallel' && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground ml-2">
                  동시성
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={parallelism}
                    onChange={(e) => setParallelism(Number(e.target.value) || 1)}
                    className="w-14 px-2 py-1 bg-background border border-border rounded text-sm"
                  />
                </label>
              )}
            </div>

            {/* 인증 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                <input
                  id={f('user')}
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                <input
                  id={f('port')}
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 22)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <p className="block text-sm text-muted-foreground mb-1">인증 방식</p>
                <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                  {(['password', 'key'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setAuthMode(m)}
                      className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-all ${
                        authMode === m
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground/70 hover:text-foreground'
                      }`}
                    >
                      {m === 'password' ? '비밀번호' : 'Private Key'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {authMode === 'password' ? (
              <div>
                <label htmlFor={f('pw')} className="block text-sm text-muted-foreground mb-1">비밀번호</label>
                <input
                  id={f('pw')}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="SSH 비밀번호"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            ) : (
              <div>
                <label htmlFor={f('pkey')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Key className="w-3 h-3" /> Private Key (PEM)
                </label>
                <textarea
                  id={f('pkey')}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ..."
                  rows={4}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <p className="text-xs text-muted-foreground/70 mt-1">RSA / Ed25519 / ECDSA / DSS 지원. 비밀번호 보호된 키는 지원 안 함.</p>
              </div>
            )}

            {/* 명령/파일 */}
            {action === 'ssh' ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor={f('cmd')} className="text-sm text-muted-foreground flex items-center gap-1">
                    <Terminal className="w-3 h-3" /> 실행할 명령 / 스크립트
                  </label>
                  <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                    {(['bash', 'python'] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLanguage(l)}
                        className={`px-2 py-1 text-xs font-medium rounded-md transition-all ${
                          language === l
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground/70 hover:text-foreground'
                        }`}
                        title={l === 'python' ? '원격 python3 인터프리터로 실행됩니다' : '원격 기본 셸로 그대로 실행됩니다'}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  id={f('cmd')}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={language === 'python' ? 'import os\nprint(os.uname())' : '예: uname -a && free -m && uptime'}
                  rows={3}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <SavedScriptPanel
                  className="mt-2"
                  currentValue={command}
                  currentLanguage={language}
                  onPick={(content, lang) => { setCommand(content); setLanguage(lang); }}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label htmlFor={f('scpContent')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                    <FileText className="w-3 h-3" /> 업로드할 내용
                  </label>
                  <textarea
                    id={f('scpContent')}
                    value={scpContent}
                    onChange={(e) => setScpContent(e.target.value)}
                    placeholder="업로드할 파일 내용"
                    rows={4}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                  <div className="mt-1 flex items-center gap-3 flex-wrap">
                    <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                      <Upload className="w-3 h-3" /> 파일에서 불러오기
                      <input
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            if (typeof ev.target?.result === 'string') setScpContent(ev.target.result);
                          };
                          reader.readAsText(f);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setRemoteFetchOpen((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <FolderInput className="w-3 h-3" /> 다른 노드에서 불러오기
                    </button>
                  </div>

                  {remoteFetchOpen && (
                    <div className="mt-2 p-2.5 bg-secondary/30 border border-border rounded-lg space-y-2">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={f('fetchSrc')} className="block text-xs text-muted-foreground mb-1">원본 노드</label>
                          <select
                            id={f('fetchSrc')}
                            value={fetchSourceKey}
                            onChange={(e) => setFetchSourceKey(e.target.value)}
                            className="w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            <option value="">노드를 선택하세요</option>
                            {knownNodes.map((n) => (
                              <option key={n.key} value={n.key}>{n.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={f('fetchPath')} className="block text-xs text-muted-foreground mb-1">원격 파일 경로</label>
                          <input
                            id={f('fetchPath')}
                            type="text"
                            value={fetchRemotePath}
                            onChange={(e) => setFetchRemotePath(e.target.value)}
                            placeholder="/etc/hosts"
                            className="w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-muted-foreground/70">
                          위 인증 정보(사용자/포트/비밀번호|키)를 그대로 사용해 텍스트 파일을 읽어옵니다.
                        </p>
                        <button
                          type="button"
                          onClick={() => fetchFileMutation.mutate()}
                          disabled={fetchFileMutation.isPending || !fetchSourceKey || !fetchRemotePath.trim()}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                        >
                          {fetchFileMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
                          불러오기
                        </button>
                      </div>
                      {fetchError && (
                        <p className="text-xs text-status-critical">{fetchError}</p>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor={f('scpPath')} className="block text-sm text-muted-foreground mb-1">원격 경로</label>
                  <input
                    id={f('scpPath')}
                    type="text"
                    value={scpRemotePath}
                    onChange={(e) => setScpRemotePath(e.target.value)}
                    placeholder="/tmp/uploaded.txt"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            )}

            {/* 타임아웃 */}
            <div className="flex items-center gap-3 gap-y-2 flex-wrap text-sm text-muted-foreground">
              <label className="flex items-center gap-1.5">
                connect timeout
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={connectTimeout}
                  onChange={(e) => setConnectTimeout(Number(e.target.value) || 8)}
                  className="w-14 px-2 py-1 bg-background border border-border rounded text-sm"
                />s
              </label>
              <label className="flex items-center gap-1.5">
                exec timeout
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={execTimeout}
                  onChange={(e) => setExecTimeout(Number(e.target.value) || 60)}
                  className="w-16 px-2 py-1 bg-background border border-border rounded text-sm"
                />s
              </label>
              <span className="text-border">·</span>
              <label className="flex items-center gap-1.5" title="한 청크에서 병렬 실행할 호스트 수. 청크 완료 후 휴지 → 다음 청크.">
                chunk
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value) || 30)}
                  className="w-14 px-2 py-1 bg-background border border-border rounded text-sm"
                />개
              </label>
              <label className="flex items-center gap-1.5" title="청크 사이 휴지 시간 (ms). 베스천/게이트웨이 burst 부하 완화.">
                pause
                <input
                  type="number"
                  min={0}
                  max={5000}
                  step={50}
                  value={chunkPauseMs}
                  onChange={(e) => setChunkPauseMs(Number(e.target.value) || 0)}
                  className="w-16 px-2 py-1 bg-background border border-border rounded text-sm"
                />ms
              </label>
            </div>

            {/* 대규모 실행 예상 시간 힌트 */}
            {selected.size >= 50 && (
              <div className="px-3 py-2 text-xs rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 flex items-start gap-2">
                <Clock className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <div>
                  선택 {selected.size}개 호스트 · parallelism {parallelism} / chunk {chunkSize}개 ·
                  예상 소요 시간 <strong className="font-mono">최소 {Math.ceil(selected.size / chunkSize) * Math.ceil(execTimeout / 10)}초 ~ 최대 {Math.ceil(selected.size / chunkSize) * (execTimeout + connectTimeout)}초</strong>.
                  실행 중 버튼이 "중지"로 바뀌며 언제든 취소 가능.
                </div>
              </div>
            )}

            {runError && (
              <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                {formatApiError(runError, '실행 중 오류')}
              </div>
            )}

            {/* 실행 */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <p className="text-sm text-muted-foreground">
                인증 정보는 이 실행에만 사용되고 저장되지 않습니다.
              </p>
              {runMutation.isPending ? (
                <button
                  onClick={runMutation.abort}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                >
                  <Square className="w-4 h-4 fill-current" />
                  중지
                </button>
              ) : (
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canRun}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4" />
                  실행 ({selected.size} 노드)
                </button>
              )}
            </div>
          </section>

          {/* 우측: 실행 결과 — mc 콘솔처럼 항상 같은 자리에 고정, 실행 전엔 플레이스홀더.
              내부에서만 스크롤되어 세 컬럼이 한 화면 폭 안에 들어온다. */}
          <section className="lg:col-span-5 min-w-0 bg-card border border-border rounded-xl overflow-hidden flex flex-col lg:h-[calc(100vh-160px)] min-h-[280px]">
            {!runResponse ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="text-center text-sm text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  명령을 실행하면<br />결과가 여기에 표시됩니다.
                </div>
              </div>
            ) : (
              <>
                <header className="px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">실행 결과</h2>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                    성공 {runResponse.okCount}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
                    실패 {runResponse.errorCount}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {runResponse.totalDurationMs}ms · {runResponse.mode}
                  </span>

                  <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                    {/* 뷰 모드 토글 */}
                    <div className="flex items-center bg-secondary/60 rounded-md p-[2px] gap-px">
                      <button onClick={() => setResultView('summary')}
                        className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-all ${
                          resultView === 'summary' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        title="모든 노드 한 줄 요약">
                        <LayoutList className="w-3 h-3" /> 요약
                      </button>
                      <button onClick={() => setResultView('detail')}
                        className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-all ${
                          resultView === 'detail' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        title="호스트별 stdout/stderr 전체">
                        <Rows className="w-3 h-3" /> 상세
                      </button>
                    </div>

                    {/* 공통 필터 */}
                    <div className="relative">
                      <input
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder="공통 필터..."
                        className="pl-2 pr-6 py-1 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary w-36"
                      />
                      {globalFilter && (
                        <button
                          onClick={() => setGlobalFilter('')}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          aria-label="필터 지우기"
                        >×</button>
                      )}
                    </div>

                    {/* 내보내기 */}
                    <div className="flex items-center gap-1">
                      <button onClick={() => {
                          const ts = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
                          downloadBlob(
                            resultsToCsv(runResponse.results, globalFilter, command),
                            `bulk-exec-${ts}.csv`,
                            'text/csv',
                          );
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-md"
                        title="필터 반영 CSV 내보내기">
                        <Download className="w-3 h-3" /> CSV
                      </button>
                      <button onClick={() => {
                          const ts = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
                          downloadBlob(
                            resultsToTxt(runResponse.results, globalFilter, command),
                            `bulk-exec-${ts}.txt`,
                            'text/plain',
                          );
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-md"
                        title="필터 반영 텍스트 내보내기">
                        <Download className="w-3 h-3" /> TXT
                      </button>
                      <button onClick={async () => {
                          const ok = await copyToClipboard(resultsToTxt(runResponse.results, globalFilter, command));
                          setCopyToast(ok ? '클립보드에 복사됨' : '복사 실패');
                          setTimeout(() => setCopyToast(null), 1500);
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-md"
                        title="필터 반영 결과 클립보드 복사">
                        <FileText className="w-3 h-3" /> 복사
                      </button>
                    </div>
                  </div>
                </header>

                {copyToast && (
                  <div className="px-3 py-1.5 text-xs bg-primary/5 text-primary border-b border-primary/20">
                    {copyToast}
                  </div>
                )}

                <div className="flex-1 overflow-auto min-h-0">
                  {resultView === 'summary' ? (
                    <SummaryResultsTable results={runResponse.results} globalFilter={globalFilter} />
                  ) : (
                    <DoubleScrollX>
                      <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                        <colgroup>
                          {(['expand', 'host', 'status', 'exit', 'dur', 'summary'] as const).map((k) => (
                            <col key={k} style={{ width: `${detailColW.getWidth(k)}px` }} />
                          ))}
                        </colgroup>
                        <thead>
                          <tr className="border-b border-border bg-muted/30 text-left">
                            <th><span className="sr-only">펼치기</span></th>
                            <th className="relative px-3 py-2 text-sm font-medium text-muted-foreground">호스트
                              <ResizeGrip onMouseDown={(e) => detailColW.beginResize('host', e)} onDoubleClick={() => detailColW.autoFit('host')} />
                            </th>
                            <th className="relative px-3 py-2 text-sm font-medium text-muted-foreground">상태
                              <ResizeGrip onMouseDown={(e) => detailColW.beginResize('status', e)} onDoubleClick={() => detailColW.autoFit('status')} />
                            </th>
                            <th className="relative px-3 py-2 text-sm font-medium text-muted-foreground">exit
                              <ResizeGrip onMouseDown={(e) => detailColW.beginResize('exit', e)} onDoubleClick={() => detailColW.autoFit('exit')} />
                            </th>
                            <th className="relative px-3 py-2 text-sm font-medium text-muted-foreground">소요
                              <ResizeGrip onMouseDown={(e) => detailColW.beginResize('dur', e)} onDoubleClick={() => detailColW.autoFit('dur')} />
                            </th>
                            <th className="relative px-3 py-2 text-sm font-medium text-muted-foreground">요약
                              <ResizeGrip onMouseDown={(e) => detailColW.beginResize('summary', e)} onDoubleClick={() => detailColW.autoFit('summary')} />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {runResponse.results.map((r, idx) => (
                            <ResultRow
                              key={`${r.clusterId ?? ''}|${r.host}|${idx}`}
                              result={r}
                              globalFilter={globalFilter}
                            />
                          ))}
                        </tbody>
                      </table>
                    </DoubleScrollX>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
        </div>
      </main>

      {/* 실행 확인 모달 */}
      <ConfirmDialog
        open={confirmOpen}
        title={action === 'ssh' ? '노드 일괄 SSH 실행 확인' : '노드 일괄 SCP 업로드 확인'}
        description={`이 작업은 ${clusterIds.length}개 클러스터의 ${selectedHosts.length}개 노드에 ${mode === 'parallel' ? '병렬' : '순차'}로 실행됩니다.`}
        confirmLabel={action === 'ssh' ? '실행' : '업로드'}
        danger={action === 'ssh'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); runMutation.mutate(); }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">접속 정보</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">(선택된 {selectedHosts.length}개 host, {clusterIds.length}개 클러스터)</span>
              <span className="text-muted-foreground">:{port}</span>
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded border border-border bg-secondary">
                {authMode === 'password' ? '비밀번호' : 'Private Key'}
              </span>
            </p>
          </div>
          {action === 'ssh' ? (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
                실행할 명령
                <span className="normal-case text-[10px] px-1.5 py-0.5 rounded border border-border bg-secondary">{language}</span>
              </p>
              <pre className="text-xs font-mono bg-background border border-border rounded p-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
                {command}
              </pre>
            </div>
          ) : (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">업로드 대상</p>
              <p className="font-mono">{scpRemotePath}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                크기: {new Blob([scpContent]).size} bytes
              </p>
            </div>
          )}
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">대상 호스트 (클러스터별)</p>
            <div className="text-xs font-mono max-h-40 overflow-auto bg-background border border-border rounded p-2 space-y-1.5">
              {Object.entries(
                selectedHosts.reduce<Record<string, typeof selectedHosts>>((acc, t) => {
                  const k = t.clusterName || t.clusterId || '-';
                  (acc[k] = acc[k] || []).push(t);
                  return acc;
                }, {})
              ).map(([cname, items]) => (
                <div key={cname}>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground/80">
                    {cname} <span className="text-muted-foreground/60">({items.length})</span>
                  </p>
                  {items.slice(0, 8).map((t) => (
                    <div key={`${t.clusterId}::${t.name}`} className="pl-2">
                      <span className="text-foreground">{t.name}</span>
                      {t.host !== t.name && <span className="text-muted-foreground"> ({t.host})</span>}
                    </div>
                  ))}
                  {items.length > 8 && (
                    <div className="pl-2 text-muted-foreground">+ {items.length - 8}개 더…</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
