import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileSpreadsheet, Upload, Loader2, ExternalLink, CheckCircle2, AlertTriangle, X, ClipboardPaste,
  Save, ArrowRight,
} from 'lucide-react';
import { jiraApi } from '@/services/api';
import type { JiraExcelImportResult, JiraExcelRow, JiraImportResult } from '@/types';
import { formatApiError } from '@/lib/utils';
import { ViewModeBar } from '@/components/common';

type ImportMode = 'file' | 'paste';

/**
 * Jira 에서 추출한 이슈 목록 Excel(.xlsx, .xls) 을 업로드하거나, 엑셀/Jira 표를 그대로
 * 복사해 붙여넣어 테이블로 미리보고, "저장"을 누르면 업무 관리 게시판(work_items)에
 * 매핑되어 저장된다. 담당자(Assignee, "이름 회사")에서 이름을 추출해 등록된 PEP 담당자와
 * 매칭한 결과를 함께 표시한다.
 */
export function JiraExcelImportPage() {
  const [mode, setMode] = useState<ImportMode>('file');
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JiraExcelImportResult | null>(null);

  // ── 업무 관리 게시판에 저장 ──
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<JiraImportResult | null>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setError(null);
    setResult(null);
    setSaveError(null);
    setSaveResult(null);
    setLoading(true);
    try {
      const res = await jiraApi.importExcel(file);
      if (res.data.status === 'error') {
        setError(res.data.detail || '가져오기에 실패했습니다.');
      } else {
        setResult(res.data);
      }
    } catch (e) {
      setError(formatApiError(e, 'Excel 파일을 가져오는 중 오류가 발생했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  const handlePaste = async () => {
    if (!pasteText.trim() || loading) return;
    setError(null);
    setResult(null);
    setSaveError(null);
    setSaveResult(null);
    setLoading(true);
    try {
      const res = await jiraApi.importPaste(pasteText);
      if (res.data.status === 'error') {
        setError(res.data.detail || '가져오기에 실패했습니다.');
      } else {
        setResult(res.data);
      }
    } catch (e) {
      setError(formatApiError(e, '붙여넣은 내용을 가져오는 중 오류가 발생했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!result || result.rows.length === 0 || saving) return;
    setSaveError(null);
    setSaving(true);
    try {
      const res = await jiraApi.importSaveToBoard(result.rows);
      if (res.data.status === 'error') {
        setSaveError(res.data.detail || '저장에 실패했습니다.');
      } else {
        setSaveResult(res.data);
      }
    } catch (e) {
      setSaveError(formatApiError(e, '업무 관리 게시판에 저장하는 중 오류가 발생했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setFileName(null);
    setPasteText('');
    setError(null);
    setResult(null);
    setSaveError(null);
    setSaveResult(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-bold leading-tight">Jira Excel 가져오기</h1>
              <p className="text-sm text-muted-foreground">
                Jira 에서 내려받은 이슈 목록(.xlsx, .xls)을 업로드하거나 표를 복사해 붙여넣어 미리보고, "저장"을 누르면 업무 관리 게시판에 매핑되어 저장됩니다.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <ViewModeBar
              modes={[
                { id: 'file', label: '파일 업로드', icon: <Upload className="w-3.5 h-3.5" /> },
                { id: 'paste', label: '붙여넣기', icon: <ClipboardPaste className="w-3.5 h-3.5" /> },
              ]}
              active={mode}
              onChange={(id) => { setMode(id as ImportMode); reset(); }}
            />
            {/* 업로드/붙여넣기가 정상 확인되면 상단에 저장 버튼 노출 — PEP 업무 관리
                게시판(work_items)에 매핑되어 저장된다. */}
            {result && result.status === 'ok' && result.rows.length > 0 && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                title="업무 관리 게시판에 저장"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                업무 관리에 저장
              </button>
            )}
          </div>
        </div>

        {/* 저장 결과 배너 */}
        {saveResult && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-3 flex-wrap">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>
              업무 관리 게시판에 저장했습니다 — 생성 {saveResult.imported}건 · 갱신 {saveResult.updated}건
              {saveResult.skipped > 0 && ` · 스킵 ${saveResult.skipped}건`}
            </span>
            {saveResult.errors.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                (오류 {saveResult.errors.length}건: {saveResult.errors.slice(0, 3).join(', ')}{saveResult.errors.length > 3 ? ' …' : ''})
              </span>
            )}
            <Link
              to="/tasks-mgmt"
              className="ml-auto inline-flex items-center gap-1 font-semibold text-primary hover:underline flex-shrink-0"
            >
              업무 관리 게시판에서 보기 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
        {saveError && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-destructive/30 bg-destructive/10 text-sm text-destructive flex items-start gap-1.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {saveError}
          </div>
        )}

        {/* 파일 업로드 / 붙여넣기 */}
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
          {mode === 'file' ? (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                파일 선택 (.xlsx, .xls)
                <input
                  type="file"
                  accept=".xlsx,.xlsm,.xls"
                  className="hidden"
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
                Jira 이슈 목록 또는 엑셀 표를 마우스로 드래그해 <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-[11px]">Ctrl+C</kbd>로
                복사한 뒤, 아래 칸을 클릭하고 <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-[11px]">Ctrl+V</kbd>로 붙여넣으세요
                (헤더 행 포함). <kbd className="px-1 py-0.5 rounded bg-secondary border border-border text-[11px]">Ctrl+Enter</kbd>로 바로 가져올 수 있습니다.
              </p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handlePaste(); }
                }}
                placeholder="여기를 클릭하고 Ctrl+V 로 붙여넣기…"
                disabled={loading}
                rows={8}
                className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-y disabled:opacity-60"
              />
              <div className="flex items-center gap-2 flex-wrap mt-2">
                <button
                  onClick={handlePaste}
                  disabled={loading || !pasteText.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
            <div className="mt-3 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        {/* 결과 테이블 */}
        {result && result.rows.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '260px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '100px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '110px' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr className="bg-secondary/40 border-b border-border text-xs text-muted-foreground uppercase">
                    <th className="text-left px-3 py-2 font-medium">Key</th>
                    <th className="text-left px-3 py-2 font-medium">Summary</th>
                    <th className="text-left px-3 py-2 font-medium">Issue Type</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Assignee</th>
                    <th className="text-left px-3 py-2 font-medium">Created</th>
                    <th className="text-left px-3 py-2 font-medium">Resolved</th>
                    <th className="text-left px-3 py-2 font-medium">Due Date</th>
                    <th className="text-left px-3 py-2 font-medium">Environment</th>
                    <th className="text-left px-3 py-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((row) => (
                    <JiraExcelTableRow key={row.key} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {result && result.rows.length === 0 && (
          <div className="text-center py-16 bg-card border border-border rounded-xl text-muted-foreground text-sm">
            가져올 항목이 없습니다.
          </div>
        )}

        {!result && !error && !loading && (
          <div className="text-center py-16 bg-card border border-border rounded-xl">
            <FileSpreadsheet className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              {mode === 'file'
                ? 'Jira 에서 내보낸(Export) .xlsx 파일을 업로드하세요.'
                : 'Jira 이슈 목록이나 엑셀 표를 복사해 위 칸에 붙여넣으세요.'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

/** 결과 요약 배지(총 건수/매칭/미매칭) — 파일 업로드·붙여넣기 두 모드가 공유. */
function ImportSummaryBadges({ result }: { result: JiraExcelImportResult | null }) {
  if (!result) return null;
  return (
    <>
      <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 text-sm">
        총 {result.total}건
      </span>
      <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 text-sm">
        담당자 매칭 {result.matched}건
      </span>
      {result.total - result.matched > 0 && (
        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/30 text-sm">
          미매칭 {result.total - result.matched}건
        </span>
      )}
    </>
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
            {row.key}
            <ExternalLink className="w-3 h-3 flex-shrink-0" />
          </a>
        ) : (
          row.key
        )}
      </td>
      <td className="px-3 py-2.5 break-words">{row.summary}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.issueType}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.status}</td>
      <td className="px-3 py-2.5">
        {row.assigneeMatched ? (
          <span className="inline-flex items-center gap-1 text-foreground">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
            {row.assigneeName}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-500" title={`원본: ${row.assigneeRaw}`}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {row.assigneeName || row.assigneeRaw || '—'}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{row.created}</td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{row.resolved}</td>
      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{row.dueDate}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{row.environment}</td>
      <td className="px-3 py-2.5 text-muted-foreground break-words" title={row.description}>
        <span className="line-clamp-2">{row.description}</span>
      </td>
    </tr>
  );
}
