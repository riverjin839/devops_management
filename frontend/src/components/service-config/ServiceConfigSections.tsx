// 설정 탭 본문 — 섹션별 카드(접기) 안에 항목 표. 키 · VALUE(편집 입력 + 다를 때만 노드 현재 값) · 반영 방식 · 상태.
// 설명 문장(항목 도움말·기본값·재정의)은 ⓘ 툴팁으로 — 본문엔 값·상태·결과만.
// 바뀐 행은 강조 + "이전 → 새" + 되돌리기, 의존 규칙 결과는 해당 행 아래에 붙인다(제안 적용 버튼 포함).
// 정상(같음)은 중립색, 버전과 다름·노드 간 다름·값 없음·조건 위반만 상태색(DESIGN_SYSTEM §12.12-3).
import { useState } from 'react';
import { ChevronDown, ChevronRight, Info, Lightbulb, RotateCcw, ShieldAlert } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { InfoHint, StatusBadge } from '@/components/common';
import { KeySignal } from './KeySignal';
import { NumericBars } from './NumericBars';
import { parseNum } from './numericFormat';
import type { StatusVariant } from '@/components/common';
import type {
  ServiceConfigItemStatus, ServiceConfigKeySignal, ServiceConfigRestartScope, ServiceConfigRow, ServiceConfigRuleResult,
} from '@/types';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2 align-top';
const INPUT = 'w-full px-2 py-1 rounded-xl border bg-card font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-secondary disabled:cursor-not-allowed';

const RESTART_LABEL: Record<ServiceConfigRestartScope, string> = {
  immediate: '즉시 반영',
  restart_member: 'etcd 멤버 재시작 (1대씩)',
  restart_service: 'containerd 재시작',
  rolling_restart_ds: 'cilium 롤링 재시작',
  reboot: '재부팅',
  restart_static_pod: '정적 파드 재시작 (1대씩)',
  nic_queue_reset: '하위 인터페이스 큐 재설정 (1개씩)',
  restart_kubelet: 'kubelet 재시작',
};

const STATUS: Record<ServiceConfigItemStatus, { variant: StatusVariant; label: string } | null> = {
  same: null,
  differs: { variant: 'warning', label: '버전과 다름' },
  mixed: { variant: 'warning', label: '노드 간 다름' },
  unknown: { variant: 'pending', label: '값 없음' },
};

/** 기대 값과 노드 현재 값 비교(백엔드 `current.same_value` 와 같은 규칙). NIC 현재 값 `N/M`(현재/최대)은 `N`·`max`(N==M)와 같고,
 *  인터페이스별 값 `a=x b=y` 는 모두 같아야 같다. */
function sameValue(expected: string, current: string): boolean {
  const e = expected.trim();
  const c = current.trim();
  if (e === c) return true;
  if (!e || !c) return false;
  const toks = c.split(/\s+/);
  if (toks.length > 1 && toks.every((t) => /^[^=\s]+=\S+$/.test(t))) return toks.every((t) => sameValue(e, t.slice(t.indexOf('=') + 1)));
  const m = /^(\d+)\/(\d+)$/.exec(c);
  return !!m && (e === m[1] || (e === 'max' && m[1] === m[2]));
}

