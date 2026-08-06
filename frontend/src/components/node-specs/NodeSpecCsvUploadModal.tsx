import { useMemo, useState } from 'react';
import { X, Upload, Loader2, AlertTriangle, CheckCircle2, FileSpreadsheet, Info } from 'lucide-react';
import { nodeSpecsApi } from '@/services/api';
import { useModalA11y } from '@/components/common/useModalA11y';
import type {
  NodeSpecCsvPreviewResponse, NodeSpecCsvRow,
} from '@/types';
import {
  HEADER_TO_FIELD, NODE_SPEC_COLUMNS, normalizeHeader, parseCellValue,
} from './columns';
import { ActionCountPills, ACTION_LABEL, DiffRow } from './DiffRow';

// 대용량 붙여넣기/CSV 가 UI 를 그대로 얼릴 수 있어 임계치 이상이면 경고만 하고 계속 진행
// (거부하지 않음 — 서버 처리량은 별개 문제이므로 프론트는 "느릴 수 있다"만 알려준다).
const LARGE_ROW_WARN_THRESHOLD = 2000;

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
  const seenHostnames = new Map<string, number>(); // hostname → 처음 등장한 행 번호
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
    // 같은 배치 안에서 hostname 이 겹치면 나중 행이 앞 행 결과를 조용히 덮어쓴다 —
    // apply 전에 미리 경고해 사용자가 파일을 고치고 다시 올릴 기회를 준다.
    const hostname = String(obj.hostname);
    if (seenHostnames.has(hostname)) {
      errors.push(`행 ${r + 1}: hostname "${hostname}" 이 행 ${seenHostnames.get(hostname)! + 1}과 중복 — 나중 행이 앞 행을 덮어씁니다.`);
    } else {
      seenHostnames.set(hostname, r);
    }
    rows.push(obj as NodeSpecCsvRow);
  }
  if (rows.length > LARGE_ROW_WARN_THRESHOLD) {
    errors.push(`${rows.length}행 — 대용량 업로드는 미리보기 계산이 느릴 수 있습니다. 필요하면 파일을 나눠 올리세요.`);
  }
  return { rows, errors };
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
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
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
      setApplyErrors(data.errors);
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
    setApplyErrors([]);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="node-spec-csv-upload-modal-title" className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <FileSpreadsheet className="w-5 h-5 text-primary" />
          <h2 id="node-spec-csv-upload-modal-title" className="text-sm font-semibold">CSV 업로드 — 노드 서버스펙</h2>
          <button onClick={onClose} disabled={applying} title="닫기" aria-label="닫기"
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
            <div className="px-3 py-2 rounded-lg bg-status-warning/10 border border-status-warning/30 text-xs text-status-warning">
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
                <ActionCountPills preview={preview} />
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
                ? 'bg-status-healthy/10 text-status-healthy border-status-healthy/30'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            }`}>
              <p>{resultMsg}</p>
              {/* 적용 후 오류는 건수만으론 어느 행이 실패했는지 알 수 없다 — 미리보기 단계처럼 itemize. */}
              {applyErrors.length > 0 && (
                <ul className="list-disc pl-4 mt-1 space-y-0.5 text-status-critical">
                  {applyErrors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                  {applyErrors.length > 10 && <li>... 외 {applyErrors.length - 10}건</li>}
                </ul>
              )}
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
