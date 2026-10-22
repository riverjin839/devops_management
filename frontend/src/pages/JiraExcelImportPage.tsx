import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileSpreadsheet, Upload, Loader2, ExternalLink, CheckCircle2, AlertTriangle, X, ClipboardPaste,
  Save, ArrowRight, ListChecks,
} from 'lucide-react';
import { jiraApi } from '@/services/api';
import type {
  JiraExcelFieldChange, JiraExcelImportResult, JiraExcelRow, JiraExcelSaveItem, JiraExcelSaveResult,
} from '@/types';
import { formatApiError } from '@/lib/utils';
import {
  ConfirmDialog, ViewModeBar, EmptyState, PageHeader, PageShell, RunLogPanel, TenantScopeSelect,
} from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useMyTenants } from '@/hooks/useTenants';
import { MacCard } from '@/components/ui/MacCard';

type ImportMode = 'file' | 'paste';

/** 로그 항목 줄 상한 — 수백 건이면 앞 200건 + "외 N건" 줄(D-136). */
const LOG_ITEM_CAP = 200;
const ACTION_LABEL: Record<string, string> = {
  create: '생성', update: '갱신', unchanged: '변경 없음', skip: '건너뜀', error: '오류',
};
/** 서버 변경 필드명(원문) → 화면 표기. label 이 오면 그쪽이 우선. */
const FIELD_LABEL: Record<string, string> = {
  title: '제목', content: '본문', kanban_status: '칸반 상태', jira_status: 'Jira 상태',
  jira_url: 'Jira 링크', due_date: '마감일', assignee: '담당자', issue_type: '유형',
  environment: '환경', description: '설명', priority: '우선순위', tenant_id: '공유 범위',
};
const TENANT_REQUIRED_HINT = '공유 범위를 선택하세요';

/** 빈 값 표기 — 공란 대신 `—`. */
function dash(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const s = String(v).trim();
  return s ? s : '—';
}

function itemKey(it: JiraExcelSaveItem): string {
  return it.jiraKey || it.key || '';
}

function changeName(c: JiraExcelFieldChange): string {
  return c.label || FIELD_LABEL[c.field] || c.field;
}
function changeBefore(c: JiraExcelFieldChange): string {
  return dash(c.before !== undefined ? c.before : c.old);
}
function changeAfter(c: JiraExcelFieldChange): string {
  return dash(c.after !== undefined ? c.after : c.new);
}

/** 표 안에서 두 번 이상 나온 키 — 서버가 목록을 주면 그대로, 구버전 응답이면 행에서 센다. */
function duplicateKeys(result: JiraExcelImportResult): { keys: string[]; count: number } {
  let keys: string[];
  if (Array.isArray(result.duplicates)) {
    keys = result.duplicates;
  } else {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const r of result.rows) {
      if (seen.has(r.key)) dup.add(r.key);
      seen.add(r.key);
    }
    keys = [...dup];
  }
  const count = typeof result.duplicates === 'number' ? Math.max(result.duplicates, keys.length) : keys.length;
  return { keys, count };
}

/** 실패 건수 — 행 단위 오류(action=error)와 errors 목록 중 큰 쪽. */
function failedCount(res: JiraExcelSaveResult): number {
  const rowErrors = (res.items ?? []).filter((it) => it.action === 'error').length;
  return Math.max(res.errors?.length ?? 0, rowErrors);
}

