import type { ComponentType } from 'react';
import { ArrowLeft } from 'lucide-react';
import { GROUPS, type GroupId } from './navConfig';

/**
 * 사이드바 레일에 "설치"할 수 있는 앱 카탈로그 — 사용자 요청("사이드바 아이콘으로 너무 많은
 * 기능이 있어서 다 빼고 SaaS 형태로 필요한 것만 추가")에 따른 opt-in 개편.
 *
 * 플랫폼 도메인 그룹(GROUPS.domain === 'platform' | 'system') + 뒤로가기 버튼만 설치 대상 —
 * 업무 도메인(협업/문서 관리)은 기존처럼 AppTopBar 에 항상 노출되는 구조를 그대로 둔다
 * (사용자가 명시: "업무·문서·지식 관리는 이름 옆에 배치되는 기본 구조는 가져간다").
 * 홈(로고) 은 유일하게 항상 남겨둔 예외 — 사용자가 전부 제거해도 "/" 로 돌아올 방법이
 * 하나는 있어야 하므로, 별도 카탈로그 항목으로 만들지 않고 로고 자체가 항상 홈으로 간다.
 */
export type InstallableAppId = GroupId | 'back';

export interface InstallableApp {
  id: InstallableAppId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const GROUP_APP_DESCRIPTION: Partial<Record<GroupId, string>> = {
  cluster: '클러스터 모니터링·점검·관리 전체',
  server: '노드 서버스펙·커널 파라미터·인프라 토폴로지',
  network: 'Cilium 추적·서비스 토폴로지·CIDR 계산기',
  storage: 'mc 클라이언트·NFS 모니터링',
  services: 'LAKE 서비스',
  devops: '플레이북·주요 명령어·스크립트 라이브러리',
  system: '설정 (관리자 전용)',
};

const SIDEBAR_GROUP_IDS: GroupId[] = ['cluster', 'server', 'network', 'storage', 'services', 'devops', 'system'];

export const SIDEBAR_APP_CATALOG: InstallableApp[] = [
  ...SIDEBAR_GROUP_IDS.map((id) => {
    const g = GROUPS.find((x) => x.id === id)!;
    return {
      id,
      label: g.label,
      description: GROUP_APP_DESCRIPTION[id] ?? '',
      icon: g.icon,
      adminOnly: id === 'system',
    };
  }),
  { id: 'back', label: '뒤로가기', description: '이전 화면으로 돌아가는 버튼', icon: ArrowLeft },
];

export function sidebarAppById(id: string): InstallableApp | undefined {
  return SIDEBAR_APP_CATALOG.find((a) => a.id === id);
}
