import type { AlarmRequestInput } from '@/types';
import { DURATION_RE } from './styles';

export interface AlarmRequestDraft extends AlarmRequestInput {
  /** 수정 중인 요청 id(없으면 새 요청). */
  editId?: number | null;
}

export const emptyDraft = (service = 'k8s'): AlarmRequestDraft => ({
  service, metricName: '', meaning: '', catalogItemId: null, thresholds: [], clusterIds: [], note: '',
});

export function validateDraft(d: AlarmRequestDraft): string[] {
  const miss: string[] = [];
  if (!d.metricName.trim()) miss.push('알람 항목');
  if (!d.meaning.trim()) miss.push('알람 의미');
  if (!d.thresholds.some((t) => t.newExpr.trim())) miss.push('수정 임계치 expr');
  if (d.thresholds.some((t) => !DURATION_RE.test(t.newFor.trim()) || !DURATION_RE.test(t.baseFor.trim()))) miss.push('for 형식(예: 5m, 1h)');
  if (!d.clusterIds.length) miss.push('적용 클러스터');
  return miss;
}