/** 파싱 응답 → 실행 로그 줄: 담당자 매칭 결과 + 매칭 실패 행 + 중복·잘림. */
function parseLines(data: JiraExcelImportResult): RunLogEntry[] {
  if (data.status !== 'ok') return [['error', `파싱 실패 — ${data.detail || '사유 없음'}`]];
  const out: RunLogEntry[] = [];
  const unmatched = (data.rows ?? []).filter((r) => !r.assigneeMatched);
  for (const r of unmatched.slice(0, LOG_ITEM_CAP)) {
    out.push(['warn', `${r.key} ${r.summary} · 담당자 매칭 실패 (${r.assigneeRaw || '비어 있음'})`]);
  }
  if (unmatched.length > LOG_ITEM_CAP) out.push(['warn', `외 ${unmatched.length - LOG_ITEM_CAP}건 매칭 실패`]);
  const dup = duplicateKeys(data);
  if (dup.count > 0) {
    out.push(['warn', `중복 키 ${dup.count}건 — 첫 행만 저장됩니다${dup.keys.length ? `: ${dup.keys.slice(0, 20).join(', ')}${dup.keys.length > 20 ? ' …' : ''}` : ''}`]);
  }
  if (data.truncated) out.push(['warn', `행 상한을 넘어 앞 ${data.rows.length}행만 가져왔습니다`]);
  out.push([unmatched.length ? 'warn' : 'info', `행 ${data.total} · 담당자 매칭 ${data.matched}/${data.total}${data.detail ? ` — ${data.detail}` : ''}`]);
  return out;
}

/** 저장 응답(미리보기·적용 공용) → 실행 로그 줄: 행별 1줄 · 오류 전부 · 합계. */
function saveLines(data: JiraExcelSaveResult, phase: '미리보기' | '적용'): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  if (data.status !== 'ok') out.push(['error', `${phase} 실패(${data.status}) — ${data.detail || '사유 없음'}`]);
  const items = data.items ?? [];
  const rowErrors: string[] = [];
  for (const it of items.slice(0, LOG_ITEM_CAP)) {
    const head = `${itemKey(it) || '(키 없음)'}${it.title ? ` ${it.title}` : ''}`;
    if (it.action === 'error') {
      out.push(['error', `${head} · 오류 — ${it.error || '사유 없음'}`]);
      if (it.error) rowErrors.push(it.error);
      continue;
    }
    const ch = it.changes ?? [];
    const fields = ch.length ? ` · ${ch.map(changeName).join(', ')}` : '';
    out.push([
      it.action === 'skip' ? 'warn' : 'info',
      `${head} · ${ACTION_LABEL[it.action] ?? it.action}${fields}${it.error ? ` — ${it.error}` : ''}`,
    ]);
  }
  if (items.length > LOG_ITEM_CAP) out.push(['info', `외 ${items.length - LOG_ITEM_CAP}건`]);
  const hidden = (data.total ?? 0) - items.length;
  if (data.truncated && hidden > 0) {
    out.push(['warn', `응답에는 앞 ${items.length}행만 담겼습니다 — 나머지 ${hidden}행은 합계에만 반영`]);
  }
  // 행 줄에 이미 나온 오류는 다시 쓰지 않는다(errors 가 "KEY: 사유" 형태로 같은 내용을 담는 경우).
  for (const e of data.errors ?? []) {
    if (rowErrors.some((x) => x === e || e.includes(x))) continue;
    out.push(['error', e]);
  }
  if (data.status === 'ok') {
    const errs = failedCount(data);
    const verb = phase === '미리보기' ? ' 예정' : '';
    out.push([
      errs ? 'warn' : 'info',
      `${phase} 완료 · 총 ${data.total} · 생성${verb} ${data.imported} · 갱신${verb} ${data.updated} · 건너뜀 ${data.skipped}${errs ? ` · 오류 ${errs}` : ''}`,
    ]);
  }
  return out;
}

/**
 * Jira 에서 추출한 이슈 목록 Excel(.xlsx, .xls) 을 업로드하거나, 엑셀/Jira 표를 그대로
 * 복사해 붙여넣어 테이블로 미리보고, "업무 관리에 저장"을 누르면 먼저 변경 내역(dry-run)을
 * 보여준 뒤 고른 행만 업무 관리 게시판(work_items)에 적용한다. 담당자(Assignee, "이름 회사")에서
 * 이름을 추출해 등록된 PEP 담당자와 매칭한 결과를 함께 표시한다.
 */
