import { useEffect, useId, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Terminal, RefreshCw, Play, Square, CheckCircle2, XCircle, AlertTriangle, Key, Upload, ChevronDown, ChevronRight,
  Wifi, FileText, ShieldAlert, Zap, Clock, Download, LayoutList, Rows, Server, FolderInput, X,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useRunLog, runLogged, consoleRunLines, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { ConfirmDialog, ExecOutputTabs, ClusterSidebar, CommandTraceList, DebugLogPanel, Skeleton, EmptyState, ErrorState, SelectClusterEmptyState, ResizeGrip, DoubleScrollX, PageShell, RunLogPanel, useToast } from '@/components/common';
import { CLUSTER_OPERATE_REQUIRED_HINT, useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { MacCard } from '@/components/ui/MacCard';
import { PageHeader } from '@/components/common/PageHeader';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import { SavedScriptPanel } from '@/components/bulk-exec';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { bulkExecApi, type NodeSummary, type BulkExecResponse, type BulkExecResultItem, type FetchFileResponse } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import { judgeCommand, type CommandVerdict } from '@/lib/dangerCommand';
import type { ScriptLanguage } from '@/types';

// ── 상태 색상 ───────────────────────────────────────────────────────────────

const STATUS_META: Record<BulkExecResultItem['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-secondary text-muted-foreground border-border',  icon: CheckCircle2 },
  error:         { label: '에러',     cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',       icon: Wifi },
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
  lines.push(`# command: ${command || '—'}`);
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
  lines.push(`# command : ${command || '—'}`);
  if (filter.trim()) lines.push(`# filter  : ${filter}`);
  lines.push(`# exported: ${new Date().toISOString()}`);
  lines.push(`# total   : ${results.length} (ok=${results.filter((r) => r.status === 'ok').length})`);
  lines.push('');
  for (const r of results) {
    const label = r.name ? `${r.name}${r.clusterName ? `@${r.clusterName}` : ''} (${r.host})` : r.host;
    lines.push(`========== ${label}  [${r.status}]  exit=${r.exitCode ?? '—'}  ${r.durationMs}ms ==========`);
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

function downloadBlob(text: string, filename: string, mime: string, withBom: boolean = true) {
  // BOM 은 CSV/TXT 를 엑셀에서 열 때 UTF-8 로 정확히 인식시키는 용도 — 스크립트/설정
  // 파일(예: bash 셔뱅 #!/bin/bash)에 붙이면 실행이 깨지므로 그런 용도는 withBom=false.
  const blob = new Blob(withBom ? ['﻿', text] : [text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 경로 문자열의 마지막 세그먼트 — scpRemotePath 를 로컬 저장 파일명 제안에 재사용 */
function basenameOf(path: string, fallback: string): string {
  const name = path.split('/').filter(Boolean).pop();
  return name || fallback;
}

function copyToClipboard(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
}

/** 클러스터 단위로 묶어 노드를 보여주는 collapsible 섹션.
 *  여러 클러스터를 한 화면에서 다룰 때 시각적 구분을 준다. */
function ClusterNodeGroup({
  clusterName, nodes, isLoading, isError, error, onRefetch,
  selectedCount, isNodeChecked, onToggleNode, onToggleAll,
}: {
  clusterName: string;
  nodes: NodeSummary[];
  isLoading: boolean;
  isError: boolean;
  /** 조회 실패 원인 — ErrorState 가 서버 사유(formatApiError)·403 권한 안내로 바꿔 보여 준다. */
  error?: unknown;
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
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="p-0.5 rounded-md text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={`${clusterName} 노드 ${open ? '접기' : '펼치기'}`}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <Server className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-semibold truncate flex-1">{clusterName}</span>
        <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
          {selectedCount}/{total}
        </span>
        <button
          type="button"
          onClick={onToggleAll}
          disabled={total === 0}
          aria-label={`${clusterName} 노드 ${allSelected ? '모두 해제' : '모두 선택'}`}
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
            <ErrorState compact error={error} title={`${clusterName} 노드를 불러오지 못했습니다`} onRetry={onRefetch} />
          ) : total === 0 ? (
            <EmptyState compact title="노드가 없습니다." description="이 클러스터에서 조회된 노드가 없습니다. 새로고침해 보세요." />
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
      {/* 좌측 제어 열(320px)에 맞춰 두 줄 — 이름 / IP·역할·kubelet 버전 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${node.ready ? 'bg-muted-foreground/40' : 'bg-status-critical'}`} aria-hidden />
          <span className="font-mono text-sm text-foreground truncate">{node.name}</span>
          {!node.ready && <span className="sr-only">(NotReady)</span>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap pl-4 mt-0.5">
          <span className="text-xs font-mono text-muted-foreground">{host}</span>
          {node.roles.map((r) => (
            <span key={r} className="text-xs px-1.5 rounded bg-secondary text-muted-foreground">{r}</span>
          ))}
          {node.kubeletVersion && (
            <span className="text-xs font-mono text-muted-foreground">{node.kubeletVersion}</span>
          )}
        </div>
      </div>
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
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-0.5 rounded-md text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            aria-label={`${primary} 출력 ${expanded ? '접기' : '펼치기'}`}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-sm">
          <div className="flex flex-col">
            <span>{primary}</span>
            {subHost && <span className="text-xs text-muted-foreground">{subHost}</span>}
            {result.clusterName && (
              <span className="text-xs text-muted-foreground">{result.clusterName}</span>
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
          {result.exitCode === null || result.exitCode === undefined ? '—' : result.exitCode}
        </td>
        <td className="px-3 py-2 text-sm font-mono text-muted-foreground">{result.durationMs}ms</td>
        <td className="px-3 py-2 text-sm text-muted-foreground max-w-[320px] truncate" title={result.error ?? ''}>
          {result.error ?? (result.stdout.split('\n')[0].slice(0, 80) || '—')}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/10">
          <td colSpan={6} className="px-5 py-3">
            <ExecOutputTabs
              stdout={result.stdout}
              stderr={result.stderr}
              maxHeight="max-h-none"
              filterOverride={globalFilter || undefined}
              hideToolbar={!!globalFilter.trim()}
            />
            {result.error && (
              <p className="text-sm text-status-critical mt-2 flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{result.error}</p>
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
                  r.status !== 'ok' ? 'bg-status-critical/[0.02]' : ''
                }`}>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <p className="font-mono text-sm font-medium">{primary}</p>
                  {subHost && <p className="font-mono text-xs text-muted-foreground">{subHost}</p>}
                  {r.clusterName && (
                    <p className="text-xs text-muted-foreground">{r.clusterName}</p>
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
                        ? 'bg-status-info/10 text-status-info border-status-info/30'
                        : 'bg-status-unknown/10 text-status-unknown border-status-unknown/30'
                    }`}>
                      매칭 {matchBadge}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {r.exitCode ?? '—'} · {r.durationMs}ms
                </td>
                <td className="px-3 py-2 align-top">
                  {r.error && (
                    <p className="text-xs text-status-critical font-medium mb-0.5 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{r.error}</p>
                  )}
                  {preview.length > 0 ? (
                    <div className="font-mono text-xs space-y-0.5">
                      {preview.map((line, i) => (
                        <p key={i} className={errLines.includes(line) ? 'text-status-critical/90' : 'text-foreground/90'}
                          title={line}>
                          {line.length > 160 ? line.slice(0, 160) + '…' : line}
                        </p>
                      ))}
                      {moreCount > 0 && (
                        <p className="text-xs text-muted-foreground">+{moreCount} 라인 더</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
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

type Action = 'ssh' | 'scp';

/** 권한 부족(403)만 토스트로 알린다 — 그 밖의 실패는 실행 로그의 error 줄과 실행 바의 알림 한 곳으로 모은다(§12.6.1). */
function toastForbidden(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403) toast.error(`${title} — 권한이 없습니다`, formatApiError(error));
}

const INPUT = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';
const SMALL_INPUT = 'w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';
const LABEL = 'block text-sm text-muted-foreground mb-1';
const SEG_BTN = (on: boolean) => `px-2 py-1.5 text-sm font-medium rounded-md transition-colors ${
  on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
}`;

export function BulkExecPage() {
  const {
    data: clusters = [],
    isError: clustersError,
    error: clustersErrorObj,
    refetch: refetchClusters,
  } = useClusters();
  const toast = useToast();
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
  const [action, setAction] = useState<Action>('ssh');
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
  const [targetOpen, setTargetOpen] = useState(true);

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

  // 결과는 모드(SSH/SCP)별로 보관한다 — 업로드 탭을 잠깐 보고 돌아와도 방금 받은 명령 결과가 남는다(§12.6.1-3).
  // label 은 내보내기(CSV/TXT) 머리글에 쓰는 "무엇을 실행했나" — 실행 시점 값으로 고정한다.
  const [results, setResults] = useState<Record<Action, { response: BulkExecResponse; label: string } | null>>({ ssh: null, scp: null });
  const current = results[action];
  const runResponse = current?.response ?? null;

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
  });

  // SCP "다른 노드에서 불러오기"
  const [remoteFetchOpen, setRemoteFetchOpen] = useState(false);
  const [fetchSourceKey, setFetchSourceKey] = useState('');
  const [fetchRemotePath, setFetchRemotePath] = useState('');
  const [fetchError, setFetchError] = useState<string | null>(null);
  // 마지막 시도의 단계별 trace — 성공/실패 무관하게 "무엇을 시도했는지" 항상 보여준다.
  const [fetchTrace, setFetchTrace] = useState<FetchFileResponse | null>(null);

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
      setFetchTrace(data);
      if (data.status === 'ok') {
        setScpContent(data.content);
        setFetchError(null);
      } else {
        setFetchError(data.error || '파일을 불러오지 못했습니다.');
      }
    },
    onError: (err) => { setFetchError(formatApiError(err)); setFetchTrace(null); },
  });

  // 실행 수명주기 로그(일괄 실행·파일 가져오기 공유) — 화면의 중심. 호스트별 출력은 결과 패널, 여기는 요청·대기·호스트별 상태·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('bulk-exec-run');

  const commandHead = `${(command.trim().split('\n')[0] ?? '').slice(0, 120)}${command.trim().includes('\n') ? ' …' : ''}`;
  const doRun = async () => {
    const n = selectedHosts.length;
    const runAction = action;
    const multiCluster = new Set(selectedHosts.map((t) => t.clusterId)).size > 1;
    const what = runAction === 'ssh'
      ? `${language} 명령 "${commandHead}"`
      : `파일 업로드 ${scpRemotePath} (${new Blob([scpContent]).size} bytes)`;
    const label = runAction === 'ssh' ? command : `scp → ${scpRemotePath}`;
    const r = await runLogged(runLog, {
      title: runAction === 'ssh' ? '노드 일괄 SSH 실행' : '노드 일괄 SCP 업로드',
      first: `${clusterIds.length}개 클러스터 · ${n}개 노드 — ${what} · SSH ${username} 포트 ${port} · ${mode === 'parallel' ? `병렬 ${parallelism}` : '순차'} · 묶음 ${chunkSize} · 제한 시간 연결 ${connectTimeout}s/실행 ${execTimeout}s 요청`,
      fn: () => runMutation.mutateAsync(),
      summarize: (res) => consoleRunLines(res.results.map((x) => {
        const hostLabel = x.name && x.name !== x.host ? `${x.name}(${x.host})` : x.host;
        return {
          host: multiCluster && x.clusterName ? `${hostLabel} @ ${x.clusterName}` : hostLabel,
          status: x.status, exitCode: x.exitCode, durationMs: x.durationMs, stderr: x.stderr, error: x.error,
        };
      })),
    });
    if (r.ok) setResults((prev) => ({ ...prev, [runAction]: { response: r.data, label } }));
    else if (!r.aborted) toastForbidden(toast, runAction === 'ssh' ? '노드 일괄 SSH 실행' : '노드 일괄 SCP 업로드', r.error);
  };

  // 파일 가져오기 — 단계 trace(ExecutionStepsTimeline)는 그대로 두고, 실행 로그에도 단계·결과를 남긴다.
  const doFetchFile = async () => {
    const node = knownNodes.find((x) => x.key === fetchSourceKey);
    const r = await runLogged(runLog, {
      title: '다른 노드에서 파일 가져오기',
      first: `${node?.label ?? '(노드 미선택)'} — ${fetchRemotePath.trim() || '(경로 없음)'} 읽기 요청 · SSH ${username} 포트 ${port}`,
      fn: () => fetchFileMutation.mutateAsync(),
      summarize: (res, run) => {
        const out: RunLogEntry[] = [];
        for (const s of res.steps ?? []) {
          run.setStep(s.id, s.label, s.status === 'failed' ? 'failed' : 'done');
          out.push([s.status === 'failed' ? 'error' : 'info',
            `단계 ${s.label} · ${s.status}${s.durationMs != null ? ` · ${s.durationMs}ms` : ''}${s.detail ? ` — ${s.detail}` : ''}`]);
        }
        out.push(...consoleRunLines({ host: res.host, status: res.status, error: res.error }));
        if (res.status === 'ok') out.push(['info', `${res.size} bytes 를 업로드 내용으로 불러옴`]);
        return out;
      },
    });
    if (!r.ok && r.aborted) setFetchError(null);
    else if (!r.ok) toastForbidden(toast, '다른 노드에서 파일 가져오기', r.error);
  };

  // 권한(§12.9) — 서버는 operator + 대상 노드가 속한 클러스터마다 테넌트 operate 를 요구한다.
  // 역할은 공통, 바인딩은 클러스터마다 달라 선택 클러스터 중 operate 불가인 것의 이름을 사유에 붙인다.
  const roleAccess = useCanOperate();
  const clusterAccess = useMyClusterAccess(roleAccess.canOperate && roleAccess.role !== 'admin');
  const blockedClusterNames = (ids: string[]) => ids
    .filter((cid) => {
      const level = clusterAccess.data?.[cid];
      return level !== undefined && level !== 'operate';
    })
    .map((cid) => clusterMetaById.get(cid)?.name ?? cid);
  const runTargetClusterIds = selectedHosts.length > 0
    ? Array.from(new Set(selectedHosts.map((t) => t.clusterId)))
    : clusterIds;
  const runBlocked = blockedClusterNames(runTargetClusterIds);
  const runDeniedHint = !roleAccess.canOperate
    ? roleAccess.hint
    : runBlocked.length > 0 ? `${CLUSTER_OPERATE_REQUIRED_HINT}: ${runBlocked.join(', ')}` : undefined;
  const fetchSourceClusterId = fetchSourceKey ? splitKey(fetchSourceKey).clusterId : '';
  const fetchBlocked = fetchSourceClusterId ? blockedClusterNames([fetchSourceClusterId]) : [];
  const fetchDeniedHint = !roleAccess.canOperate
    ? roleAccess.hint
    : fetchBlocked.length > 0 ? `${CLUSTER_OPERATE_REQUIRED_HINT}: ${fetchBlocked.join(', ')}` : undefined;

  const canRun =
    !runDeniedHint &&
    clusterIds.length > 0 &&
    selectedHosts.length > 0 &&
    (authMode === 'password' ? !!password : !!privateKey.trim()) &&
    (action === 'ssh' ? !!command.trim() : !!scpRemotePath.trim());

  // 위험 판정(D-171·§12.6.1-1) — 조회 allowlist(bash) 안의 명령만 확인 없이 바로 실행한다.
  // python 스크립트는 정적으로 조회 여부를 판정할 수 없고, SCP 는 원격 파일을 덮어쓰므로 항상 danger 확인.
  const verdict: CommandVerdict = useMemo(() => {
    if (action === 'scp') return { readOnly: false, subcommand: 'scp', reason: `원격 파일 덮어쓰기 — ${scpRemotePath || '(경로 없음)'}` };
    if (language === 'python') return { readOnly: false, subcommand: 'python', reason: 'python 스크립트는 조회 명령으로 판정할 수 없습니다' };
    return judgeCommand(command, 'shell');
  }, [action, language, command, scpRemotePath]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const requestRun = () => {
    if (!canRun || runMutation.isPending) return;
    if (verdict.readOnly) void doRun();
    else setConfirmOpen(true);
  };
  const runKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); requestRun(); }
  };

  // 오류 표시는 한 곳(§12.6.1-4) — 일괄 실행 실패가 우선, SCP 탭에서는 파일 가져오기 실패도 같은 자리에.
  const runError = runMutation.error as { response?: { data?: { detail?: string } }; message?: string } | null;
  const alertMessage = runError
    ? formatApiError(runError, '실행 중 오류')
    : action === 'scp' && fetchError ? `파일 가져오기 실패 — ${fetchError}` : null;

  const [globalFilter, setGlobalFilter] = useState('');
  const [resultView, setResultView] = useState<'summary' | 'detail'>('summary');
  const [copyToast, setCopyToast] = useState<string | null>(null);

  const tabs: { key: Action; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'ssh', label: '명령 실행 (SSH)', icon: Terminal },
    { key: 'scp', label: '파일 업로드 (SCP)', icon: Upload },
  ];
  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].key;
    setAction(next);
    document.getElementById(f(`tab-${next}`))?.focus();
  };

  const authLabel = authMode === 'password' ? '비밀번호' : '개인키';
  const targetSummary = selectedHosts.length > 0
    ? `${username}@노드 ${selectedHosts.length}개:${port} · ${authLabel}`
    : '노드 미선택';
  const advancedSummary = `${mode === 'parallel' ? `병렬 ${parallelism}` : '순차'} · 연결 ${connectTimeout}s · 실행 ${execTimeout}s · 묶음 ${chunkSize}`;
  const runLabel = action === 'ssh' ? `실행 (${selectedHosts.length} 노드)` : `업로드 (${selectedHosts.length} 노드)`;
  const exportTs = () => new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
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
        <PageHeader
          className="mb-3"
          icon={Terminal}
          title="노드 일괄 실행 (SSH / SCP)"
          titleExtra={clusterIds.length > 0 ? (
            <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
              클러스터 {clusterIds.length} · 노드 {selected.size} / {totalNodesShown}
            </span>
          ) : undefined}
          actions={
            <button
              type="button"
              onClick={refetchAllNodes}
              disabled={clusterIds.length === 0}
              className="p-2 bg-secondary hover:bg-secondary/80 rounded-xl text-muted-foreground disabled:opacity-50"
              title="노드 목록 새로고침"
              aria-label="노드 목록 새로고침"
            >
              <RefreshCw className={`w-4 h-4 ${isAnyFetching ? 'animate-spin' : ''}`} />
            </button>
          }
        />

        <div role="tablist" aria-label="일괄 실행 작업" className="flex items-center gap-1 mb-3 border-b border-border">
          {tabs.map((t, idx) => (
            <button
              key={t.key}
              id={f(`tab-${t.key}`)}
              type="button"
              role="tab"
              aria-selected={action === t.key}
              aria-controls={f('panel')}
              tabIndex={action === t.key ? 0 : -1}
              onClick={() => setAction(t.key)}
              onKeyDown={(e) => onTabKey(e, idx)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                action === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* 로그 중심 콘솔(DESIGN_SYSTEM §12.6.1) — 좌: 제어(좁게), 우: 실행 로그(3) + 결과(2). 실행 로그가 화면의 중심이다. */}
        <div
          id={f('panel')}
          role="tabpanel"
          aria-labelledby={f(`tab-${action}`)}
          className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-3 lg:h-[calc(100vh-var(--topbar-h)-10rem)] lg:min-h-[480px]"
        >
          {/* 좌: 제어 */}
          <MacCard title="제어" rootClassName="min-w-0 flex flex-col lg:min-h-0" bodyPadding="p-0" className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* 대상·인증 — 자주 바꾸지 않으므로 접으면 요약 한 줄만 남는다. */}
              <section className="border-b border-border">
                <button
                  type="button"
                  onClick={() => setTargetOpen((v) => !v)}
                  aria-expanded={targetOpen}
                  aria-controls={f('target')}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-left hover:bg-secondary/50"
                >
                  {targetOpen ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
                  대상·인증
                  <span className="ml-auto text-xs font-mono font-normal text-muted-foreground truncate">{targetSummary}</span>
                </button>
                {targetOpen && (
                  <div id={f('target')} className="px-4 pb-4 space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm text-muted-foreground">대상 노드 <span className="font-mono">{selected.size}/{totalNodesShown}</span></p>
                        <button
                          type="button"
                          onClick={toggleAllAcrossClusters}
                          disabled={totalNodesShown === 0}
                          className="text-xs text-primary hover:text-primary/80 disabled:opacity-40"
                        >
                          {selected.size === totalNodesShown && totalNodesShown > 0 ? '전체 해제' : '전체 선택'}
                        </button>
                      </div>
                      {/* 노드가 수백 개여도 명령 입력이 밀려나지 않게 목록만 제한 높이로 스크롤한다. */}
                      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                        {clustersError ? (
                          <ErrorState compact error={clustersErrorObj} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void refetchClusters(); }} />
                        ) : clusterIds.length === 0 ? (
                          <SelectClusterEmptyState compact description="왼쪽 사이드바에서 한 개 이상의 클러스터를 체크하세요." />
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
                                error={sec.query?.error}
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
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={f('user')} className={LABEL}>사용자</label>
                        <input id={f('user')} type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={INPUT} />
                      </div>
                      <div>
                        <label htmlFor={f('port')} className={LABEL}>포트</label>
                        <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} className={INPUT} />
                      </div>
                    </div>
                    <div>
                      <p id={f('authMode')} className={LABEL}>인증 방식</p>
                      <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px" role="group" aria-labelledby={f('authMode')}>
                        {(['password', 'key'] as const).map((m) => (
                          <button key={m} type="button" onClick={() => setAuthMode(m)} aria-pressed={authMode === m} className={`flex-1 ${SEG_BTN(authMode === m)}`}>
                            {m === 'password' ? '비밀번호' : '개인키'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {authMode === 'password' ? (
                      <div>
                        <label htmlFor={f('pw')} className={LABEL}>SSH 비밀번호</label>
                        <input
                          id={f('pw')}
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="off"
                          className={INPUT}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">이 실행에만 쓰이며 저장되지 않습니다.</p>
                      </div>
                    ) : (
                      <div>
                        <label htmlFor={f('pkey')} className={`${LABEL} flex items-center gap-1`}>
                          <Key className="w-3 h-3" aria-hidden /> 개인키(PEM)
                        </label>
                        <textarea
                          id={f('pkey')}
                          value={privateKey}
                          onChange={(e) => setPrivateKey(e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY----- …"
                          rows={4}
                          className={`${INPUT} text-xs font-mono resize-none`}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">RSA / Ed25519 / ECDSA / DSS 지원. 비밀번호 보호된 키는 지원하지 않습니다. 이 실행에만 쓰이며 저장되지 않습니다.</p>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <div className="px-4 py-3 space-y-3">
                {/* 명령/파일 */}
                {action === 'ssh' ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor={f('cmd')} className="text-sm text-muted-foreground flex items-center gap-1">
                        <Terminal className="w-3 h-3" aria-hidden /> 명령 / 스크립트
                      </label>
                      <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px" role="group" aria-label="스크립트 언어">
                        {(['bash', 'python'] as const).map((l) => (
                          <button
                            key={l}
                            type="button"
                            onClick={() => setLanguage(l)}
                            aria-pressed={language === l}
                            className={`px-2 py-0.5 text-xs font-medium rounded-md transition-colors ${
                              language === l ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
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
                      onKeyDown={runKeyDown}
                      placeholder={language === 'python' ? 'import os\nprint(os.uname())' : '예: uname -a && free -m && uptime'}
                      rows={4}
                      aria-describedby={f('verdict')}
                      className={`${INPUT} text-xs font-mono resize-y`}
                    />
                    {/* 입력하는 동안 위험 신호를 보인다(§12.6.1-2) — live 영역은 항상 두고 내용만 바꾼다. */}
                    <p
                      id={f('verdict')}
                      aria-live="polite"
                      className={`mt-1.5 text-xs flex items-start gap-1.5 ${verdict.readOnly ? 'text-muted-foreground' : 'text-status-critical'}`}
                    >
                      {command.trim() ? (
                        <>
                          <span className="shrink-0 rounded-full border border-current px-2 font-semibold">
                            {verdict.readOnly ? '조회 명령' : '변경 명령'}
                          </span>
                          <span>{verdict.readOnly ? '확인 없이 바로 실행됩니다.' : `실행 전에 확인합니다 — ${verdict.reason ?? ''}`}</span>
                        </>
                      ) : null}
                    </p>
                    <SavedScriptPanel
                      className="mt-2"
                      currentValue={command}
                      currentLanguage={language}
                      onPick={(content, lang) => { setCommand(content); setLanguage(lang); }}
                    />
                  </div>
                ) : (
                  <>
                    <div>
                      <label htmlFor={f('scpPath')} className={LABEL}>원격 경로</label>
                      <input
                        id={f('scpPath')}
                        type="text"
                        value={scpRemotePath}
                        onChange={(e) => setScpRemotePath(e.target.value)}
                        onKeyDown={runKeyDown}
                        placeholder="/tmp/uploaded.txt"
                        aria-describedby={f('verdict')}
                        className={`${INPUT} font-mono`}
                      />
                      <p id={f('verdict')} aria-live="polite" className="mt-1.5 text-xs flex items-start gap-1.5 text-status-critical">
                        <span className="shrink-0 rounded-full border border-current px-2 font-semibold">변경 명령</span>
                        <span>같은 경로의 파일을 덮어쓰므로 실행 전에 확인합니다.</span>
                      </p>
                    </div>
                    <div>
                      <label htmlFor={f('scpContent')} className={`${LABEL} flex items-center gap-1`}>
                        <FileText className="w-3 h-3" aria-hidden /> 업로드할 내용
                      </label>
                      <textarea
                        id={f('scpContent')}
                        value={scpContent}
                        onChange={(e) => setScpContent(e.target.value)}
                        onKeyDown={runKeyDown}
                        placeholder="업로드할 파일 내용"
                        rows={5}
                        className={`${INPUT} text-xs font-mono resize-y`}
                      />
                      <div className="mt-1 flex items-center gap-3 flex-wrap">
                        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          <Upload className="w-3 h-3" aria-hidden /> 파일에서 불러오기
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const reader = new FileReader();
                              reader.onload = (ev) => {
                                if (typeof ev.target?.result === 'string') setScpContent(ev.target.result);
                              };
                              reader.readAsText(file);
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => setRemoteFetchOpen((v) => !v)}
                          aria-expanded={remoteFetchOpen}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <FolderInput className="w-3 h-3" aria-hidden /> 다른 노드에서 불러오기
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadBlob(
                            scpContent, basenameOf(scpRemotePath, 'scp-content.txt'), 'text/plain', false,
                          )}
                          disabled={!scpContent}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="현재 업로드 내용을 내 컴퓨터에 파일로 저장"
                        >
                          <Download className="w-3 h-3" aria-hidden /> 로컬에 저장
                        </button>
                      </div>

                      {remoteFetchOpen && (
                        <div className="mt-2 p-2.5 bg-secondary/30 border border-border rounded-md space-y-2">
                          <div>
                            <label htmlFor={f('fetchSrc')} className="block text-xs text-muted-foreground mb-1">원본 노드</label>
                            <select
                              id={f('fetchSrc')}
                              value={fetchSourceKey}
                              onChange={(e) => setFetchSourceKey(e.target.value)}
                              className={SMALL_INPUT}
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
                              className={`${SMALL_INPUT} font-mono`}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            위 인증 정보(사용자/포트/비밀번호|키)를 그대로 사용해 텍스트 파일을 읽어옵니다. 조회 전용이라 확인 없이 실행됩니다.
                          </p>
                          {fetchFileMutation.isPending ? (
                            <button
                              type="button"
                              onClick={fetchFileMutation.abort}
                              className="w-full flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl bg-secondary hover:bg-secondary/80 text-foreground border border-border"
                            >
                              <Square className="w-3 h-3 fill-current" aria-hidden /> 중지
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void doFetchFile()}
                              disabled={!!fetchDeniedHint || !fetchSourceKey || !fetchRemotePath.trim()}
                              title={fetchDeniedHint ?? '원본 노드의 텍스트 파일을 업로드 내용으로 불러오기'}
                              aria-label={fetchDeniedHint ? `불러오기 — ${fetchDeniedHint}` : '불러오기'}
                              className="w-full flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <FolderInput className="w-3 h-3" aria-hidden />
                              불러오기
                            </button>
                          )}
                          {fetchTrace && (fetchTrace.steps?.length || fetchTrace.commands?.length) ? (
                            <div className="pt-1 border-t border-border space-y-2">
                              <ExecutionStepsTimeline steps={fetchTrace.steps} />
                              <CommandTraceList commands={fetchTrace.commands ?? []} />
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* 고급 설정 — 실행 방식·제한 시간·묶음 */}
                <details className="group">
                  <summary className="cursor-pointer text-sm font-semibold list-none flex items-center gap-1.5">
                    <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" aria-hidden />
                    고급 설정
                    <span className="text-xs font-normal text-muted-foreground truncate">{advancedSummary}</span>
                  </summary>
                  <div className="mt-2 space-y-3">
                    <div>
                      <p id={f('modeLabel')} className={LABEL}>실행 방식</p>
                      <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px" role="group" aria-labelledby={f('modeLabel')}>
                        {(['parallel', 'sequential'] as const).map((m) => (
                          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={`flex-1 ${SEG_BTN(mode === m)}`}>
                            {m === 'parallel' ? <><Zap className="w-3 h-3 inline mr-1" aria-hidden />병렬</> : '순차'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {mode === 'parallel' && (
                        <div>
                          <label htmlFor={f('par')} className={LABEL}>동시성</label>
                          <input id={f('par')} type="number" min={1} max={50} value={parallelism} onChange={(e) => setParallelism(Number(e.target.value) || 1)} className={SMALL_INPUT} />
                        </div>
                      )}
                      <div>
                        <label htmlFor={f('cto')} className={LABEL}>연결 제한 시간(초)</label>
                        <input id={f('cto')} type="number" min={1} max={60} value={connectTimeout} onChange={(e) => setConnectTimeout(Number(e.target.value) || 8)} className={SMALL_INPUT} />
                      </div>
                      <div>
                        <label htmlFor={f('eto')} className={LABEL}>실행 제한 시간(초)</label>
                        <input id={f('eto')} type="number" min={1} max={600} value={execTimeout} onChange={(e) => setExecTimeout(Number(e.target.value) || 60)} className={SMALL_INPUT} />
                      </div>
                      <div>
                        <label htmlFor={f('chunk')} className={LABEL}>묶음 크기(개)</label>
                        <input id={f('chunk')} type="number" min={1} max={200} value={chunkSize} onChange={(e) => setChunkSize(Number(e.target.value) || 30)} className={SMALL_INPUT} />
                      </div>
                      <div>
                        <label htmlFor={f('pause')} className={LABEL}>묶음 간 대기(ms)</label>
                        <input id={f('pause')} type="number" min={0} max={5000} step={50} value={chunkPauseMs} onChange={(e) => setChunkPauseMs(Number(e.target.value) || 0)} className={SMALL_INPUT} />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      노드별 SSH 접속·명령 실행 최대 시간입니다. 묶음 크기만큼 병렬 실행한 뒤 대기 시간만큼 쉬고 다음 묶음으로 넘어갑니다(베스천·게이트웨이 순간 부하 완화).
                    </p>
                  </div>
                </details>

                {/* 대규모 실행 예상 시간 힌트 */}
                {selected.size >= 50 && (
                  <div className="px-3 py-2 text-xs rounded-md bg-status-warning/10 border border-status-warning/30 text-status-warning flex items-start gap-2">
                    <Clock className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
                    <div>
                      선택 {selected.size}개 호스트 · 동시성 {parallelism} / 묶음 {chunkSize}개 ·
                      예상 소요 시간 <strong className="font-mono">최소 {Math.ceil(selected.size / chunkSize) * Math.ceil(execTimeout / 10)}초 ~ 최대 {Math.ceil(selected.size / chunkSize) * (execTimeout + connectTimeout)}초</strong>.
                      실행 중 버튼이 "중지"로 바뀌며 언제든 취소할 수 있습니다.
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 실행 바 — 스크롤과 무관하게 항상 보인다. */}
            <div className="border-t border-border p-3 space-y-2">
              {alertMessage && (
                <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                  {alertMessage}
                </div>
              )}
              {runMutation.isPending ? (
                <button
                  type="button"
                  onClick={runMutation.abort}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                >
                  <Square className="w-4 h-4 fill-current" aria-hidden />
                  중지
                </button>
              ) : (
                <button
                  type="button"
                  onClick={requestRun}
                  disabled={!canRun}
                  title={runDeniedHint ?? (canRun
                    ? (verdict.readOnly ? '선택한 노드에 바로 실행(조회 명령)' : '확인 후 선택한 노드에 실행')
                    : '노드·인증 정보·명령(또는 원격 경로)을 입력하세요')}
                  aria-label={runDeniedHint ? `${runLabel} — ${runDeniedHint}` : runLabel}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {action === 'ssh' ? <Play className="w-4 h-4" aria-hidden /> : <Upload className="w-4 h-4" aria-hidden />}
                  {runLabel}
                </button>
              )}
              <p className="text-center text-xs text-muted-foreground">
                <kbd className="px-1 rounded border border-border bg-secondary">Ctrl</kbd>+<kbd className="px-1 rounded border border-border bg-secondary">Enter</kbd> 로도 실행
              </p>
            </div>
          </MacCard>

          {/* 우: 실행 로그(중심) + 결과 — 항상 같은 위치, 실행 전엔 대기 상태 */}
          <div className="min-w-0 min-h-0 flex flex-col gap-3">
            <div className="flex flex-col min-h-[240px] lg:min-h-0 flex-[3]">
              <RunLogPanel
                run={runLog}
                show={showLog}
                onShowChange={setShowLog}
                fill
                idleHint="실행하면 요청·노드별 접속·결과 요약이 여기에 실시간으로 쌓입니다."
              />
            </div>
            <div className="flex flex-col min-h-[200px] lg:min-h-0 flex-[2]">
              {!runResponse ? (
                <div className="min-w-0 flex-1 flex items-center justify-center min-h-[120px] rounded-md border border-border">
                  <EmptyState
                    compact
                    icon={action === 'ssh' ? Terminal : Upload}
                    title="아직 실행 결과가 없습니다."
                    description={action === 'ssh' ? '명령을 실행하면 노드별 결과가 여기에 표시됩니다.' : '파일을 업로드하면 노드별 결과가 여기에 표시됩니다.'}
                  />
                </div>
              ) : (
              <MacCard
                title={action === 'ssh' ? '실행 결과' : '업로드 결과'}
                rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
                bodyPadding="p-0"
                className="flex-1 min-h-0 flex flex-col"
                titleExtra={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                      성공 {runResponse.okCount}
                    </span>
                    {/* 0 은 중립(§12.12-2) — 실패가 있을 때만 상태색. */}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      runResponse.errorCount > 0
                        ? 'bg-status-critical/10 text-status-critical border-status-critical/30'
                        : 'bg-secondary text-muted-foreground border-border'
                    }`}>
                      실패 {runResponse.errorCount}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {runResponse.totalDurationMs}ms · {runResponse.mode}
                    </span>
                  </span>
                }
                actions={<>
                    {/* 뷰 모드 토글 */}
                    <div className="flex items-center bg-secondary/60 rounded-xl p-[2px] gap-px" role="group" aria-label="결과 보기 방식">
                      <button type="button" onClick={() => setResultView('summary')}
                        aria-pressed={resultView === 'summary'}
                        className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                          resultView === 'summary' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        title="모든 노드 한 줄 요약">
                        <LayoutList className="w-3 h-3" aria-hidden /> 요약
                      </button>
                      <button type="button" onClick={() => setResultView('detail')}
                        aria-pressed={resultView === 'detail'}
                        className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                          resultView === 'detail' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        title="호스트별 stdout/stderr 전체">
                        <Rows className="w-3 h-3" aria-hidden /> 상세
                      </button>
                    </div>

                    {/* 공통 필터 */}
                    <div className="relative">
                      <input
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder="공통 필터…"
                        aria-label="실행 결과 공통 필터"
                        className="pl-2 pr-6 py-1 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary w-36"
                      />
                      {globalFilter && (
                        <button
                          type="button"
                          onClick={() => setGlobalFilter('')}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          title="필터 지우기"
                          aria-label="필터 지우기"
                        ><X className="w-3.5 h-3.5" aria-hidden /></button>
                      )}
                    </div>

                    {/* 내보내기 */}
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => downloadBlob(
                          resultsToCsv(runResponse.results, globalFilter, current?.label ?? ''),
                          `bulk-exec-${exportTs()}.csv`,
                          'text/csv',
                        )}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
                        title="필터 반영 CSV 내보내기">
                        <Download className="w-3 h-3" aria-hidden /> CSV
                      </button>
                      <button type="button" onClick={() => downloadBlob(
                          resultsToTxt(runResponse.results, globalFilter, current?.label ?? ''),
                          `bulk-exec-${exportTs()}.txt`,
                          'text/plain',
                        )}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
                        title="필터 반영 텍스트 내보내기">
                        <Download className="w-3 h-3" aria-hidden /> TXT
                      </button>
                      <button type="button" onClick={async () => {
                          const ok = await copyToClipboard(resultsToTxt(runResponse.results, globalFilter, current?.label ?? ''));
                          setCopyToast(ok ? '클립보드에 복사됨' : '복사 실패');
                          setTimeout(() => setCopyToast(null), 1500);
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
                        title="필터 반영 결과 클립보드 복사">
                        <FileText className="w-3 h-3" aria-hidden /> 복사
                      </button>
                    </div>
                </>}
              >
                {copyToast && (
                  <div role="status" className="px-3 py-1.5 text-xs bg-primary/5 text-primary border-b border-primary/20">
                    {copyToast}
                  </div>
                )}

                {/* 스크롤은 여기 한 겹뿐 — 행 안의 ExecOutputTabs 는 max-h-none. */}
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
              </MacCard>
              )}
            </div>
          </div>
        </div>
        </div>
      </PageShell>

      {/* 변경 명령 확인 모달 — bash 조회 명령은 확인 없이 실행한다(§12.6.1-1). SCP 는 원격 파일을 덮어쓰므로 항상 danger(D-161). */}
      <ConfirmDialog
        open={confirmOpen}
        title={action === 'ssh' ? '변경 명령 일괄 실행 확인' : '노드 일괄 SCP 업로드 확인'}
        description={action === 'ssh'
          ? `${clusterIds.length}개 클러스터의 ${selectedHosts.length}개 노드에 ${mode === 'parallel' ? '병렬' : '순차'}로 실행합니다. 조회 명령으로 판정되지 않아 노드 상태를 되돌릴 수 없게 바꿀 수 있습니다.`
          : `${selectedHosts.length}개 노드의 ${scpRemotePath} 에 업로드합니다. 같은 경로에 파일이 있으면 덮어씁니다.`}
        confirmLabel={action === 'ssh' ? '실행' : '덮어쓰기 업로드'}
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void doRun(); }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">접속 정보</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">(선택된 {selectedHosts.length}개 host, {clusterIds.length}개 클러스터)</span>
              <span className="text-muted-foreground">:{port}</span>
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded border border-border bg-secondary">
                {authLabel}
              </span>
            </p>
          </div>
          {action === 'ssh' ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                실행할 명령
                <span className="text-xs px-1.5 py-0.5 rounded border border-border bg-secondary">{language}</span>
              </p>
              <pre className="text-xs font-mono bg-background border border-border rounded p-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
                {command}
              </pre>
              {verdict.reason && (
                <p className="mt-2 text-sm text-status-critical flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  {verdict.reason}
                </p>
              )}
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">업로드 대상(덮어쓰기)</p>
              <p className="font-mono font-semibold text-status-critical break-all">{scpRemotePath}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                크기: {new Blob([scpContent]).size} bytes · 기존 파일은 백업 없이 교체됩니다.
              </p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">대상 호스트 (클러스터별)</p>
            <div className="text-xs font-mono max-h-40 overflow-auto bg-background border border-border rounded p-2 space-y-1.5">
              {Object.entries(
                selectedHosts.reduce<Record<string, typeof selectedHosts>>((acc, t) => {
                  const k = t.clusterName || t.clusterId || '-';
                  (acc[k] = acc[k] || []).push(t);
                  return acc;
                }, {})
              ).map(([cname, items]) => (
                <div key={cname}>
                  <p className="text-xs font-medium text-muted-foreground">
                    {cname} <span className="text-muted-foreground">({items.length})</span>
                  </p>
                  {items.slice(0, 8).map((t) => (
                    <div key={`${t.clusterId}::${t.name}`} className="pl-2">
                      <span className="text-foreground">{t.name}</span>
                      {t.host !== t.name && <span className="text-muted-foreground"> ({t.host})</span>}
                    </div>
                  ))}
                  {items.length > 8 && (
                    <div className="pl-2 text-muted-foreground">외 {items.length - 8}개</div>
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
