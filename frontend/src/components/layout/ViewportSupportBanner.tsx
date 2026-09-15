import { useEffect, useState } from 'react';
import { X, MonitorSmartphone } from 'lucide-react';

const NARROW_QUERY = '(max-width: 1023px)'; // Tailwind `lg` 미만 — D-076 "축약/미지원" 경계
const DISMISS_KEY = 'pep:viewportBannerDismissed';

/**
 * D-076 — 지원 뷰포트 선언. PEP 는 ≥1280px 을 정식으로, 1024~1279px 은 상단바 메뉴가
 * 접힌 축약 레이아웃으로 지원한다. 1024px 미만은 사이드바·상단바·카드 그리드가 겹치거나
 * 잘려 보일 수 있어 이 배너로 알린다 — 막지는 않는다(조회는 대부분 화면에서 여전히 된다).
 * 세션당 1회 닫으면 이 탭에서는 다시 뜨지 않는다(다음 세션엔 조건이 유지되면 다시 뜬다).
 */
export function ViewportSupportBanner() {
  const [narrow, setNarrow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      // sessionStorage 접근 불가(프라이빗 모드 등) — 닫기 상태를 기억 못 해도 배너 자체는 정상 동작.
    }
  }, []);

  if (!narrow || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // 저장 실패해도 이번 렌더는 이미 닫힌 상태 — 무시.
    }
  };

  return (
    <div
      role="status"
      className="flex-none flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning-soft text-status-warning border-b border-status-warning/30"
    >
      <MonitorSmartphone className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0">
        이 창 폭(1024px 미만)은 PEP 의 권장 지원 범위 밖입니다 — 일부 화면 요소가 겹치거나 잘려 보일 수 있습니다. 창을 넓히거나 화면 배율을 낮춰 주세요.
      </span>
      <button
        type="button"
        onClick={dismiss}
        title="닫기"
        aria-label="닫기"
        className="flex-shrink-0 p-0.5 rounded hover:bg-status-warning/15"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
