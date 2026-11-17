// DC 인벤토리 ▸ 서버 일괄 등록 — 현업 엑셀 열 그대로(서버구성 · 서버환경 · 호스트명 · 서버용도 · OS버전 · NW설정 · 이중화 ·
// DC 위치 · RACK 열 · 랙 No. · 하단 위치) 파일을 올리거나 엑셀에서 복사해 붙여넣는다.
//   붙여넣기 → 바로 표로 보이고 어느 열을 무엇으로 읽는지 표시 → 미리보기(검증, DB 불변) → 확정(실시간 로그).
// 없는 DC·구간·열·랙은 확정 때 함께 만들어지고(미리보기에 목록), 오류가 하나라도 있으면 아무것도 반영하지 않는다.
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { EmptyState, RunLogPanel, SegTabs, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { dcKeys } from '@/hooks/useDcInventory';
import { useLogPref } from '@/hooks/useLogPref';
import { applyRunEvent, elapsed, useRunLog } from '@/hooks/useRunLog';
import { downloadBlob } from '@/lib/download';
import { postSse } from '@/lib/sse';
import { parseTabular } from '@/lib/tabular';
import { formatApiError } from '@/lib/utils';
import { camelizeKeys, dcApi } from '@/services/api';
import type { DcImportAction, DcServerImportResult } from '@/types';
import { ImportRowDetail } from './ImportRowDetail';
import { ACTION_CLS, ACTION_LABEL, BTN, BTN_PRIMARY, TD, TH, fmt } from './shared';

type Mode = 'paste' | 'file';

/** 서버가 인식하는 머리글 — 붙여넣은 표에서 바로 "읽는 열 / 무시하는 열" 을 보여 주는 데 쓴다(서버 판정이 최종). */
const KNOWN: Record<string, string> = {
  서버구성: '서버구성', 구성: '서버구성', 서버환경: '서버환경', 환경: '서버환경', 호스트명: '호스트명', 호스트: '호스트명',
  hostname: '호스트명', 서버명: '호스트명', 서버용도: '서버용도', 용도: '서버용도', os버전: 'OS버전', os: 'OS버전',
  nw설정: 'NW설정', 네트워크: 'NW설정', 이중화: '이중화', 이증화: '이중화', dc위치: 'DC 위치', 위치: 'DC 위치',
  rack열: 'RACK 열', 랙열: 'RACK 열', 열: 'RACK 열', 랙no: '랙 No.', 랙번호: '랙 No.', 랙: '랙 No.',
  하단위치: '하단 위치', 하단: '하단 위치', '높이(u)': '높이(U)', 높이: '높이(U)',
};
const norm = (s: string) => s.replace(/[\s.()[\]_\-/]/g, '').toLowerCase();
const KNOWN_NORM = new Map(Object.entries(KNOWN).map(([k, v]) => [norm(k), v]));

const SHEET_NAME: Record<string, string> = { racks: '새 랙', devices: '서버' };

export function DcServerImportPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('dc-inventory-server-import');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<Mode>('paste');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DcServerImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [shown, setShown] = useState<Record<DcImportAction, boolean>>({ error: true, update: true, insert: true });

  const pasted = useMemo(() => (text.trim() ? parseTabular(text).rows : []), [text]);
  const headerAt = useMemo(() => pasted.findIndex((r) => r.some((c) => KNOWN_NORM.get(norm(c)) === '호스트명')), [pasted]);
  const header = headerAt >= 0 ? pasted[headerAt] : [];
  const body = headerAt >= 0 ? pasted.slice(headerAt + 1) : [];

  const input = (): { file?: File; rows?: string[][] } | null =>
    mode === 'file' ? (file ? { file } : null) : (pasted.length ? { rows: pasted } : null);
  const ready = input() !== null && (mode === 'file' || headerAt >= 0);

  const reset = (keepInput = false) => {
    setPreview(null);
    setApplied(false);
    if (!keepInput) {
      setText('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadTemplate = async () => {
    try {
      downloadBlob('dc-server-import.xlsx', (await dcApi.serverImportTemplate()).data);
    } catch (e) {
      toast.error('양식을 받지 못했습니다', formatApiError(e));
    }
  };

  const runPreview = async () => {
    const src = input();
    if (!src) return;
    setBusy(true);
    setApplied(false);
    const run = runLog.begin('서버 일괄 등록 · 미리보기',
      `${mode === 'file' ? file?.name : `붙여넣기 ${fmt(body.length)}행`} 검증 요청 — DB 는 바뀌지 않는다`);
    const t0 = performance.now();
    try {
      const { data } = await dcApi.serverImportPreview(src);
      setPreview(data);
      run.log('info', `헤더 ${data.headerRow}행 · 읽은 열: ${data.columns.filter((c) => c.field).map((c) => c.label).join(', ')}`);
      const ignored = data.columns.filter((c) => !c.field).map((c) => c.column);
      if (ignored.length) run.log('warn', `무시한 열: ${ignored.join(', ')}`);
      for (const c of data.createdLocations.slice(0, 20)) run.log('info', `새로 만듦 — ${c}`);
      for (const s of data.sheets) {
        run.log(s.error > 0 ? 'error' : 'info',
          `${SHEET_NAME[s.name] ?? s.name} ${fmt(s.total)}행 · 추가 ${fmt(s.insert)} · 변경 ${fmt(s.update)} · 변경 없음 ${fmt(s.skip)} · 오류 ${fmt(s.error)}`);
        for (const r of s.rows.filter((x) => x.action === 'error').slice(0, 20)) {
          run.log('error', `  ${r.row}행 ${r.key}: ${(r.errors ?? []).map((e) => e.message).join(' / ')}`);
        }
      }
      for (const w of data.warnings.slice(0, 20)) run.log('warn', w);
      run.log(data.ok ? 'info' : 'error', `검증 끝 (${elapsed(t0)}) — 오류 ${fmt(data.summary.error)}건. DB 는 바뀌지 않았다.`);
    } catch (e) {
      const msg = formatApiError(e, '검증하지 못했습니다');
      run.log('error', msg);
      toast.error('미리보기 실패', msg);
      setPreview(null);
    } finally {
      setBusy(false);
      run.end();
    }
  };

  const apply = async () => {
    const src = input();
    if (!src || !preview?.ok) return;
    setBusy(true);
    const run = runLog.begin('서버 일괄 등록 · 확정',
      `추가 ${fmt(preview.summary.insert)} · 변경 ${fmt(preview.summary.update)} 반영 요청`);
    const fd = new FormData();
    if (src.file) fd.append('file', src.file);
    if (src.rows) fd.append('rows_json', JSON.stringify(src.rows));
    fd.append('sha256', preview.sha256);
    let error: string | null = null;
    let result: DcServerImportResult | null = null;
    try {
      await postSse(dcApi.serverImportApplyStreamUrl, fd, (evt) => {
        if (evt.type === 'result') result = camelizeKeys<DcServerImportResult>(evt.result);
        else if (evt.type === 'error') error = String(evt.message ?? '확정 실패');
        else applyRunEvent(run, evt);
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const final = result as DcServerImportResult | null;
    if (error) {
      run.log('error', error);
      toast.error('서버 일괄 등록 실패', error);
    } else if (final?.applied) {
      setApplied(true);
      setPreview(final);
      toast.success('서버 일괄 등록 완료', `추가 ${fmt(final.summary.insert)} · 변경 ${fmt(final.summary.update)}`);
      void qc.invalidateQueries({ queryKey: dcKeys.all });
      void qc.invalidateQueries({ queryKey: ['node-specs'] });
    } else if (final) {
      setPreview(final);
      toast.error('반영하지 않았습니다', `오류 ${fmt(final.summary.error)}건 — 전부 되돌렸습니다.`);
    }
    setBusy(false);
    run.end();
  };

  const rows = useMemo(() => {
    if (!preview) return [];
    return preview.sheets
      .flatMap((s) => s.rows.map((r) => ({ ...r, sheet: s.name })))
      .filter((r) => shown[r.action])
      .sort((a, b) => (a.action === 'error' ? 0 : 1) - (b.action === 'error' ? 0 : 1) || a.row - b.row);
  }, [preview, shown]);
  const total = preview ? preview.summary.insert + preview.summary.update : 0;
  const counts = preview?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegTabs<Mode> label="입력 방식" mode="toggle" size="md" value={mode}
          onChange={(m) => { setMode(m); reset(true); }}
          options={[['paste', '엑셀에서 붙여넣기'], ['file', '파일 올리기']]} />
        <button type="button" className={BTN} onClick={() => void downloadTemplate()}>
          <Download className="w-4 h-4" aria-hidden /> 양식 받기 (.xlsx)
        </button>
      </div>

      <MacCard
        title={mode === 'paste' ? '붙여넣기' : '파일'}
        icon={mode === 'paste' ? ClipboardPaste : FileSpreadsheet}
        description="서버구성 · 서버환경 · 호스트명 · 서버용도 · OS버전 · NW설정 · 이중화 · DC 위치 · RACK 열 · 랙 No. · 하단 위치"
      >
        {mode === 'paste' ? (
          <div className="space-y-3">
            <label htmlFor="dc-srv-paste" className="sr-only">엑셀에서 복사한 표</label>
            <textarea id="dc-srv-paste" value={text} onChange={(e) => { setText(e.target.value); setPreview(null); setApplied(false); }}
              rows={pasted.length ? 4 : 8} spellCheck={false}
              placeholder={'엑셀에서 머리글 줄까지 함께 복사해 여기에 붙여넣으세요 (Ctrl+V)\n\n서버구성\t서버환경\t호스트명\t서버용도\tOS버전\tNW설정\t이중화\tDC 위치\tRACK 열\t랙 No.\t하단 위치\nR750 / 512G\t운영\tnode-a-0101\tK8S 워커\tRocky 9.4\tbond0 25G x2\tActive-Active\tDC1 2층 A구역\tA\t07\tU21'}
              className="w-full font-mono text-xs rounded-xl border border-border bg-background p-3 focus:outline-none focus:ring-1 focus:ring-primary" />
            {pasted.length > 0 && headerAt < 0 && (
              <p role="alert" className="text-sm text-status-critical">머리글 줄에 &lsquo;호스트명&rsquo; 열이 없습니다 — 머리글까지 함께 복사해 주세요.</p>
            )}
            {headerAt >= 0 && (
              <div className="rounded-md border border-border overflow-auto max-h-80">
                <table className="w-full border-collapse min-w-[900px]">
                  <thead className="sticky top-0 bg-card">
                    <tr>
                      <th className={TH}>행</th>
                      {header.map((h, i) => {
                        const known = KNOWN_NORM.get(norm(h));
                        return (
                          <th key={i} className={`${TH} ${known ? '' : 'opacity-60'}`} title={known ? `${known} 로 읽음` : '이 열은 무시합니다'}>
                            {h || '(빈 머리글)'}
                            <span className="block font-normal">{known ? `→ ${known}` : '무시'}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {body.slice(0, 200).map((r, ri) => (
                      <tr key={ri}>
                        <td className={`${TD} font-mono text-xs text-muted-foreground`}>{headerAt + ri + 2}</td>
                        {header.map((_, ci) => <td key={ci} className={`${TD} whitespace-nowrap`}>{r[ci] ?? ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {body.length > 200 && <p className="px-3 py-2 text-xs text-muted-foreground">앞 200행만 표시 — 전체 {fmt(body.length)}행을 검증합니다.</p>}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground min-w-0">
              {file ? <><span className="text-foreground font-medium">{file.name}</span> · {fmt(Math.ceil(file.size / 1024))}KB</>
                : 'Excel(.xlsx) 또는 CSV. 머리글 위에 제목 줄이 있어도 됩니다 — "호스트명" 이 있는 줄을 머리글로 읽습니다.'}
            </p>
            <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" className="sr-only" id="dc-srv-file"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setApplied(false); }} />
            <label htmlFor="dc-srv-file" className={`${file ? BTN : BTN_PRIMARY} cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
              <Upload className="w-4 h-4" aria-hidden /> {file ? '다른 파일 고르기' : '파일 고르기'}
            </label>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            호스트명이 같으면 수정, 없으면 추가합니다. 없는 DC·구간·열·랙은 함께 만들어집니다. 목록에 없는 서버는 지우지 않습니다.
          </p>
          <div className="flex gap-2">
            {(text || file || preview) && <button type="button" className={BTN} disabled={busy} onClick={() => reset()}>지우기</button>}
            <button type="button" className={BTN_PRIMARY} disabled={!ready || busy} onClick={() => void runPreview()}>
              미리보기 · 검증
            </button>
          </div>
        </div>
      </MacCard>

      {preview && (
        <MacCard title="미리보기" bodyPadding="p-0" description={applied ? '반영된 결과' : 'DB 는 아직 바뀌지 않았습니다'}
          titleExtra={counts && (
            <span className="text-xs text-muted-foreground">
              추가 {fmt(counts.insert)} · 변경 {fmt(counts.update)} · 변경 없음 {fmt(counts.skip)}
              {counts.error > 0 && <span className="text-status-critical font-semibold"> · 오류 {fmt(counts.error)}</span>}
            </span>
          )}>
          {preview.createdLocations.length > 0 && (
            <p className="px-4 py-2 text-sm border-b border-border">
              <span className="font-medium">함께 만들어질 위치</span>{' '}
              <span className="text-muted-foreground">{preview.createdLocations.join(' · ')}</span>
            </p>
          )}
          {preview.warnings.length > 0 && (
            <ul className="px-4 py-2 text-sm text-status-warning border-b border-border space-y-0.5">
              {preview.warnings.slice(0, 10).map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 text-sm border-b border-border">
            <span className="text-muted-foreground">보기</span>
            {(['error', 'update', 'insert'] as DcImportAction[]).map((a) => (
              <label key={a} className="inline-flex items-center gap-1.5">
                <input type="checkbox" className="w-4 h-4" checked={shown[a]}
                  onChange={(e) => setShown((p) => ({ ...p, [a]: e.target.checked }))} />
                {ACTION_LABEL[a]} {fmt(counts?.[a] ?? 0)}
              </label>
            ))}
          </div>
          {rows.length === 0 ? (
            <EmptyState compact icon={FileSpreadsheet}
              title={total + (counts?.error ?? 0) === 0 ? '바뀌는 행이 없습니다 — 입력과 현재 데이터가 같습니다' : '선택한 판정에 해당하는 행이 없습니다'} />
          ) : (
            <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
              <table className="w-full border-collapse min-w-[720px]">
                <thead className="sticky top-0 bg-card">
                  <tr><th className={TH}>행</th><th className={TH}>대상</th><th className={TH}>판정</th><th className={TH}>내용</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.sheet}-${r.row}-${r.key}`} className={r.action === 'error' ? 'bg-status-critical/5' : undefined}>
                      <td className={`${TD} font-mono text-xs tabular-nums whitespace-nowrap`}>{r.row}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        {r.key}{r.sheet === 'racks' && <span className="text-xs text-muted-foreground"> · 새 랙</span>}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-semibold ${ACTION_CLS[r.action]}`}>
                          {ACTION_LABEL[r.action]}
                        </span>
                      </td>
                      <td className={TD}><ImportRowDetail row={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </MacCard>
      )}

      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-72" />

      {preview && !applied && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <p className="text-sm">
            {preview.ok
              ? (total === 0 ? <span className="text-muted-foreground">바뀌는 행이 없습니다.</span>
                : <span>전체가 한 번에 반영되고, 도중에 실패하면 전부 되돌립니다.</span>)
              : <span className="text-status-critical font-semibold">오류 {fmt(preview.summary.error)}건을 고친 뒤 다시 미리보기 하세요.</span>}
          </p>
          <button type="button" className={BTN_PRIMARY} disabled={!canOperate || !preview.ok || total === 0 || busy}
            title={withHint(preview.ok ? '미리보기한 내용을 반영' : '오류가 있어 확정할 수 없습니다')}
            aria-label={ariaWithHint(`${fmt(total)}건 확정`)} onClick={() => void apply()}>
            {fmt(total)}건 확정
          </button>
        </div>
      )}
      {applied && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
          <p className="text-sm">반영했습니다. 장비 탭과 노드 서버스펙 화면에서 같은 값으로 보입니다.</p>
          <button type="button" className={BTN} onClick={() => reset()}>새로 등록</button>
        </div>
      )}
    </div>
  );
}
