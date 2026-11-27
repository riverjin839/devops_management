import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard } from 'lucide-react';
import { EmptyState } from '@/components/common';

/**
 * 홈(Main UI, `/`) — "Main UI 일단 비우기" 요청으로 모든 사용자에게 빈 상태 안내만 보여 준다.
 * 로그인 후에도 이 화면에 머물고(자동 이동 없음), 사이드바 앱이나 아래 버튼으로 화면을 연다.
 * 예전 홈(업무/플랫폼 현황 탭)은 `pages/HomeDashboard.tsx` 에 그대로 남아 있다.
 */
export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <main className="app-h-screen flex items-center justify-center bg-background px-4">
      <h1 className="sr-only">{t('home.title')}</h1>
      <EmptyState
        icon={LayoutDashboard}
        title={t('home.empty.title')}
        description={t('home.empty.description')}
        action={{ label: t('home.empty.openK8s'), onClick: () => navigate('/k8s') }}
      />
    </main>
  );
}
