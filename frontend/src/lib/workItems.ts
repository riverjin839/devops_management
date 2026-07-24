import type { WorkItem } from '@/types';
import { assigneeNames, toLocalDateKey } from './utils';

/**
 * 업무 도메인 공용 셀렉터 — "내 할일" 판정을 여러 화면(홈 KPI, /todo-today)에서
 * 동일하게 쓰도록 한 곳에 모은다. 정의가 갈리면 같은 사용자가 화면마다 다른 숫자를 본다.
 */

/** 로그인 사용자가 이 업무의 담당자(정/부/legacy, 쉼표 복수 "A,B" 포함)인가. */
export function isAssignedTo(item: WorkItem, name: string): boolean {
  return !!name && assigneeNames(item).includes(name);
}

/** 업무 시작일의 로컬(KST) 날짜 키(YYYY-MM-DD). 저장은 UTC canonical. */
export function itemDateKey(item: WorkItem): string {
  return toLocalDateKey(item.startedAt);
}

/**
 * "내 오늘 할일" 판정 — 홈 KPI 와 `/todo-today` 의 지연+오늘(open) 집계가 같은 정의를 공유한다.
 * 조건: 미완료(done 제외) + (내 담당 or 공통업무 allAttendees) + 시작일이 오늘 이하(또는 미지정).
 */
export function isMyDueTodo(item: WorkItem, myName: string, todayKey: string): boolean {
  if (item.kanbanStatus === 'done') return false;
  if (!isAssignedTo(item, myName) && !item.allAttendees) return false;
  const due = itemDateKey(item);
  return !due || due <= todayKey;
}
