import { Loader2, Bug } from 'lucide-react';
import { useReleaseNotes } from '@/hooks/useReleaseNotes';

// 사이드바 "버그 픽스 로그" SidePane 본문 — 릴리즈 노트와 같은 CHANGELOG 파싱 API 를
// 재사용하되, 각 버전의 `Fixed`(버그 수정) 섹션 항목만 모아 최신 버전 순으로 나열한다.
// 운영자가 "무슨 버그가 언제 고쳐졌는지"만 빠르게 훑어보는 용도.
interface Props {
  open: boolean;
}

// 섹션 이름이 "Fixed" / "fix" 계열인지 (대소문자 무시).
function isFixSection(name: string): boolean {
  return /\bfix/i.test(name);
}

export function BugFixLogPanel({ open }: Props) {
  const { data: entries, isLoading, error } = useReleaseNotes(open);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive py-6 text-center">
        버그 픽스 로그를 불러오지 못했습니다.
      </p>
    );
  }

  // Fixed 섹션이 있는 버전만, 그 버전의 fix 항목만 추린다.
  const versions = (entries ?? [])
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      fixes: entry.sections.filter((s) => isFixSection(s.name)).flatMap((s) => s.items),
    }))
    .filter((v) => v.fixes.length > 0);

  const totalFixes = versions.reduce((acc, v) => acc + v.fixes.length, 0);

  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        기록된 버그 수정 이력이 없습니다.
      </p>
    );
  }

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border text-sm text-muted-foreground">
        <Bug className="w-4 h-4 text-primary" />
        <span>
          총 <span className="font-semibold text-foreground tabular-nums">{totalFixes}</span>건의 버그 수정
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          {versions.length}개 버전
        </span>
      </div>

      {versions.map((v) => (
        <section key={v.version} className="border-b border-border">
          <header className="sticky top-0 z-[1] flex items-center gap-2 px-4 py-2 bg-muted/40 backdrop-blur-sm">
            <span className="font-mono font-semibold text-sm">v{v.version}</span>
            <span className="text-xs text-muted-foreground">{v.date}</span>
            <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary tabular-nums">
              {v.fixes.length}
            </span>
          </header>
          <ul className="divide-y divide-border/60">
            {v.fixes.map((fix, i) => (
              <li key={i} className="px-4 py-2.5 text-sm">
                <div className="flex gap-2">
                  <span className="text-primary/70 flex-shrink-0 mt-0.5">·</span>
                  <div className="min-w-0">
                    <span className="font-medium break-words">{fix.summary}</span>
                    {fix.detail && (
                      <span className="text-muted-foreground break-words"> — {fix.detail}</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
