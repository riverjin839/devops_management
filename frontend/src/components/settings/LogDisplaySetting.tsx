// 실행 로그 표시 위치 — 전역 기본 설정(브라우저 단위). 기본: 우측 상단 새 창.
import { MacCard } from '@/components/ui/MacCard';
import { useLogWindowStore, type LogDisplayMode } from '@/stores/logWindowStore';
import { cn } from '@/lib/utils';

const OPTIONS: { key: LogDisplayMode; label: string }[] = [
  { key: 'window', label: '새 창(우측 상단)' },
  { key: 'inline', label: '화면 안' },
];

export function LogDisplaySetting() {
  const mode = useLogWindowStore((s) => s.mode);
  const setMode = useLogWindowStore((s) => s.setMode);
  return (
    <MacCard title="실행 로그 표시" description="모든 화면의 실행 로그(로그 보기)를 어디에 띄울지 정합니다" bodyPadding="p-0">
      <div className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm">로그 표시 위치</p>
          <p className="text-xs text-muted-foreground">
            새 창은 브라우저 우측 상단에 별도 창으로 뜨고 실시간으로 따라갑니다. 팝업이 차단되면 화면 안에 표시합니다.
            이 브라우저에만 저장되며, 각 로그 패널 헤더의 창 전환 버튼으로도 바꿀 수 있습니다.
          </p>
        </div>
        <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm" role="group" aria-label="로그 표시 위치">
          {OPTIONS.map(({ key, label }, idx) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={cn(
                'px-2.5 py-1.5 transition-colors',
                idx > 0 && 'border-l border-border',
                mode === key ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </MacCard>
  );
}
