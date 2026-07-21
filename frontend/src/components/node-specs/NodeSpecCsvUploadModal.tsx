import { useMemo, useState } from 'react';
import { X, Upload, Loader2, AlertTriangle, CheckCircle2, FileSpreadsheet, Info } from 'lucide-react';
import { nodeSpecsApi } from '@/services/api';
import { useModalA11y } from '@/components/common/useModalA11y';
import type {
  NodeSpecCsvDiff, NodeSpecCsvPreviewResponse, NodeSpecCsvRow,
} from '@/types';
import {
  HEADER_TO_FIELD, NODE_SPEC_COLUMNS, normalizeHeader, parseCellValue,
} from './columns';

interface Props {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}

// ── 간단 CSV 파서 — RFC4180 준수(쌍따옴표 이스케이프 지원) ────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuote = true; i++; continue; }
    if (c === ',') { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // 마지막 필드
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  // 빈 행 제거
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// CSV → NodeSpecCsvRow[] 변환 (shared columns.ts 의 NODE_SPEC_COLUMNS + HEADER_TO_FIELD 사용)
function rowsFromCsv(table: string[][]): { rows: NodeSpecCsvRow[]; errors: string[] } {
  const errors: string[] = [];
  if (table.length < 2) {
    errors.push('헤더 + 데이터 최소 2행 필요');
    return { rows: [], errors };
  }
  const rawHeaders = table[0];
  const mappedFields = rawHeaders.map((h) => HEADER_TO_FIELD[normalizeHeader(h)] ?? null);
  const unknown = rawHeaders
    .map((h, i) => mappedFields[i] === null ? h : null)
    .filter((h): h is string => !!h);
  if (unknown.length > 0) {
    errors.push(`인식되지 않은 헤더(무시됨): ${unknown.join(', ')}`);
  }
  if (!mappedFields.includes('hostname')) {
    errors.push('필수 헤더 "hostname" 이 없습니다.');
    return { rows: [], errors };
  }

  // field → column 조회용
  const byField = new Map(NODE_SPEC_COLUMNS.map((c) => [c.field, c]));

  const rows: NodeSpecCsvRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const obj: Record<string, unknown> = {};
    mappedFields.forEach((field, colIdx) => {
      if (!field) return;
      const col = byField.get(field);
      if (!col) return;
      const raw = (cells[colIdx] ?? '').trim();
      if (raw === '') return;
      try {
        const parsed = parseCellValue(raw, col);
        if (parsed !== null) obj[field] = parsed;
      } catch (e) {
        errors.push(`행 ${r + 1}: ${field} — ${(e as Error).message}`);
      }
    });
    if (!obj.hostname) {
      errors.push(`행 ${r + 1}: hostname 비어있음 — 건너뜀`);
      continue;
    }
    rows.push(obj as NodeSpecCsvRow);
  }
  return { rows, errors };
}

// ── Diff 행 렌더 ─────────────────────────────────────────────────────────
const ACTION_CLS: Record<string, string> = {
  insert: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  update: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  skip:   'bg-slate-500/10 text-slate-400 border-slate-500/30',
  error:  'bg-red-500/10 text-red-500 border-red-500/30',
};
const ACTION_LABEL: Record<string, string> = {
  insert: '신규', update: '업데이트', skip: '변경없음', error: '오류',
};

