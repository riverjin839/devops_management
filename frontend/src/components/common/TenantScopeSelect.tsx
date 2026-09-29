import { useId } from 'react';
import { Lock } from 'lucide-react';
import { useMyTenants } from '@/hooks/useTenants';

interface TenantScopeSelectProps {
  /** null = 전체 공유 */
  value: string | null;
  onChange: (tenantId: string | null) => void;
  /** 폼마다 다른 라벨 스타일을 그대로 쓰기 위한 클래스(미지정 시 기본값). */
  labelClassName?: string;
  selectClassName?: string;
}

/**
 * 업무·지식 데이터의 "공유 범위" 선택 (멀티테넌시 3단계).
 *
 * - `전체 공유`(null) 가 기본이고, 내가 속한 테넌트(admin 은 전체)로 좁힐 수 있다.
 * - 고를 테넌트가 하나도 없고 현재 값도 공유면 아무것도 그리지 않는다 — 테넌트를 안 쓰는
 *   설치에서는 폼이 이전과 똑같아야 한다.
 * - 서버가 최종 판정한다(`services/tenant_scope.py` — 속하지 않은 테넌트 지정은 403).
 */
export function TenantScopeSelect({
  value, onChange,
  labelClassName = 'block text-sm font-medium mb-1.5',
  selectClassName = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40',
}: TenantScopeSelectProps) {
  const id = useId();
  const { data: tenants = [] } = useMyTenants();
  if (tenants.length === 0 && !value) return null;

  const known = tenants.some((t) => t.id === value);
  return (
    <div>
      <label htmlFor={id} className={labelClassName}>
        <span className="inline-flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5 text-muted-foreground" />
          공유 범위
        </span>
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={selectClassName}
      >
        <option value="">전체 공유</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>{t.name} 테넌트만</option>
        ))}
        {value && !known && <option value={value}>현재 테넌트 (내 소속 아님)</option>}
      </select>
      <p className="text-xs text-muted-foreground mt-1">
        테넌트를 고르면 그 테넌트 멤버와 admin 만 볼 수 있습니다.
      </p>
    </div>
  );
}
