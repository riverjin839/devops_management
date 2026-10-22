// K8S 자원 관리 화면 공용 표/셀 프리미티브 — 정렬 헤더, 페이저, 미터바, 사용률 배지, Stat 카드.
import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { StatTile } from '@/components/common/StatTile';
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
        <Icon className={`w-3 h-3 ${active ? '' : 'opacity-40'}`} aria-hidden="true" />
      </button>
    </th>
  );
}

export function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      title="현재 표를 CSV(엑셀)로 추출"
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50">
      <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" /> CSV 내보내기
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
        className="text-sm px-1.5 py-0.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
        className="px-3 py-1 text-sm bg-secondary border border-border rounded-xl hover:bg-muted disabled:opacity-50">이전</button>
      <span className="px-2 text-sm tabular-nums">{page} / {totalPages}</span>
      <button type="button" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
        className="px-3 py-1 text-sm bg-secondary border border-border rounded-xl hover:bg-muted disabled:opacity-50">다음</button>
    </div>
  );
}

// ── 검색 입력 (노드/네임스페이스 찾기) ────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder, width = 'w-44' }: {
  value: string; onChange: (v: string) => void; placeholder: string; width?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${width} rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary`}
      />
    </div>
  );
}

export function EffBadge({ kind }: { kind: EffKind }) {
  if (!kind) return null;
  const b = EFF_BADGE[kind];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${b.cls}`}>{b.label}</span>;
}

/** `worstEfficiency()` 결과 배지 — CPU·MEM 판정이 다르면 어느 자원 기준인지 옆에 적는다. */
export function WorstEffBadge({ kind, res }: { kind: EffKind; res: 'CPU' | 'MEM' | null }) {
  if (!kind) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <EffBadge kind={kind} />
      {res && <span className="text-xs text-muted-foreground">{res}</span>}
    </span>
  );
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
  // req 대비: 105% 초과 request 초과(red) · 30% 미만 낭비는 위험이 아니므로 상태색 대신 굵은 글자로만 · 그 외 무채색.
  // 주황은 "곧 문제가 된다"에만 남겨 둔다 — 매일 보이는 여유·낭비에 쓰면 진짜 경고가 묻힌다.
  const rCls = rRatio == null ? 'text-muted-foreground' : rRatio > 1.05 ? 'text-status-critical' : rRatio < 0.3 ? 'text-foreground' : 'text-muted-foreground';
  // limit 대비: 90% 이상 스로틀/OOM 위험(red) · 그 외 muted
  const lCls = lRatio == null ? 'text-muted-foreground' : lRatio >= 0.9 ? 'text-status-critical' : 'text-muted-foreground';
  return (
    <div className={`text-xs tabular-nums flex items-center gap-1 ${className}`}
      title="R = 사용/요청(req 대비 사용률) · L = 사용/제한(limit 기준 사용율)">
      <span className="text-muted-foreground">사용률</span>
      <span>R <b className={rCls}>{rRatio == null ? '—' : `${Math.round(rRatio * 100)}%`}</b></span>
      <span className="text-muted-foreground">·</span>
      <span>L <b className={lCls}>{lRatio == null ? '—' : `${Math.round(lRatio * 100)}%`}</b></span>
    </div>
  );
}

// ── 미터 바: alloc(=track) 대비 요청(--chart-1) + 사용(--chart-2) 2줄 ───────────────
// 시리즈 구분이라 카테고리 색(--chart-*)을 쓴다 — 상태색(초록=정상)을 쓰면 "사용량이 많을수록 정상"으로 읽힌다.
// 요청이 할당 가능량을 넘는(과할당) 경우에만 상태색(critical)으로 바꾼다.
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
  const reqColor = allocRatio != null && allocRatio > 1 ? 'bg-status-critical' : 'bg-chart-1';
  return (
    <div className="min-w-[150px]">
      <div className="flex items-center gap-1.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">요청</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          <div className={`h-full ${reqColor}`} style={{ width: `${reqPct}%` }} />
        </div>
        <span className="w-20 text-xs tabular-nums text-right shrink-0">{reqDisplay} · {pctText(req, alloc)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">사용</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          {usage != null && <div className="h-full bg-chart-2" style={{ width: `${usagePct}%` }} />}
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
        className="inline-flex items-center ml-0.5 text-muted-foreground hover:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <HelpCircle className="w-3 h-3" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent data-export-ignore side="bottom" className="max-w-64 whitespace-normal text-left leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

// 공용 StatTile 위임(D-118) — warn: true = 주의, 'critical' = 위험. 색 단독으로 위험도를 전달하지 않도록
// 경고·위험이면 값 앞에 AlertTriangle 을 함께 그린다. icon 은 회색 타일 규칙상 표시하지 않는다(호환용으로만 받음).
export function Stat({ label, value, sub, warn, help, valueClassName }: {
  label: string; value: string; sub?: string; icon?: ReactNode; warn?: boolean | 'critical'; help?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <StatTile
      label={label}
      tone={warn === 'critical' ? 'critical' : warn ? 'warning' : undefined}
      value={
        <span className={`inline-flex items-center gap-1 ${warn ? '' : (valueClassName ?? '')}`}>
          {warn && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />}
          {value}
        </span>
      }
      hint={help ? <StatTooltip>{help}</StatTooltip> : undefined}
    >
      {sub && <div className="text-xs text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
    </StatTile>
  );
}

/**
 * 화면 공용 분절 선택기 — 이 화면의 탭·토글 모양을 하나로 맞춘다.
 * - `mode="tabs"`: 아래 내용을 통째로 바꾸는 탭(`role="tablist"`/`tab` + `aria-selected`, ←/→ 로 이동).
 * - `mode="toggle"`(기본): 같은 내용의 기준값만 바꾸는 토글(`role="group"` + `aria-pressed`).
 */
export function SegTabs<T extends string>({ value, onChange, options, label, mode = 'toggle', size = 'sm', className = '' }: {
  value: T; onChange: (v: T) => void; options: readonly (readonly [T, ReactNode])[];
  label: string; mode?: 'tabs' | 'toggle'; size?: 'sm' | 'md'; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const isTabs = mode === 'tabs';
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!isTabs || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')) return;
    e.preventDefault();
    const n = options.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    onChange(options[next][0]);
    refs.current[next]?.focus();
  };
  const pad = size === 'md' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <div role={isTabs ? 'tablist' : 'group'} aria-label={label}
      className={`inline-flex rounded-xl border border-border bg-muted/20 p-0.5 ${className}`}>
      {options.map(([k, l], i) => {
        const on = value === k;
        return (
          <button key={k} type="button" ref={(el) => { refs.current[i] = el; }}
            role={isTabs ? 'tab' : undefined}
            aria-selected={isTabs ? on : undefined}
            aria-pressed={isTabs ? undefined : on}
            tabIndex={isTabs && !on ? -1 : undefined}
            onClick={() => onChange(k)} onKeyDown={(e) => onKey(e, i)}
            className={`inline-flex items-center gap-1 rounded-lg ${pad} ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** 카드 헤더 우측 개별 새로고침 버튼 — MacCard `actions` 슬롯에 넣는다(D-122). */
export function RefreshIconButton({ label, onRefresh, refreshing }: { label: string; onRefresh: () => void; refreshing: boolean }) {
  return (
    <button type="button" onClick={onRefresh} title="새로고침" aria-label={`${label} 새로고침`}
      className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground">
      <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
    </button>
  );
}
