import { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { REACTION_EMOJIS, type ReactionTargetType } from '@/types';
import { useReactions, useToggleReaction } from '@/hooks/useReactions';
import { cn } from '@/lib/utils';

interface ReactionBarProps {
  targetType: ReactionTargetType;
  targetId: string;
  className?: string;
}

/**
 * 이모지 공감(리액션) 바 — 담당자 작성글(운영 노트 / 업무 댓글 / 작업 가이드) 공통.
 * 기존 이모지는 칩(개수+누른사람 툴팁)으로, 우측 + 버튼으로 팔레트에서 새 이모지 추가.
 * 같은 이모지를 다시 누르면 토글 해제.
 */
export function ReactionBar({ targetType, targetId, className }: ReactionBarProps) {
  const { data } = useReactions(targetType, targetId);
  const toggle = useToggleReaction();
  const [open, setOpen] = useState(false);
  const groups = data?.groups ?? [];

  const pick = (emoji: string) => {
    if (!targetId) return;
    toggle.mutate({ targetType, targetId, emoji });
    setOpen(false);
  };

  return (
    <div className={cn('flex items-center gap-1 flex-wrap', className)}>
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          onClick={() => pick(g.emoji)}
          title={g.users.join(', ')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
            g.reacted
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary',
          )}
        >
          <span className="text-sm leading-none">{g.emoji}</span>
          <span className="tabular-nums">{g.count}</span>
        </button>
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="공감 추가"
          aria-label="공감 추가"
          aria-expanded={open}
          className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <SmilePlus className="w-3.5 h-3.5" />
        </button>

        {open && (
          <>
            {/* click-away */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-[40] cursor-default"
              onClick={() => setOpen(false)}
            />
            <div className="absolute left-0 z-[41] mt-1 flex items-center gap-0.5 rounded-xl border border-border bg-card p-1 mac-shadow">
              {REACTION_EMOJIS.map((e) => {
                const mine = groups.find((g) => g.emoji === e)?.reacted;
                return (
                  <button
                    key={e}
                    type="button"
                    onClick={() => pick(e)}
                    title={e}
                    className={cn(
                      'w-7 h-7 rounded-lg text-base leading-none hover:bg-secondary transition-colors',
                      mine && 'bg-primary/10 ring-1 ring-primary/30',
                    )}
                  >
                    {e}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
