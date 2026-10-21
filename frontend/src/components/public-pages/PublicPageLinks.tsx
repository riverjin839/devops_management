// 로그인 없는 공개 화면끼리 오가는 링크 — 일일 리포트 ↔ 외부 서비스. 로그인 상태면 포털 링크도 보인다.
// 공유 링크(`?t=`)로 들어왔으면 다른 공개 화면으로 갈 때도 토큰을 그대로 들고 간다.
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

export const PUBLIC_PAGES = [
  { path: '/daily-report', label: '일일 자원 리포트' },
  { path: '/external-services', label: '외부 서비스' },
] as const;

export function PublicPageLinks() {
  const { pathname, search } = useLocation();
  const token = new URLSearchParams(search).get('t');
  const suffix = token ? `?t=${encodeURIComponent(token)}` : '';
  const loggedIn = useAuthStore((s) => !!s.token && !!s.user);
  return (
    <nav aria-label="공개 화면" className="flex items-center gap-3 text-sm">
      {PUBLIC_PAGES.map((p) => (
        <Link key={p.path} to={`${p.path}${suffix}`} aria-current={pathname === p.path ? 'page' : undefined}
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
