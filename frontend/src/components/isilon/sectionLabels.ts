import type { IsilonCommandSection } from '@/types';

export const ISILON_SECTION_LABEL: Record<IsilonCommandSection, string> = {
  exports: 'Export / 마운트',
  nfs_settings: 'NFS 서비스 설정',
  quotas: '쿼터 / 용량',
  clients: '클라이언트 / 성능',
  node_health: '클러스터 / 노드 상태',
  custom: '커스텀 명령',
};
