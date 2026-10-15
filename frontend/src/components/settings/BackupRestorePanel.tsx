import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Download, Upload, AlertTriangle, CheckCircle2, Loader2,
  Info, HardDrive, RotateCcw, Trash2,
} from 'lucide-react';
import { backupApi } from '@/services/api';
import type { BackupImportResponse } from '@/services/api';
import { ConfirmDialog, EmptyState, RunLogPanel, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
import { formatApiError, parseUTC } from '@/lib/utils';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useAuthStore, hasRole } from '@/stores/authStore';

type Mode = 'merge' | 'replace';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 백업은 kubeconfig·자격증명을 포함한 전체 DB 반출이라 서버가 meta/export/import 모두 admin 만
 * 허용한다. admin 이 아니면 403 을 연달아 맞는 대신 탭 안에서 사유를 먼저 보여준다.
 */
export function BackupRestorePanel() {
  const user = useAuthStore((s) => s.user);
  if (!hasRole(user, 'admin')) {
    return (
      <EmptyState
        icon={Info}
        title="관리자 전용 기능입니다"
        description={`백업 / 복구는 kubeconfig·자격증명 등 전체 데이터를 다루므로 admin 권한이 필요합니다 (현재: ${user?.role ?? '미로그인'}).`}
      />
    );
  }
  return <BackupRestorePanelBody />;
}

