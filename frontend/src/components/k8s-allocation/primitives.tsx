// K8S 자원 관리 화면 공용 표/셀 프리미티브 — 정렬 헤더, 페이저, 미터바, 사용률 배지, Stat 카드.
import type { ReactNode } from 'react';
import {
  ArrowUp, ArrowDown, ChevronsUpDown, FileSpreadsheet, Search, Cpu, MemoryStick, HelpCircle,
  AlertTriangle, RefreshCw,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { EFF_BADGE, efficiency, pctText, ratio, utilRatio } from './format';
import type { EffKind } from './format';
import type { SortState } from './tableSort';

// ── 컬럼 정렬 헤더 ─────────────────────────────────────────────────────────────
/** 정렬 가능한 테이블 헤더 셀. 활성 시 ▲/▼, 비활성은 흐린 양방향 아이콘. */
export function SortableTh({ label, k, sort, onSort, align = 'left', title }: {
  label: string; k: string; sort: SortState; onSort: (k: string) => void;
  align?: 'left' | 'right'; title?: string;
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`} title={title}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-primary' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <Icon className={`w-3 h-3 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  );
}

export function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      title="현재 표를 CSV(엑셀)로 추출"
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50">
      <FileSpreadsheet className="w-3.5 h-3.5" /> CSV 내보내기
    </button>
  );
}

// ── 페이징 공용 ───────────────────────────────────────────────────────────────
/** 페이지당 표시 개수 선택. */
export function PageSizeSelect({ value, onChange, options }: {
  value: number; onChange: (n: number) => void; options: number[];
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      페이지당
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="text-sm px-1.5 py-0.5 rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        title="페이지당 표시 개수"
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      개
    </label>
  );
}

/** 이전/다음 페이지 이동. totalPages ≤ 1 이면 렌더 안 함. */
export function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}
        className="px-3 py-1 text-sm bg-secondary border border-border rounded-lg hover:bg-muted disabled:opacity-50">이전</button>
      <span className="px-2 text-sm tabular-nums">{page} / {totalPages}</span>
      <button type="button" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
        className="px-3 py-1 text-sm bg-secondary border border-border rounded-lg hover:bg-muted disabled:opacity-50">다음</button>
    </div>
  );
}

// ── 검색 입력 (노드/네임스페이스 찾기) ────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder, width = 'w-44' }: {
  value: string; onChange: (v: string) => void; placeholder: string; width?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${width} rounded-lg border border-border bg-card pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary`}
      />
    </div>
  );
}

export function EffBadge({ kind }: { kind: EffKind }) {
  if (!kind) return null;
  const b = EFF_BADGE[kind];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${b.cls}`}>{b.label}</span>;
}

// ── 사용률(util) 배지: k9s 의 %R / %L 에 해당 ─────────────────────────────────
// R = 실사용 ÷ request (req 대비 사용률), L = 실사용 ÷ limit (limit 기준 사용율).
// usage 없거나(메트릭 미가용) req·lim 모두 0이면 표시하지 않는다.
export function UtilPct({ usage, req, lim, className = '' }: {
  usage: number | null; req: number; lim: number; className?: string;
}) {
  if (usage == null) return null;
  const rRatio = utilRatio(usage, req);
  const lRatio = utilRatio(usage, lim);
  if (rRatio == null && lRatio == null) return null;
  // req 대비: 30% 미만 낭비(amber) · 105% 초과 request 초과(red) · 그 외 적정(green)
  const rCls = rRatio == null ? 'text-muted-foreground' : rRatio > 1.05 ? 'text-status-critical' : rRatio < 0.3 ? 'text-status-warning' : 'text-status-healthy';
  // limit 대비: 90% 이상 스로틀/OOM 위험(red) · 그 외 muted
  const lCls = lRatio == null ? 'text-muted-foreground' : lRatio >= 0.9 ? 'text-status-critical' : 'text-muted-foreground';
  return (
    <div className={`text-[11px] tabular-nums flex items-center gap-1 ${className}`}
      title="R = 사용/요청(req 대비 사용률) · L = 사용/제한(limit 기준 사용율)">
      <span className="text-muted-foreground">사용률</span>
      <span>R <b className={rCls}>{rRatio == null ? '—' : `${Math.round(rRatio * 100)}%`}</b></span>
      <span className="text-muted-foreground/50">·</span>
      <span>L <b className={lCls}>{lRatio == null ? '—' : `${Math.round(lRatio * 100)}%`}</b></span>
    </div>
  );
}

