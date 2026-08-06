import { k8sEventsApi } from '@/services/api';
import { IncidentAnalysisPanel } from '@/components/common/IncidentAnalysisPanel';
import type { K8sEvent } from '@/types';

/**
 * K8s 이벤트 상세(펼침 행)에 붙는 AI 분석 패널 — 공용 `IncidentAnalysisPanel` 의 얇은 래퍼.
 * 알람 파이프라인과 별도로, kubewatch 로 수신된 이벤트를 직접 트리거로 분석한다.
 */
export function K8sEventAnalysisPanel({ event }: { event: K8sEvent }) {
  return (
    <IncidentAnalysisPanel
      subjectId={event.id}
      analysisStatus={event.analysisStatus}
      queryKeyPrefix="k8s-event-analysis"
      fetchAnalysis={async (id) => (await k8sEventsApi.getAnalysis(id)).data.data}
      triggerAnalysis={async (id) => {
        const res = await k8sEventsApi.triggerAnalysis(id);
        return res.data;
      }}
      invalidateKeys={[['k8s-events']]}
      emptyHint="아직 분석되지 않은 이벤트입니다. Settings → AI/LLM 의 자동 분석 범위에 매칭되면 자동 분석되며, 위 버튼으로 수동 실행할 수도 있습니다."
    />
  );
}