function DiffRow({ d }: { d: NodeSpecCsvDiff }) {
  const changeKeys = Object.keys(d.changes);
  return (
    <tr className="border-b border-border align-top">
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{d.rowIndex + 1}</td>
      <td className="px-2 py-1.5">
        <span className={`inline-block text-xs px-1.5 py-0.5 rounded-full border ${ACTION_CLS[d.action] ?? ''}`}>
          {ACTION_LABEL[d.action] ?? d.action}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-sm">{d.hostname}</td>
      <td className="px-2 py-1.5 text-xs">
        {d.action === 'error' ? (
          <span className="text-red-500">{d.error ?? '-'}</span>
        ) : changeKeys.length === 0 ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              {changeKeys.length}개 필드 {d.action === 'insert' ? '신규' : '변경'}
            </summary>
            <table className="mt-1 text-xs font-mono w-full">
              <tbody>
                {changeKeys.map((k) => (
                  <tr key={k} className="border-t border-border/40">
                    <td className="pr-2 text-muted-foreground/80">{k}</td>
                    <td className="pr-2 text-red-400/80 line-through max-w-[180px] truncate">
                      {String(d.changes[k].old ?? '—')}
                    </td>
                    <td className="pr-2 text-emerald-400 max-w-[200px] truncate">
                      → {String(d.changes[k].new ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </td>
    </tr>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export function NodeSpecCsvUploadModal({ open, onClose, onApplied }: Props) {
  const dialogRef = useModalA11y(open, onClose);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<NodeSpecCsvRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<NodeSpecCsvPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [matchClusterScope, setMatchClusterScope] = useState(false);
  const [ignoreEmptyOnUpdate, setIgnoreEmptyOnUpdate] = useState(true);
  const [filter, setFilter] = useState<'all' | 'insert' | 'update' | 'skip' | 'error'>('all');

  const diffs = useMemo(() => {
    if (!preview) return [];
    if (filter === 'all') return preview.diffs;
    return preview.diffs.filter((d) => d.action === filter);
  }, [preview, filter]);

  const handleFile = async (f: File) => {
    setFileName(f.name);
    setPreview(null);
    setResultMsg(null);
    const text = await f.text();
    const table = parseCsv(text);
    const { rows, errors } = rowsFromCsv(table);
    setParsedRows(rows);
    setParseErrors(errors);
  };

  const handlePreview = async () => {
    if (parsedRows.length === 0) return;
    setPreviewLoading(true);
    setResultMsg(null);
    try {
      const r = await nodeSpecsApi.csvPreview({
        rows: parsedRows,
        dryRun: true,
        matchClusterScope,
        ignoreEmptyOnUpdate,
      });
      setPreview(r.data);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setResultMsg(`미리보기 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!preview || parsedRows.length === 0) return;
    setApplying(true);
    setResultMsg(null);
    try {
      const r = await nodeSpecsApi.csvApply({
        rows: parsedRows,
        dryRun: false,
        matchClusterScope,
        ignoreEmptyOnUpdate,
      });
      const data = r.data;
      setResultMsg(`✓ 신규 ${data.inserted} / 업데이트 ${data.updated} / 건너뜀 ${data.skipped}` +
        (data.errors.length ? ` · 오류 ${data.errors.length}건` : ''));
      onApplied();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setResultMsg(`적용 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setApplying(false);
    }
  };

  const reset = () => {
    setFileName(null);
    setParsedRows([]);
    setParseErrors([]);
    setPreview(null);
    setResultMsg(null);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="node-spec-csv-upload-modal-title" className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <FileSpreadsheet className="w-5 h-5 text-primary" />
          <h2 id="node-spec-csv-upload-modal-title" className="text-sm font-semibold">CSV 업로드 — 노드 서버스펙</h2>
          <button onClick={onClose} disabled={applying}
            className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 파일 선택 */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              파일 선택
              <input type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </label>
            {fileName && (
              <span className="text-sm text-muted-foreground">
                {fileName} · {parsedRows.length} 행 {parseErrors.length ? `· 경고 ${parseErrors.length}` : ''}
              </span>
            )}
            {fileName && (
              <button onClick={reset}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground">
                초기화
              </button>
            )}
          </div>

          {/* 파싱 에러/경고 */}
          {parseErrors.length > 0 && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-500">
              <p className="font-medium mb-0.5 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> 파싱 경고 {parseErrors.length}건
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {parseErrors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
                {parseErrors.length > 6 && <li>... 외 {parseErrors.length - 6}건</li>}
              </ul>
            </div>
          )}

          {/* 옵션 + 미리보기 버튼 */}
          {parsedRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-muted/20 rounded-lg border border-border">
              <label className="flex items-center gap-1.5 text-xs text-foreground/80">
                <input type="checkbox" checked={ignoreEmptyOnUpdate}
                  onChange={(e) => setIgnoreEmptyOnUpdate(e.target.checked)} />
                빈 값은 기존 값 보존
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground/80">
                <input type="checkbox" checked={matchClusterScope}
                  onChange={(e) => setMatchClusterScope(e.target.checked)} />
                cluster_id 까지 매칭
              </label>
              <button onClick={handlePreview} disabled={previewLoading}
                className="ml-auto flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50">
                {previewLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                미리보기 (diff 확인)
              </button>
            </div>
          )}

          {/* 미리보기 결과 */}
          {preview && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
                  신규 {preview.insertCount}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/30">
                  업데이트 {preview.updateCount}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400 border border-slate-500/30">
                  변경없음 {preview.skipCount}
                </span>
                {preview.errorCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 border border-red-500/30">
                    오류 {preview.errorCount}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {(['all', 'insert', 'update', 'skip', 'error'] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)}
                      className={`px-2 py-0.5 text-xs rounded-md border ${
                        filter === f ? 'bg-primary/10 text-primary border-primary/30' : 'bg-card border-border text-muted-foreground hover:text-foreground'
                      }`}>
                      {f === 'all' ? '전체' : ACTION_LABEL[f]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border border-border rounded-xl overflow-hidden max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 sticky top-0">
                    <tr className="text-left text-xs text-muted-foreground uppercase">
                      <th className="px-2 py-1.5">#</th>
                      <th className="px-2 py-1.5">동작</th>
                      <th className="px-2 py-1.5">hostname</th>
                      <th className="px-2 py-1.5">변경</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d) => <DiffRow key={d.rowIndex} d={d} />)}
                    {diffs.length === 0 && (
                      <tr><td colSpan={4} className="text-center py-4 text-sm text-muted-foreground">표시할 행 없음</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {parsedRows.length === 0 && !fileName && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground space-y-2">
              <FileSpreadsheet className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <p>CSV 파일을 업로드하세요. 첫 행은 헤더, <strong>hostname</strong> 컬럼은 필수입니다.</p>
              <details className="text-left max-w-xl mx-auto">
                <summary className="cursor-pointer text-xs text-primary hover:underline">
                  지원 헤더 전체 ({NODE_SPEC_COLUMNS.length}개) 보기 — 테이블 컬럼과 동일
                </summary>
                <div className="mt-2 text-xs font-mono grid grid-cols-3 gap-x-2 gap-y-0.5">
                  {NODE_SPEC_COLUMNS.map((c) => (
                    <span key={c.field} className="truncate" title={`${c.label} (${c.type})`}>
                      {c.csvKey}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs">한글 라벨("호스트명", "제조사" 등) 도 인식됩니다. 업로드 전 내보내기 CSV 를 템플릿으로 사용하세요.</p>
              </details>
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
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Info className="w-3 h-3" />
            적용은 미리보기로 diff 를 확인한 후에만 가능합니다.
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={applying}
              className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
              닫기
            </button>
            <button onClick={handleApply}
              disabled={!preview || preview.insertCount + preview.updateCount === 0 || applying}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50">
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              {preview ? `적용 (${preview.insertCount + preview.updateCount}건)` : '적용'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
