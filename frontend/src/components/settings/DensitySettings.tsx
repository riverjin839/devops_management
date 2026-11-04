import { MacCard } from '@/components/ui/MacCard';
import { useDensityStore, DENSITIES, type Density } from '@/stores/densityStore';

const DENSITY_META: Record<Density, { label: string; desc: string; sample: string }> = {
  compact: { label: '촘촘하게', desc: '보조 12px · 본문 14px — 한 화면에 많이 볼 때', sample: 'text-[12px]' },
  default: { label: '기본', desc: '보조 13px · 본문 14.5px — 한글 가독성 기준', sample: 'text-[13px]' },
  comfortable: { label: '크게', desc: '보조 14px · 본문 16px — 장시간 작업·저시력·대형 화면', sample: 'text-[14px]' },
};

/** 화면 밀도(글자 크기·줄간격) 선택 — `text-xs`/`text-sm` 전체에 적용되고 기기 간 동기화된다(`k8s:density`). */
export function DensitySettings() {
  const density = useDensityStore((s) => s.density);
  const setDensity = useDensityStore((s) => s.setDensity);

  return (
    <MacCard title="화면 밀도" bodyPadding="p-4">
      <p className="text-xs text-muted-foreground mb-3">
        표·로그·카드의 글자 크기와 줄간격을 정합니다. 모든 화면에 바로 적용되고, 같은 계정의 다른 기기에도 따라옵니다.
      </p>
      <div role="radiogroup" aria-label="화면 밀도" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {DENSITIES.map((d) => {
          const meta = DENSITY_META[d];
          const active = density === d;
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setDensity(d)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="text-sm font-medium">
                {meta.label}
                {d === 'default' && <span className="ml-1.5 text-xs font-normal text-muted-foreground">기본값</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{meta.desc}</div>
              <div className={`${meta.sample} mt-2 rounded-md bg-secondary px-2 py-1.5 leading-snug`}>
                kube-system / coredns-7d4f9 재시작 3회
              </div>
            </button>
          );
        })}
      </div>
    </MacCard>
  );
}
