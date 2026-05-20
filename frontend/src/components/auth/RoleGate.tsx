/**
 * Role-based visibility gate. Renders children only when the current user's
 * role is in the `allow` list. Used to hide menus/buttons from users who lack
 * the required permission — the backend enforces the actual check.
 */
import { type ReactNode } from 'react';
import { useAuthStore, hasRole, type UserRole } from '@/stores/authStore';

interface RoleGateProps {
  allow: UserRole[];
  children: ReactNode;
  fallback?: ReactNode;
}

export function RoleGate({ allow, children, fallback = null }: RoleGateProps) {
  const user = useAuthStore((s) => s.user);
  if (!hasRole(user, ...allow)) return <>{fallback}</>;
  return <>{children}</>;
}
