import { ServiceDomainCatalog } from '@/components/service-domain/ServiceDomainCatalog';

export function PepServicesPage() {
  return (
    <ServiceDomainCatalog
      domain="pep"
      title="PEP 서비스"
      description="플랫폼 엔지니어링 서비스 카탈로그 — Runtime / Catalog / Workflow / JupyterLab"
    />
  );
}
