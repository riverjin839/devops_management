import { useState } from 'react';
import {
  FileSpreadsheet, Upload, Loader2, ExternalLink, CheckCircle2, AlertTriangle, X,
} from 'lucide-react';
import { jiraApi } from '@/services/api';
import type { JiraExcelImportResult, JiraExcelRow } from '@/types';
import { formatApiError } from '@/lib/utils';

/**
 * Jira 에서 추출한 이슈 목록 Excel(.xlsx, .xls) 을 업로드해 테이블로 보여준다.
 * 저장하지 않는 미리보기 전용 기능 — 담당자(Assignee, "이름 회사")에서 이름을 추출해
 * 등록된 PEP 담당자와 매칭한 결과를 함께 표시한다.
 */
export function JiraExcelImportPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JiraExcelImportResult | null>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setError(null);
    setResult(null);
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

  const reset = () => {
    setFileName(null);
    setError(null);
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-center gap-3 mb-6">
          <FileSpreadsheet className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold leading-tight">Jira Excel 가져오기</h1>
            <p className="text-sm text-muted-foreground">
              Jira 에서 내려받은 이슈 목록(.xlsx, .xls)을 업로드하면 테이블로 보여줍니다. 저장되지 않는 미리보기입니다.
            </p>
          </div>
        </div>

        {/* 파일 업로드 */}
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
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
            {result && (
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
            )}
            {(fileName || result || error) && !loading && (
              <button
                onClick={reset}
                className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" /> 초기화
              </button>
            )}
          </div>

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
              Jira 에서 내보낸(Export) .xlsx 파일을 업로드하세요.
            </p>
          </div>
        )}
      </main>
    </div>
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
