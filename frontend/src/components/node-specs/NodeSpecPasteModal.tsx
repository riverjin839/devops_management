import { useEffect, useMemo, useState } from 'react';
import { X, ClipboardPaste, Loader2, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { nodeSpecsApi } from '@/services/api';
import type { NodeSpecCsvDiff, NodeSpecCsvPreviewResponse, NodeSpecCsvRow } from '@/types';
import {
  NODE_SPEC_COLUMNS, HEADER_TO_FIELD, normalizeHeader, parseCellValue,
} from './columns';
import type { NodeSpecColumn } from './columns';
import type { NodeServerSpec } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  /** 페이지 테이블에 현재 표시된 컬럼 순서 (hostname 먼저 오도록 권장).
   *  여기 없으면 기본 EXPORT_COLUMNS 순서 사용. */
  displayColumns?: NodeSpecColumn[];
  /** 모달 오픈 시 자동으로 채워줄 텍스트 (전역 paste 핸들러용) */
  initialText?: string;
}

// ── TSV / CSV 둘 다 파서 ────────────────────────────────────────────────
// Excel 복사본은 기본 TSV (\t 구분). Google Sheets 도 동일.
// CSV 처럼 쉼표 기반도 감지해서 파싱.
function parseTabular(text: string): { rows: string[][]; delim: '\t' | ',' } {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const delim: '\t' | ',' = firstLine.includes('\t') ? '\t' : ',';

  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  const n = text.length;
  let i = 0;
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
    if (c === delim) { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return { rows: rows.filter((r) => r.some((v) => v.trim() !== '')), delim };
}

// ── 파싱 결과: 헤더 감지 + 필드 매핑 ───────────────────────────────────
interface PasteInterpretation {
  /** 업로드에 쓸 row 배열 */
  rows: NodeSpecCsvRow[];
  /** 소스 grid 의 컬럼 개수 */
  sourceCols: number;
  /** 감지한 구분자 */
  delim: '\t' | ',';
  /** 헤더 자동 감지 여부 */
  headerDetected: boolean;
  /** 매핑된 field 명 (컬럼 순서) */
  mappedFields: (string | null)[];
  /** 파싱 중 생긴 경고 */
  warnings: string[];
}

function interpret(text: string, displayColumns: NodeSpecColumn[]): PasteInterpretation {
  const { rows: raw, delim } = parseTabular(text);
  const warnings: string[] = [];
  if (raw.length === 0) {
    return { rows: [], sourceCols: 0, delim, headerDetected: false, mappedFields: [], warnings: ['붙여넣은 데이터가 비어있습니다.'] };
  }

  const byField: Map<keyof NodeServerSpec, NodeSpecColumn> = new Map(
    NODE_SPEC_COLUMNS.map((c) => [c.field, c]),
  );
  const firstRow = raw[0];
  const firstRowMapped: (keyof NodeServerSpec | null)[] = firstRow.map(
    (h) => HEADER_TO_FIELD[normalizeHeader(h)] ?? null,
  );
  const hasKnownHeader = firstRowMapped.some((f) => f !== null);

  let dataRows: string[][];
  let mappedFields: (keyof NodeServerSpec | null)[];

  if (hasKnownHeader) {
    mappedFields = firstRowMapped;
    dataRows = raw.slice(1);
  } else {
    // 헤더 없음 → displayColumns 순서로 매핑
    mappedFields = displayColumns.map((c) => c.field);
    if (firstRow.length !== displayColumns.length) {
      warnings.push(
        `헤더 없음으로 판단. 소스 열 ${firstRow.length}개 · 테이블 열 ${displayColumns.length}개 — 앞에서부터 매핑합니다.`,
      );
    }
    dataRows = raw;
  }

  if (!mappedFields.includes('hostname')) {
    warnings.push('hostname 을 확인할 수 없어 업로드할 수 없습니다. 테이블에 hostname 컬럼이 보이는지, 헤더 포함 복사를 했는지 확인하세요.');
    return { rows: [], sourceCols: firstRow.length, delim, headerDetected: hasKnownHeader, mappedFields: mappedFields.map(String), warnings };
  }

  const result: NodeSpecCsvRow[] = [];
  dataRows.forEach((cells, r) => {
    const obj: Record<string, unknown> = {};
    mappedFields.forEach((field, colIdx) => {
      if (!field) return;
      const col = byField.get(field);
      if (!col) return;
      const rawVal = (cells[colIdx] ?? '').trim();
      if (rawVal === '') return;
      try {
        const parsed = parseCellValue(rawVal, col);
        if (parsed !== null) obj[field] = parsed;
      } catch (e) {
        warnings.push(`행 ${r + 1}: ${field} — ${(e as Error).message}`);
      }
    });
    if (obj.hostname) {
      result.push(obj as NodeSpecCsvRow);
    } else {
      warnings.push(`행 ${r + 1}: hostname 비어있음 → 건너뜀`);
    }
  });

  return {
    rows: result,
    sourceCols: firstRow.length,
    delim,
    headerDetected: hasKnownHeader,
    mappedFields: mappedFields.map((f) => f === null ? null : String(f)),
    warnings,
  };
}

// ── 결과 행 스타일 ────────────────────────────────────────────────────
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
  const keys = Object.keys(d.changes);
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
        ) : keys.length === 0 ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              {keys.length}개 필드 {d.action === 'insert' ? '신규' : '변경'}
            </summary>
            <table className="mt-1 text-xs font-mono w-full">
              <tbody>
                {keys.map((k) => (
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

// ── 메인 모달 ─────────────────────────────────────────────────────────
export function NodeSpecPasteModal({ open, onClose, onApplied, displayColumns, initialText }: Props) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<NodeSpecCsvPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cols = displayColumns ?? NODE_SPEC_COLUMNS;

  // 열릴 때 initialText 있으면 자동 채우기
  useEffect(() => {
    if (open && initialText && !text) {
      setText(initialText);
    }
    if (!open) {
      // 닫힐 때 리셋
      setText('');
      setPreview(null);
      setMsg(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialText]);

  const interpretation = useMemo(
    () => text.trim() ? interpret(text, cols) : null,
    [text, cols],
  );

  const handlePreview = async () => {
    if (!interpretation || interpretation.rows.length === 0) return;
    setPreviewLoading(true);
    setMsg(null);
    try {
      const r = await nodeSpecsApi.csvPreview({
        rows: interpretation.rows,
        dryRun: true,
        matchClusterScope: false,
        ignoreEmptyOnUpdate: true,
      });
      setPreview(r.data);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setMsg(`미리보기 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!interpretation || !preview) return;
    setApplying(true);
    setMsg(null);
    try {
      const r = await nodeSpecsApi.csvApply({
        rows: interpretation.rows,
        dryRun: false,
        matchClusterScope: false,
        ignoreEmptyOnUpdate: true,
      });
      const d = r.data;
      setMsg(`✓ 신규 ${d.inserted} / 업데이트 ${d.updated} / 건너뜀 ${d.skipped}` +
        (d.errors.length ? ` · 오류 ${d.errors.length}건` : ''));
      onApplied();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setMsg(`적용 실패: ${err.response?.data?.detail ?? err.message}`);
    } finally {
      setApplying(false);
    }
  };

  const reset = () => { setText(''); setPreview(null); setMsg(null); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <ClipboardPaste className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-semibold">엑셀 블록 붙여넣기 — 노드 서버스펙</h2>
          <button onClick={onClose} disabled={applying}
            className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-xs text-foreground/80 flex items-start gap-2">
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-primary" />
            <div>
              엑셀 / 구글 시트에서 블록을 <strong>Ctrl+C</strong> 한 뒤 아래 상자에 <strong>Ctrl+V</strong> 붙여넣으세요.
              첫 행이 컬럼 헤더면 자동 매핑, 헤더가 없으면 테이블 컬럼 순서대로 매핑됩니다.
              <strong> hostname</strong> 컬럼은 필수입니다.
            </div>
          </div>

          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            onPaste={() => setPreview(null)}
            placeholder={"여기에 붙여넣기 (Ctrl+V)\n\n예시:\nhostname\tos\tdisk_total_gb\tssd\tvm\tcurrent_usage\nsrv-m01\tRHEL9\t18\tO\tX\tNEW K8S MASTER"}
            rows={8}
            className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
          />

          {interpretation && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground/80 border border-border">
                구분자: {interpretation.delim === '\t' ? 'TAB (엑셀)' : 'CSV ,'}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground/80 border border-border">
                {interpretation.headerDetected ? '헤더 감지됨' : `헤더 없음 — 테이블 컬럼 순서`}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground/80 border border-border">
                {interpretation.rows.length} 행
              </span>
              <button onClick={reset} className="ml-auto text-muted-foreground hover:text-foreground">
                초기화
              </button>
            </div>
          )}

          {interpretation && interpretation.warnings.length > 0 && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-500">
              <p className="font-medium mb-0.5 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> 경고 {interpretation.warnings.length}건
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {interpretation.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
                {interpretation.warnings.length > 6 && <li>... 외 {interpretation.warnings.length - 6}건</li>}
              </ul>
            </div>
          )}

          {interpretation && interpretation.rows.length > 0 && !preview && (
            <div className="flex justify-end">
              <button onClick={handlePreview} disabled={previewLoading}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50">
                {previewLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                미리보기 (diff 확인)
              </button>
            </div>
          )}

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
              </div>
              <div className="border border-border rounded-xl overflow-hidden max-h-[320px] overflow-y-auto">
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
                    {preview.diffs.map((d) => <DiffRow key={d.rowIndex} d={d} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {msg && (
            <div className={`px-3 py-2 rounded-lg text-sm border ${
              msg.startsWith('✓')
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            }`}>
              {msg}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
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
  );
}
