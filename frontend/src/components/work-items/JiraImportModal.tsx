import { useRef, useState } from 'react';
import {
  X, Loader2, DownloadCloud, AlertTriangle, CheckCircle2, FileSpreadsheet, ClipboardPaste, RotateCcw, Upload, Link2Off, ShieldCheck, Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useJiraImport, useJiraCredential, useJiraVerifyLinks, useJiraUnlink } from '@/hooks/useJira';
import { JiraConnectCard } from '@/components/settings/JiraConnectCard';
import { jiraApi } from '@/services/api';
import { useModalA11y } from '@/components/common/useModalA11y';
import { ConfirmDialog, RunLogPanel, useToast } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError } from '@/lib/utils';
import type { JiraImportResult, JiraExcelImportResult, JiraVerifyLinksResult } from '@/types';

/** 로그 항목 줄 상한 — 수백 건이면 앞 200건 + "외 N건" 줄(D-136). */
const LOG_ITEM_CAP = 200;
const ACTION_LABEL: Record<string, string> = { create: '생성', update: '갱신', unchanged: '변경 없음' };

/** 가져오기/저장 응답(JiraImportResult) → 실행 로그 줄: JQL · 항목별 · 오류 전부 · 절삭 경고 · 합계. */
function importResultLines(data: JiraImportResult): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  if (data.appliedJql) out.push(['info', `JQL ${data.appliedJql}`]);
  if (data.status !== 'ok') {
    out.push(['error', `${data.dryRun ? '미리보기' : '가져오기'} 실패(${data.status}) — ${data.detail || '사유 없음'}`]);
  }
  const items = data.items ?? [];
  const prefix = data.dryRun ? '미리보기 · ' : '';
  for (const it of items.slice(0, LOG_ITEM_CAP)) {
    const n = it.changes?.length ?? 0;
    out.push(['info', `${prefix}${it.jiraKey} ${it.title} · ${ACTION_LABEL[it.action] ?? it.action}${n ? ` (변경 필드 ${n})` : ''}`]);
  }
  if (items.length > LOG_ITEM_CAP) out.push(['info', `외 ${items.length - LOG_ITEM_CAP}건`]);
  for (const e of data.errors ?? []) out.push(['error', e]);
  if (data.truncated) out.push(['warn', '조회 상한에 걸려 일부 이슈만 가져왔습니다 — 조건(기간·프로젝트)을 좁혀 다시 실행하세요']);
  if (data.status === 'ok') {
    const errs = data.errors?.length ?? 0;
    out.push([errs ? 'warn' : 'info',
      `${data.dryRun ? '미리보기 완료' : '완료'} · 총 ${data.total} · 신규 ${data.imported} · 갱신 ${data.updated} · 변경 없음 ${data.skipped}${errs ? ` · 오류 ${errs}` : ''}`]);
  }
  return out;
}

/** Excel·붙여넣기 파싱 응답 → 실행 로그 줄: 담당자 매칭 결과 + 매칭 실패 행. */
function excelParseLines(data: JiraExcelImportResult): RunLogEntry[] {
  if (data.status !== 'ok') return [['error', `파싱 실패 — ${data.detail || '사유 없음'}`]];
  const out: RunLogEntry[] = [];
  const unmatched = (data.rows ?? []).filter((r) => !r.assigneeMatched);
  for (const r of unmatched.slice(0, LOG_ITEM_CAP)) {
    out.push(['warn', `${r.key} ${r.summary} · 담당자 매칭 실패 (${r.assigneeRaw || '비어 있음'})`]);
  }
  if (unmatched.length > LOG_ITEM_CAP) out.push(['warn', `외 ${unmatched.length - LOG_ITEM_CAP}건 매칭 실패`]);
  out.push([unmatched.length ? 'warn' : 'info', `행 ${data.total} · 담당자 매칭 ${data.matched}/${data.total}${data.detail ? ` — ${data.detail}` : ''}`]);
  return out;
}

interface JiraImportModalProps {
  open: boolean;
  onClose: () => void;
  defaultProjectKey?: string | null;
}

