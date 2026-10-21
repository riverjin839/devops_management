// NS 담당자 한 줄 — 규칙(rule) 또는 NS 라벨(label:<키>) 에서 온 담당 팀/사람과 연락처.
import type { NsOwner } from '@/types';

export function OwnerLine({ owner }: { owner?: NsOwner | null }) {
  if (!owner) return null;
  const from = owner.source === 'rule' ? '담당자 규칙' : `NS 라벨 ${owner.source.replace('label:', '')}`;
  return (
    <span className="block font-sans text-xs text-muted-foreground" title={`담당자 출처: ${from}`}>
      담당 {owner.owner}{owner.contact ? ` · ${owner.contact}` : ''}
    </span>
  );
}
