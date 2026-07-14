import { ServiceDomainCatalog } from '@/components/service-domain/ServiceDomainCatalog';

export function AppServicesPage() {
  return (
    <ServiceDomainCatalog
      domain="app"
      title="APP 서비스"
      description="애플리케이션 서비스 카탈로그 — Settings에서 카테고리를 추가해 시작하세요"
    />
  );
}
