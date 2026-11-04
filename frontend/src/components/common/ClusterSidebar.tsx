import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Server, CheckCircle, AlertTriangle, XCircle, WifiOff, LayoutGrid, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import type { Cluster, Status } from '@/types';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useK8sHub } from '@/lib/k8sHub';
import { useClusterIconSrc } from '@/hooks/useClusterIconSrc';
import { isGuardedLevel, levelLabel, useOperationLevels } from '@/hooks/useOperationLevels';
import { ResizeHandle } from './ResizeHandle';
import { Skeleton } from './Skeleton';

interface ClusterSidebarProps {
  clusters: Cluster[];
  /** 현재 선택 — null 이면 전체(All), 문자열이면 해당 cluster.id */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 지금 선택된 클러스터를 강조할지 */
  highlightActive?: boolean;
  /** 최상단에 "전체" 선택지 (Dashboard 에 유용) */
  allowAll?: boolean;
  /** "전체" 표시 라벨 */
  allLabel?: string;
  /** 다중 선택 모드 — 활성화 시 selectedIds/onMultiSelectChange 가 우선한다. 기본 false. */
  multiSelect?: boolean;
  /** multiSelect 모드일 때 현재 선택된 클러스터 id 들 */
  selectedIds?: string[];
  /** multiSelect 모드일 때 선택 변경 콜백 */
  onMultiSelectChange?: (ids: string[]) => void;
  /** 표준(§12.5) 표기용 — 레일은 늘 아이콘 전용이다. 예전 넓은 목록 모드는 쓰는 화면이 없어 걷어냈다. */
  iconOnly?: boolean;
  /** 클러스터 목록을 불러오는 중 — 빈 목록 대신 자리표시 타일을 그린다. */
  isLoading?: boolean;
  /** 목록 조회 실패 — "없음" 대신 오류와 다시 시도를 보인다. */
  error?: unknown;
  onRetry?: () => void;
}

// 아이콘 레일 폭(useSidebarStore.clusterIconRailWidth, 드래그로 조절)에서 아이콘 크기를
// 파생시킨다. 버튼은 레일 폭에서 고정 ICON_RAIL_PADDING 만 뺀 크기로 꽉 채우고, 빌더 타일
// 이미지는 버튼의 0.82 로 키워 활성 배경이 얇은 테두리처럼만 보이게 한다(아이콘=0.5·
// 도트≈0.145·이모지≈0.44 비율은 유지).
const ICON_RAIL_PADDING = 6; // 레일 폭에서 버튼을 뺄 여백(좌우 합, 즉 한쪽당 3px)

function iconSizeFor(railWidth: number) {
  const btn = Math.max(24, railWidth - ICON_RAIL_PADDING);
  return {
    rail: railWidth,
    btn,
    image: Math.round(btn * 0.82),
    icon: Math.round(btn * 0.5),
    dot: Math.max(5, Math.round(btn * 0.145)),
    mark: Math.max(10, Math.round(btn * 0.26)),
    bar: Math.round(btn * 0.5),
    emojiFont: Math.round(btn * 0.44),
  };
}

/** 레일 "전체" 항목의 id — 클러스터 id(UUID)와 겹치지 않는다. */
const ALL_RAIL_ID = '__all__';

/** 상태 어휘는 `StatusBadge` 와 같다 — 툴팁·스크린리더가 색 없이도 상태를 전한다. */
const STATUS_LABEL: Record<Status, string> = {
  healthy: '정상', warning: '경고', critical: '위험', pending: '미연결',
};

// 비정상은 색뿐 아니라 모양으로도 구분한다(WCAG 1.4.1) — 정상만 무채색 점.
const STATUS_MARK: Partial<Record<Status, { Icon: React.ComponentType<{ className?: string }>; cls: string }>> = {
  warning:  { Icon: AlertTriangle, cls: 'text-status-warning' },
  critical: { Icon: XCircle,       cls: 'text-status-critical' },
  pending:  { Icon: WifiOff,       cls: 'text-status-unknown' },
};

const isAbnormal = (c: Cluster) => c.status === 'critical' || c.status === 'warning';

const railItem = (box: HTMLElement | null, id: string) =>
  box?.querySelector<HTMLElement>(`[data-rail-item="${window.CSS.escape(id)}"]`) ?? null;

