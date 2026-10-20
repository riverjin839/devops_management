import { FileText, CheckCircle, Archive } from 'lucide-react';

/**
 * 작업 가이드 상태 배지 — 트리(WorkGuidePage)와 읽기 화면(GuidePageView)이 같은 정의를 쓴다.
 * 상태 토큰(status-*)은 장애·이상에만 쓰므로(§12.12) 문서 상태는 중립·chart 계열로 구분한다:
 * 활성 = 중립, 초안 = chart-3 배지, 보관 = 점선 테두리(색 외 신호). 아이콘만 보이는 자리에선
 * `label` 을 title·sr-only 로 함께 붙인다(D-166).
 */
export const GUIDE_STATUS_CFG: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  draft:    { label: '초안', icon: <FileText className="w-3 h-3" aria-hidden />,    cls: 'bg-chart-3/15 text-chart-3-text border-chart-3/30' },
  active:   { label: '활성', icon: <CheckCircle className="w-3 h-3" aria-hidden />, cls: 'bg-secondary text-muted-foreground border-border' },
  archived: { label: '보관', icon: <Archive className="w-3 h-3" aria-hidden />,     cls: 'bg-background text-muted-foreground border-dashed border-muted-foreground/60' },
};

export function guideStatusCfg(status: string) {
  return GUIDE_STATUS_CFG[status] ?? GUIDE_STATUS_CFG.draft;
}
