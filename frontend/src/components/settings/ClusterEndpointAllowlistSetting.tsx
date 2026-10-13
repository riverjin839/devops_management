import { useEffect, useId, useState } from 'react';
import { Network, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { useClusterEndpointAllowlist, useUpdateClusterEndpointAllowlist } from '@/hooks/useUiSettings';
import { formatApiError } from '@/lib/utils';

/** Settings → 접근 제어 — 클러스터 API 엔드포인트 허용 대역. 클러스터 등록·수정·연결 검증은 서버가
 *  api_endpoint 로 직접 요청을 보내므로, 폐쇄망 운영 정책에 맞춰 도달 가능한 대역을 제한한다.
 *  비어 있으면 제한 없음(기본). 서버가 항목 형식을 검증하고 변경을 감사 로그로 남긴다. */
export function ClusterEndpointAllowlistSetting() {
  const { data, isLoading } = useClusterEndpointAllowlist();
  const update = useUpdateClusterEndpointAllowlist();
  const toast = useToast();
  const fieldId = useId();
  const [draft, setDraft] = useState('');

  useEffect(() => { setDraft((data?.entries ?? []).join('\n')); }, [data]);

  const entries = draft.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  const dirty = entries.join('\n') !== (data?.entries ?? []).join('\n');

  const save = () =>
    update.mutate({ entries }, {
      onSuccess: (res) => {
        const n = res.data.data.entries.length;
        toast.success(n ? `허용 대역 ${n}개 저장됨` : '허용 대역 제한 해제됨');
      },
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  return (
    <MacCard title="클러스터 API 엔드포인트 허용 대역">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Network className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" aria-hidden />
          <div className="space-y-1.5 min-w-0">
            <p className="text-sm text-muted-foreground">
              클러스터 등록·수정·연결 검증 때 서버가 API 엔드포인트로 직접 요청을 보냅니다. 여기에 대역을 적으면
              그 밖의 주소는 <b>등록·변경이 거절</b>되고 연결 검증도 요청을 보내지 않습니다. <b>비어 있으면 제한
              없음</b>(기본)입니다.
            </p>
            <p className="text-xs text-muted-foreground">
              한 줄에 하나씩 — CIDR(<code>10.0.0.0/8</code>, 단일 IP 도 가능) 또는 호스트명(<code>api.k8s.local</code>,
              하위 도메인 전체는 <code>*.k8s.local</code>). 호스트명 엔드포인트는 DNS 로 푼 주소가 모두 CIDR 안에
              있어야 허용됩니다. 이미 등록된 클러스터는 바뀌지 않으며, 대역 밖이면 연결 검증에서 실패로 드러납니다.
            </p>
          </div>
        </div>
        <label htmlFor={fieldId} className="sr-only">허용 대역 목록</label>
        <textarea
          id={fieldId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isLoading}
          rows={4}
          placeholder={'10.0.0.0/8\n*.k8s.local'}
          className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {entries.length ? `${entries.length}개 항목` : '제한 없음'}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || update.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Save className="w-4 h-4" aria-hidden />
            저장
          </button>
        </div>
      </div>
    </MacCard>
  );
}