// ── 미터 바: alloc(=track) 대비 request(파랑) + usage(초록) 2줄 ─────────────────
export function MeterBar({
  alloc, req, lim, usage, reqDisplay, usageDisplay,
}: {
  alloc: number; req: number; lim: number; usage: number | null;
  reqDisplay: string; usageDisplay: string | null;
}) {
  const allocRatio = ratio(req, alloc);
  const reqPct = allocRatio == null ? 0 : Math.min(100, allocRatio * 100);
  const usageRatio = usage == null ? null : ratio(usage, alloc);
  const usagePct = usageRatio == null ? 0 : Math.min(100, usageRatio * 100);
  const reqColor = allocRatio != null && allocRatio > 1 ? 'bg-status-critical' : 'bg-status-info';
  return (
    <div className="min-w-[150px]">
      <div className="flex items-center gap-1.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">req</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          <div className={`h-full ${reqColor}`} style={{ width: `${reqPct}%` }} />
        </div>
        <span className="w-20 text-xs tabular-nums text-right shrink-0">{reqDisplay} · {pctText(req, alloc)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">use</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          {usage != null && <div className="h-full bg-status-healthy" style={{ width: `${usagePct}%` }} />}
        </div>
        <span className="w-20 text-xs tabular-nums text-right shrink-0 text-muted-foreground">
          {usage == null ? '—' : `${usageDisplay} · ${pctText(usage, alloc)}`}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 pl-[34px]">
        <UtilPct usage={usage} req={req} lim={lim} />
        <EffBadge kind={efficiency(req, usage)} />
      </div>
    </div>
  );
}

// ── req / use 인라인 셀 (항목명 req/use 패턴에 맞춤) ──────────────────────────────
export function ReqUseCell({ req, usage, icon }: { req: string; usage: string | null; icon: 'cpu' | 'mem' }) {
  const Icon = icon === 'cpu' ? Cpu : MemoryStick;
  return (
    <div className="flex items-center gap-1 text-sm tabular-nums whitespace-nowrap">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span>{req}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-muted-foreground">{usage == null ? '—' : usage}</span>
    </div>
  );
}

export function StatTooltip({ children }: { children: ReactNode }) {
  // 프로젝트 표준 Tooltip 프리미티브(Base UI) 사용 — hover/키보드 포커스/터치 모두
  // 지원하고 트리거에 title 이 붙어 마우스 사용자에게도 네이티브 툴팁 텍스트가 뜬다.
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        title="설명 보기"
        aria-label="설명 보기"
        className="inline-flex items-center ml-0.5 text-muted-foreground/60 hover:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <HelpCircle className="w-3 h-3" />
      </TooltipTrigger>
      <TooltipContent data-export-ignore side="bottom" className="max-w-64 whitespace-normal text-left leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

// warn: true = 주의(주황, 낭비 등 경미), 'critical' = 위험(빨강, 오버커밋/스로틀 등 심각).
// 색상 단독으로 위험도를 전달하지 않도록 AlertTriangle 아이콘을 함께 표시한다.
export function Stat({ label, value, sub, icon, warn, help, valueClassName }: {
  label: string; value: string; sub?: string; icon?: ReactNode; warn?: boolean | 'critical'; help?: ReactNode;
  valueClassName?: string;
}) {
  const warnCls = warn === 'critical' ? 'text-status-critical' : warn ? 'text-status-warning' : (valueClassName ?? '');
  return (
    <div className="rounded-lg border border-border bg-card/50 px-2.5 py-2">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {icon}{label}
        {help && <StatTooltip>{help}</StatTooltip>}
      </div>
      <div className={`text-xl font-semibold leading-tight mt-0.5 flex items-center gap-1 ${warnCls}`}>
        {warn && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />}
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

/** 카드 헤더 + 우측 개별 새로고침 버튼 (MacCard 는 title 만 지원하므로 body 내부에 직접 구성). */
export function CardHeader({ title, onRefresh, refreshing }: { title: string; onRefresh: () => void; refreshing: boolean }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">{title}</span>
      <button type="button" onClick={onRefresh} title="새로고침" aria-label={`${title} 새로고침`}
        className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
}
