import { useEffect, useState } from 'react';
import { dateKeyOf } from '@/lib/utils';

/**
 * 오늘 날짜 키(YYYY-MM-DD, 로컬=KST)를 반환하고 **자정을 넘기면 자동 갱신**한다.
 *
 * 홈(업무 현황)처럼 상시 띄워두는 대시보드는 마운트 시각의 `new Date()` 에 '오늘' 이
 * 고정되면 자정 이후 KPI/오늘 하이라이트/지연 판정이 어긋난다. 이 훅은 30초마다 날짜만
 * 확인해(값이 바뀔 때만 setState) 날짜 경계에서 재계산을 트리거하고, 탭 복귀 시에도 즉시
 * 재확인한다. 분(minute) 단위가 아닌 '날짜' 단위라 리렌더 비용이 사실상 없다.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => dateKeyOf(new Date()));
  useEffect(() => {
    const tick = () => {
      const k = dateKeyOf(new Date());
      setToday((prev) => (prev === k ? prev : k));
    };
    const id = window.setInterval(tick, 30_000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return today;
}
