import { ServiceDomainCatalog } from '@/components/service-domain/ServiceDomainCatalog';

export function AppServicesPage() {
  return (
    <ServiceDomainCatalog
      domain="app"
      title="APP 서비스"
      description="K8s 내부에 배포되는 사용자 서비스 카탈로그 — Runtime / Catalog / Workbench / AI Ready"
    />
  );
}
