import { PageHeader } from '@/components/common/PageHeader';
import { PageShell } from '@/components/common/PageShell';
import { SegTabs } from '@/components/common/SegTabs';
import { DeliverySettingsCard, NotificationHistoryList, NotificationPrefsPanel } from '@/components/notifications';
import { useUrlParams } from '@/hooks/useUrlParams';
import { hasRole, useAuthStore } from '@/stores/authStore';
import type { NotificationCategory } from '@/types';

/**
 * 알림 — 받은 알림 전체 이력(읽은 것 포함) + 내 알림 설정(+ 관리자: 외부 발송 채널).
 * 알림 종(상단 바)은 안 읽은 것만 보여주고, 읽었거나 지난 알림은 여기서 다시 찾는다.
 */
export function NotificationsPage() {
  const user = useAuthStore((s) => s.user);
  const [params, setParams] = useUrlParams({ tab: 'inbox', category: 'all' });
  const tab = params.tab === 'settings' ? 'settings' : 'inbox';
  const category = (['work', 'ops'].includes(params.category) ? params.category : 'all') as 'all' | NotificationCategory;
  const canSeeDelivery = hasRole(user, 'admin', 'operator');

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="doc" className="space-y-4">
        <PageHeader
          title="알림"
          description="받은 알림을 다시 보고, 알림 종류마다 앱·메일·메신저 중 받을 곳을 고릅니다."
        />
        <SegTabs
          mode="tabs"
          label="알림 화면"
          value={tab}
          onChange={(v) => setParams({ tab: v })}
          options={[['inbox', '받은 알림'], ['settings', '알림 설정']] as const}
        />
        {tab === 'inbox' ? (
          <NotificationHistoryList category={category} onCategory={(c) => setParams({ category: c })} />
        ) : (
          <>
            <NotificationPrefsPanel />
            {canSeeDelivery && <DeliverySettingsCard />}
          </>
        )}
      </PageShell>
    </div>
  );
}
