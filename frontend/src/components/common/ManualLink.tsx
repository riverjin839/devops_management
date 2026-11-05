import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { MANUAL_BY_KEY } from '@/manual/manuals';

/**
 * 화면 헤더의 「사용법」 링크 — 설명 문장 대신 `/manual/:topic` 으로 연결한다.
 * 새 탭으로 열어 작업 중인 화면(터미널 세션·입력 중인 폼)을 잃지 않게 한다.
 * `PageHeader` 의 `manual` prop 이 이것을 그린다 — 페이지에서 직접 쓰지 않는다.
 */
export function ManualLink({ topic, section }: { topic: string; section?: string }) {
  if (!MANUAL_BY_KEY[topic]) return null;
  const to = `/manual/${topic}${section ? `#${section}` : ''}`;
  return (
    <Link
      to={to}
      target="_blank"
      rel="noopener"
      title="사용법 (새 탭)"
      aria-label="사용법 보기 (새 탭에서 열림)"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground whitespace-nowrap"
    >
      <BookOpen className="w-4 h-4" aria-hidden="true" /> 사용법
    </Link>
  );
}
