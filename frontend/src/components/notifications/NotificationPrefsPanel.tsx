import { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { SegTabs } from '@/components/common/SegTabs';
import { ErrorState, LoadingState } from '@/components/common/EmptyState';
import { SwitchToggle } from '@/components/common/SwitchToggle';
import { useToastSafe } from '@/components/common/Toast';
import { useNotificationPrefs, useSaveNotificationPrefs } from '@/hooks/useNotifications';
import { formatApiError } from '@/lib/utils';
import type { NotificationEventChannels, NotificationPrefsInput } from '@/types';

const CHANNELS = [
  ['inapp', '앱(알림 종)'],
  ['email', '메일'],
  ['webhook', '메신저'],
] as const;

/** 내 알림 설정 — 이벤트 종류 × 채널, 외부 채널 발송 방식(즉시/하루 요약), 방해 금지 시간. 본인 설정이라 viewer 도 저장 가능. */
export function NotificationPrefsPanel() {
  const toast = useToastSafe();
  const { data, isLoading, error, refetch } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();
  const [draft, setDraft] = useState<NotificationPrefsInput | null>(null);
  const [quietOn, setQuietOn] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft({
      events: data.events, digestMode: data.digestMode, digestHour: data.digestHour,
      quietStart: data.quietStart ?? null, quietEnd: data.quietEnd ?? null,
    });
    setQuietOn(Boolean(data.quietStart && data.quietEnd));
  }, [data]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    const base = { events: data.events, digestMode: data.digestMode, digestHour: data.digestHour,
      quietStart: data.quietStart ?? null, quietEnd: data.quietEnd ?? null };
    return JSON.stringify(base) !== JSON.stringify(draft);
  }, [data, draft]);

  if (isLoading) return <MacCard title="알림 설정" icon={SlidersHorizontal}><LoadingState compact /></MacCard>;
  if (error || !data || !draft) {
    return <MacCard title="알림 설정" icon={SlidersHorizontal}><ErrorState compact error={error} onRetry={() => refetch()} /></MacCard>;
  }

  const pref = (type: string) => draft.events.find((e) => e.type === type);
  const setCh = (type: string, ch: keyof NotificationEventChannels, v: boolean) =>
    setDraft((d) => d && ({
      ...d,
      events: d.events.some((e) => e.type === type)
        ? d.events.map((e) => (e.type === type ? { ...e, [ch]: v } : e))
        : [...d.events, { type, inapp: true, email: false, webhook: false, [ch]: v }],
    }));

  const onSave = () => {
    const body = { ...draft, quietStart: quietOn ? draft.quietStart || '22:00' : null, quietEnd: quietOn ? draft.quietEnd || '07:00' : null };
    save.mutate(body, {
      onSuccess: () => toast.success('알림 설정을 저장했습니다'),
      onError: (e) => toast.error('알림 설정 저장 실패', formatApiError(e)),
    });
  };

  const groups = [
    ['work', '업무'],
    ['ops', '운영'],
  ] as const;
  const unavailable = (ch: 'email' | 'webhook') => !data.available[ch] || (ch === 'email' && !data.myEmail);
  const unavailableHint = (ch: 'email' | 'webhook') =>
    !data.available[ch] ? '관리자가 발송 채널을 지정하지 않아 보내지지 않습니다'
      : ch === 'email' && !data.myEmail ? '내 계정에 메일 주소가 없어 보내지지 않습니다' : undefined;

  return (
    <MacCard
      title="알림 설정"
      icon={SlidersHorizontal}
      description="알림 종류마다 받을 곳을 고릅니다. 앱을 끄면 알림 종에는 뜨지 않고 받은 알림 이력에만 남습니다."
      actions={
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={onSave}
          className="px-3 py-1.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {save.isPending ? '저장 중…' : '저장'}
        </button>
      }
      bodyPadding="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th scope="col" className="text-left font-medium px-4 py-2">알림 종류</th>
              {CHANNELS.map(([ch, label]) => (
                <th key={ch} scope="col" className="font-medium px-3 py-2 w-24 text-center"
                  title={ch !== 'inapp' ? unavailableHint(ch) : undefined}>
                  {label}
                  {ch !== 'inapp' && unavailable(ch) && <span className="block text-faint font-normal">미설정</span>}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(([cat, catLabel]) => (
            <tbody key={cat}>
              <tr><th colSpan={4} scope="colgroup" className="text-left text-xs font-semibold text-muted-foreground bg-secondary/40 px-4 py-1.5">{catLabel}</th></tr>
              {data.catalog.filter((c) => c.category === cat).map((c) => (
                <tr key={c.type} className="border-b border-border/60 last:border-b-0">
                  <th scope="row" className="text-left font-normal px-4 py-2">
                    <span className="text-foreground">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">{c.help}</span>
                  </th>
                  {CHANNELS.map(([ch, label]) => (
                    <td key={ch} className="text-center px-3 py-2">
                      <input
                        type="checkbox"
                        checked={Boolean(pref(c.type)?.[ch])}
                        onChange={(e) => setCh(c.type, ch, e.target.checked)}
                        aria-label={`${c.label} — ${label}`}
                        className="w-4 h-4 accent-primary"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <div className="border-t border-border px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground w-40">메일·메신저 발송 방식</span>
          <SegTabs
            label="메일·메신저 발송 방식"
            value={draft.digestMode}
            onChange={(v) => setDraft((d) => d && ({ ...d, digestMode: v }))}
            options={[['immediate', '바로'], ['daily', '하루 한 번 요약']] as const}
          />
          {draft.digestMode === 'daily' && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              요약 시각
              <input
                type="time"
                value={draft.digestHour}
                onChange={(e) => setDraft((d) => d && ({ ...d, digestHour: e.target.value }))}
                className="h-8 px-2 rounded-xl border border-border bg-background text-sm text-foreground"
              />
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground w-40">방해 금지 시간</span>
          <SwitchToggle checked={quietOn} onChange={setQuietOn} label="방해 금지 사용"
            title="이 시간에는 메일·메신저를 보내지 않고, 끝나면 보냅니다(앱 알림은 그대로)." />
          {quietOn && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="time" aria-label="방해 금지 시작"
                value={draft.quietStart ?? '22:00'}
                onChange={(e) => setDraft((d) => d && ({ ...d, quietStart: e.target.value }))}
                className="h-8 px-2 rounded-xl border border-border bg-background text-sm text-foreground"
              />
              ~
              <input
                type="time" aria-label="방해 금지 끝"
                value={draft.quietEnd ?? '07:00'}
                onChange={(e) => setDraft((d) => d && ({ ...d, quietEnd: e.target.value }))}
                className="h-8 px-2 rounded-xl border border-border bg-background text-sm text-foreground"
              />
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          메일은 내 계정 메일 주소({data.myEmail || '없음'})로 갑니다. 메신저는 관리자가 지정한 사내 메신저 게이트웨이로
          내 계정 정보와 함께 보내집니다. 3일 넘게 보내지 못한 알림은 버립니다.
        </p>
      </div>
    </MacCard>
  );
}
