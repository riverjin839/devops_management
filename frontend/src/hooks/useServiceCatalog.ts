import { createElement, useMemo, type ComponentType } from 'react';
import {
  SERVICE_CATALOG as STATIC_CATALOG,
  type ServiceDef,
  colorBadgeClass,
} from '@/components/services/serviceCatalog';
import {
  BookOpen, type LucideIcon,
} from 'lucide-react';
import { resolveClusterIcon, CLUSTER_ICON_OPTIONS } from '@/lib/clusterIcons';
import { useLakeServiceTypeRows } from './useLakeServices';

/** 서비스 카탈로그의 아이콘 옵션 — cluster 와 같은 lucide 화이트리스트 사용 (재사용성). */
export const SERVICE_ICON_OPTIONS = Object.keys(CLUSTER_ICON_OPTIONS);

/**
 * 저장된 아이콘 값(lucide 이름 / emoji / data URL)을 ``ComponentType`` 으로 변환.
 * 기존 호출자가 ``<Icon className="w-4 h-4" />`` 처럼 쓰는 패턴 그대로 지원.
 * (이 파일이 .ts 라 JSX 대신 ``createElement`` 사용.)
 */
export function getServiceIcon(name?: string | null): ComponentType<{ className?: string }> {
  const resolved = resolveClusterIcon(name);
  if (!resolved) return BookOpen;
  if (resolved.kind === 'lucide') return resolved.Component;
  if (resolved.kind === 'image') {
    const src = resolved.value;
    const Img: ComponentType<{ className?: string }> = ({ className }) =>
      createElement('img', {
        src,
        alt: '',
        className: `${className ?? ''} object-cover rounded`,
      });
    Img.displayName = 'ServiceIcon(image)';
    return Img;
  }
  // emoji / 텍스트
  const text = resolved.value;
  const TextIcon: ComponentType<{ className?: string }> = ({ className }) =>
    createElement(
      'span',
      {
        className: `${className ?? ''} inline-flex items-center justify-center leading-none`,
        'aria-hidden': true,
      },
      text,
    );
  TextIcon.displayName = 'ServiceIcon(text)';
  return TextIcon;
}

// Re-export for backwards compatibility — 기존 코드가 ``LucideIcon`` 타입을 임포트하던 경우.
export type { LucideIcon };

/** PEP 서비스 타입(LakeServiceType domain='pep') 을 서비스 카탈로그로 사용. 비어있으면
 *  static 폴백. ServiceDef 형태로 통일해 기존 페이지/컴포넌트 호환성 유지.
 *
 *  구 ui_settings.serviceCatalog(Settings → 관리 서비스 → "서비스 카탈로그" 서브탭) 는
 *  PEP 서비스와 항목이 중복돼 폐지됐다 — 아이콘/색상 정의가 이제 여기 한 곳에서만 나온다. */
export function useServiceCatalog(): ServiceDef[] {
  const { data } = useLakeServiceTypeRows({ domain: 'pep', limit: 200 });
  return useMemo(() => {
    const rows = data?.data ?? [];
    if (rows.length === 0) {
      // 기본 카탈로그 (static) — 백엔드 시드 전이거나 조회 실패 시.
      return STATIC_CATALOG;
    }
    const sorted = [...rows].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return sorted.map((s) => ({
      key: s.serviceType,
      label: s.label,
      icon: getServiceIcon(s.icon),
      color: s.color || 'slate',
      description: s.description ?? undefined,
    }));
  }, [data]);
}

/** 카탈로그 항목 + 'other' fallback 조회. */
export function useGetServiceDef() {
  const catalog = useServiceCatalog();
  return useMemo(() => {
    const map = new Map(catalog.map((s) => [s.key, s]));
    return (key: string): ServiceDef => {
      const found = map.get(key);
      if (found) return found;
      const other = map.get('other');
      return other
        ? { ...other, key, label: key }
        : { key, label: key, icon: getServiceIcon('MoreHorizontal'), color: 'slate' };
    };
  }, [catalog]);
}

export { colorBadgeClass };
