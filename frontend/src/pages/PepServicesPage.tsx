import { ServiceDomainCatalog } from '@/components/service-domain/ServiceDomainCatalog';

export function PepServicesPage() {
  return (
    <ServiceDomainCatalog
      domain="pep"
      title="PEP 서비스"
      description="DevOps 엔지니어가 운영하는 플랫폼 인프라 서비스 — K8s / Cilium / Linux / Keycloak / Nexus / CI-CD / Prometheus / Grafana / AIStor / Network"
    />
  );
}
