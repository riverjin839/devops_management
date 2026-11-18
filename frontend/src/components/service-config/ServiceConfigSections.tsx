// 설정 탭 본문 — 섹션별 카드(접기) 안에 항목 표. 1단계는 읽기 전용: 설정 값(선택 버전) · 현재 노드 값 · 반영 방식 · 상태.
// 정상(같음)은 중립색, 버전과 다름·노드 간 다름·값 없음만 상태색(DESIGN_SYSTEM §12.12-3).
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge } from '@/components/common';
import type { StatusVariant } from '@/components/common';
import type { ServiceConfigItemStatus, ServiceConfigRestartScope, ServiceConfigRow } from '@/types';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2 align-top';

const RESTART_LABEL: Record<ServiceConfigRestartScope, string> = {
  immediate: '즉시 반영',
  restart_member: 'etcd 멤버 재시작 (1대씩)',
  restart_service: 'containerd 재시작',
  rolling_restart_ds: 'cilium 롤링 재시작',
  reboot: '재부팅',
};

const STATUS: Record<ServiceConfigItemStatus, { variant: StatusVariant; label: string } | null> = {
  same: null,
  differs: { variant: 'warning', label: '버전과 다름' },
  mixed: { variant: 'warning', label: '노드 간 다름' },
  unknown: { variant: 'pending', label: '값 없음' },
};

function CurrentCell({ row, nodeCount }: { row: ServiceConfigRow; nodeCount: number }) {
  const [open, setOpen] = useState(false);
  const c = row.current;
  if (c.groups.length === 0) return <span className="text-muted-foreground">수집된 값 없음</span>;
  if (c.uniform) {
    return (
      <span>
        <span className="font-mono text-xs break-all">{c.value}</span>
        {nodeCount > 1 && <span className="block text-xs text-muted-foreground">노드 {c.nodeCount}개 같음</span>}
      </span>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-foreground hover:underline">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {c.groups.length}가지 값 · 노드 {c.nodeCount}개
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

interface Props {
  sections: { name: string; items: ServiceConfigRow[] }[];
  hasVersion: boolean;
  versionNo: number | null;
  nodeCount: number;
}

export function ServiceConfigSections({ sections, hasVersion, versionNo, nodeCount }: Props) {
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
        const flagged = sec.items.filter((r) => r.status !== 'same').length;
        return (
          <MacCard
            key={sec.name}
            title={sec.name}
            titleExtra={<span className="text-xs text-muted-foreground">{sec.items.length}개{flagged ? ` · 확인 필요 ${flagged}` : ''}</span>}
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
                      <th className={`${TH} w-[32%]`}>키</th>
                      <th className={`${TH} w-[18%]`}>{hasVersion ? `설정 값 (V${versionNo})` : '설정 값'}</th>
                      <th className={`${TH} w-[26%]`}>현재 노드 값</th>
                      <th className={`${TH} w-[14%]`}>반영 방식</th>
                      <th className={`${TH} w-[10%]`}>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.items.map((r) => {
                      const st = STATUS[r.status];
                      return (
                          <tr key={r.id} className="border-b border-border last:border-0">
                            <td className={TD}>
                              <span className="font-mono text-xs break-all">{r.key}</span>
                              {r.label && <span className="block text-xs text-muted-foreground">{r.label}{r.unit ? ` (${r.unit})` : ''}</span>}
                              {r.help && <span className="block text-xs text-muted-foreground mt-0.5">{r.help}</span>}
                            </td>
                            <td className={TD}>
                              {hasVersion ? (
                                <input readOnly value={r.versionValue ?? ''} placeholder="(없음)" aria-label={`${r.key} 설정 값`}
                                  title="편집은 다음 단계에서 열린다"
                                  className="w-full px-2 py-1 rounded-xl border border-border bg-secondary font-mono text-xs text-foreground" />
                              ) : <span className="text-xs text-muted-foreground">버전 없음</span>}
                              {r.defaultValue && <span className="block text-xs text-muted-foreground mt-1">기본값 {r.defaultValue}</span>}
                            </td>
                            <td className={TD}><CurrentCell row={r} nodeCount={nodeCount} /></td>
                            <td className={`${TD} text-xs text-muted-foreground`}>{RESTART_LABEL[r.restartScope] ?? r.restartScope}</td>
                            <td className={TD}>{st ? <StatusBadge variant={st.variant} label={st.label} /> : <span className="text-xs text-muted-foreground">일치</span>}</td>
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
