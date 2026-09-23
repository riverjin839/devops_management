import type { ComponentType } from 'react';
import { ArrowLeft, Star, Palmtree } from 'lucide-react';
import { GROUPS, NAV_MAP, type GroupId } from './navConfig';

/**
 * 사이드바(레일)/상단바(이름 옆)에 "설치"할 수 있는 앱 카탈로그 — leaf(최하위 메뉴) 단위 opt-in.
 *
 * 예전엔 GROUPS 단위(예: "클러스터" 하나)로 설치해 레일 아이콘 하나가 flyout 으로 18개 하위
 * 화면을 감췄다. 사용자 요청("앱 추가할때는 가장 하위 메뉴 기준으로 추가")에 따라 설치 단위를
 * GROUPS.paths 의 개별 leaf 페이지로 바꾼다 — 설치한 leaf 하나 = 레일/상단바의 아이콘 하나
 * (직행 링크, flyout 없음).
 *
 * `domain` 이 배치를 결정한다: `platform`/`system` → Sidebar 레일, `work` → AppTopBar(이름 옆).
 * 즐겨찾기·Your Island·뒤로가기는 leaf 페이지가 아닌 개인 기능이라 `personal` 특수 항목으로
 * 별도 취급하고, 도메인만 부여해 같은 opt-in 목록(`installedApps`)에 함께 담는다.
 */
export type SpecialAppId = 'back' | 'favorites' | 'island';
export type InstallableAppId = string; // leaf path 또는 SpecialAppId

export interface InstallableApp {
  id: InstallableAppId;
  label: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  iconColor?: string;
  groupId: GroupId | 'personal';
  groupLabel: string;
  domain: 'platform' | 'system' | 'work';
  adminOnly?: boolean;
}

const SPECIAL_APPS: Record<SpecialAppId, InstallableApp> = {
  back: {
    id: 'back', label: '뒤로가기', description: '이전 화면으로 돌아가는 버튼',
    icon: ArrowLeft, groupId: 'personal', groupLabel: '개인', domain: 'platform',
  },
  favorites: {
    id: 'favorites', label: '즐겨찾기', description: '자주 쓰는 화면을 별표로 모아본다',
    icon: Star, groupId: 'personal', groupLabel: '개인', domain: 'work',
  },
  island: {
    id: 'island', label: '나의 아일랜드', description: '내가 꾸민 커스텀 화면',
    icon: Palmtree, groupId: 'personal', groupLabel: '개인', domain: 'work',
  },
};

// leaf 단위 카탈로그 — 그룹의 paths 를 펼쳐 페이지 하나하나를 설치 항목으로 만든다.
const LEAF_APPS: InstallableApp[] = GROUPS.flatMap((g) =>
  g.paths
    .map((p) => {
      const entry = NAV_MAP[p];
      if (!entry) return null;
      const app: InstallableApp = {
        id: p,
        label: entry.defaultLabel,
        icon: entry.icon,
        iconColor: entry.iconColor,
        groupId: g.id,
        groupLabel: g.label,
        domain: g.domain,
        adminOnly: g.domain === 'system',
      };
      return app;
    })
    .filter((a): a is InstallableApp => a != null),
);

export const INSTALLABLE_APPS: InstallableApp[] = [...LEAF_APPS, ...Object.values(SPECIAL_APPS)];

export function installableAppById(id: string): InstallableApp | undefined {
  return INSTALLABLE_APPS.find((a) => a.id === id);
}

export interface InstallableAppSection {
  label: string;
  apps: InstallableApp[];
  /** GROUPS.description — 섹션 제목 아래 한 줄 설명. */
  description?: string;
  /** GROUPS.tone — `danger` 는 명령을 보내는 화면 묶음(경고 톤으로 구분). */
  tone?: 'danger';
}

function sectionsForDomain(domain: 'platform' | 'system' | 'work', personal: InstallableApp[], isAdmin: boolean): InstallableAppSection[] {
  const groupSections = GROUPS
    .filter((g) => g.domain === domain || (domain === 'platform' && g.domain === 'system'))
    .map((g) => ({
      label: g.label,
      description: g.description,
      tone: g.tone,
      apps: LEAF_APPS.filter((a) => a.groupId === g.id && (!a.adminOnly || isAdmin)),
    }))
    .filter((s) => s.apps.length > 0);
  const personalApps = personal.filter((a) => !a.adminOnly || isAdmin);
  return personalApps.length > 0 ? [...groupSections, { label: '개인', apps: personalApps }] : groupSections;
}

/** Sidebar 레일 카탈로그 — platform + system 도메인 leaf + 뒤로가기. */
export function sidebarAppSections(isAdmin: boolean): InstallableAppSection[] {
  return sectionsForDomain('platform', [SPECIAL_APPS.back], isAdmin);
}

/** AppTopBar(이름 옆) 카탈로그 — work 도메인 leaf + 즐겨찾기/Your Island. */
export function topbarAppSections(): InstallableAppSection[] {
  return sectionsForDomain('work', [SPECIAL_APPS.favorites, SPECIAL_APPS.island], false);
}
