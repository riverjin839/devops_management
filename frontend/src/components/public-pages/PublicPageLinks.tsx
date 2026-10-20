// 로그인 없는 공개 화면끼리 오가는 링크 — 일일 리포트 ↔ 외부 서비스. 로그인 상태면 포털 링크도 보인다.
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

export const PUBLIC_PAGES = [
  { path: '/daily-report', label: '일일 자원 리포트' },
  { path: '/external-services', label: '외부 서비스' },
] as const;

export function PublicPageLinks() {
  const { pathname } = useLocation();
  const loggedIn = useAuthStore((s) => !!s.token && !!s.user);
  return (
    <nav aria-label="공개 화면" className="flex items-center gap-3 text-sm">
      {PUBLIC_PAGES.map((p) => (
        <Link key={p.path} to={p.path} aria-current={pathname === p.path ? 'page' : undefined}
          className={cn(pathname === p.path ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground')}>
          {p.label}
        </Link>
      ))}
      {loggedIn && (
        <Link to="/" className="text-muted-foreground hover:text-foreground border-l border-border pl-3">포털로 이동</Link>
      )}
    </nav>
  );
}
