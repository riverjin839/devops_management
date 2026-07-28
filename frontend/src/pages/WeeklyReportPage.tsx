import { useEffect, useState } from 'react';
import { Loader2, FileText, Send, Save, RefreshCw, ExternalLink } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import {
  useWeeklyReportPreview, useWeeklyReportPublish,
  useWeeklyReportSettings, useUpdateWeeklyReportSettings,
} from '@/hooks/useJira';
import type { WeeklyReport, WeeklyReportSettings } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const th = 'text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap';
const td = 'px-2 py-1.5 align-top';

function statusClass(status: string) {
  if (status === '완료') return 'text-emerald-500';
  if (status === '지연') return 'text-red-500';
  return 'text-blue-500';
}

export function WeeklyReportPage() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const previewMut = useWeeklyReportPreview();
  const publishMut = useWeeklyReportPublish();
  const { data: settings } = useWeeklyReportSettings();
  const updateSettings = useUpdateWeeklyReportSettings();

  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [weekOf, setWeekOf] = useState('');
  // 게시 위치 — 매번 바꿀 수 있게 폼으로 노출 (기본값은 설정에서).
  const [spaceKey, setSpaceKey] = useState('');
  const [parentPageId, setParentPageId] = useState('');
  const [title, setTitle] = useState('');
  const [form, setForm] = useState<WeeklyReportSettings | null>(null);

  useEffect(() => {
    if (settings) {
      setForm(settings);
      setSpaceKey((prev) => prev || settings.spaceKey);
      setParentPageId((prev) => prev || settings.parentPageId);
    }
  }, [settings]);

  const loadPreview = async () => {
    try {
      const { data } = await previewMut.mutateAsync({ weekOf: weekOf || undefined });
      setReport(data);
      setTitle((prev) => prev || data.title);
    } catch (err) {
      toast.error('주간보고 생성 실패', formatApiError(err));
    }
  };

  useEffect(() => {
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publish = async () => {
    try {
      const { data } = await publishMut.mutateAsync({
        weekOf: weekOf || undefined,
        spaceKey: spaceKey.trim() || undefined,
        parentPageId: parentPageId.trim() || undefined,
        title: title.trim() || undefined,
      });
      if (data.status === 'ok') {
        toast.success('Confluence 게시 완료', data.detail);
      } else {
        toast.error('게시 실패', data.detail);
      }
    } catch (err) {
      toast.error('게시 실패', formatApiError(err));
    }
  };

  const saveSettings = async () => {
    if (!form) return;
    try {
      await updateSettings.mutateAsync(form);
      toast.success('주간보고 설정 저장됨');
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  const busy = previewMut.isPending || publishMut.isPending;
  const s = report?.summary;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <FileText className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold">주간보고</h1>
        {report && (
          <span className="text-sm text-muted-foreground">
            {report.periodStart} ~ {report.periodEnd}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <input type="date" className={`${inputCls} w-auto`} value={weekOf}
            onChange={(e) => setWeekOf(e.target.value)} title="해당 주(월~금) 선택" />
          <button onClick={() => void loadPreview()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
            {previewMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            다시 생성
          </button>
        </div>
      </div>

      {/* 1. 전체 요약 */}
      <MacCard title="1. 전체 요약">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>전체 task 수</th><th className={th}>진행중</th>
                <th className={th}>완료</th><th className={th}>지연</th><th className={th}>비고</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={td}>{s?.total ?? 0}</td>
                <td className={`${td} text-blue-500`}>{s?.inProgress ?? 0}</td>
                <td className={`${td} text-emerald-500`}>{s?.done ?? 0}</td>
                <td className={`${td} text-red-500`}>{s?.delayed ?? 0}</td>
                <td className={td}>{s?.note ?? ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </MacCard>

      {/* 2. 구분별 상세 */}
      <MacCard title="2. 구분별 상세">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>구분</th><th className={th}>task</th><th className={th}>sub task</th>
                <th className={th}>시작일</th><th className={th}>종료 예정일</th><th className={th}>종료일</th>
                <th className={th}>상태</th><th className={th}>이슈</th><th className={th}>비고</th>
              </tr>
            </thead>
            <tbody>
              {(report?.details ?? []).map((r, i) => (
                <tr key={`${r.jiraKey}-${i}`} className="border-b border-border/40">
                  <td className={td}>{r.component}</td>
                  <td className={td}>
                    {r.jiraUrl ? (
                      <a href={r.jiraUrl} target="_blank" rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1">
                        {r.task} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : r.task}
                  </td>
                  <td className={td}>{r.subTask}</td>
                  <td className={td}>{r.start}</td>
                  <td className={td}>{r.due}</td>
                  <td className={td}>{r.closed}</td>
                  <td className={`${td} ${statusClass(r.status)}`}>{r.status}</td>
                  <td className={td}>{r.issue}</td>
                  <td className={td}>{r.note}</td>
                </tr>
              ))}
              {(report?.details.length ?? 0) === 0 && (
                <tr><td className={`${td} text-muted-foreground`} colSpan={9}>해당 주에 집계된 업무가 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </MacCard>

      {/* 3. 담당자별 */}
      <MacCard title="3. 담당자별 추진 업무">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>task</th><th className={th}>담당자</th>
                <th className={th}>주요 추진업무</th><th className={th}>issue 요약</th>
              </tr>
            </thead>
            <tbody>
              {(report?.owners ?? []).map((r, i) => (
                <tr key={`${r.task}-${i}`} className="border-b border-border/40">
                  <td className={td}>{r.task}</td>
                  <td className={td}>{r.assignee}</td>
                  <td className={td}>{r.mainWork}</td>
                  <td className={td}>{r.issueSummary}</td>
                </tr>
              ))}
              {(report?.owners.length ?? 0) === 0 && (
                <tr><td className={`${td} text-muted-foreground`} colSpan={4}>해당 주에 집계된 업무가 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </MacCard>

      {/* Confluence 게시 — 위치를 매번 바꿀 수 있다 */}
      <MacCard title="Confluence 게시">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">스페이스 키</span>
            <input className={inputCls} placeholder="TEAM" value={spaceKey}
              onChange={(e) => setSpaceKey(e.target.value)} />
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">상위 페이지 ID (선택)</span>
            <input className={inputCls} placeholder="123456" value={parentPageId}
              onChange={(e) => setParentPageId(e.target.value)} />
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">문서 제목</span>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          같은 제목의 페이지가 있으면 <b>새 버전으로 갱신</b>되고, 없으면 생성됩니다.
        </p>
        <div className="mt-3">
          <button onClick={() => void publish()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
            {publishMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Confluence 에 게시
          </button>
        </div>
      </MacCard>

      {/* 자동 생성 설정 (관리자) */}
      {isAdmin && form && (
        <MacCard title="자동 생성 설정 (관리자)">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <span className="block text-sm font-medium text-muted-foreground mb-1">기본 스페이스 키</span>
              <input className={inputCls} value={form.spaceKey}
                onChange={(e) => setForm({ ...form, spaceKey: e.target.value })} />
            </div>
            <div>
              <span className="block text-sm font-medium text-muted-foreground mb-1">기본 상위 페이지 ID</span>
              <input className={inputCls} value={form.parentPageId}
                onChange={(e) => setForm({ ...form, parentPageId: e.target.value })} />
            </div>
            <div>
              <span className="block text-sm font-medium text-muted-foreground mb-1">제목 형식</span>
              <input className={inputCls} value={form.titleTemplate}
                onChange={(e) => setForm({ ...form, titleTemplate: e.target.value })} />
            </div>
            <div>
              <span className="block text-sm font-medium text-muted-foreground mb-1">자동 생성 cron</span>
              <input className={inputCls} placeholder="0 17 * * 5" value={form.autoCron}
                onChange={(e) => setForm({ ...form, autoCron: e.target.value })} />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="rounded border-border" checked={form.autoEnabled}
                  onChange={(e) => setForm({ ...form, autoEnabled: e.target.checked })} />
                자동 생성·게시 사용
              </label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            제목 형식에 <code className="px-1 rounded bg-secondary">{'{start}'}</code> /
            <code className="px-1 rounded bg-secondary">{'{end}'}</code> 를 쓰면 주차 날짜로 치환됩니다.
            자동 게시는 Confluence 세션이 저장된 사용자의 권한으로 수행됩니다.
          </p>
          <div className="mt-3">
            <button onClick={() => void saveSettings()} disabled={updateSettings.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
              {updateSettings.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              설정 저장
            </button>
          </div>
        </MacCard>
      )}
    </div>
  );
}

export default WeeklyReportPage;