/** 운영등급별로 묶는다 — 등급은 처음 나온 순서, 등급 안은 받은 순서(seq) 그대로, 미지정은 맨 뒤. */
function groupByLevel(clusters: Cluster[]): { level: string; items: Cluster[] }[] {
  const groups = new Map<string, Cluster[]>();
  for (const c of clusters) {
    const level = c.operationLevel?.trim() ?? '';
    groups.set(level, [...(groups.get(level) ?? []), c]);
  }
  const named = [...groups].filter(([level]) => level);
  const unnamed = groups.get('');
  return [...named, ...(unnamed ? [['', unnamed] as [string, Cluster[]]] : [])]
    .map(([level, items]) => ({ level, items }));
}

const STATUS_ICON: Record<Status, React.ComponentType<{ className?: string }>> = {
  healthy: CheckCircle,
  warning: AlertTriangle,
  critical: XCircle,
  pending: WifiOff,
};

const STATUS_DOT: Record<Status, string> = {
  // 정상은 무채색 점 — 비정상만 색으로 튀게 (§12.12-3, D-119)
  healthy:  'bg-muted-foreground/40',
  warning:  'bg-status-warning',
  critical: 'bg-status-critical',
  pending:  'bg-status-unknown',
};

// ── 아이콘 전용 레일 버튼 — 메인 Sidebar 의 RailIconButton 패턴을 차용. ────────
interface IconRailButtonProps {
  label: string;
  /** 레일 안에서의 id — 방향키 이동·선택 항목 스크롤에 쓴다. */
  railId: string;
  /** 우측 상단 상태 표식(정상 = 점, 비정상 = 아이콘). 미지정 시 표시 없음. */
  status?: Status;
  /** 보호 등급 클러스터 — 좌측 하단 방패 표식. */
  guarded?: boolean;
  /** Tab 으로 들어오는 하나의 항목인가(roving tabindex). */
  tabbable: boolean;
  onRailKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => void;
  onRailFocus: (id: string) => void;
  /** 단일 선택의 현재 항목 — `aria-current`. */
  current?: boolean;
  /** 다중 선택의 선택 여부 — `aria-pressed`. 단일 선택이면 undefined. */
  pressed?: boolean;
  /** 표시할 lucide 컴포넌트. 다른 표시 옵션이 없을 때 사용. */
  Icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  /** 표시할 텍스트(주로 emoji 1자). 우선순위: imageSrc > emojiText > Icon. */
  emojiText?: string;
  /** 표시할 이미지 URL / data URL — 사용자가 업로드한 커스텀 아이콘. */
  imageSrc?: string;
  active?: boolean;
  onClick: () => void;
  /** 픽셀 단위 크기 프리셋 (버튼/이미지/아이콘/도트). */
  size: ReturnType<typeof iconSizeFor>;
}

