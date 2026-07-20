import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Download, Upload, AlertTriangle, CheckCircle2, Loader2,
  Info, HardDrive, RotateCcw, Trash2,
} from 'lucide-react';
import { backupApi } from '@/services/api';
import type { BackupImportResponse } from '@/services/api';
import { ConfirmDialog, useToast } from '@/components/common';
import { formatApiError, parseUTC } from '@/lib/utils';

type Mode = 'merge' | 'replace';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function BackupRestorePanel() {
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
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const totalRows = metaQ.data?.totalRows ?? 0;
  const logTableRows = useMemo(() => {
    if (!metaQ.data) return 0;
    return metaQ.data.tables.filter((t) => t.isLog).reduce((s, t) => s + t.rows, 0);
  }, [metaQ.data]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await backupApi.exportDownload(exportIncludeLogs, exportIncludeSensitive);
      const blob = r.data instanceof Blob ? r.data : new Blob([JSON.stringify(r.data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `k8s-monitor-backup-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('백업 파일 다운로드');
    } catch (e: unknown) {
      toast.error('내보내기 실패', formatApiError(e));
    } finally {
      setExporting(false);
    }
  };

  const handlePreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setResultMsg(null);
    try {
      const r = await backupApi.importPreview(file, mode, includeLogs);
      setPreview(r.data);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setResultMsg(`미리보기 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const doApply = async () => {
    if (!file || !preview) return;
    setApplying(true);
    setResultMsg(null);
    try {
      const r = await backupApi.importApply(file, mode, includeLogs, mode === 'replace');
      const d = r.data;
      setResultMsg(
        `✓ 복구 완료 — 신규 ${d.inserted} · 업데이트 ${d.updated} · 삭제 ${d.deleted}` +
        (d.errors.length ? ` · 오류 ${d.errors.length}건` : ''),
      );
      metaQ.refetch();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setResultMsg(`복구 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setApplying(false);
      setConfirmReplace(false);
    }
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
    setResultMsg(null);
  };

  return (
    <div className="space-y-5">
      {/* ── 현재 DB 요약 ─────────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-xl p-5">
        <header className="flex items-center gap-2 mb-3">
          <HardDrive className="w-5 h-5 text-primary" />
          <h2 className="font-semibold">현재 데이터</h2>
          {metaQ.isLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground ml-1" />}
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div>
            <p className="text-xs text-muted-foreground">전체 테이블</p>
            <p className="text-xl font-bold">{metaQ.data?.tables.length ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">총 Row</p>
            <p className="text-xl font-bold">{totalRows.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">사용자 데이터 row</p>
            <p className="text-xl font-bold text-emerald-500">{(totalRows - logTableRows).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">로그성 row</p>
            <p className="text-xl font-bold text-amber-500">{logTableRows.toLocaleString()}</p>
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            테이블별 row 수 보기
          </summary>
          <div className="mt-2 max-h-60 overflow-y-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr className="text-left text-xs text-muted-foreground uppercase">
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
                        <span className="text-xs text-amber-500">log</span>
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
      </section>

      {/* ── 백업 (Export) ────────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-xl p-5">
        <header className="flex items-center gap-2 mb-3">
          <Download className="w-5 h-5 text-emerald-500" />
          <h2 className="font-semibold">백업 (Export)</h2>
        </header>
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
            <span>민감 필드 포함 <span className="text-amber-500">(kubeconfig 내용 등 — 파일 유출 시 보안 위험)</span></span>
          </label>
        </div>

        <button onClick={handleExport} disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {exporting ? '내보내는 중...' : '백업 파일 다운로드'}
        </button>
      </section>

      {/* ── 복구 (Import) ────────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-xl p-5">
        <header className="flex items-center gap-2 mb-3">
          <Upload className="w-5 h-5 text-sky-500" />
          <h2 className="font-semibold">복구 (Import)</h2>
        </header>

        <div className="px-3 py-2 mb-3 rounded-lg bg-sky-500/5 border border-sky-500/20 text-xs text-foreground/80 flex items-start gap-2">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-sky-500" />
          <div>
            <strong>병합(merge)</strong>: PK 기준 upsert — 백업에 없는 기존 row 는 유지. 안전한 기본값.<br/>
            <strong>덮어쓰기(replace)</strong>: 대상 테이블 전체 DELETE 후 INSERT. 백업 내용과 100% 일치. <span className="text-amber-500">현재 데이터가 백업에 없으면 사라짐.</span>
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
                  if (f) { setFile(f); setPreview(null); setResultMsg(null); }
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
                    mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/80 hover:text-foreground'
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
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 text-xs">
                    신규 합계 {preview.diff.tables.reduce((s, t) => s + t.insertCount, 0)}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/30 text-xs">
                    업데이트 합계 {preview.diff.tables.reduce((s, t) => s + t.updateCount, 0)}
                  </span>
                  {mode === 'replace' && (
                    <span className="px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500 border border-red-500/30 text-xs">
                      삭제 예정 {preview.diff.tables.reduce((s, t) => s + t.deleteCandidates, 0)}
                    </span>
                  )}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 sticky top-0">
                    <tr className="text-xs text-muted-foreground uppercase text-left">
                      <th className="px-2 py-1">테이블</th>
                      <th className="px-2 py-1 text-right">현재</th>
                      <th className="px-2 py-1 text-right">백업</th>
                      <th className="px-2 py-1 text-right text-emerald-500">신규</th>
                      <th className="px-2 py-1 text-right text-amber-500">업데이트</th>
                      <th className="px-2 py-1 text-right text-red-500">{mode === 'replace' ? '삭제 예정' : '유지'}</th>
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
                        <td className="px-2 py-1 text-right font-mono text-emerald-500">{t.insertCount}</td>
                        <td className="px-2 py-1 text-right font-mono text-amber-500">{t.updateCount}</td>
                        <td className="px-2 py-1 text-right font-mono text-red-500">{mode === 'replace' ? t.deleteCandidates : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {resultMsg && (
            <div className={`px-3 py-2 rounded-lg text-sm border ${
              resultMsg.startsWith('✓')
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            }`}>
              {resultMsg}
            </div>
          )}

          {/* apply */}
          <div className="flex items-center justify-end pt-2 border-t border-border">
            <button onClick={handleApply}
              disabled={!file || !preview || applying}
              className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg text-primary-foreground disabled:opacity-50 ${
                mode === 'replace' ? 'bg-red-500 hover:bg-red-600' : 'bg-primary hover:bg-primary/90'
              }`}>
              {applying
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : mode === 'replace' ? <Trash2 className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              {mode === 'replace' ? '덮어쓰기 실행' : '병합 적용'}
            </button>
          </div>
        </div>
      </section>

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
          <p className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-red-500" /> 현재 DB 의 사용자 데이터 {totalRows.toLocaleString()} row 중 백업에 없는 row 는 모두 사라집니다.</p>
          <p>· 파일: <span className="font-mono">{file?.name}</span></p>
          <p>· 모드: <span className="font-mono text-red-500">replace</span> (병합 아님)</p>
        </div>
      </ConfirmDialog>

      {/* ── 도움말 ──────────────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-xl p-5 text-sm text-muted-foreground space-y-1.5">
        <p className="flex items-center gap-2 text-foreground font-medium">
          <Database className="w-4 h-4" /> 사용 팁
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>정기 백업은 내보내기 버튼을 눌러 파일을 내려받고 별도 저장소에 보관하세요.</li>
          <li>다른 환경(kind → 운영)으로 이전할 때 병합 모드로 안전하게 가져올 수 있습니다.</li>
          <li>덮어쓰기 모드는 신규 환경 초기 시드에만 사용하세요.</li>
          <li>로그성 테이블(check_logs 등) 은 재생성 가능하므로 기본적으로 백업에서 제외됩니다.</li>
          <li>민감 필드(kubeconfig) 포함 옵션은 파일이 안전한 저장소에 보관됨을 확인 후 사용하세요.</li>
        </ul>
      </section>
    </div>
  );
}
