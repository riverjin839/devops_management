import { createElement, type ComponentType } from 'react';
import {
  siKubernetes, siHelm, siContainerd, siRancher, siK3s, siPodman, siDocker,
  siPrometheus, siGrafana, siOpentelemetry, siJaeger, siFluentd, siFluentbit, siElasticsearch,
  siCilium, siIstio, siLinkerd, siEnvoyproxy, siTraefikproxy, siNginx,
  siArgo, siFlux, siJenkins, siTekton, siSpinnaker, siSkaffold, siGitlab, siGithub,
  siKeycloak, siVault, siHashicorp, siFalco,
  siHarbor, siSonatype,
  siRook, siMinio, siRedis, siPostgresql, siMongodb, siMysql, siVitess,
  siApachekafka, siRabbitmq, siApacherocketmq,
  siAnsible, siTerraform, siVagrant,
  siBackstage, siDapr, siKnative, siCncf,
  siApacheairflow, siApachespark, siJupyter,
} from 'simple-icons';

/** simple-icons 항목(브랜드 로고 SVG path) → currentColor 로 채워지는 아이콘 컴포넌트.
 *  (이 파일은 .ts 라 JSX 대신 createElement 사용 — useServiceCatalog 와 동일 패턴.) */
interface SI { path: string; title: string; }
function brand(si: SI): ComponentType<{ className?: string }> {
  const Icon: ComponentType<{ className?: string }> = ({ className }) =>
    createElement(
      'svg',
      { viewBox: '0 0 24 24', className, fill: 'currentColor', role: 'img', 'aria-label': si.title },
      createElement('path', { d: si.path }),
    );
  Icon.displayName = `Brand(${si.title})`;
  return Icon;
}

/**
 * CNCF 졸업/인큐베이팅 + 인기 오픈소스 브랜드 로고 아이콘.
 * 키(= 저장값/툴팁)는 사람이 읽기 쉬운 이름. lucide 화이트리스트와 키가 겹치지 않는다.
 * Nexus 는 Sonatype 로고를 사용.
 */
export const BRAND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  // 오케스트레이션 / 런타임
  Kubernetes: brand(siKubernetes), Helm: brand(siHelm), Containerd: brand(siContainerd),
  Rancher: brand(siRancher), K3s: brand(siK3s), Podman: brand(siPodman), Docker: brand(siDocker),
  // 관측성
  Prometheus: brand(siPrometheus), Grafana: brand(siGrafana), OpenTelemetry: brand(siOpentelemetry),
  Jaeger: brand(siJaeger), Fluentd: brand(siFluentd), FluentBit: brand(siFluentbit), Elasticsearch: brand(siElasticsearch),
  // 네트워크 / 서비스메시
  Cilium: brand(siCilium), Istio: brand(siIstio), Linkerd: brand(siLinkerd),
  Envoy: brand(siEnvoyproxy), Traefik: brand(siTraefikproxy), NGINX: brand(siNginx),
  // GitOps / CI·CD
  Argo: brand(siArgo), Flux: brand(siFlux), Jenkins: brand(siJenkins), Tekton: brand(siTekton),
  Spinnaker: brand(siSpinnaker), Skaffold: brand(siSkaffold), GitLab: brand(siGitlab), GitHub: brand(siGithub),
  // 보안 / 인증
  Keycloak: brand(siKeycloak), Vault: brand(siVault), HashiCorp: brand(siHashicorp), Falco: brand(siFalco),
  // 레지스트리 / 아티팩트
  Harbor: brand(siHarbor), Nexus: brand(siSonatype),
  // 스토리지 / DB
  Rook: brand(siRook), MinIO: brand(siMinio), Redis: brand(siRedis), PostgreSQL: brand(siPostgresql),
  MongoDB: brand(siMongodb), MySQL: brand(siMysql), Vitess: brand(siVitess),
  // 메시징
  Kafka: brand(siApachekafka), RabbitMQ: brand(siRabbitmq), RocketMQ: brand(siApacherocketmq),
  // IaC / 자동화
  Ansible: brand(siAnsible), Terraform: brand(siTerraform), Vagrant: brand(siVagrant),
  // 플랫폼
  Backstage: brand(siBackstage), Dapr: brand(siDapr), Knative: brand(siKnative), CNCF: brand(siCncf),
  // 데이터 / LAKE (Airflow·Spark·JupyterHub·JupyterLab — 공식 simple-icons 로고 기준.
  // StarRocks 는 simple-icons 에 등록된 브랜드 SVG 가 없어 제외 — 필요하면 아이콘 picker 의
  // emoji/이미지 업로드로 대체 가능. JupyterHub/JupyterLab 은 두 프로젝트 모두 동일한
  // Jupyter 로고를 공식 마크로 사용해 같은 아이콘을 공유한다.)
  Airflow: brand(siApacheairflow), Spark: brand(siApachespark),
  JupyterHub: brand(siJupyter), JupyterLab: brand(siJupyter),
};

export const BRAND_ICON_LIST: { name: string; Component: ComponentType<{ className?: string }> }[] =
  Object.entries(BRAND_ICONS).map(([name, Component]) => ({ name, Component }));