function IconRailButton({
  label, railId, status, guarded, tabbable, onRailKeyDown, onRailFocus, current, pressed,
  Icon, emojiText, imageSrc, active, onClick, size,
}: IconRailButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // viewport 좌표 — 부모 overflow 를 회피하기 위해 portal 로 렌더한다.
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = () => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  const hideTooltip = () => setTooltipPos(null);
  const mark = status ? STATUS_MARK[status] : undefined;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-rail-item={railId}
        tabIndex={tabbable ? 0 : -1}
        aria-label={label}
        aria-current={current ? 'true' : undefined}
        aria-pressed={pressed}
        onClick={onClick}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={() => { showTooltip(); onRailFocus(railId); }}
        onBlur={hideTooltip}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hideTooltip();
          else onRailKeyDown(e, railId);
        }}
        style={{ width: size.btn, height: size.btn }}
        className={`relative flex items-center justify-center rounded-md transition-colors ${
          active
            // 타일 이미지가 버튼의 82% 를 덮어 배경만으로는 띠처럼만 보인다 — 바깥 링으로 확실히 보이게.
            ? 'bg-primary/15 text-primary ring-2 ring-primary'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && (
          <span
            aria-hidden
            style={{ height: size.bar }}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[3px] w-1 bg-primary rounded-r"
          />
        )}
        {imageSrc
          ? <img src={imageSrc} alt="" style={{ width: size.image, height: size.image }} className="rounded-md object-cover" />
          : emojiText
            ? <span style={{ fontSize: size.emojiFont }} className="leading-none select-none" aria-hidden>{emojiText}</span>
            : Icon
              ? <Icon style={{ width: size.icon, height: size.icon }} />
              : <Server style={{ width: size.icon, height: size.icon }} />}
        {mark ? (
          <span
            aria-hidden
            style={{ width: size.mark, height: size.mark }}
            className={`absolute top-0.5 right-0.5 flex items-center justify-center rounded-full bg-card ${mark.cls}`}
          >
            <mark.Icon className="w-full h-full p-px" />
          </span>
        ) : status && (
          <span
            aria-hidden
            style={{ width: size.dot, height: size.dot }}
            className={`absolute top-1 right-1 rounded-full ring-1 ring-card ${STATUS_DOT[status] ?? 'bg-status-unknown'}`}
          />
        )}
        {guarded && (
          // 보호 등급(운영·DR 등 — Settings 운영레벨의 `guarded`)은 상태와 무관하게 늘 표시한다.
          <span
            aria-hidden
            style={{ width: size.mark, height: size.mark }}
            className="absolute bottom-0.5 left-0.5 flex items-center justify-center rounded-full bg-card text-foreground"
          >
            <ShieldAlert className="w-full h-full p-px" />
          </span>
        )}
      </button>
      {tooltipPos && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-foreground text-background rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

/** 아이콘 레일의 클러스터 버튼 — `useClusterIconSrc` 훅(테마 동기화)을 써야 해서
 *  `clusters.map()` 콜백 안에서 직접 훅을 호출할 수 없어 별도 컴포넌트로 분리했다. */
function ClusterRailIconButton({
  cluster, tooltip, ...rest
}: {
  cluster: Cluster;
  tooltip: string;
} & Pick<IconRailButtonProps,
  'railId' | 'guarded' | 'tabbable' | 'onRailKeyDown' | 'onRailFocus' | 'current' | 'pressed' | 'active' | 'onClick' | 'size'
>) {
  // 아이콘 미지정 클러스터도 이름 이니셜 타일로 그려 레일의 모양을 통일한다.
  const resolved = useClusterIconSrc(cluster, { monogramFallback: true });
  const FallbackIcon = STATUS_ICON[cluster.status] ?? Server;
  const lucideIcon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> =
    resolved?.kind === 'lucide' ? resolved.Component : FallbackIcon;
  const emojiText = resolved?.kind === 'text' ? resolved.value : undefined;
  const imageSrc = resolved?.kind === 'image' ? resolved.value : undefined;

  return (
    <IconRailButton
      label={tooltip}
      Icon={lucideIcon}
      emojiText={emojiText}
      imageSrc={imageSrc}
      status={cluster.status}
      {...rest}
    />
  );
}

/** 좌측 클러스터 선택 레일 — 드래그·키보드로 폭 조절 가능.
 *  부모가 flex row 레이아웃을 잡아주면, 이 컴포넌트는 자기 폭을 가짐.
 */
function ClusterSidebarIconRail({
  clusters, selectedId, onSelect, highlightActive, allowAll, allLabel,
  multiSelect, selectedIds, onMultiSelectChange, isLoading, error, onRetry,
}: Omit<ClusterSidebarProps, 'iconOnly'>) {
  // 보호 등급(운영·DR 등)과 등급 이름은 Settings 운영레벨이 원천이다(UI-First) — 레일에 박지 않는다.
  const { data: levels } = useOperationLevels();
  const selectedSet = multiSelect ? new Set(selectedIds ?? []) : null;
  const isAllActive = multiSelect
    ? (selectedSet?.size ?? 0) === 0
    : selectedId === null;

  const railWidth = useSidebarStore((s) => s.clusterIconRailWidth);
  const setRailWidth = useSidebarStore((s) => s.setClusterIconRailWidth);
  const resetRailWidth = useSidebarStore((s) => s.resetClusterIconRailWidth);
  const size = iconSizeFor(railWidth);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 비정상만 보기 — 레일 순서를 상태에 따라 재배치하지 않는다. 30초 폴링마다 항목이 움직이면
  // 누르려던 자리에 다른 클러스터가 올 수 있어서, 순서는 고정하고 운영자가 직접 좁혀 보게 한다.
  // 비정상이 없어지면 자동으로 전체로 돌아가고, 지금 선택한 클러스터는 좁혀도 남긴다.
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const abnormal = clusters.filter(isAbnormal);
  const filtering = abnormalOnly && abnormal.length > 0;
  const isChosen = (c: Cluster) => (multiSelect ? !!selectedSet?.has(c.id) : c.id === selectedId);
  const groups = groupByLevel(filtering ? clusters.filter((c) => isAbnormal(c) || isChosen(c)) : clusters);
  const showLevels = groups.length > 1;

  // 방향키 이동(roving tabindex) — 클러스터가 몇 개든 Tab 정지점은 하나다.
  const [focusId, setFocusId] = useState<string | null>(null);
  const navOrder = [...(allowAll ? [ALL_RAIL_ID] : []), ...groups.flatMap((g) => g.items.map((c) => c.id))];
  const chosenId = multiSelect
    ? groups.flatMap((g) => g.items).find(isChosen)?.id
    : selectedId ?? ALL_RAIL_ID;
  const tabbableId = [focusId, chosenId].find((id) => id && navOrder.includes(id)) ?? navOrder[0];

  const handleRailKey = (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const i = navOrder.indexOf(id);
    const n = navOrder.length;
    const next = e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowUp' ? (i - 1 + n) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1
            : -1;
    if (i < 0 || next < 0) return;
    e.preventDefault();
    setFocusId(navOrder[next]);
    railItem(scrollRef.current, navOrder[next])?.focus();
  };

  // 선택한 클러스터가 레일 스크롤 밖이면 안으로 — scrollIntoView 는 본문까지 움직일 수 있어 레일만 옮긴다.
  useEffect(() => {
    const box = scrollRef.current;
    const el = !multiSelect && selectedId ? railItem(box, selectedId) : null;
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop += r.top - b.top - 8;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
  }, [selectedId, multiSelect, clusters.length]);

  // 사이드바에서는 아이콘 변경을 허용하지 않는다. 변경은 시스템 등록된 클러스터 관리 화면
  // (/cluster-manage) 의 테이블 첫 컬럼에서만 가능하도록 권한을 한정.

  // multiSelect 에서 "전체" 클릭 → 선택 비우기 (=전체로 간주). 단일 모드에서는 onSelect(null).
  const handleAllClick = () => {
    if (multiSelect && onMultiSelectChange) onMultiSelectChange([]);
    else onSelect(null);
  };

  // multiSelect 에서 개별 클릭 → 토글. 단일 모드에서는 onSelect(id).
  const handleClusterClick = (id: string) => {
    if (multiSelect && onMultiSelectChange) {
      const next = new Set(selectedSet ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // 원본 cluster 순서를 유지해서 내려준다.
      onMultiSelectChange(clusters.map((c) => c.id).filter((cid) => next.has(cid)));
    } else {
      onSelect(id);
    }
  };

  const railProps = { size, onRailKeyDown: handleRailKey, onRailFocus: setFocusId };

  return (
    <aside
      aria-label="클러스터 선택"
      style={{ width: size.rail }}
      className="relative flex flex-col flex-shrink-0 self-start bg-card border border-border rounded-md sticky top-4 max-h-[calc(100vh-var(--topbar-h)-2rem)]"
    >
      {abnormal.length > 0 && (
        <button
          type="button"
          onClick={() => setAbnormalOnly(!filtering)}
          aria-pressed={filtering}
          title={filtering ? `전체 ${clusters.length}개 보기` : `비정상 ${abnormal.length}개만 보기`}
          aria-label={filtering ? `전체 ${clusters.length}개 보기` : `비정상 ${abnormal.length}개만 보기`}
          style={{ width: size.btn }}
          className={`flex-shrink-0 self-center mt-2 inline-flex items-center justify-center gap-1 rounded-xl py-1 text-xs font-semibold tabular-nums transition-colors ${
            filtering ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary/60'
          }`}
        >
          <AlertTriangle
            aria-hidden
            className={`w-3.5 h-3.5 ${abnormal.some((c) => c.status === 'critical') ? 'text-status-critical' : 'text-status-warning'}`}
          />
          {abnormal.length}
        </button>
      )}
      {/* 높이 제한은 aside, 스크롤은 이 안쪽 — 폭 조절 핸들이 목록과 함께 스크롤되지 않게 나눈다. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar py-2">
        <nav aria-label="클러스터 목록" className="flex flex-col items-center gap-1">
          {allowAll && (
            <IconRailButton
              {...railProps}
              railId={ALL_RAIL_ID}
              tabbable={tabbableId === ALL_RAIL_ID}
              current={!multiSelect && isAllActive}
              label={multiSelect
                ? `${allLabel ?? '전체'} — 선택 비우기 (${selectedSet?.size ?? 0}/${clusters.length})`
                : `${allLabel ?? '전체'} (${clusters.length})`}
              Icon={LayoutGrid}
              active={isAllActive && (highlightActive ?? true)}
              onClick={handleAllClick}
            />
          )}
          {clusters.length === 0 ? (
            // 불러오는 중·조회 실패·정말 없음을 구분한다 — 셋 다 "없음" 이면 장애를 빈 목록으로 오인한다.
            isLoading ? (
              <div aria-busy="true" aria-label="클러스터 목록을 불러오는 중" className="flex flex-col items-center gap-1">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={size.btn} height={size.btn} />)}
              </div>
            ) : error ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={!onRetry}
                title="클러스터 목록을 불러오지 못했습니다 — 눌러서 다시 시도"
                aria-label="클러스터 목록을 불러오지 못했습니다 — 다시 시도"
                style={{ width: size.btn, height: size.btn }}
                className="flex flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-foreground hover:bg-secondary/60 disabled:cursor-default"
              >
                <AlertTriangle aria-hidden className="w-4 h-4 text-status-critical" />
                {onRetry && <RefreshCw aria-hidden className="w-3 h-3 text-muted-foreground" />}
              </button>
            ) : (
              <Link
                to="/cluster-manage"
                title="등록된 클러스터가 없습니다 — 클러스터 관리에서 등록"
                aria-label="등록된 클러스터가 없습니다 — 클러스터 관리에서 등록"
                style={{ width: size.btn, height: size.btn }}
                className="flex items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary"
              >
                <Plus aria-hidden className="w-4 h-4" />
              </Link>
            )
          ) : (
            groups.map(({ level, items }) => {
              const groupName = level ? levelLabel(levels, level) : '등급 미지정';
              return (
                <div
                  key={level}
                  role="group"
                  aria-label={showLevels ? groupName : undefined}
                  className="w-full flex flex-col items-center gap-1"
                >
                  {showLevels && (
                    <div
                      aria-hidden
                      title={groupName}
                      className="w-full mt-1 pt-1 px-0.5 border-t border-border text-center text-xs leading-tight text-muted-foreground truncate"
                    >
                      {/* "운영 (Production)" 처럼 괄호 설명은 좁은 레일에서 뺀다 — 전체 이름은 title 로 */}
                      {groupName.replace(/\s*\(.*\)\s*$/, '')}
                    </div>
                  )}
                  {items.map((c) => {
                    const guarded = isGuardedLevel(levels, c.operationLevel);
                    const details = [
                      c.region,
                      c.operationLevel ? levelLabel(levels, c.operationLevel) : '',
                      guarded ? '보호 등급' : '',
                      STATUS_LABEL[c.status] ?? STATUS_LABEL.pending,
                    ].filter(Boolean).join(' · ');
                    const isActive = multiSelect
                      ? !!selectedSet?.has(c.id)
                      : (highlightActive ?? true) && c.id === selectedId;
                    const baseTooltip = `${c.name} · ${details}`;
                    const tooltip = multiSelect
                      ? `${baseTooltip}${isActive ? ' (선택됨 — 클릭하면 해제)' : ' (클릭하면 선택)'}`
                      : baseTooltip;

                    return (
                      <ClusterRailIconButton
                        {...railProps}
                        key={c.id}
                        railId={c.id}
                        guarded={guarded}
                        tabbable={tabbableId === c.id}
                        current={!multiSelect && c.id === selectedId}
                        pressed={multiSelect ? isActive : undefined}
                        cluster={c}
                        tooltip={tooltip}
                        active={isActive}
                        onClick={() => handleClusterClick(c.id)}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
        </nav>
      </div>
      <ResizeHandle width={railWidth} onResize={setRailWidth} onReset={resetRailWidth} ariaLabel="클러스터 레일 폭 조절" />
    </aside>
  );
}

export function ClusterSidebar({
  clusters, selectedId, onSelect,
  highlightActive = true, allowAll = false, allLabel = '전체 클러스터',
  multiSelect = false, selectedIds, onMultiSelectChange,
  isLoading = false, error, onRetry,
}: ClusterSidebarProps) {
  const hub = useK8sHub();

  // K8s 클러스터 허브 안에 임베드된 화면 — 레일은 허브가 하나만 그린다(lib/k8sHub.ts).
  if (hub) return null;

  return (
    <ClusterSidebarIconRail
      clusters={clusters}
      selectedId={selectedId}
      onSelect={onSelect}
      highlightActive={highlightActive}
      allowAll={allowAll}
      allLabel={allLabel}
      multiSelect={multiSelect}
      selectedIds={selectedIds}
      onMultiSelectChange={onMultiSelectChange}
      isLoading={isLoading}
      error={error}
      onRetry={onRetry}
    />
  );
}
