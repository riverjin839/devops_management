// 토폴로지 편집기 왼쪽 도형 팔레트 — 캔버스로 끌어다 놓으면 그 자리에 바로 만들어진다.
// 마우스 없이도 쓸 수 있게 누르면(Enter) 기본 위치에 추가한다(서버·leaf 는 선택한 랙에).
import type { DragEvent } from 'react';
import { Box, LayoutGrid, Server } from 'lucide-react';
import type { DcDeviceRole } from '@/types';
import { ROLE_FILL } from '../topologyLayout';

export type ShapeKind = 'fa-core' | 'super-spine' | 'spine' | 'leaf' | 'rack' | 'server' | 'zone';
export const SHAPE_MIME = 'application/x-dc-shape';

const SHAPES: { kind: ShapeKind; label: string; help: string }[] = [
  { kind: 'fa-core', label: 'FA 코어', help: 'FA 코어 띠 어디든' },
  { kind: 'super-spine', label: 'super-spine', help: 'super-spine 띠 어디든' },
  { kind: 'spine', label: 'spine', help: 'spine 띠 어디든' },
  { kind: 'leaf', label: 'leaf (ToR)', help: '랙 위에 놓으면 그 랙의 ToR' },
  { kind: 'rack', label: '랙', help: '구간 상자 안에' },
  { kind: 'server', label: '서버', help: '랙 위에 놓으면 빈 U 에' },
  { kind: 'zone', label: '구간', help: '아래 빈 곳 어디든' },
];

interface Props {
  disabled: boolean;
  hint: string | undefined;
  onAdd: (kind: ShapeKind) => void;
  onDragKind: (kind: ShapeKind | null) => void;
}

export function Palette({ disabled, hint, onAdd, onDragKind }: Props) {
  const onDragStart = (e: DragEvent, kind: ShapeKind) => {
    e.dataTransfer.setData(SHAPE_MIME, kind);
    e.dataTransfer.effectAllowed = 'copy';
    onDragKind(kind);
  };
  return (
    <nav aria-label="도형" className="w-full lg:w-40 shrink-0 rounded-md border border-border bg-card p-2 space-y-1">
      <p className="px-1 pb-1 text-xs font-semibold text-muted-foreground">도형 — 끌어다 놓기</p>
      {SHAPES.map((s) => {
        const role = s.kind as DcDeviceRole;
        const isDevice = s.kind !== 'rack' && s.kind !== 'zone';
        return (
          <button
            key={s.kind}
            type="button"
            draggable={!disabled}
            disabled={disabled}
            title={hint ?? `${s.label} — ${s.help} (누르면 기본 위치에 추가)`}
            aria-label={`${s.label} 추가`}
            onDragStart={(e) => onDragStart(e, s.kind)}
            onDragEnd={() => onDragKind(null)}
            onClick={() => onAdd(s.kind)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl border border-transparent text-sm text-left hover:bg-secondary hover:border-border disabled:opacity-40 disabled:cursor-not-allowed cursor-grab active:cursor-grabbing"
          >
            <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden className="shrink-0">
              {isDevice && s.kind !== 'server' && (
                <rect x="1" y="2" width="24" height="14" rx="4" className={ROLE_FILL[role]} strokeWidth={1.25} />
              )}
              {s.kind === 'server' && <Server x={5} y={1} width={16} height={16} className="text-muted-foreground" />}
              {s.kind === 'rack' && <Box x={5} y={1} width={16} height={16} className="text-muted-foreground" />}
              {s.kind === 'zone' && <LayoutGrid x={5} y={1} width={16} height={16} className="text-muted-foreground" />}
            </svg>
            <span className="truncate">{s.label}</span>
          </button>
        );
      })}
      <p className="px-1 pt-2 text-xs text-muted-foreground leading-relaxed">
        이름은 자동으로 붙습니다. 놓은 뒤 오른쪽에서 바로 고치세요.
      </p>
    </nav>
  );
}
