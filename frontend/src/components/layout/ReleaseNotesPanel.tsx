import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useReleaseNotes } from '@/hooks/useReleaseNotes';

// 사이드바 "릴리즈 노트" SidePane 본문 — CHANGELOG.md 를 파싱한 backend API 를 그대로
// 테이블(버전/날짜/요약)로 보여주고, 행을 클릭하면 그 아래로 섹션별(Added/Fixed/Changed 등)
// 상세 항목이 펼쳐진다. Unreleased 는 backend 에서 이미 제외하고 내려주므로 실제 릴리즈된
// 버전만 표시된다.
interface Props {
  open: boolean;
}

export function ReleaseNotesPanel({ open }: Props) {
  const { data: entries, isLoading, error } = useReleaseNotes(open);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

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
        릴리즈 노트를 불러오지 못했습니다.
      </p>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        아직 릴리즈된 버전이 없습니다.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-card border-b border-border text-left">
        <tr>
          <th className="py-2 px-3 font-medium w-[84px]">버전</th>
          <th className="py-2 px-3 font-medium w-[100px]">날짜</th>
          <th className="py-2 px-3 font-medium">요약</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const isOpen = expanded.has(entry.version);
          // 요약 칸 — 한 줄 truncate 대신 전체 섹션의 항목 제목을 리스트로 모아 보여준다.
          // 버전 하나에 수십 건이 쌓이는 경우(예: 릴리스 컷 직전 축적분)를 대비해 앞부분만 미리보고,
          // 나머지는 "+N개 더" 로 안내(행 클릭 시 펼쳐지는 섹션별 표에서 전체 확인).
          const SUMMARY_PREVIEW_LIMIT = 6;
          const allSummaries = entry.sections.flatMap((s) => s.items.map((it) => it.summary));
          const previewSummaries = allSummaries.slice(0, SUMMARY_PREVIEW_LIMIT);
          const hiddenCount = allSummaries.length - previewSummaries.length;
          return (
            <Fragment key={entry.version}>
              <tr
                onClick={() => toggle(entry.version)}
                className="border-b border-border cursor-pointer hover:bg-secondary/50 align-top"
              >
                <td className="py-2 px-3 font-mono font-semibold whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {isOpen ? (
                      <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
                    )}
                    v{entry.version}
                  </span>
                </td>
                <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">{entry.date}</td>
                <td className="py-2 px-3 text-muted-foreground">
                  {previewSummaries.length > 0 ? (
                    <ul className="space-y-0.5">
                      {previewSummaries.map((s, i) => (
                        <li key={i} className="flex gap-1.5">
                          <span className="text-primary flex-shrink-0">·</span>
                          <span className="truncate">{s}</span>
                        </li>
                      ))}
                      {hiddenCount > 0 && (
                        <li className="flex gap-1.5 text-xs text-muted-foreground/70">
                          <span className="flex-shrink-0 invisible">·</span>
                          <span>+{hiddenCount}개 더 (클릭해서 전체 보기)</span>
                        </li>
                      )}
                    </ul>
                  ) : (
                    entry.summary
                  )}
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-border bg-secondary/30">
                  <td colSpan={3} className="px-3 py-3">
                    <div className="space-y-3">
                      {entry.sections.map((section) => (
                        <div key={section.name}>
                          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                            {section.name}
                          </div>
                          <table className="w-full text-xs border border-border/60 rounded-md overflow-hidden">
                            <thead className="bg-muted/40">
                              <tr>
                                <th className="py-1.5 px-2 font-medium text-left w-9">#</th>
                                <th className="py-1.5 px-2 font-medium text-left">내용</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {section.items.map((item, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 px-2 text-muted-foreground align-top tabular-nums">
                                    {i + 1}
                                  </td>
                                  <td className="py-1.5 px-2 align-top">
                                    <span className="font-medium">{item.summary}</span>
                                    {item.detail && (
                                      <span className="text-muted-foreground"> — {item.detail}</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