/** 상단 소스 — Jira 검색으로 가져오기 vs Excel·붙여넣기(구 전용 페이지 기능 통합). */
type Source = 'jql' | 'excel' | 'verify';
type Scope = 'me' | 'project' | 'filter' | 'jql';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'me', label: '내게 할당' },
  { id: 'project', label: '프로젝트' },
  { id: 'filter', label: '조건 조합' },
  { id: 'jql', label: '직접 JQL' },
];

/** 이번주 월요일부터 오늘까지 일수 — 가져오기 날짜 범위 기본값(옵션 수정 가능). */
function daysSinceMonday(): number {
  const day = new Date().getDay(); // 0=일 ... 6=토
  return (day + 6) % 7 + 1; // 월=1, 화=2, ... 일=7 (당일 포함 버퍼)
}

export function JiraImportModal({ open, onClose, defaultProjectKey }: JiraImportModalProps) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const importMut = useJiraImport();
  const { data: cred } = useJiraCredential();
  const fileRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source>('jql');
  const [scope, setScope] = useState<Scope>('me');
  const [projectKey, setProjectKey] = useState(defaultProjectKey ?? '');
  const [jql, setJql] = useState('');
  // 조건 조합 (scope='filter') — 프로젝트·컴포넌트·라벨을 개별 또는 조합으로 쓴다. 쉼표 구분.
  const [labels, setLabels] = useState('');
  const [components, setComponents] = useState('');
  const [statuses, setStatuses] = useState('');
  const [assignee, setAssignee] = useState('');
  // 가져오는 날짜 기본 범위 = 이번주(월요일부터) — 옵션(입력칸)에서 언제든 수정 가능.
  const [sinceDays, setSinceDays] = useState(() => String(daysSinceMonday()));
  const [preview, setPreview] = useState<JiraImportResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** 확정 가져오기가 끝난 상태 — 결과만 보여주고 닫기/다시 가져오기로 전환한다. */
  const [done, setDone] = useState<JiraImportResult | null>(null);

  // Excel / 붙여넣기
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelRows, setExcelRows] = useState<JiraExcelImportResult | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [excelError, setExcelError] = useState<string | null>(null);

  // 연결 점검 — Jira 에서 지워졌거나 안 보이는 이슈에 붙어 있는 죽은 링크를 찾아 정리한다.
  const verifyMut = useJiraVerifyLinks();
  const unlinkMut = useJiraUnlink();
  const [verifyResult, setVerifyResult] = useState<JiraVerifyLinksResult | null>(null);
  const [pickedMissing, setPickedMissing] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  // 벌크 삭제(업무 행까지 제거)는 단일 삭제 흐름들과 동일하게 확인을 받는다.
  const [confirmDeleteCount, setConfirmDeleteCount] = useState<number | null>(null);

  // 모달 안 실행(미리보기·가져오기·Excel 파싱/저장·연결 점검/정리)의 실행 로그(D-136).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('jira-import');

  if (!open) return null;

  const busy = importMut.isPending || excelBusy || verifyMut.isPending || cleaning;
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  const resetAll = () => {
    setPreview(null); setDone(null); setExcluded(new Set());
    setExcelRows(null); setExcelError(null); setPasteText('');
    setVerifyResult(null); setPickedMissing(new Set());
  };

  const runVerify = async () => {
    setVerifyResult(null);
    setPickedMissing(new Set());
    const r = await runLogged(runLog, {
      title: 'Jira 연결 점검',
      first: '내 업무에 연결된 Jira 이슈가 아직 있는지 점검 요청',
      fn: async () => (await verifyMut.mutateAsync(false)).data,
      summarize: (data): RunLogEntry[] => {
        if (data.status !== 'ok') return [['error', `점검 실패(${data.status}) — ${data.detail}`]];
        const out: RunLogEntry[] = [];
        for (const m of data.missing.slice(0, LOG_ITEM_CAP)) {
          out.push(['warn', `${m.jiraKey} ${m.title} · 찾을 수 없음 — ${m.detail}`]);
        }
        if (data.missing.length > LOG_ITEM_CAP) out.push(['warn', `외 ${data.missing.length - LOG_ITEM_CAP}건`]);
        if (data.truncated) out.push(['warn', '점검 상한에 걸려 일부 연결만 확인했습니다']);
        out.push([data.missing.length ? 'warn' : 'info', `점검 ${data.checked} · 찾을 수 없음 ${data.missing.length}`]);
        return out;
      },
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('연결 점검 실패', formatApiError(r.error));
      return;
    }
    const data = r.data;
    if (data.status !== 'ok') {
      toast.error('연결 점검 실패', data.detail);
      return;
    }
    setVerifyResult(data);
    // 찾지 못한 연결은 기본으로 전부 선택 — 대개 그대로 정리하려는 흐름이다.
    setPickedMissing(new Set(data.missing.map((m) => m.workItemId)));
    toast.info('연결 점검됨', data.detail);
  };

  /** 고른 죽은 링크를 일괄 정리. deleteWorkItem=true 면 업무 행까지 삭제한다. */
  const cleanMissing = async (deleteWorkItem: boolean) => {
    const ids = [...pickedMissing];
    if (!ids.length) return;
    setCleaning(true);
    const verb = deleteWorkItem ? '업무 삭제' : '연결 해제';
    const byId = new Map((verifyResult?.missing ?? []).map((m) => [m.workItemId, m]));
    let ok = 0;
    let failed = 0;
    // 브라우저 루프 — 항목마다 단계·결과 줄, 한 건 실패가 나머지를 막지 않는다(D-136).
    await runLogged(runLog, {
      title: deleteWorkItem ? 'Jira 연결 정리 · 업무 삭제' : 'Jira 연결 정리 · 연결 해제',
      first: `찾을 수 없는 연결 ${ids.length}건 ${verb} 시작`,
      fn: async () => {
        for (const id of ids) {
          const m = byId.get(id);
          const label = m ? `${m.jiraKey} ${m.title}` : id;
          runLog.setStep(id, m?.jiraKey || id, 'running');
          try {
            const { data } = await unlinkMut.mutateAsync({ itemId: id, data: { deleteWorkItem } });
            if (data.status === 'ok') {
              ok += 1;
              runLog.setStep(id, '', 'done');
              runLog.log('info', `${label} · ${data.workItemDeleted ? '연결 해제 + 업무 삭제' : '연결 해제'} 완료`);
            } else {
              failed += 1;
              runLog.setStep(id, '', 'failed');
              runLog.log('error', `${label} · ${verb} 실패 — ${data.detail}`);
            }
          } catch (err) {
            failed += 1;
            runLog.setStep(id, '', 'failed');
            runLog.log('error', `${label} · ${verb} 실패 — ${formatApiError(err)}`);
          }
        }
      },
      summarize: () => [[failed ? 'warn' : 'info', `${verb} 대상 ${ids.length} · 성공 ${ok} · 실패 ${failed}`]],
    });
    setCleaning(false);
    if (ok) {
      toast.success(deleteWorkItem ? '업무 삭제 완료' : '연결 해제 완료', `${ok}건 처리했습니다.`);
      setVerifyResult((prev) => prev && {
        ...prev,
        missing: prev.missing.filter((m) => !pickedMissing.has(m.workItemId)),
      });
      setPickedMissing(new Set());
    }
    if (failed) toast.error('일부 실패', `${failed}건 실패 — 실행 로그에서 항목별 사유를 확인하세요.`);
  };

  const run = async (dryRun: boolean) => {
    if (!dryRun) setDone(null);
    const applicable = (preview?.items ?? [])
      .filter((it) => it.action !== 'unchanged')
      .map((it) => it.jiraKey);
    const scopeLabel = SCOPES.find((x) => x.id === scope)?.label ?? scope;
    const r = await runLogged(runLog, {
      title: dryRun ? 'Jira 가져오기 미리보기' : 'Jira 가져오기',
      first: `${scopeLabel} 조건으로 ${dryRun ? '미리보기(저장 없음)' : '가져오기'} 요청${!dryRun && excluded.size > 0 ? ` · 제외 ${excluded.size}건` : ''}`,
      fn: async () => (await importMut.mutateAsync({
        scope,
        projectKey: scope === 'project' || scope === 'filter' ? projectKey.trim() : undefined,
        jql: scope === 'jql' ? jql.trim() : undefined,
        labels: scope === 'filter' ? csv(labels) : undefined,
        components: scope === 'filter' ? csv(components) : undefined,
        statuses: scope === 'filter' ? csv(statuses) : undefined,
        assignee: scope === 'filter' && assignee.trim() ? assignee.trim() : undefined,
        // 이번주(기본값) 등 날짜 범위 — 직접 JQL(scope='jql')은 사용자가 전체 쿼리를 쥐고
        // 있으므로 자동으로 끼워넣지 않는다.
        updatedSinceDays: scope !== 'jql' && sinceDays.trim() ? Number(sinceDays) : undefined,
        onlyKeys: !dryRun && excluded.size > 0 ? applicable.filter((k) => !excluded.has(k)) : undefined,
        dryRun,
      })).data,
      summarize: importResultLines,
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('요청 실패', formatApiError(r.error));
      return;
    }
    const data = r.data;
    if (data.status !== 'ok') {
      toast.error('Jira ' + (data.status === 'offline' ? '연결 실패' : '오류'), data.detail || '가져오기에 실패했습니다.');
      setPreview(data);
      return;
    }
    if (dryRun) {
      setPreview(data);
      setExcluded(new Set());
      toast.info('미리보기 생성됨', `신규 ${data.imported} · 갱신 ${data.updated} · 변경없음 ${data.skipped}`);
    } else {
      setDone(data);
      setPreview(null);
      toast.success('Jira 가져옴', `신규 ${data.imported} · 갱신 ${data.updated}`);
    }
  };

  /** Excel 파일/붙여넣기 파싱 공통 — 실행 로그에 매칭 결과·매칭 실패 행을 남기고 인라인 오류도 유지한다. */
  const parseExcel = async (title: string, first: string, fn: () => Promise<JiraExcelImportResult>) => {
    setExcelBusy(true); setExcelError(null); setExcelRows(null);
    const r = await runLogged(runLog, { title, first, fn, summarize: excelParseLines });
    setExcelBusy(false);
    if (!r.ok) {
      if (!r.aborted) setExcelError(formatApiError(r.error));
      return;
    }
    if (r.data.status !== 'ok') setExcelError(r.data.detail || '파싱 실패');
    else setExcelRows(r.data);
  };

  const handleFile = (file: File) => parseExcel(
    'Excel 파일 읽기', `${file.name} (${Math.max(1, Math.round(file.size / 1024))}KB) 업로드·파싱 요청`,
    async () => (await jiraApi.importExcel(file)).data,
  );

  const handlePaste = async () => {
    if (!pasteText.trim()) { toast.error('붙여넣은 내용이 없습니다'); return; }
    await parseExcel(
      '붙여넣기 변환', `붙여넣은 표 ${pasteText.split('\n').filter((l) => l.trim()).length}줄 변환 요청`,
      async () => (await jiraApi.importPaste(pasteText)).data,
    );
  };

  const saveExcelRows = async () => {
    if (!excelRows?.rows.length) return;
    setExcelBusy(true);
    const rows = excelRows.rows;
    const r = await runLogged(runLog, {
      title: '업무 관리에 저장',
      first: `Excel·붙여넣기 ${rows.length}행 업무 관리 저장 요청`,
      fn: async () => (await jiraApi.importSaveToBoard(rows)).data,
      summarize: importResultLines,
    });
    setExcelBusy(false);
    if (!r.ok) {
      if (!r.aborted) toast.error('저장 실패', formatApiError(r.error));
      return;
    }
    const data = r.data;
    if (data.status !== 'ok') {
      toast.error('저장 실패', data.detail || '업무 저장에 실패했습니다.');
      return;
    }
    setDone(data);
    setExcelRows(null);
    toast.success('업무 관리에 저장됨', `신규 ${data.imported} · 갱신 ${data.updated}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="jira-import-modal-title"
        className="relative bg-card border border-border rounded-md shadow-card w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <DownloadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="jira-import-modal-title" className="text-base font-semibold leading-tight">Jira 가져오기</h2>
            <p className="text-xs text-muted-foreground">
              내 Jira 인증 권한으로 이슈를 가져오거나, Jira 에서 내보낸 Excel·표를 그대로 등록합니다.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} title="닫기"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          {done ? (
            /* 완료 상태 — 결과만 보여주고 닫기 / 다시 가져오기 */
            <>
              <div className="rounded-xl border border-status-healthy/30 bg-status-healthy/5 p-4">
                <div className="flex items-center gap-2 font-medium text-status-healthy">
                  <CheckCircle2 className="w-4 h-4" /> 가져오기 완료
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div><span className="text-muted-foreground">신규</span> <b className="text-status-healthy">{done.imported}</b></div>
                  <div><span className="text-muted-foreground">갱신</span> <b className="text-status-info">{done.updated}</b></div>
                  <div><span className="text-muted-foreground">건너뜀</span> <b>{done.skipped}</b></div>
                </div>
                {done.appliedJql && (
                  <p className="mt-2 text-[11px] font-mono text-muted-foreground break-all">JQL: {done.appliedJql}</p>
                )}
                {done.errors.length > 0 && (
                  <div className="mt-2 text-xs text-status-critical">
                    {done.errors.slice(0, 5).map((e, i) => <div key={i}><AlertTriangle className="inline w-3 h-3 mr-1 align-[-2px]" aria-hidden />{e}</div>)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={resetAll}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80">
                  <RotateCcw className="w-4 h-4" /> 다시 가져오기
                </button>
                <button type="button" onClick={onClose}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">
                  닫기
                </button>
              </div>
            </>
          ) : (
            <>
              {/* 내 Jira 연결 — 개인 자격 등록(관리자 아님). 미등록이면 여기서 바로 해결한다. */}
              <JiraConnectCard compact />

              {/* 소스 선택 — Jira 검색 / Excel·붙여넣기 */}
              <div className="flex items-stretch gap-1.5">
                {([
                  { id: 'jql' as const, label: 'Jira 에서 검색', icon: DownloadCloud },
                  { id: 'excel' as const, label: 'Excel · 붙여넣기', icon: FileSpreadsheet },
                  { id: 'verify' as const, label: '연결 점검', icon: ShieldCheck },
                ]).map((m) => {
                  const Icon = m.icon;
                  return (
                    <button key={m.id} type="button" onClick={() => setSource(m.id)} aria-pressed={source === m.id}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                        source === m.id ? 'bg-primary/10 text-primary border-primary/30'
                          : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                      }`}>
                      <Icon className="w-4 h-4" /> {m.label}
                    </button>
                  );
                })}
              </div>

              {source === 'jql' && (
                <>
                  <div className="flex items-stretch gap-1.5">
                    {SCOPES.map((s) => (
                      <button key={s.id} type="button" onClick={() => { setScope(s.id); setPreview(null); }}
                        aria-pressed={scope === s.id}
                        className={`flex-1 px-2 py-2 rounded-xl border text-xs font-medium transition-colors ${
                          scope === s.id ? 'bg-primary/10 text-primary border-primary/30'
                            : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                        }`}>
                        {s.label}
                      </button>
                    ))}
                  </div>

                  {scope === 'project' && (
                    <div>
                      <span className="text-sm font-medium text-muted-foreground mb-1 block">프로젝트 키</span>
                      <input className={inputCls} placeholder="PROJ" value={projectKey}
                        onChange={(e) => { setProjectKey(e.target.value); setPreview(null); }} />
                    </div>
                  )}

                  {(scope === 'me' || scope === 'project') && (
                    <div>
                      <span className="text-sm font-medium text-muted-foreground mb-1 block">최근 N일 변경분</span>
                      <input className={inputCls} type="number" min={1} placeholder="7" value={sinceDays}
                        onChange={(e) => { setSinceDays(e.target.value); setPreview(null); }} />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        기본값은 이번주 월요일부터입니다 — 비우면 전체 이력을 가져옵니다.
                      </p>
                    </div>
                  )}

                  {scope === 'filter' && (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">프로젝트 (쉼표)</span>
                          <input className={inputCls} placeholder="PROJ" value={projectKey}
                            onChange={(e) => { setProjectKey(e.target.value); setPreview(null); }} />
                        </div>
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">컴포넌트 (쉼표)</span>
                          <input className={inputCls} placeholder="K8s, Network" value={components}
                            onChange={(e) => { setComponents(e.target.value); setPreview(null); }} />
                        </div>
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">라벨 (쉼표)</span>
                          <input className={inputCls} placeholder="infra, urgent" value={labels}
                            onChange={(e) => { setLabels(e.target.value); setPreview(null); }} />
                        </div>
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">상태 (쉼표)</span>
                          <input className={inputCls} placeholder="In Progress, Done" value={statuses}
                            onChange={(e) => { setStatuses(e.target.value); setPreview(null); }} />
                        </div>
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">담당자 (선택)</span>
                          <input className={inputCls} placeholder="jira 계정 또는 currentUser()" value={assignee}
                            onChange={(e) => { setAssignee(e.target.value); setPreview(null); }} />
                        </div>
                        <div>
                          <span className="text-xs font-medium text-muted-foreground mb-1 block">최근 N일 변경분</span>
                          <input className={inputCls} type="number" min={1} placeholder="7" value={sinceDays}
                            onChange={(e) => { setSinceDays(e.target.value); setPreview(null); }} />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        프로젝트·컴포넌트·라벨은 <b>개별 또는 조합</b>으로 쓸 수 있습니다 — 채운 조건끼리 AND,
                        쉼표로 나열한 값은 OR. <b>하나도 채우지 않으면 실행되지 않습니다.</b>
                      </p>
                    </div>
                  )}

                  {scope === 'jql' && (
                    <div>
                      <span className="text-sm font-medium text-muted-foreground mb-1 block">JQL</span>
                      <input className={inputCls} placeholder='project = "PROJ" AND status != Done ORDER BY updated DESC'
                        value={jql} onChange={(e) => { setJql(e.target.value); setPreview(null); }} />
                    </div>
                  )}

                  {preview && preview.status === 'ok' && (
                    <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm">
                      <div className="flex items-center gap-3 font-medium">
                        <span className="text-status-healthy">신규 {preview.imported}</span>
                        <span className="text-status-info">갱신 {preview.updated}</span>
                        <span className="text-muted-foreground">변경없음 {preview.skipped}</span>
                        <span className="text-muted-foreground ml-auto">검색 {preview.total}건{preview.truncated ? '+' : ''}</span>
                      </div>
                      {preview.appliedJql && (
                        <p className="mt-1 text-[11px] font-mono text-muted-foreground break-all">JQL: {preview.appliedJql}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        미리보기 — 아직 저장되지 않았습니다. <b>적용할 항목만 체크</b>한 뒤 "가져오기 확정"을 누르세요.
                        {excluded.size > 0 && <span className="text-status-warning"> ({excluded.size}건 제외됨)</span>}
                      </p>
                      {preview.items.length > 0 && (
                        <ul className="mt-2 max-h-56 overflow-y-auto divide-y divide-border/40">
                          {preview.items.map((it) => (
                            <li key={it.jiraKey} className="py-1">
                              <div className="flex items-center gap-2">
                                {it.action !== 'unchanged' && (
                                  <input type="checkbox" className="rounded border-border"
                                    checked={!excluded.has(it.jiraKey)}
                                    onChange={(e) => setExcluded((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.delete(it.jiraKey);
                                      else next.add(it.jiraKey);
                                      return next;
                                    })}
                                    aria-label={`${it.jiraKey} 적용 여부`} />
                                )}
                                <span className={`text-[11px] font-semibold px-1 rounded ${
                                  it.action === 'create' ? 'bg-status-healthy/15 text-status-healthy'
                                    : it.action === 'update' ? 'bg-status-info/15 text-status-info'
                                    : 'bg-secondary text-muted-foreground'
                                }`}>
                                  {it.action === 'create' ? '신규' : it.action === 'update' ? '갱신' : '변경없음'}
                                </span>
                                <span className="font-mono text-xs text-muted-foreground">{it.jiraKey}</span>
                                <span className="truncate flex-1">{it.title}</span>
                              </div>
                              {(it.changes?.length ?? 0) > 0 && (
                                <ul className="ml-6 mt-0.5 space-y-0.5">
                                  {(it.changes ?? []).map((c) => (
                                    <li key={c.field} className="text-[11px] text-muted-foreground">
                                      <span className="font-medium text-foreground">{c.label || c.field}</span>{' '}
                                      <span className="line-through opacity-70">{c.old || '(없음)'}</span>
                                      {' → '}
                                      <span className="text-status-info">{c.new || '(없음)'}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {preview && preview.status !== 'ok' && (
                    <div className="rounded-xl bg-status-critical/10 text-status-critical px-3 py-2 text-sm flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <div>
                        <div>{preview.detail}</div>
                        {preview.appliedJql && <div className="mt-1 font-mono text-[11px] break-all">JQL: {preview.appliedJql}</div>}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    {preview && preview.status === 'ok' && (
                      <button type="button" onClick={() => setPreview(null)} disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
                        <RotateCcw className="w-4 h-4" /> 다시 검색
                      </button>
                    )}
                    <button type="button"
                      onClick={() => void run(!(preview && preview.status === 'ok'))}
                      disabled={busy || !cred?.configured}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      {preview && preview.status === 'ok' ? '가져오기 확정' : '가져오기'}
                    </button>
                    <button type="button" onClick={onClose} disabled={busy}
                      className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground">닫기</button>
                  </div>
                </>
              )}

              {source === 'excel' && (
                <>
                  <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-3">
                    <div>
                      <span className="text-sm font-medium text-muted-foreground mb-1 block">파일 업로드 (.xlsx / .xls)</span>
                      <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
                      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-secondary disabled:opacity-50">
                        {excelBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        파일 선택
                      </button>
                    </div>
                    <div>
                      <span className="text-sm font-medium text-muted-foreground mb-1 block">또는 표 붙여넣기 (TSV)</span>
                      <textarea className={`${inputCls} font-mono text-xs min-h-[80px] resize-y`}
                        placeholder="Jira 표를 복사해 붙여넣으세요 (Ctrl+V)"
                        value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
                      <button type="button" onClick={() => void handlePaste()} disabled={busy}
                        className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-secondary disabled:opacity-50">
                        {excelBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
                        붙여넣기 가져오기
                      </button>
                    </div>
                  </div>

                  {excelError && (
                    <div className="rounded-xl bg-status-critical/10 text-status-critical px-3 py-2 text-sm flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> {excelError}
                    </div>
                  )}

                  {excelRows && (
                    <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm">
                      <div className="flex items-center gap-3 font-medium">
                        <span>총 {excelRows.total}건</span>
                        <span>담당자 매칭 {excelRows.matched}</span>
                        <span className="text-muted-foreground">미매칭 {excelRows.total - excelRows.matched}</span>
                      </div>
                      <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-border/40">
                        {excelRows.rows.slice(0, 100).map((r, i) => (
                          <li key={`${r.key}-${i}`} className="py-1 flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{r.key}</span>
                            <span className="truncate flex-1">{r.summary}</span>
                            <span className="text-xs text-muted-foreground">{r.assigneeName}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-center gap-2 mt-3">
                        <button type="button" onClick={() => void saveExcelRows()} disabled={busy}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                          {excelBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                          업무 관리에 저장
                        </button>
                        <Link to="/jira-import" onClick={onClose}
                          className="text-xs text-muted-foreground hover:text-foreground underline">
                          전체 표로 자세히 보기
                        </Link>
                      </div>
                    </div>
                  )}

                  {!excelRows && (
                    <div className="flex items-center gap-2 pt-1">
                      <Link to="/jira-import" onClick={onClose}
                        className="text-xs text-muted-foreground hover:text-foreground underline">
                        전체 표로 자세히 보기
                      </Link>
                      <button type="button" onClick={onClose} disabled={busy}
                        className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground">닫기</button>
                    </div>
                  )}
                </>
              )}

              {source === 'verify' && (
                <>
                  <p className="text-xs text-muted-foreground">
                    연결된 업무의 Jira 이슈가 아직 살아 있는지 확인합니다. Jira 에서 이슈를 직접
                    지웠다면 PEP 에는 죽은 링크가 남는데, 여기서 찾아 정리할 수 있습니다.
                    <b className="text-foreground"> 찾지 못한 것이 항상 삭제된 것은 아닙니다</b> —
                    조회 권한이 없어도 똑같이 안 보이므로 확인 후 처리하세요.
                  </p>

                  <button type="button" onClick={() => void runVerify()} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                    {verifyMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                    내 업무의 Jira 연결 점검
                  </button>

                  {verifyResult && (
                    <div className="rounded-xl border border-border bg-secondary/30 p-3 text-sm">
                      <div className="flex items-center gap-3 font-medium">
                        <span>확인 {verifyResult.checked}건</span>
                        <span className={verifyResult.missing.length ? 'text-status-warning' : 'text-status-healthy'}>
                          미확인 {verifyResult.missing.length}건
                        </span>
                        {verifyResult.truncated && (
                          <span className="text-xs text-muted-foreground">(상한 초과 — 일부만 검사)</span>
                        )}
                      </div>

                      {verifyResult.missing.length > 0 ? (
                        <>
                          <ul className="mt-2 max-h-48 overflow-y-auto divide-y divide-border/40">
                            {verifyResult.missing.map((m) => (
                              <li key={m.workItemId} className="py-1.5 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="rounded border-border"
                                  checked={pickedMissing.has(m.workItemId)}
                                  onChange={(e) => setPickedMissing((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(m.workItemId);
                                    else next.delete(m.workItemId);
                                    return next;
                                  })}
                                  aria-label={`${m.jiraKey} 선택`}
                                />
                                <span className="font-mono text-xs text-brand-jira dark:text-blue-300">{m.jiraKey}</span>
                                <span className="truncate flex-1">{m.title}</span>
                              </li>
                            ))}
                          </ul>
                          <div className="flex items-center gap-2 mt-3">
                            <button type="button" onClick={() => void cleanMissing(false)}
                              disabled={busy || pickedMissing.size === 0}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
                              {cleaning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2Off className="w-4 h-4" />}
                              연결만 해제 ({pickedMissing.size})
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteCount(pickedMissing.size)}
                              disabled={busy || pickedMissing.size === 0}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-status-critical/30 text-status-critical text-sm hover:bg-status-critical/10 disabled:opacity-50">
                              <Trash2 className="w-4 h-4" /> 업무까지 삭제 ({pickedMissing.size})
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="mt-2 text-muted-foreground">{verifyResult.detail}</p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <button type="button" onClick={onClose} disabled={busy}
                      className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground">닫기</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {confirmDeleteCount !== null && (
        <ConfirmDialog
          open={confirmDeleteCount !== null}
          title="업무 일괄 삭제"
          description={`선택한 업무 ${confirmDeleteCount}건을 Jira 연결 해제와 함께 완전히 삭제합니다. 되돌릴 수 없습니다.`}
          danger
          confirmLabel="삭제"
          onConfirm={() => { setConfirmDeleteCount(null); void cleanMissing(true); }}
          onCancel={() => setConfirmDeleteCount(null)}
        />
      )}
    </div>
  );
}