function BackupRestorePanelBody() {
  // 현재 DB 메타
  const toast = useToast();
  const metaQ = useQuery({
    queryKey: ['backup-meta'],
    queryFn: () => backupApi.meta().then((r) => r.data),
    staleTime: 30_000,
  });

  // Export 옵션
  const [exportIncludeLogs, setExportIncludeLogs] = useState(false);
  const [exportIncludeSensitive, setExportIncludeSensitive] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Import 상태
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>('merge');
  const [includeLogs, setIncludeLogs] = useState(false);
  const [preview, setPreview] = useState<BackupImportResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  // 실행 로그 — 내보내기·미리보기·적용의 요청·소요·테이블별 요약·오류(errors[] 개별 줄)를 남긴다(D-135).
  // 이전의 인라인 결과 문구(resultMsg)는 이 로그와 역할이 같아 대체했다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('settings-backup');
  // 로그 패널은 마지막 실행의 버튼 근처에 — 내보내기 카드 또는 복구 카드.
  const [logScope, setLogScope] = useState<'export' | 'import'>('export');

  const totalRows = metaQ.data?.totalRows ?? 0;
  const logTableRows = useMemo(() => {
    if (!metaQ.data) return 0;
    return metaQ.data.tables.filter((t) => t.isLog).reduce((s, t) => s + t.rows, 0);
  }, [metaQ.data]);

  const handleExport = async () => {
    setExporting(true);
    setLogScope('export');
    const opts = [
      exportIncludeLogs ? '로그성 테이블 포함' : '로그성 테이블 제외',
      exportIncludeSensitive ? '민감 필드 포함' : '민감 필드 마스킹',
    ].join(' · ');
    const filename = `k8s-monitor-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const r = await runLogged(runLog, {
      title: '백업 내보내기',
      first: `전체 테이블 JSON 내보내기 요청 — ${opts}`,
      fn: async () => {
        const res = await backupApi.exportDownload(exportIncludeLogs, exportIncludeSensitive);
        return res.data instanceof Blob ? res.data : new Blob([JSON.stringify(res.data)], { type: 'application/json' });
      },
      summarize: (blob): RunLogEntry[] => [
        ['info', `파일 ${filename} · ${formatBytes(blob.size)}`],
        ['info', '브라우저 다운로드 시작'],
      ],
    });
    if (r.ok) {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('백업 파일 다운로드');
    } else if (!r.aborted) {
      toast.error('내보내기 실패', formatApiError(r.error));
    }
    setExporting(false);
  };

  // 테이블별 diff 요약 줄 — 변화가 있는 테이블만, 합계 줄을 마지막에.
  const diffLines = (d: BackupImportResponse, m: Mode): RunLogEntry[] => {
    const tables = d.diff.tables.filter((t) => t.insertCount > 0 || t.updateCount > 0 || (m === 'replace' && t.deleteCandidates > 0));
    const out: RunLogEntry[] = [[
      'info',
      `${d.diff.version ? `백업 버전 ${d.diff.version}` : '버전 미상'} · 백업 ${d.diff.totalIncoming.toLocaleString()}행 · 현재 ${d.diff.totalExisting.toLocaleString()}행`,
    ]];
    for (const t of tables) {
      out.push(['info', `${t.name} — 신규 ${t.insertCount} · 업데이트 ${t.updateCount}${m === 'replace' ? ` · 삭제 예정 ${t.deleteCandidates}` : ''}`]);
    }
    const sum = (k: 'insertCount' | 'updateCount' | 'deleteCandidates') => d.diff.tables.reduce((s, t) => s + t[k], 0);
    out.push([
      m === 'replace' && sum('deleteCandidates') > 0 ? 'warn' : 'info',
      `변경 테이블 ${tables.length}개 · 신규 ${sum('insertCount')} · 업데이트 ${sum('updateCount')}${m === 'replace' ? ` · 삭제 예정 ${sum('deleteCandidates')}` : ''}`,
    ]);
    for (const e of d.errors ?? []) out.push(['error', `오류 — ${e}`]);
    return out;
  };

  const handlePreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setLogScope('import');
    const r = await runLogged(runLog, {
      title: '복구 미리보기 (diff)',
      first: `${file.name} (${formatBytes(file.size)}) 분석 요청 — ${mode === 'replace' ? '덮어쓰기' : '병합'} · 로그성 테이블 ${includeLogs ? '포함' : '제외'}`,
      fn: () => backupApi.importPreview(file, mode, includeLogs).then((res) => res.data),
      summarize: (d) => diffLines(d, mode),
    });
    if (r.ok) setPreview(r.data);
    else if (!r.aborted) toast.error('미리보기 실패', formatApiError(r.error));
    setPreviewing(false);
  };

  const doApply = async () => {
    if (!file || !preview) return;
    setApplying(true);
    setConfirmReplace(false);
    setLogScope('import');
    const r = await runLogged(runLog, {
      title: mode === 'replace' ? '복구 — 덮어쓰기' : '복구 — 병합',
      first: `${file.name} 적용 요청 — ${mode === 'replace' ? '대상 테이블 전체 교체' : 'PK 기준 upsert'} · 로그성 테이블 ${includeLogs ? '포함' : '제외'}`,
      fn: () => backupApi.importApply(file, mode, includeLogs, mode === 'replace').then((res) => res.data),
      summarize: (d): RunLogEntry[] => [
        [d.errors.length ? 'warn' : 'info', `복구 ${d.errors.length ? '부분 완료' : '완료'} — 신규 ${d.inserted} · 업데이트 ${d.updated} · 삭제 ${d.deleted}${d.errors.length ? ` · 오류 ${d.errors.length}건` : ''}`],
        ...d.errors.map((e): RunLogEntry => ['error', `오류 — ${e}`]),
      ],
    });
    if (r.ok) {
      if (r.data.errors.length) {
        setShowLog(true);
        toast.warning('복구 부분 완료', `오류 ${r.data.errors.length}건 — 실행 로그에서 확인하세요.`);
      } else {
        toast.success('복구 완료', `신규 ${r.data.inserted} · 업데이트 ${r.data.updated} · 삭제 ${r.data.deleted}`);
      }
      metaQ.refetch();
    } else if (!r.aborted) {
      toast.error('복구 실패', formatApiError(r.error));
    }
    setApplying(false);
  };

  const handleApply = () => {
    if (mode === 'replace') {
      setConfirmReplace(true);
    } else {
      doApply();
    }
  };

  const resetImport = () => {
    setFile(null);
    setPreview(null);
  };

  return (
    <div className="space-y-5">
      {/* ── 현재 DB 요약 ─────────────────────────────────────────────────── */}
      <MacCard
        title="현재 데이터"
        icon={HardDrive}
        titleExtra={metaQ.isLoading ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" aria-label="불러오는 중" /> : undefined}
      >

        <StatTileRow className="mb-4">
          <StatTile label="전체 테이블" value={metaQ.data?.tables.length ?? 0} />
          <StatTile label="총 행" value={totalRows.toLocaleString()} />
          <StatTile label="사용자 데이터 행" value={(totalRows - logTableRows).toLocaleString()} />
          <StatTile label="로그성 행" value={logTableRows.toLocaleString()} />
        </StatTileRow>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            테이블별 row 수 보기
          </summary>
          <div className="mt-2 max-h-60 overflow-y-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr className="text-left text-xs font-medium text-muted-foreground">
                  <th className="px-2 py-1">테이블</th>
                  <th className="px-2 py-1 text-right">Rows</th>
                  <th className="px-2 py-1">유형</th>
                </tr>
              </thead>
              <tbody>
                {metaQ.data?.tables.map((t) => (
                  <tr key={t.name} className="border-t border-border">
                    <td className="px-2 py-1 font-mono">{t.name}</td>
                    <td className="px-2 py-1 text-right font-mono">{t.rows.toLocaleString()}</td>
                    <td className="px-2 py-1">
                      {t.isLog ? (
                        <span className="text-xs text-status-warning">log</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">data</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </MacCard>

      {/* ── 백업 (Export) ────────────────────────────────────────────────── */}
      <MacCard title="백업 (내보내기)" icon={Download}>
        <p className="text-sm text-muted-foreground mb-3">
          현재 모든 테이블을 JSON 한 파일로 내보냅니다. 별도 PostgreSQL 백업 없이도 앱 레벨 복구 가능.
        </p>

        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={exportIncludeLogs}
              onChange={(e) => setExportIncludeLogs(e.target.checked)} />
            <span>로그성 테이블 포함 <span className="text-muted-foreground">(check_logs / daily_check_logs / cluster_config_snapshots / trend_* / ontology_events 등 — 파일 크기 증가, 대부분 재생성 가능)</span></span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={exportIncludeSensitive}
              onChange={(e) => setExportIncludeSensitive(e.target.checked)} />
            <span>민감 필드 포함 <span className="text-status-warning">(kubeconfig 내용 등 — 파일 유출 시 보안 위험)</span></span>
          </label>
        </div>

        <button onClick={handleExport} disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {exporting ? '내보내는 중…' : '백업 파일 다운로드'}
        </button>
        {logScope === 'export' && (
          <div className="mt-3">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          </div>
        )}
      </MacCard>

      {/* ── 복구 (Import) ────────────────────────────────────────────────── */}
      <MacCard title="복구 (가져오기)" icon={Upload}>

        <div className="px-3 py-2 mb-3 rounded-lg bg-status-info/5 border border-status-info/20 text-xs text-foreground/80 flex items-start gap-2">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-status-info" />
          <div>
            <strong>병합(merge)</strong>: PK 기준 upsert — 백업에 없는 기존 row 는 유지. 안전한 기본값.<br/>
            <strong>덮어쓰기(replace)</strong>: 대상 테이블 전체 DELETE 후 INSERT. 백업 내용과 100% 일치. <span className="text-status-warning">현재 데이터가 백업에 없으면 사라짐.</span>
          </div>
        </div>

        <div className="space-y-3">
          {/* 파일 + 옵션 */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              백업 파일 선택
              <input type="file" accept=".json,application/json" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setFile(f); setPreview(null); }
                }} />
            </label>
            {file && (
              <span className="text-sm text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
              </span>
            )}
            {file && (
              <button onClick={resetImport}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> 초기화
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
              {(['merge', 'replace'] as Mode[]).map((m) => (
                <button key={m} onClick={() => { setMode(m); setPreview(null); }}
                  className={`px-3 py-1 text-sm font-medium rounded-md ${
                    mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  {m === 'merge' ? '병합 (merge)' : '덮어쓰기 (replace)'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={includeLogs}
                onChange={(e) => { setIncludeLogs(e.target.checked); setPreview(null); }} />
              로그성 테이블 포함
            </label>

            <button onClick={handlePreview}
              disabled={!file || previewing}
              className="ml-auto flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-50">
              {previewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Info className="w-3 h-3" />}
              미리보기 (diff)
            </button>
          </div>

          {/* diff preview */}
          {preview && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-muted/30 border-b border-border flex items-center gap-2 text-sm">
                <span className="font-semibold">
                  {preview.diff.version ? `백업 버전 ${preview.diff.version}` : '버전 미상'}
                </span>
                {preview.diff.createdAt && (
                  <span className="text-muted-foreground font-mono">
                    {parseUTC(preview.diff.createdAt).toLocaleString()}
                  </span>
                )}
                <span className="ml-auto flex gap-2">
                  <span className="px-1.5 py-0.5 rounded-full bg-status-healthy/10 text-status-healthy border border-status-healthy/30 text-xs">
                    신규 합계 {preview.diff.tables.reduce((s, t) => s + t.insertCount, 0)}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30 text-xs">
                    업데이트 합계 {preview.diff.tables.reduce((s, t) => s + t.updateCount, 0)}
                  </span>
                  {mode === 'replace' && (
                    <span className="px-1.5 py-0.5 rounded-full bg-status-critical/10 text-status-critical border border-status-critical/30 text-xs">
                      삭제 예정 {preview.diff.tables.reduce((s, t) => s + t.deleteCandidates, 0)}
                    </span>
                  )}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 sticky top-0">
                    <tr className="text-xs font-medium text-muted-foreground text-left">
                      <th className="px-2 py-1">테이블</th>
                      <th className="px-2 py-1 text-right">현재</th>
                      <th className="px-2 py-1 text-right">백업</th>
                      <th className="px-2 py-1 text-right text-status-healthy">신규</th>
                      <th className="px-2 py-1 text-right text-status-warning">업데이트</th>
                      <th className="px-2 py-1 text-right text-status-critical">{mode === 'replace' ? '삭제 예정' : '유지'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.diff.tables
                      .filter((t) => t.incoming > 0 || t.existing > 0)
                      .map((t) => (
                      <tr key={t.name} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{t.name}</td>
                        <td className="px-2 py-1 text-right font-mono text-muted-foreground">{t.existing}</td>
                        <td className="px-2 py-1 text-right font-mono">{t.incoming}</td>
                        <td className="px-2 py-1 text-right font-mono text-status-healthy">{t.insertCount}</td>
                        <td className="px-2 py-1 text-right font-mono text-status-warning">{t.updateCount}</td>
                        <td className="px-2 py-1 text-right font-mono text-status-critical">{mode === 'replace' ? t.deleteCandidates : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 실행 로그 — 미리보기·적용의 수명주기와 테이블별 요약, 적용 오류(errors[])는 한 줄씩 */}
          {logScope === 'import' && (
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          )}

          {/* apply */}
          <div className="flex items-center justify-end pt-2 border-t border-border">
            <button onClick={handleApply}
              disabled={!file || !preview || applying}
              className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg text-primary-foreground disabled:opacity-50 ${
                mode === 'replace' ? 'bg-status-critical hover:bg-status-critical' : 'bg-primary hover:bg-primary/90'
              }`}>
              {applying
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : mode === 'replace' ? <Trash2 className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              {mode === 'replace' ? '덮어쓰기 실행' : '병합 적용'}
            </button>
          </div>
        </div>
      </MacCard>

      <ConfirmDialog
        open={confirmReplace}
        title="전체 덮어쓰기 확인"
        description="대상 테이블의 모든 기존 row 가 삭제되고 백업 내용으로 교체됩니다. 이 작업은 되돌릴 수 없습니다."
        confirmLabel="덮어쓰기 실행"
        danger
        onCancel={() => setConfirmReplace(false)}
        onConfirm={doApply}
      >
        <div className="text-sm space-y-1">
          <p className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-status-critical" /> 현재 DB 의 사용자 데이터 {totalRows.toLocaleString()} row 중 백업에 없는 row 는 모두 사라집니다.</p>
          <p>· 파일: <span className="font-mono">{file?.name}</span></p>
          <p>· 모드: <span className="font-mono text-status-critical">replace</span> (병합 아님)</p>
        </div>
      </ConfirmDialog>

      {/* ── 도움말 ──────────────────────────────────────────────────────── */}
      <MacCard title="백업 / 복구 사용 팁" icon={Database} className="text-sm text-muted-foreground">
        <ul className="list-disc pl-4 space-y-1">
          <li>정기 백업은 내보내기 버튼을 눌러 파일을 내려받고 별도 저장소에 보관하세요.</li>
          <li>다른 환경(kind → 운영)으로 이전할 때 병합 모드로 안전하게 가져올 수 있습니다.</li>
          <li>덮어쓰기 모드는 신규 환경 초기 시드에만 사용하세요.</li>
          <li>로그성 테이블(check_logs 등) 은 재생성 가능하므로 기본적으로 백업에서 제외됩니다.</li>
          <li>민감 필드(kubeconfig) 포함 옵션은 파일이 안전한 저장소에 보관됨을 확인 후 사용하세요.</li>
        </ul>
      </MacCard>
    </div>
  );
}
