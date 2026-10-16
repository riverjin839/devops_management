import { observabilityApi } from '@/services/api';
import { IncidentAnalysisPanel } from '@/components/common/IncidentAnalysisPanel';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { AlertEvent } from '@/types';

/**
 * 알람 인박스 행 확장에 붙는 AI 분석 패널 — 공용 `IncidentAnalysisPanel` 의 얇은 래퍼.
 */
export function AlertAnalysisPanel({ alert }: { alert: AlertEvent }) {
  // D-105 — 분석 트리거는 서버가 operator + 클러스터 operate 를 요구한다. 숨기지 않고 사유와 함께 막는다.
  const { canOperate, hint } = useCanOperate(alert.clusterId);
  return (
    <IncidentAnalysisPanel
      canOperate={canOperate}
      hint={hint}
      subjectId={alert.id}
      analysisStatus={alert.analysisStatus}
      queryKeyPrefix="alert-analysis"
      fetchAnalysis={async (id) => (await observabilityApi.getAlertAnalysis(id)).data.data}
      triggerAnalysis={async (id) => {
        const res = await observabilityApi.triggerAlertAnalysis(id);
        return res.data;
      }}
      invalidateKeys={[['alert-inbox']]}
      emptyHint="아직 분석되지 않은 알람입니다. 설정 → AI/LLM 의 자동 분석 범위에 매칭되면 자동 분석되며, 위 버튼으로 수동 실행할 수도 있습니다."
    />
  );
}
