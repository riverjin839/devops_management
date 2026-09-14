import { useMemo } from 'react';
import { useAuthStore, hasRole, type UserRole } from '@/stores/authStore';

/** viewer 에게 보이는 비활성 사유 — 버튼 `title`/`aria-label` 보조 문구로 그대로 쓴다. */
export const OPERATOR_REQUIRED_HINT = 'operator 이상 권한이 필요합니다';

export interface CanOperate {
  /** admin 또는 operator 면 true. 실행/추가/수정/삭제/설정 저장 버튼의 활성 조건. */
  canOperate: boolean;
  role: UserRole | null;
  /** 비활성일 때 버튼에 붙일 사유(활성이면 undefined). `title={hint ?? 원래 title}` 패턴으로 쓴다. */
  hint: string | undefined;
  /** 원래 title 을 받아 권한에 따라 사유로 바꿔주는 헬퍼 — `title={withHint('지금 실행')}`. */
  withHint: (title: string) => string;
}

/**
 * D-082 — "보이지만 눌리지 않고 이유가 보이는" 권한 UX 의 공용 판정.
 *
 * 백엔드(`require_operator`)가 실제 차단을 담당하고, 프론트는 viewer 가 실행·추가·설정 버튼을
 * 눌러본 뒤 403 토스트로 권한 부재를 아는 일을 없앤다. 숨기지 않고 `disabled` + 사유를 붙이는
 * 이유는 "그 기능이 있다는 것" 자체는 알아야 권한을 요청할 수 있기 때문이다.
 */
export function useCanOperate(): CanOperate {
  const user = useAuthStore((s) => s.user);
  return useMemo(() => {
    const canOperate = hasRole(user, 'admin', 'operator');
    const role = user?.role ?? null;
    const hint = canOperate ? undefined : `${OPERATOR_REQUIRED_HINT} (현재: ${role ?? '미로그인'})`;
    return { canOperate, role, hint, withHint: (title: string) => hint ?? title };
  }, [user]);
}
