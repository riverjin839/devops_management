import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, FileText, Send, Save, RefreshCw, ExternalLink, ArrowUp, ArrowDown, Search, X,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import {
  useWeeklyReportPreview, useWeeklyReportPublish,
  useWeeklyReportSettings, useUpdateWeeklyReportSettings,
} from '@/hooks/useJira';
import type {
  WeeklyReport, WeeklyReportSettings, WeeklyDetailRow, WeeklyOwnerRow,
} from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const th = 'text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap select-none';
const td = 'px-2 py-1.5 align-top';

type TabId = 'summary' | 'detail' | 'owner' | 'publish';

const TABS: { id: TabId; label: string }[] = [
  { id: 'summary', label: '1. 전체 요약' },
  { id: 'detail', label: '2. 구분별 상세' },
  { id: 'owner', label: '3. 담당자별' },
  { id: 'publish', label: 'Confluence 게시' },
];

const STATUSES = ['진행', '완료', '지연'] as const;

function statusClass(status: string) {
  if (status === '완료') return 'text-emerald-500';
  if (status === '지연') return 'text-red-500';
  return 'text-blue-500';
}

/** 컬럼 헤더 클릭 정렬 — 같은 키 재클릭 시 asc ↔ desc 토글. */
function useSort<T extends Record<string, unknown>>(rows: T[], initialKey: keyof T) {
  const [key, setKey] = useState<keyof T>(initialKey);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = String(a[key] ?? '');
      const bv = String(b[key] ?? '');
      // 빈 값은 항상 뒤로 — 종료일처럼 비어 있는 칸이 위로 올라오면 읽기 나쁘다.
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      const cmp = av.localeCompare(bv, 'ko');
      return dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, key, dir]);
  const toggle = (k: keyof T) => {
    if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setKey(k); setDir('asc'); }
  };
  return { sorted, key, dir, toggle };
}

