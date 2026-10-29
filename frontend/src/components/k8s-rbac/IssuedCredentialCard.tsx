/**
 * 방금 발급한 kubeconfig 카드 — 발급 마법사·ServiceAccount 재발급 공용, 탭 위에 고정.
 *
 * 값은 `useRbacCredentialStore`(메모리) 에 있어서 탭·허브 뷰·클러스터를 옮겼다 돌아와도 남고,
 * 운영자가 **닫기** 를 눌러야 사라진다. 카드가 떠 있는 동안 새로고침·창 닫기는 브라우저 이탈
 * 확인을 띄운다 — 토큰은 다시 볼 수 없어 실수로 잃으면 재발급(토큰 증가)해야 한다.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ConfirmDialog } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useRbacCredentialStore } from '@/stores/rbacCredentialStore';
import { CredentialResult } from './CredentialResult';

const fmtExpiry = (iso: string | null) => (iso ? `만료 ${iso.replace('T', ' ').slice(0, 16)}` : '만료 없음');
const safe = (s: string) => s.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'cluster';

export function IssuedCredentialCard({ clusterId }: { clusterId: string }) {
  const cred = useRbacCredentialStore((s) => s.byCluster[clusterId]);
  const clear = useRbacCredentialStore((s) => s.clear);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!cred) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 일부 브라우저는 returnValue 가 있어야 확인창을 띄운다(문구는 브라우저 기본값).
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [cred]);

  if (!cred) return null;

  return (
    <MacCard
      title={cred.source === 'wizard' ? '발급된 kubeconfig' : '재발급된 kubeconfig'}
      titleExtra={
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{cred.clusterName}</span> ·{' '}
          <span className="font-mono">{cred.namespace}/{cred.serviceAccount}</span> · {fmtExpiry(cred.expiresAt)}
        </span>
      }
      actions={
        <button
          type="button"
          onClick={() => setConfirmClose(true)}
          title="kubeconfig 닫기 — 닫으면 다시 볼 수 없습니다"
          aria-label="kubeconfig 닫기"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" /> 닫기
        </button>
      }
    >
      <CredentialResult
        kubeconfig={cred.kubeconfig}
        fileName={`kubeconfig-${safe(cred.clusterName)}-${cred.serviceAccount}-${cred.namespace}.yaml`}
        maxHeight="max-h-72"
      />
      <ConfirmDialog
        open={confirmClose}
        title="kubeconfig 를 닫을까요?"
        description="닫으면 이 토큰은 다시 볼 수 없습니다. 개발자에게 전달하거나 파일로 저장했는지 확인하세요 — 잃어버리면 다시 발급해야 합니다."
        confirmLabel="닫기"
        onConfirm={() => {
          setConfirmClose(false);
          clear(clusterId);
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </MacCard>
  );
}
