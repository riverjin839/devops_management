import { Link } from 'react-router-dom';
import { useGetServiceDef } from '@/hooks/useServiceCatalog';
import { colorBadgeClass } from '@/components/services/serviceCatalog';

interface ServiceChipProps {
  /** ui_settings.serviceCatalog 의 slug */
  service: string;
  /** chip 클릭 시 /services/<slug> 로 이동할지. 기본 true. */
  linked?: boolean;
  className?: string;
  /** 작게 표시 (테이블 행 안쪽). 기본 false (form 등에서 표준 사이즈). */
  small?: boolean;
}

/** task/issue/todo 행에 표시되는 service tag chip.
 *  카탈로그에서 라벨/아이콘/색상을 동적으로 가져와 통일된 룩 유지. */
export function ServiceChip({ service, linked = true, className = '', small = false }: ServiceChipProps) {
  const getServiceDef = useGetServiceDef();
  const def = getServiceDef(service);
  const Icon = def.icon;
  const cls = colorBadgeClass(def.color);
  const sizeCls = small
    ? 'px-1.5 py-0 text-xs gap-0.5'
    : 'px-2 py-0.5 text-xs gap-1';

  const content = (
    <>
      <Icon className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      <span className="truncate max-w-[100px]">{def.label}</span>
    </>
  );

  if (linked) {
    return (
      <Link
        to={`/services/${service}`}
        title={`통합지식 → ${def.label}`}
        onClick={(e) => e.stopPropagation()}
        className={`inline-flex items-center rounded-full border whitespace-nowrap ${sizeCls} ${cls} hover:brightness-110 ${className}`}
      >
        {content}
      </Link>
    );
  }
  return (
    <span className={`inline-flex items-center rounded-full border whitespace-nowrap ${sizeCls} ${cls} ${className}`}>
      {content}
    </span>
  );
}
