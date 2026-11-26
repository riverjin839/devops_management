/* eslint-disable react-refresh/only-export-components */
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Circle, XCircle } from 'lucide-react';
import type { ClusterCheckLevel, ClusterCheckSummary } from '@/types';

/**
 * 클러스터 상태 아이콘 — K8s 허브 「점검」 탭(점검 항목 카탈로그)의 마지막 결과가 원천이다
 * (`GET /ops-checks/summary`, `useClusterCheckSummaries`). 글자 라벨 없이 아이콘 모양·색으로만 구분하고
 * (정상만 무채색 — DESIGN_SYSTEM §12.12), 누르면 그 클러스터의 점검 탭으로 가서 문제 항목만 보여 준다.
 * 어떤 항목이 문제인지는 툴팁·스크린리더 이름에 담는다.
 */
const META: Record<ClusterCheckLevel, { Icon: typeof Circle; cls: string }> = {
  healthy: { Icon: CheckCircle2, cls: 'text-muted-foreground' },
  warning: { Icon: AlertTriangle, cls: 'text-status-warning' },
  critical: { Icon: XCircle, cls: 'text-status-critical' },
  none: { Icon: Circle, cls: 'text-faint' },
};

/** 툴팁·aria-label 문구 — 문제 항목 이름을 앞에서부터 3개까지. */
export function clusterCheckDescription(summary: ClusterCheckSummary | undefined): string {
  if (!summary || summary.status === 'none') return '점검 결과 없음 — 누르면 점검 탭';
  const { counts, problems } = summary;
  if (summary.status === 'healthy') return `점검 정상 (${counts.healthy}개 항목) — 누르면 점검 탭`;
  const names = problems.slice(0, 3).map((p) => p.name).join(', ');
  const more = problems.length > 3 ? ` 외 ${problems.length - 3}건` : '';
  const parts = [counts.critical ? `실패 ${counts.critical}` : '', counts.warning ? `경고 ${counts.warning}` : '']
    .filter(Boolean).join(' · ');
  return `점검 문제 ${problems.length}건(${parts}): ${names}${more} — 누르면 점검 탭에서 확인`;
}

/** 문제 항목이 있으면 점검 탭을 문제만 보기로 연다. */
export function clusterCheckHref(clusterId: string, summary: ClusterCheckSummary | undefined): string {
  const problem = summary && (summary.status === 'warning' || summary.status === 'critical');
  return `/k8s/${clusterId}/checks${problem ? '?filter=problem' : ''}`;
}

export function ClusterCheckIcon({
  clusterId, summary, size = 'sm', onNavigate, className = '', role,
}: {
  clusterId: string;
  summary: ClusterCheckSummary | undefined;
  size?: 'sm' | 'md';
  /** 링크로 이동할 때(flyout 닫기 등). */
  onNavigate?: () => void;
  className?: string;
  /** flyout 메뉴 안에서는 `menuitem` — 키보드 내비게이션 대상이 되게(DESIGN_SYSTEM §12.8). */
  role?: 'menuitem';
}) {
  const level: ClusterCheckLevel = summary?.status ?? 'none';
  const { Icon, cls } = META[level];
  const label = clusterCheckDescription(summary);
  const box = size === 'md' ? 'w-7 h-7' : 'w-6 h-6';
  const icon = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';
  return (
    <Link
      to={clusterCheckHref(clusterId, summary)}
      onClick={(e) => { e.stopPropagation(); onNavigate?.(); }}
      title={label}
      aria-label={label}
      role={role}
      className={`inline-flex items-center justify-center flex-shrink-0 rounded-xl ${box} hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${className}`}
    >
      <Icon className={`${icon} ${cls}`} aria-hidden="true" />
    </Link>
  );
}