export function JiraExcelImportPage() {
  const [mode, setMode] = useState<ImportMode>('file');
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JiraExcelImportResult | null>(null);

  // ── 업무 관리 게시판에 저장 (1단계 dry-run → 2단계 선택 적용) ──
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<JiraExcelSaveResult | null>(null);
  /** 체크를 해제한 키 — 기본은 전부 체크(빈 집합). */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<JiraExcelSaveResult | null>(null);

  // 새 업무의 공유 범위 — 소속 테넌트가 1개면 그 테넌트, 0개면 전체 공유, 여러 개면 직접 골라야 한다.
  const { data: myTenants = [] } = useMyTenants();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantChosen, setTenantChosen] = useState(false);
  const effectiveTenantId = tenantChosen ? tenantId : (myTenants.length === 1 ? myTenants[0].id : null);
  const tenantMissing = myTenants.length > 1 && !tenantChosen;

  const { canOperate, withHint, ariaWithHint } = useCanOperate();

  // 파일 읽기·붙여넣기 변환·저장 실행 로그(D-136).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('jira-excel-import');

  const clearSave = () => {
    setPlan(null);
    setExcluded(new Set());
    setConfirmOpen(false);
    setSaveError(null);
    setSaveResult(null);
  };

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setError(null);
    setResult(null);
    clearSave();
    setLoading(true);
    const r = await runLogged(runLog, {
      title: 'Excel 파일 읽기',
      first: `${file.name} (${Math.max(1, Math.round(file.size / 1024))}KB) 업로드·파싱 요청`,
      fn: async () => (await jiraApi.importExcel(file)).data,
      summarize: parseLines,
    });
    setLoading(false);
    if (!r.ok) {
      if (!r.aborted) setError(formatApiError(r.error, 'Excel 파일을 가져오는 중 오류가 발생했습니다.'));
      return;
    }
    if (r.data.status === 'error') setError(r.data.detail || '가져오기에 실패했습니다.');
    else setResult(r.data);
  };

  const handlePaste = async () => {
    if (!pasteText.trim() || loading) return;
    setError(null);
    setResult(null);
    clearSave();
    setLoading(true);
    const r = await runLogged(runLog, {
      title: '붙여넣기 변환',
      first: `붙여넣은 표 ${pasteText.split('\n').filter((l) => l.trim()).length}줄 변환 요청`,
      fn: async () => (await jiraApi.importPaste(pasteText)).data,
      summarize: parseLines,
    });
    setLoading(false);
    if (!r.ok) {
      if (!r.aborted) setError(formatApiError(r.error, '붙여넣은 내용을 가져오는 중 오류가 발생했습니다.'));
      return;
    }
    if (r.data.status === 'error') setError(r.data.detail || '가져오기에 실패했습니다.');
    else setResult(r.data);
  };

  /** 1단계 — dry-run: 아무것도 저장하지 않고 행별 생성/갱신/변경 필드를 받는다. */
  const handlePlan = async () => {
    if (!result || result.rows.length === 0 || planning || saving || !canOperate || tenantMissing) return;
    clearSave();
    setPlanning(true);
    const rows = result.rows;
    const r = await runLogged(runLog, {
      title: '저장 미리보기',
      first: `${rows.length}행 저장 미리보기(dry-run) 요청 — 아직 저장하지 않습니다`,
      fn: async () => (await jiraApi.importExcelSave({ rows, dryRun: true, tenantId: effectiveTenantId })).data,
      summarize: (d) => (d.dryRun === true
        ? saveLines(d, '미리보기')
        : [['warn', '서버가 미리보기를 지원하지 않아 바로 저장했습니다'], ...saveLines(d, '적용')]),
    });
    setPlanning(false);
    if (!r.ok) {
      if (!r.aborted) setSaveError(formatApiError(r.error, '저장 미리보기를 만드는 중 오류가 발생했습니다.'));
      return;
    }
    if (r.data.status !== 'ok') {
      setSaveError(r.data.detail || '저장 미리보기에 실패했습니다.');
      return;
    }
    // 구버전 서버는 dry_run 을 모른 채 바로 저장한다 — 결과로 취급한다.
    if (r.data.dryRun !== true) setSaveResult(r.data);
    else setPlan(r.data);
  };

  // 적용 대상 집계 — 서버 합계(전체 행 기준)에서 체크 해제한 표시 행만 뺀다(items 200행 상한 대응).
  const planItems = plan?.items ?? [];
  const isSelectable = (it: JiraExcelSaveItem) => (it.action === 'create' || it.action === 'update') && !!itemKey(it);
  const excludedCreates = planItems.filter((it) => it.action === 'create' && excluded.has(itemKey(it))).length;
  const excludedUpdates = planItems.filter((it) => it.action === 'update' && excluded.has(itemKey(it))).length;
  const applyCreates = Math.max(0, (plan?.imported ?? 0) - excludedCreates);
  const applyUpdates = Math.max(0, (plan?.updated ?? 0) - excludedUpdates);
  const applyCount = applyCreates + applyUpdates;
  const selectableItems = planItems.filter(isSelectable);
  const allChecked = selectableItems.length > 0 && selectableItems.every((it) => !excluded.has(itemKey(it)));
  const hiddenPlanRows = plan?.truncated ? Math.max(0, (plan.total ?? 0) - planItems.length) : 0;
  const updateKeys = planItems.filter((it) => it.action === 'update' && !excluded.has(itemKey(it))).map(itemKey);

  const toggleKey = (key: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleAll = () => {
    setExcluded(allChecked ? new Set(selectableItems.map(itemKey)) : new Set());
  };

  /** 2단계 — 체크한 행만 적용(onlyKeys). 표에 안 보인 행(응답 상한 밖)은 체크된 것으로 본다. */
  const handleApply = async () => {
    if (!result || !plan || saving || !canOperate || applyCount === 0) return;
    setSaveError(null);
    setSaving(true);
    const rows = result.rows;
    const onlyKeys = [...new Set(rows.map((r) => r.key))].filter((k) => k && !excluded.has(k));
    const r = await runLogged(runLog, {
      title: '업무 관리에 저장',
      first: `선택 적용 요청 — 생성 ${applyCreates} · 갱신 ${applyUpdates}${excluded.size ? ` · 체크 해제 ${excluded.size}건 제외` : ''}`,
      fn: async () => (await jiraApi.importExcelSave({ rows, dryRun: false, onlyKeys, tenantId: effectiveTenantId })).data,
      summarize: (d) => saveLines(d, '적용'),
    });
    setSaving(false);
    setConfirmOpen(false);
    if (!r.ok) {
      if (!r.aborted) setSaveError(formatApiError(r.error, '업무 관리 게시판에 저장하는 중 오류가 발생했습니다.'));
      return;
    }
    if (r.data.status !== 'ok') {
      setSaveError(r.data.detail || '저장에 실패했습니다.');
      return;
    }
    setSaveResult(r.data);
    setPlan(null);
    setExcluded(new Set());
  };

  const reset = () => {
    setFileName(null);
    setPasteText('');
    setError(null);
    setResult(null);
    clearSave();
  };

  const saveTitle = !canOperate ? withHint('업무 관리에 저장') : tenantMissing ? TENANT_REQUIRED_HINT : '변경 내역을 먼저 확인한 뒤 저장';
  const saveAria = !canOperate ? ariaWithHint('업무 관리에 저장') : tenantMissing ? `업무 관리에 저장 — ${TENANT_REQUIRED_HINT}` : '업무 관리에 저장';
  const saveFailed = saveResult ? failedCount(saveResult) : 0;
  const dup = result ? duplicateKeys(result) : { keys: [], count: 0 };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-4">
        <PageHeader
          icon={FileSpreadsheet}
          title="Jira Excel 가져오기"
          description={'Jira 에서 내려받은 이슈 목록(.xlsx, .xls)을 업로드하거나 표를 복사해 붙여넣어 미리보고, "업무 관리에 저장"을 누르면 바뀌는 내용을 먼저 확인한 뒤 고른 행만 업무 관리 게시판에 저장합니다.'}
          actions={<>
            <ViewModeBar
              modes={[
                { id: 'file', label: '파일 업로드', icon: <Upload className="w-3.5 h-3.5" /> },
                { id: 'paste', label: '붙여넣기', icon: <ClipboardPaste className="w-3.5 h-3.5" /> },
              ]}
              active={mode}
              onChange={(id) => { setMode(id as ImportMode); reset(); }}
            />
            {/* 업로드/붙여넣기가 정상 확인되면 상단에 저장 버튼 노출 — 먼저 dry-run 결과를 보여준다. */}
            {result && result.status === 'ok' && result.rows.length > 0 && (
              <button
                type="button"
                onClick={handlePlan}
                disabled={!canOperate || tenantMissing || planning || saving}
                title={saveTitle}
                aria-label={saveAria}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                업무 관리에 저장
              </button>
            )}
          </>}
        />

        <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />

        {/* 저장 결과 배너 — 오류가 한 건이라도 있으면 성공이 아니라 경고(D-136 부분 실패). */}
        {saveResult && saveFailed > 0 && (
          <div role="alert" className="px-4 py-3 rounded-xl border border-status-warning/30 bg-status-warning/10 text-sm text-status-warning flex items-center gap-3 flex-wrap">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              일부 실패 {saveFailed}건 — 생성 {saveResult.imported}건 · 갱신 {saveResult.updated}건
              {saveResult.skipped > 0 && ` · 건너뜀 ${saveResult.skipped}건`}
              {saveResult.errors.length > 0 && ` (${saveResult.errors.slice(0, 3).join(', ')}${saveResult.errors.length > 3 ? ' …' : ''})`}
              . 전체 사유는 실행 로그에서 확인하세요.
            </span>
            <Link
              to="/tasks-mgmt"
              className="ml-auto inline-flex items-center gap-1 font-semibold text-primary hover:underline flex-shrink-0"
            >
              업무 관리 게시판에서 보기 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
        {saveResult && saveFailed === 0 && (
          <div role="status" className="px-4 py-3 rounded-xl border border-status-healthy/30 bg-status-healthy/10 text-sm text-status-healthy flex items-center gap-3 flex-wrap">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>
              업무 관리 게시판에 저장했습니다 — 생성 {saveResult.imported}건 · 갱신 {saveResult.updated}건
              {saveResult.skipped > 0 && ` · 건너뜀 ${saveResult.skipped}건`}
            </span>
            <Link
              to="/tasks-mgmt"
              className="ml-auto inline-flex items-center gap-1 font-semibold text-primary hover:underline flex-shrink-0"
            >
              업무 관리 게시판에서 보기 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
        {saveError && (
          <div role="alert" className="px-4 py-3 rounded-xl border border-status-critical/30 bg-status-critical/10 text-sm text-status-critical flex items-start gap-1.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {saveError}
          </div>
        )}

        {/* 2단계 저장 — dry-run 결과(행별 작업·변경 필드·체크) */}
        {plan && (
          <MacCard
            title="저장 미리보기"
            icon={ListChecks}
            titleExtra={
              <span className="text-xs text-muted-foreground tabular-nums">
                생성 {plan.imported} · 갱신 {plan.updated} · 건너뜀 {plan.skipped}
                {failedCount(plan) > 0 && <span className="text-status-critical"> · 오류 {failedCount(plan)}</span>}
              </span>
            }
            description="아직 저장하지 않았습니다. 적용할 행만 체크한 뒤 선택 적용을 누르세요."
            bodyPadding="p-0"
            actions={<>
              <button
                type="button"
                onClick={clearSave}
                disabled={saving}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-xl disabled:opacity-50 transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!canOperate || saving || applyCount === 0}
                title={withHint(applyCount === 0 ? '적용할 행을 체크하세요' : `선택한 ${applyCount}행 적용`)}
                aria-label={ariaWithHint(`선택 적용 (${applyCount}건)`)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                선택 적용 ({applyCount})
              </button>
            </>}
          >
            {hiddenPlanRows > 0 && (
              <p role="status" className="px-4 py-2 text-xs text-status-warning border-b border-border">
                표에는 앞 {planItems.length}행만 표시합니다 — 나머지 {hiddenPlanRows}행은 체크된 상태로 적용됩니다.
              </p>
            )}
            {planItems.length === 0 ? (
              <EmptyState compact title="표시할 행이 없습니다." description="서버가 행별 결과를 보내지 않았습니다. 합계를 확인하세요." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] table-fixed text-sm">
                  <thead>
                    <tr className="bg-secondary/40 border-b border-border text-xs text-muted-foreground">
                      <th className="w-10 px-3 py-2 text-left font-medium">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-primary"
                          checked={allChecked}
                          onChange={toggleAll}
                          disabled={selectableItems.length === 0 || saving}
                          aria-label="표시된 행 전체 선택"
                          title="표시된 행 전체 선택"
                        />
                      </th>
                      <th className="w-[130px] px-3 py-2 text-left font-medium">키</th>
                      <th className="w-[90px] px-3 py-2 text-left font-medium">작업</th>
                      <th className="px-3 py-2 text-left font-medium">변경 필드 (이전 → 이후)</th>
                      <th className="w-[220px] px-3 py-2 text-left font-medium">사유</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {planItems.map((it, i) => (
                      <PlanRow
                        key={`${itemKey(it)}-${i}`}
                        item={it}
                        selectable={isSelectable(it)}
                        checked={isSelectable(it) && !excluded.has(itemKey(it))}
                        disabled={saving}
                        onToggle={() => toggleKey(itemKey(it))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </MacCard>
        )}

        {/* 파일 업로드 / 붙여넣기 */}
        <MacCard title={mode === 'file' ? '파일 업로드' : '표 붙여넣기'}>
          {mode === 'file' ? (
            <div className="flex items-center gap-2 flex-wrap">
              {/* 입력은 sr-only 로 남겨 Tab 으로 도달하고, 포커스 링은 label 이 그린다. */}
              <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-xl cursor-pointer focus-within:ring-2 focus-within:ring-primary/40">
                <Upload className="w-3.5 h-3.5" />
                파일 선택 (.xlsx, .xls)
                <input
                  type="file"
                  accept=".xlsx,.xlsm,.xls"
                  className="sr-only"
                  disabled={loading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              {loading && (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 가져오는 중…
                </span>
              )}
              {fileName && !loading && (
                <span className="text-sm text-muted-foreground">{fileName}</span>
              )}
              <ImportSummaryBadges result={result} />
              {(fileName || result || error) && !loading && (
                <button
                  type="button"
                  onClick={reset}
                  className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-3.5 h-3.5" /> 초기화
                </button>
              )}
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Jira 이슈 목록 또는 엑셀 표를 마우스로 드래그해 <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-xs">Ctrl+C</kbd>로
                복사한 뒤, 아래 칸을 클릭하고 <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-xs">Ctrl+V</kbd>로 붙여넣으세요
                (헤더 행 포함). <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-xs">Ctrl+Enter</kbd>로 바로 가져올 수 있습니다.
              </p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handlePaste(); }
                }}
                placeholder="여기를 클릭하고 Ctrl+V 로 붙여넣기…"
                aria-label="붙여넣을 표"
                disabled={loading}
                rows={8}
                className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y disabled:opacity-60"
              />
              <div className="flex items-center gap-2 flex-wrap mt-2">
                <button
                  type="button"
                  onClick={handlePaste}
                  disabled={loading || !pasteText.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardPaste className="w-3.5 h-3.5" />}
                  가져오기
                </button>
                {loading && (
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    가져오는 중…
                  </span>
                )}
                <ImportSummaryBadges result={result} />
                {(pasteText || result || error) && !loading && (
                  <button
                    type="button"
                    onClick={reset}
                    className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-3.5 h-3.5" /> 초기화
                  </button>
                )}
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-3 px-3 py-2 rounded-md bg-status-critical/10 border border-status-critical/30 text-sm text-status-critical flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </MacCard>

        {/* 결과 테이블 */}
        {result && result.rows.length > 0 && (
          <MacCard
            title="미리보기"
            titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{result.rows.length}건{result.truncated ? ` (총 ${result.total}건 중)` : ''}</span>}
            bodyPadding="p-0"
          >
            {myTenants.length > 0 && (
              <div className="px-4 py-3 border-b border-border sm:w-96">
                <TenantScopeSelect
                  value={effectiveTenantId}
                  onChange={(id) => { setTenantId(id); setTenantChosen(true); clearSave(); }}
                  labelClassName="block text-xs font-medium text-muted-foreground mb-1"
                />
                {tenantMissing && (
                  <p role="status" className="text-xs text-status-warning mt-1">
                    소속 테넌트가 여러 개입니다 — 새 업무의 공유 범위를 고른 뒤 저장하세요.
                  </p>
                )}
              </div>
            )}
            {(dup.count > 0 || result.truncated) && (
              <div role="status" className="px-4 py-2 border-b border-border text-xs text-status-warning space-y-0.5">
                {result.truncated && (
                  <p>행 상한을 넘어 앞 {result.rows.length}행만 가져왔습니다 — 나머지는 파일을 나눠 다시 가져오세요.</p>
                )}
                {dup.count > 0 && (
                  <p>
                    중복 키 {dup.count}건 — 첫 행만 저장됩니다
                    {dup.keys.length > 0 && `: ${dup.keys.slice(0, 10).join(', ')}${dup.keys.length > 10 ? ' …' : ''}`}
                  </p>
                )}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1360px] table-fixed text-sm">
                <thead>
                  <tr className="bg-secondary/40 border-b border-border text-xs text-muted-foreground">
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Key">키</th>
                    <th className="w-[260px] text-left px-3 py-2 font-medium" title="Summary">요약</th>
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Issue Type">유형</th>
                    <th className="w-[100px] text-left px-3 py-2 font-medium" title="Status">상태</th>
                    <th className="w-[140px] text-left px-3 py-2 font-medium" title="Assignee">담당자</th>
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Created">생성일</th>
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Resolved">해결일</th>
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Due Date">마감일</th>
                    <th className="w-[110px] text-left px-3 py-2 font-medium" title="Environment">환경</th>
                    <th className="text-left px-3 py-2 font-medium" title="Description">설명</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((row, i) => (
                    <JiraExcelTableRow key={`${row.key}-${i}`} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </MacCard>
        )}

        {result && result.rows.length === 0 && (
          <EmptyState compact title="가져올 항목이 없습니다." description="파일에 가져올 수 있는 행이 없습니다. 헤더와 필수 열을 확인하세요." />
        )}

        {!result && !error && !loading && (
          <EmptyState
            icon={FileSpreadsheet}
            title="아직 불러온 이슈 목록이 없습니다."
            description={mode === 'file'
              ? 'Jira 에서 내보낸(Export) .xlsx 파일(최대 10MB)을 업로드하면 여기에 미리보기가 나타납니다.'
              : 'Jira 이슈 목록이나 엑셀 표(최대 2MB)를 복사해 위 칸에 붙여넣으면 여기에 미리보기가 나타납니다.'}
          />
        )}
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        title={applyUpdates > 0 ? `기존 업무 ${applyUpdates}건의 필드를 바꿉니다` : `새 업무 ${applyCreates}건을 만듭니다`}
        description={`생성 ${applyCreates}건 · 갱신 ${applyUpdates}건을 업무 관리 게시판에 적용합니다.${excluded.size ? ` 체크를 해제한 ${excluded.size}건은 건너뜁니다.` : ''}`}
        confirmLabel="적용"
        danger={applyUpdates > 0}
        busy={saving}
        onConfirm={handleApply}
        onCancel={() => setConfirmOpen(false)}
      >
        {updateKeys.length > 0 && (
          <p className="text-xs text-muted-foreground break-words">
            갱신 대상: {updateKeys.slice(0, 10).join(', ')}
            {(applyUpdates > Math.min(updateKeys.length, 10)) && ` 외 ${applyUpdates - Math.min(updateKeys.length, 10)}건`}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** 결과 요약 배지(총 건수/매칭/미매칭) — 파일 업로드·붙여넣기 두 모드가 공유. */
function ImportSummaryBadges({ result }: { result: JiraExcelImportResult | null }) {
  if (!result) return null;
  return (
    <>
      <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground border border-border text-sm">
        총 {result.total}건
      </span>
      <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border text-sm">
        담당자 매칭 {result.matched}건
      </span>
      {result.total - result.matched > 0 && (
        <span className="px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30 text-sm">
          미매칭 {result.total - result.matched}건
        </span>
      )}
    </>
  );
}

/** dry-run 결과 1행 — 체크박스 · 키 · 작업 · 변경 필드(이전 → 이후) · 사유. */
function PlanRow({
  item, selectable, checked, disabled, onToggle,
}: {
  item: JiraExcelSaveItem;
  selectable: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const key = itemKey(item);
  const changes = item.changes ?? [];
  const actionCls = item.action === 'error'
    ? 'text-status-critical'
    : item.action === 'skip'
      ? 'text-status-warning'
      : 'text-foreground';
  return (
    <tr className="hover:bg-muted/30 transition-colors align-top">
      <td className="px-3 py-2.5">
        <input
          type="checkbox"
          className="w-4 h-4 accent-primary"
          checked={checked}
          onChange={onToggle}
          disabled={!selectable || disabled}
          aria-label={`${key || '행'} 적용`}
          title={selectable ? `${key} 적용` : '적용할 변경이 없는 행입니다'}
        />
      </td>
      <td className="px-3 py-2.5 font-mono text-xs break-all">
        {dash(key)}
        {item.title && <div className="font-sans text-muted-foreground line-clamp-1" title={item.title}>{item.title}</div>}
      </td>
      <td className={`px-3 py-2.5 ${actionCls}`}>{ACTION_LABEL[item.action] ?? item.action}</td>
      <td className="px-3 py-2.5">
        {changes.length === 0 ? (
          <span className="text-muted-foreground">{item.action === 'create' ? '새 업무' : '—'}</span>
        ) : (
          <ul className="space-y-1">
            {changes.map((c, i) => (
              <li key={`${c.field}-${i}`} className="flex items-start gap-1.5 text-xs min-w-0">
                <span className="font-medium text-foreground flex-shrink-0" title={c.field}>{changeName(c)}</span>
                <span className="text-muted-foreground truncate" title={changeBefore(c)}>{changeBefore(c)}</span>
                <ArrowRight className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                <span className="sr-only">에서</span>
                <span className="text-foreground truncate" title={changeAfter(c)}>{changeAfter(c)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={`px-3 py-2.5 text-xs break-words ${item.action === 'error' ? 'text-status-critical' : 'text-muted-foreground'}`}>
        {dash(item.error)}
      </td>
    </tr>
  );
}

function JiraExcelTableRow({ row }: { row: JiraExcelRow }) {
  return (
    <tr className="hover:bg-muted/30 transition-colors align-top">
      <td className="px-3 py-2.5 font-mono text-xs">
        {row.jiraUrl ? (
          <a
            href={row.jiraUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {dash(row.key)}
            <ExternalLink className="w-3 h-3 flex-shrink-0" />
          </a>
        ) : (
          dash(row.key)
        )}
      </td>
      <td className="px-3 py-2.5 break-words">{dash(row.summary)}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{dash(row.issueType)}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{dash(row.status)}</td>
      <td className="px-3 py-2.5">
        {row.assigneeMatched ? (
          <span className="inline-flex items-center gap-1 text-foreground">
            <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            {dash(row.assigneeName)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-status-warning" title={`원본: ${dash(row.assigneeRaw)}`}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {row.assigneeName || row.assigneeRaw || '—'}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{dash(row.created)}</td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{dash(row.resolved)}</td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{dash(row.dueDate)}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{dash(row.environment)}</td>
      <td className="px-3 py-2.5 text-muted-foreground break-words" title={row.description || undefined}>
        <span className="line-clamp-2">{dash(row.description)}</span>
      </td>
    </tr>
  );
}