/** VALUE 칸 아래 줄 — 노드 현재 값. 입력(비교) 값과 같으면 아무것도 그리지 않고(같은 노드 수는 ⓘ), 다르면 노드 값을, 노드마다 다르면 값별 노드 목록(펼침). */
function NodeValueLine({ row, compare }: { row: ServiceConfigRow; compare: string }) {
  const [open, setOpen] = useState(false);
  const c = row.current;
  if (c.groups.length === 0) return <span className="block text-xs text-muted-foreground mt-1">노드 값 없음</span>;
  if (c.uniform) {
    if (sameValue(compare, c.value ?? '')) return null;
    return (
      <span className="block text-xs mt-1 break-all">
        <span className="text-muted-foreground">노드 </span>
        <span className="font-mono text-status-warning">{c.value}</span>
        {c.nodeCount > 1 && <span className="text-muted-foreground"> · {c.nodeCount}개</span>}
      </span>
    );
  }
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-status-warning hover:underline">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        노드 {c.groups.length}가지 값 · {c.nodeCount}개
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {c.groups.map((g) => (
            <li key={g.value} className="text-xs">
              <span className="font-mono break-all">{g.value}</span>
              <span className="text-muted-foreground"> — {g.nodes.length}개: {g.nodes.slice(0, 8).join(', ')}{g.nodes.length > 8 ? ` 외 ${g.nodes.length - 8}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** VALUE 입력 옆 ⓘ — 노드 값 요약·기본값·재정의 등 보조 정보(설명은 본문 대신 툴팁). */
function valueInfo(row: ServiceConfigRow, groupMode: boolean): string {
  const parts: string[] = [];
  const c = row.current;
  if (c.groups.length === 0) parts.push('노드에서 수집된 값이 없다');
  else if (c.uniform) parts.push(`노드 ${c.nodeCount}개 현재 값 ${c.value}`);
  else parts.push(`노드 ${c.nodeCount}개가 ${c.groups.length}가지 값`);
  if (groupMode) parts.push(row.overrideValue ? `기본 ${row.baseValue ?? '없음'} 을(를) 이 그룹에서 재정의` : `기본 그룹 값 ${row.baseValue ?? '없음'} 을(를) 상속`);
  if (row.defaultValue) parts.push(`커널·제품 기본값 ${row.defaultValue}`);
  return parts.join('\n');
}

function ValueInput({ row, value, placeholder, disabled, changed, onChange }: {
  row: ServiceConfigRow; value: string; placeholder: string; disabled: boolean; changed: boolean;
  onChange: (v: string) => void;
}) {
  const border = changed ? 'border-primary' : 'border-border';
  const label = `${row.key} 설정 값`;
  const opts = row.valueType === 'bool' ? ['true', 'false'] : row.valueType === 'enum' ? (row.options ?? []) : null;
  if (opts) {
    const list = value && !opts.includes(value) ? [value, ...opts] : opts;
    return (
      <select value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)} className={`${INPUT} ${border}`}>
        <option value="">{placeholder || '(없음)'}</option>
        {list.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const numeric = row.valueType === 'int' || row.valueType === 'size';
  if (row.valueType === 'int_or_max') {
    // 숫자 또는 max(인터페이스별 최대값) — 노드마다 NIC 최대값이 달라도 한 값으로 맞출 수 있다
    const listId = `max-${row.key}`;
    return (
      <>
        <input value={value} disabled={disabled} aria-label={label} placeholder={placeholder || '숫자 또는 max'} list={listId}
          title="숫자 또는 max(인터페이스 최대값)" onChange={(e) => onChange(e.target.value.trim())} className={`${INPUT} ${border}`} />
        <datalist id={listId}><option value="max">max — 인터페이스 최대값</option></datalist>
      </>
    );
  }
  return (
    <input value={value} disabled={disabled} aria-label={label} placeholder={placeholder || '(없음)'}
      inputMode={numeric ? 'numeric' : undefined} onChange={(e) => onChange(e.target.value)} className={`${INPUT} ${border}`} />
  );
}

function RuleHints({ hints, onApply, editable }: {
  hints: ServiceConfigRuleResult[]; onApply: (key: string, value: string) => void; editable: boolean;
}) {
  if (hints.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {hints.map((h) => {
        const Icon = h.kind === 'require' ? ShieldAlert : h.kind === 'recommend' ? Lightbulb : Info;
        const tone = h.kind === 'require' ? (h.blocking ? 'text-status-critical' : 'text-status-warning')
          : h.kind === 'recommend' ? 'text-status-warning' : 'text-muted-foreground';
        const label = h.kind === 'require' ? (h.blocking ? '필수' : '필수(기존 위반)') : h.kind === 'recommend' ? '권장' : '영향';
        return (
          <li key={h.ruleId} className={`flex items-start gap-1.5 text-xs ${tone}`}>
            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="font-semibold">{label}</span>
              {h.suggested != null && <> · 제안 <span className="font-mono">{h.suggested}</span></>}
              {h.targetService && h.targetService !== h.sourceService && <> · {h.sourceService.toUpperCase()} 의 조건</>}
              {' — '}{h.reason}
              {h.fixableHere && editable && h.targetKey && h.suggested != null && (
                <button type="button" onClick={() => onApply(h.targetKey as string, h.suggested as string)}
                  className="ml-1.5 px-1.5 py-0.5 rounded-xl border border-border bg-card text-foreground hover:bg-secondary">
                  제안 적용
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  sections: { name: string; items: ServiceConfigRow[] }[];
  /** 그룹 화면이면 값 입력 = 재정의, 비우면 기본 값 상속. */
  groupMode: boolean;
  versionLabel: string;
  /** 편집 가능(최신 버전·operator). false 면 입력이 잠긴다. */
  editable: boolean;
  lockReason?: string;
  /** 키 → 편집 전 값 / 현재 초안 값(그룹이면 재정의, 없으면 ''). */
  initial: Record<string, string>;
  draft: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** 키별 의존 규칙 결과(대상 키 기준, 영향은 원인 키 기준). */
  hints: Record<string, ServiceConfigRuleResult[]>;
  /** 키별 열린 알람·최근 변경(LINUX — 노드 파라미터 에이전트). */
  signals?: Record<string, ServiceConfigKeySignal>;
  signalHref?: (key: string) => string;
}

export function ServiceConfigSections({
  sections, groupMode, versionLabel, editable, lockReason, initial, draft, onChange, hints, signals, signalHref,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (name: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  return (
    <div className="space-y-3">
      {sections.map((sec) => {
        const isOpen = !collapsed.has(sec.name);
        const flagged = sec.items.filter((r) => r.status === 'differs' || r.status === 'mixed' || (hints[r.key]?.length ?? 0) > 0).length;
        const edited = sec.items.filter((r) => (draft[r.key] ?? '') !== (initial[r.key] ?? '')).length;
        return (
          <MacCard
            key={sec.name}
            title={sec.name}
            titleExtra={(
              <span className="text-xs text-muted-foreground">
                {sec.items.length}개{flagged ? ` · 확인 필요 ${flagged}` : ''}{edited ? ` · 편집 ${edited}` : ''}
              </span>
            )}
            actions={(
              <button type="button" onClick={() => toggle(sec.name)} aria-expanded={isOpen}
                aria-label={`${sec.name} ${isOpen ? '접기' : '펼치기'}`} title={isOpen ? '접기' : '펼치기'}
                className="inline-flex items-center justify-center w-7 h-7 rounded-xl border border-border bg-card hover:bg-secondary">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            )}
            bodyPadding="p-0"
          >
            {isOpen && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[860px] table-fixed">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={`${TH} w-[34%]`}>키</th>
                      <th className={`${TH} w-[42%]`}>{groupMode ? `VALUE · 재정의 (${versionLabel})` : `VALUE (${versionLabel})`}</th>
                      <th className={`${TH} w-[13%]`}>반영 방식</th>
                      <th className={`${TH} w-[11%]`}>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.items.map((r) => {
                      const st = STATUS[r.status];
                      const before = initial[r.key] ?? '';
                      const now = draft[r.key] ?? '';
                      const changed = now !== before;
                      const rowHints = hints[r.key] ?? [];
                      const placeholder = groupMode ? (r.baseValue ? `상속: ${r.baseValue}` : '상속(값 없음)') : '';
                      const effective = groupMode ? (now || (r.baseValue ?? '')) : now;
                      // 수치형이고 설정 값이나 노드 값이 숫자로 읽히면 막대(설정·노드·기본)로 — 노드 값 줄은 막대가 대신한다.
                      const numeric = (r.valueType === 'int' || r.valueType === 'size')
                        && [effective, ...r.current.groups.map((g) => g.value)].some((v) => parseNum(v) != null);
                      return (
                        <tr key={r.id} className={`border-b border-border last:border-0 ${changed ? 'bg-primary/5' : ''}`}>
                          <td className={TD}>
                            <span className="inline-flex items-center gap-0.5 max-w-full">
                              <span className="font-mono text-xs break-all">{r.key}</span>
                              {r.help && <InfoHint text={r.help} label={`${r.key} 도움말`} side="right" />}
                            </span>
                            {r.label && <span className="block text-xs text-muted-foreground">{r.label}{r.unit ? ` (${r.unit})` : ''}</span>}
                            <RuleHints hints={rowHints} editable={editable} onApply={onChange} />
                          </td>
                          <td className={TD}>
                            <div className="flex items-center gap-1">
                              <div className="flex-1 min-w-0" title={editable ? undefined : lockReason}>
                                <ValueInput row={r} value={now} placeholder={placeholder} disabled={!editable}
                                  changed={changed} onChange={(v) => onChange(r.key, v)} />
                              </div>
                              <InfoHint text={valueInfo(r, groupMode)} label={`${r.key} 값 정보`} />
                              {changed && (
                                <button type="button" onClick={() => onChange(r.key, before)} title="되돌리기" aria-label={`${r.key} 되돌리기`}
                                  className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-xl border border-border bg-card hover:bg-secondary">
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                            {changed ? (
                              <span className="block text-xs text-primary mt-1 break-all">
                                {before || (groupMode ? '상속' : '없음')} → {now || (groupMode ? '상속' : '없음')}
                              </span>
                            ) : null}
                            {numeric ? (
                              <NumericBars row={r} value={effective} editable={editable} onChange={(v) => onChange(r.key, v)} />
                            ) : (
                              <NodeValueLine row={r} compare={effective} />
                            )}
                          </td>
                          <td className={`${TD} text-xs text-muted-foreground`}>{RESTART_LABEL[r.restartScope] ?? r.restartScope}</td>
                          <td className={TD}>
                            {st ? <StatusBadge variant={st.variant} label={st.label} /> : <span className="text-xs text-muted-foreground">일치</span>}
                            <KeySignal paramKey={r.key} signal={signals?.[r.key]} href={signalHref?.(r.key)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </MacCard>
        );
      })}
    </div>
  );
}