function SortHeader<T extends Record<string, unknown>>(
  { label, col, sort }: { label: string; col: keyof T; sort: ReturnType<typeof useSort<T>> },
) {
  const active = sort.key === col;
  return (
    <th className={th}>
      <button type="button" onClick={() => sort.toggle(col)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
        title={`${label} 정렬`} aria-label={`${label} 정렬`}>
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </th>
  );
}

export function WeeklyReportPage() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const previewMut = useWeeklyReportPreview();
  const publishMut = useWeeklyReportPublish();
  const { data: settings } = useWeeklyReportSettings();
  const updateSettings = useUpdateWeeklyReportSettings();

  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [tab, setTab] = useState<TabId>('summary');
  const [weekOf, setWeekOf] = useState('');

  // 필터바 — 날짜 외 조건들 (클라이언트 필터, 표 3종에 공통 적용)
  const [fComponent, setFComponent] = useState('');
  const [fAssignee, setFAssignee] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fSearch, setFSearch] = useState('');

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

  // 필터 적용 — 구분/담당자/상태/검색어. 담당자 필터는 상세표에 담당자 컬럼이 없으므로
  // 담당자별 표에서 매칭된 task 이름으로 상세표를 교차 필터한다.
  const ownerTaskByAssignee = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const o of report?.owners ?? []) {
      const list = map.get(o.assignee) ?? [];
      list.push(o.task);
      map.set(o.assignee, list);
    }
    return map;
  }, [report]);

  const matchesSearch = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    return (...vals: string[]) =>
      !q || vals.some((v) => (v || '').toLowerCase().includes(q));
  }, [fSearch]);

  const details = useMemo(() => {
    const allowedTasks = fAssignee ? new Set(ownerTaskByAssignee.get(fAssignee) ?? []) : null;
    return (report?.details ?? []).filter((r) =>
      (!fComponent || r.component === fComponent) &&
      (!fStatus || r.status === fStatus) &&
      (!allowedTasks || allowedTasks.has(r.task)) &&
      matchesSearch(r.task, r.subTask, r.note, r.issue, r.jiraKey));
  }, [report, fComponent, fStatus, fAssignee, matchesSearch, ownerTaskByAssignee]);

  const owners = useMemo(() => {
    const allowedTasks = fComponent || fStatus
      ? new Set((report?.details ?? [])
        .filter((r) => (!fComponent || r.component === fComponent) && (!fStatus || r.status === fStatus))
        .map((r) => r.task))
      : null;
    return (report?.owners ?? []).filter((r) =>
      (!fAssignee || r.assignee === fAssignee) &&
      (!allowedTasks || allowedTasks.has(r.task)) &&
      matchesSearch(r.task, r.mainWork, r.issueSummary, r.assignee));
  }, [report, fAssignee, fComponent, fStatus, matchesSearch]);

  // 요약은 필터 결과 기준으로 다시 센다 — 필터를 걸면 표와 숫자가 어긋나면 안 된다.
  const summary = useMemo(() => ({
    total: details.length,
    inProgress: details.filter((r) => r.status === '진행').length,
    done: details.filter((r) => r.status === '완료').length,
    delayed: details.filter((r) => r.status === '지연').length,
  }), [details]);

  const componentOptions = useMemo(
    () => Array.from(new Set((report?.details ?? []).map((r) => r.component))).sort(),
    [report]);
  const assigneeOptions = useMemo(
    () => Array.from(new Set((report?.owners ?? []).map((r) => r.assignee).filter(Boolean))).sort(),
    [report]);

  const detailSort = useSort<WeeklyDetailRow & Record<string, unknown>>(
    details as (WeeklyDetailRow & Record<string, unknown>)[], 'component');
  const ownerSort = useSort<WeeklyOwnerRow & Record<string, unknown>>(
    owners as (WeeklyOwnerRow & Record<string, unknown>)[], 'assignee');

  const publish = async () => {
    try {
      const { data } = await publishMut.mutateAsync({
        weekOf: weekOf || undefined,
        spaceKey: spaceKey.trim() || undefined,
        parentPageId: parentPageId.trim() || undefined,
        title: title.trim() || undefined,
      });
      if (data.status === 'ok') toast.success('Confluence 게시 완료', data.detail);
      else toast.error('게시 실패', data.detail);
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
  const filterActive = !!(fComponent || fAssignee || fStatus || fSearch);
  const resetFilters = () => { setFComponent(''); setFAssignee(''); setFStatus(''); setFSearch(''); };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <FileText className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold">주간보고</h1>
        {report && (
          <span className="text-sm text-muted-foreground">{report.periodStart} ~ {report.periodEnd}</span>
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

      {/* 필터바 — 날짜 외 다양한 조건 */}
      <MacCard title="필터">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-1">구분(component)</span>
            <select className={inputCls} value={fComponent} onChange={(e) => setFComponent(e.target.value)}>
              <option value="">전체</option>
              {componentOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-1">담당자</span>
            <select className={inputCls} value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
              <option value="">전체</option>
              {assigneeOptions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-1">상태</span>
            <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">전체</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-1">검색</span>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input className={`${inputCls} pl-8`} placeholder="task · 이슈 · 비고 · Jira 키"
                value={fSearch} onChange={(e) => setFSearch(e.target.value)} />
            </div>
          </div>
        </div>
        {filterActive && (
          <button onClick={resetFilters}
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <X className="w-3 h-3" /> 필터 초기화 ({details.length}건 표시 중)
          </button>
        )}
      </MacCard>

      {/* 탭 — 세로 스크롤 대신 표를 탭으로 분리 */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
            className={`px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
            }`}>
            {t.label}
            {t.id === 'detail' && <span className="ml-1.5 text-xs opacity-70">{details.length}</span>}
            {t.id === 'owner' && <span className="ml-1.5 text-xs opacity-70">{owners.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
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
                  <td className={td}>{summary.total}</td>
                  <td className={`${td} text-blue-500`}>{summary.inProgress}</td>
                  <td className={`${td} text-emerald-500`}>{summary.done}</td>
                  <td className={`${td} text-red-500`}>{summary.delayed}</td>
                  <td className={td}>{filterActive ? '필터 적용된 집계' : (report?.summary.note ?? '')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </MacCard>
      )}

      {tab === 'detail' && (
        <MacCard title="2. 구분별 상세">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <SortHeader label="구분" col="component" sort={detailSort} />
                  <SortHeader label="task" col="task" sort={detailSort} />
                  <SortHeader label="sub task" col="subTask" sort={detailSort} />
                  <SortHeader label="시작일" col="start" sort={detailSort} />
                  <SortHeader label="종료 예정일" col="due" sort={detailSort} />
                  <SortHeader label="종료일" col="closed" sort={detailSort} />
                  <SortHeader label="상태" col="status" sort={detailSort} />
                  <th className={th}>이슈</th>
                  <th className={th}>비고</th>
                </tr>
              </thead>
              <tbody>
                {detailSort.sorted.map((r, i) => (
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
                {detailSort.sorted.length === 0 && (
                  <tr><td className={`${td} text-muted-foreground`} colSpan={9}>표시할 업무가 없습니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </MacCard>
      )}

      {tab === 'owner' && (
        <MacCard title="3. 담당자별 추진 업무">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <SortHeader label="task" col="task" sort={ownerSort} />
                  <SortHeader label="담당자" col="assignee" sort={ownerSort} />
                  <th className={th}>주요 추진업무</th>
                  <th className={th}>issue 요약</th>
                </tr>
              </thead>
              <tbody>
                {ownerSort.sorted.map((r, i) => (
                  <tr key={`${r.task}-${i}`} className="border-b border-border/40">
                    <td className={td}>{r.task}</td>
                    <td className={td}>{r.assignee}</td>
                    <td className={td}>{r.mainWork}</td>
                    <td className={td}>{r.issueSummary}</td>
                  </tr>
                ))}
                {ownerSort.sorted.length === 0 && (
                  <tr><td className={`${td} text-muted-foreground`} colSpan={4}>표시할 업무가 없습니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </MacCard>
      )}

      {tab === 'publish' && (
        <>
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
              게시 문서는 <b>필터와 무관하게 해당 주 전체</b>를 담습니다.
            </p>
            <div className="mt-3">
              <button onClick={() => void publish()} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                {publishMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Confluence 에 게시
              </button>
            </div>
          </MacCard>

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
        </>
      )}
    </div>
  );
}

export default WeeklyReportPage;
