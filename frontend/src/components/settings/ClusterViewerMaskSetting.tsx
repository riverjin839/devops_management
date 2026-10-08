import { EyeOff } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { useClusterViewerMask, useUpdateClusterViewerMask } from '@/hooks/useUiSettings';
import { formatApiError } from '@/lib/utils';

/** Settings → 접근 제어 — viewer 에게 클러스터 망 구성 정보(IP·CIDR·MAC·호스트명·API 엔드포인트)를
 *  숨길지. 클러스터 단위 격리(테넌트 바인딩)는 "어느 클러스터를 보나"만 정하므로, 볼 수 있는
 *  클러스터의 필드 단위 노출은 이 정책이 맡는다. 변경은 서버에서 감사 로그로 남는다. */
export function ClusterViewerMaskSetting() {
  const { data, isLoading } = useClusterViewerMask();
  const update = useUpdateClusterViewerMask();
  const toast = useToast();
  const enabled = data?.enabled ?? false;

  const toggle = () =>
    update.mutate({ enabled: !enabled }, {
      onSuccess: (res) =>
        toast.success(res.data.data.enabled ? 'viewer 네트워크 정보 숨김 켜짐' : 'viewer 네트워크 정보 숨김 꺼짐'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  return (
    <MacCard title="클러스터 네트워크 정보 (viewer)">
      <div className="flex items-start gap-3">
        <EyeOff className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm text-muted-foreground">
            켜면 <b>viewer</b> 의 클러스터 목록·상세 응답에서 내부 IP·CIDR(Node/Pod/Service)·
            bond IP/MAC·호스트명·AS 번호·API 엔드포인트·Prometheus/Alertmanager 주소를 비우고, Cilium 설정 보기를
            막습니다. 이름·지역·운영레벨·상태·노드 수는 그대로 보입니다. admin·operator 에는 적용되지 않습니다.
          </p>
          <p className="text-xs text-muted-foreground">
            적용 범위는 클러스터 관리·사이드바 등 <code>/clusters</code> 응답입니다. 인프라 노드·토폴로지처럼 IP 를
            보여주는 다른 화면은 위 <b>화면별 노출</b>로 막으세요. 변경은 감사 로그에 남습니다.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0">
          <input
            type="checkbox"
            checked={enabled}
            disabled={isLoading || update.isPending}
            onChange={toggle}
            aria-label="viewer 에게 클러스터 네트워크 정보 숨김"
            className="w-4 h-4 rounded border-border accent-primary disabled:opacity-60"
          />
          숨김
        </label>
      </div>
    </MacCard>
  );
}
