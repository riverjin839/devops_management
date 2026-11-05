/**
 * 사용 매뉴얼 — `/manual`(목록), `/manual/:topic`(화면별 매뉴얼).
 * 내용은 `manual/manuals.ts` 가 원천이다. 각 화면은 설명 문장 대신 헤더의 「사용법」 링크로 여기 연결한다.
 */
import { useEffect } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BookOpen, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { PageShell } from '@/components/common/PageShell';
import { EmptyState } from '@/components/common/EmptyState';
import { MacCard } from '@/components/ui/MacCard';
import { MANUALS, MANUAL_BY_KEY, type ManualNote } from '@/manual/manuals';

const NOTE_CLS: Record<ManualNote['kind'], string> = {
  tip: 'border-border bg-secondary/40 text-muted-foreground',
  warn: 'border-status-warning/40 bg-status-warning/5 text-status-warning',
};

export function ManualPage() {
  const { topic } = useParams<{ topic?: string }>();
  const { hash } = useLocation();
  const manual = topic ? MANUAL_BY_KEY[topic] : undefined;

  // 「사용법」 링크가 섹션 앵커(#id)를 줄 수 있다 — 렌더 뒤에 해당 섹션으로 이동한다.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [hash, topic]);

  if (topic && !manual) {
    return (
      <PageShell density="doc">
        <PageHeader icon={BookOpen} title="사용 매뉴얼" back={{ to: '/manual', label: '목록' }} />
        <EmptyState title="없는 매뉴얼입니다" description="목록에서 화면을 골라 주세요." />
      </PageShell>
    );
  }

  if (!manual) {
    return (
      <PageShell density="doc" className="space-y-4">
        <PageHeader icon={BookOpen} title="사용 매뉴얼" />
        <MacCard title="화면별 매뉴얼">
          <ul className="divide-y divide-border -my-1">
            {MANUALS.map((m) => (
              <li key={m.key}>
                <Link to={`/manual/${m.key}`} className="block py-2 hover:text-foreground">
                  <span className="text-sm font-medium text-foreground">{m.title}</span>
                  <span className="block text-sm text-muted-foreground">{m.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </MacCard>
      </PageShell>
    );
  }

  return (
    <PageShell density="doc" className="space-y-4">
      <PageHeader
        icon={BookOpen}
        title={`${manual.title} 사용법`}
        description={manual.summary}
        back={{ to: '/manual', label: '목록' }}
        actions={
          <Link
            to={manual.route}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="w-4 h-4" aria-hidden="true" /> 화면 열기
          </Link>
        }
      />

      <nav aria-label="이 매뉴얼의 목차" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {manual.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground">
            {s.title}
          </a>
        ))}
      </nav>

      {manual.sections.map((s) => (
        <section key={s.id} id={s.id} className="scroll-mt-4">
          <MacCard title={s.title} className="space-y-3 text-sm leading-relaxed">
            {s.body?.map((p) => <p key={p}>{p}</p>)}
            {s.steps && (
              <ol className="list-decimal pl-5 space-y-1">
                {s.steps.map((t) => <li key={t}>{t}</li>)}
              </ol>
            )}
            {s.items && (
              <ul className="list-disc pl-5 space-y-1">
                {s.items.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
            {s.notes?.map((n) => (
              <p key={n.text} className={`rounded-xl border px-3 py-2 ${NOTE_CLS[n.kind]}`}>
                <span className="font-medium">{n.kind === 'warn' ? '주의 ' : '참고 '}</span>
                {n.text}
              </p>
            ))}
          </MacCard>
        </section>
      ))}
    </PageShell>
  );
}
