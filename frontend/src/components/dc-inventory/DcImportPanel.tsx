// DC 인벤토리 ▸ 일괄 등록 — 양식 받기 → 파일 올리기 → 미리보기(검증) → 확정.
// 미리보기는 DB 를 바꾸지 않는다. 확정은 SSE 로 시트별 진행이 실시간 로그(RunLogPanel)에 쌓이고,
// "로그 보기" 는 사용자가 정한다. 오류가 하나라도 있으면 확정할 수 없고 서버도 전부 되돌린다.
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { EmptyState, RunLogPanel, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { dcKeys } from '@/hooks/useDcInventory';
import { useLogPref } from '@/hooks/useLogPref';
import { applyRunEvent, elapsed, useRunLog } from '@/hooks/useRunLog';
import { downloadBlob } from '@/lib/download';
import { postSse } from '@/lib/sse';
import { formatApiError } from '@/lib/utils';
import { camelizeKeys, dcApi } from '@/services/api';
import type { DcImportAction, DcImportResult } from '@/types';
import { ImportRowDetail as RowDetail } from './ImportRowDetail';
import { ACTION_CLS, ACTION_LABEL, BTN, BTN_PRIMARY, SHEET_LABEL, TD, TH, fmt } from './shared';

export function DcImportPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('dc-inventory-import');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DcImportResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sheet, setSheet] = useState('');
  const [shown, setShown] = useState<Record<DcImportAction, boolean>>({ error: true, update: true, insert: true });
  const [applied, setApplied] = useState(false);

  const active = useMemo(
    () => preview?.sheets.find((s) => s.name === sheet) ?? preview?.sheets[0] ?? null,
    [preview, sheet],
  );
  const rows = useMemo(() => (active?.rows ?? []).filter((r) => shown[r.action]), [active, shown]);
  const changeCount = preview ? preview.summary.insert + preview.summary.update : 0;
  const step = applied ? 3 : preview ? 2 : 1;

  const download = async (kind: 'template' | 'export') => {
    try {
      const res = kind === 'template' ? await dcApi.importTemplate() : await dcApi.exportXlsx();
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadBlob(kind === 'template' ? 'dc-inventory-template.xlsx' : `dc-inventory-${stamp}.xlsx`, res.data);
    } catch (e) {
      toast.error(kind === 'template' ? '양식을 받지 못했습니다' : '내보내기에 실패했습니다', formatApiError(e));
    }
  };

  const runPreview = async (picked: File) => {
    setFile(picked);
    setPreview(null);
    setApplied(false);
    setPreviewing(true);
    const run = runLog.begin('미리보기 검증', `${picked.name} (${fmt(Math.ceil(picked.size / 1024))}KB) 검증 요청 — DB 는 바뀌지 않는다`);
    const t0 = performance.now();
    try {
      const { data } = await dcApi.importPreview(picked);
      setPreview(data);
      const firstBad = data.sheets.find((s) => s.error > 0);
      setSheet((firstBad ?? data.sheets[0])?.name ?? '');
      for (const s of data.sheets) {
        run.log(s.error > 0 ? 'error' : 'info',
          `${s.name} ${fmt(s.total)}행 · 추가 ${fmt(s.insert)} · 변경 ${fmt(s.update)} · 변경 없음 ${fmt(s.skip)} · 오류 ${fmt(s.error)}`);
        for (const r of s.rows.filter((x) => x.action === 'error').slice(0, 20)) {
          run.log('error', `  ${r.row}행 ${r.key}: ${(r.errors ?? []).map((e) => e.message).join(' / ')}`);
        }
      }
      for (const w of data.warnings.slice(0, 20)) run.log('warn', w);
      run.log(data.ok ? 'info' : 'error',
        `검증 끝 (${elapsed(t0)}) — 오류 ${fmt(data.summary.error)}건. DB 는 바뀌지 않았다.`);
    } catch (e) {
      const msg = formatApiError(e, '파일을 검증하지 못했습니다');
      run.log('error', msg);
      toast.error('미리보기 실패', msg);
      setFile(null);
    } finally {
      setPreviewing(false);
      run.end();
    }
  };

  const apply = async () => {
    if (!file || !preview || !preview.ok) return;
    const run = runLog.begin('일괄 등록 확정', `${file.name} — 추가 ${fmt(preview.summary.insert)} · 변경 ${fmt(preview.summary.update)} 반영 요청`);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('sha256', preview.sha256);
    let error: string | null = null;
    let result: DcImportResult | null = null;
    try {
      await postSse(dcApi.importApplyStreamUrl, fd, (evt) => {
        if (evt.type === 'result') result = camelizeKeys<DcImportResult>(evt.result);
        else if (evt.type === 'error') error = String(evt.message ?? '확정 실패');
        else applyRunEvent(run, evt);
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const final = result as DcImportResult | null;
    if (error) {
      run.log('error', error);
      toast.error('일괄 등록 실패', error);
    } else if (final && final.applied) {
      setApplied(true);
      setPreview(final);
      toast.success('일괄 등록 완료', `추가 ${fmt(final.summary.insert)} · 변경 ${fmt(final.summary.update)}`);
      void qc.invalidateQueries({ queryKey: dcKeys.all });
    } else if (final) {
      // 미리보기 뒤에 다른 사람이 데이터를 바꿔 지금은 오류가 생긴 경우 — 새 판정을 보여준다.
      setPreview(final);
      toast.error('반영하지 않았습니다', `오류 ${fmt(final.summary.error)}건 — 전부 되돌렸습니다.`);
    }
    run.end();
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setApplied(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const busy = previewing || runLog.running;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ol aria-label="진행 단계" className="flex flex-wrap gap-2 text-sm">
          {['파일 올리기', '미리보기 · 검증', '확정'].map((label, i) => (
            <li key={label} aria-current={step === i + 1 ? 'step' : undefined}
              className={`px-3 py-1 rounded-full border ${step === i + 1 ? 'bg-foreground text-background border-foreground font-medium' : 'bg-secondary text-muted-foreground border-border'}`}>
              {i + 1} {label}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} onClick={() => void download('template')}>
            <Download className="w-4 h-4" aria-hidden /> 양식 받기 (.xlsx)
          </button>
          <button type="button" className={BTN} onClick={() => void download('export')}>
            <Download className="w-4 h-4" aria-hidden /> 현재 데이터 내보내기
          </button>
        </div>
      </div>

      <MacCard title="파일" icon={FileSpreadsheet}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {file ? (
              <>
                <p className="text-sm font-medium truncate">
                  {file.name} <span className="font-normal text-xs text-muted-foreground">· {fmt(Math.ceil(file.size / 1024))}KB</span>
                </p>
                {preview && (
                  <p className="text-sm mt-1">
                    추가 <b>{fmt(preview.summary.insert)}</b> · 변경 <b>{fmt(preview.summary.update)}</b> · 변경 없음 {fmt(preview.summary.skip)}
                    {preview.summary.error > 0 && <span className="text-status-critical font-semibold"> · 오류 {fmt(preview.summary.error)}</span>}
                  </p>
                )}
                {previewing && <p className="text-sm text-muted-foreground mt-1">검증하는 중 — 수천 행이면 수십 초가 걸립니다.</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Excel(.xlsx) 또는 시트 하나짜리 CSV 를 올리면 먼저 검증하고, 오류가 없을 때만 한 번에 반영합니다.
                키 열이 같은 행은 수정, 없는 행은 추가하며 파일에 없는 행은 지우지 않습니다.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.csv" className="sr-only" id="dc-import-file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void runPreview(f); }} />
            <label htmlFor="dc-import-file"
              className={`${file ? BTN : BTN_PRIMARY} cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
              <Upload className="w-4 h-4" aria-hidden /> {file ? '다른 파일 올리기' : '파일 고르기'}
            </label>
            {file && <button type="button" className={BTN} onClick={reset} disabled={busy}>지우기</button>}
          </div>
        </div>
      </MacCard>

      {preview && active && (
        <MacCard title="미리보기" bodyPadding="p-0"
          description={applied ? '반영된 결과' : 'DB 는 아직 바뀌지 않았습니다'}>
          <div role="tablist" aria-label="시트" className="flex flex-wrap gap-1 px-3 pt-2 border-b border-border">
            {preview.sheets.map((s) => {
              const on = s.name === active.name;
              return (
                <button key={s.name} type="button" role="tab" aria-selected={on} onClick={() => setSheet(s.name)}
                  className={`px-2.5 py-2 text-sm border-b-2 -mb-px ${on ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                  {SHEET_LABEL[s.name] ?? s.name} · {fmt(s.total)}
                  {s.error > 0 && <span className="text-status-critical"> · 오류 {fmt(s.error)}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 text-sm border-b border-border">
            <span className="text-muted-foreground">보기</span>
            {(['error', 'update', 'insert'] as DcImportAction[]).map((a) => (
              <label key={a} className="inline-flex items-center gap-1.5">
                <input type="checkbox" className="w-4 h-4" checked={shown[a]}
                  onChange={(e) => setShown((prev) => ({ ...prev, [a]: e.target.checked }))} />
                {ACTION_LABEL[a]} {fmt(active[a])}
              </label>
            ))}
            <span className="text-muted-foreground">변경 없음 {fmt(active.skip)}</span>
          </div>
          {rows.length === 0 ? (
            <EmptyState compact icon={FileSpreadsheet}
              title={active.insert + active.update + active.error === 0 ? '이 시트는 바뀌는 행이 없습니다' : '선택한 판정에 해당하는 행이 없습니다'} />
          ) : (
            <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
              <table className="w-full border-collapse min-w-[720px]">
                <thead className="sticky top-0 bg-card">
                  <tr>
                    <th className={TH}>행</th>
                    <th className={TH}>키</th>
                    <th className={TH}>판정</th>
                    <th className={TH}>내용</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.row}-${r.action}`} className={r.action === 'error' ? 'bg-status-critical/5' : undefined}>
                      <td className={`${TD} font-mono text-xs tabular-nums whitespace-nowrap`}>{r.row}</td>
                      <td className={`${TD} whitespace-nowrap`}>{r.key}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-semibold ${ACTION_CLS[r.action]}`}>
                          {ACTION_LABEL[r.action]}
                        </span>
                      </td>
                      <td className={TD}><RowDetail row={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {active.truncated && (
            <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
              행이 많아 판정별로 앞부분만 표시합니다. 건수는 전체 기준입니다.
            </p>
          )}
        </MacCard>
      )}

      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-72" />

      {preview && !applied && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <p className="text-sm">
            {preview.ok ? (
              changeCount === 0
                ? <span className="text-muted-foreground">바뀌는 행이 없습니다 — 파일과 현재 데이터가 같습니다.</span>
                : <span>전체가 한 번에 반영되고, 도중에 실패하면 전부 되돌립니다.</span>
            ) : (
              <span className="text-status-critical font-semibold">오류 {fmt(preview.summary.error)}건을 고친 파일을 다시 올려야 확정할 수 있습니다.</span>
            )}
          </p>
          <button type="button" className={BTN_PRIMARY}
            disabled={!canOperate || !preview.ok || changeCount === 0 || busy}
            title={withHint(preview.ok ? '미리보기한 내용을 반영' : '오류가 있어 확정할 수 없습니다')}
            aria-label={ariaWithHint(`${fmt(changeCount)}건 확정`)}
            onClick={() => void apply()}>
            {fmt(changeCount)}건 확정
          </button>
        </div>
      )}
      {applied && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <p className="text-sm">반영했습니다. 변경 이력에 한 묶음으로 기록됐습니다.</p>
          <button type="button" className={BTN} onClick={reset}>다른 파일 올리기</button>
        </div>
      )}
    </div>
  );
}
