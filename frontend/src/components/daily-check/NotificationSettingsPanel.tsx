import { useState } from 'react';
import { Plus, Trash2, Power, PowerOff, Send } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import {
  useNotificationChannels,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
  useTestChannel,
} from '@/hooks/useNotifications';
import type { NotificationChannel, NotificationChannelInput, NotificationChannelType } from '@/types';

const CHANNEL_TYPES: { value: NotificationChannelType; label: string }[] = [
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email (SMTP)' },
  { value: 'webhook', label: 'Generic Webhook' },
  { value: 'k8s_event', label: 'K8s Event' },
];

export function NotificationSettingsPanel() {
  const { data: channels = [] } = useNotificationChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const remove = useDeleteChannel();
  const test = useTestChannel();
  const [adding, setAdding] = useState(false);

  return (
    <MacCard title="알림 채널">
      <div className="space-y-3">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            <Plus className="w-3.5 h-3.5" />
            {adding ? '닫기' : '채널 추가'}
          </button>
        </div>

        {adding && (
          <ChannelForm
            onSubmit={async (body) => {
              await create.mutateAsync(body);
              setAdding(false);
            }}
          />
        )}

        {channels.length === 0 ? (
          <div className="text-sm text-muted-foreground italic">
            등록된 채널이 없습니다.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card overflow-hidden">
            {channels.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                onToggle={() =>
                  update.mutate({
                    id: c.id,
                    body: {
                      name: c.name,
                      channelType: c.channelType,
                      enabled: !c.enabled,
                      clusterId: c.clusterId ?? null,
                      minSeverity: c.minSeverity,
                      config: c.config ?? null,
                    },
                  })
                }
                onDelete={() => {
                  if (window.confirm('채널을 삭제하시겠습니까?')) {
                    remove.mutate(c.id);
                  }
                }}
                onTest={() => test.mutate(c.id)}
                testing={test.isPending}
              />
            ))}
          </ul>
        )}
      </div>
    </MacCard>
  );
}

function ChannelRow({
  channel,
  onToggle,
  onDelete,
  onTest,
  testing,
}: {
  channel: NotificationChannel;
  onToggle: () => void;
  onDelete: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <button
        type="button"
        onClick={onToggle}
        title={channel.enabled ? '비활성화' : '활성화'}
        className={`rounded-lg p-1.5 ${
          channel.enabled
            ? 'text-emerald-600 hover:bg-emerald-500/10'
            : 'text-muted-foreground hover:bg-muted'
        }`}
      >
        {channel.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{channel.name}</span>
          <span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">
            {channel.channelType}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          최소 심각도: {channel.minSeverity}
          {channel.clusterId ? ` · 클러스터 한정` : ' · 전체 클러스터'}
        </div>
      </div>
      <button
        type="button"
        onClick={onTest}
        disabled={testing}
        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        title="테스트 발송"
      >
        <Send className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded-lg p-1.5 text-red-500 hover:bg-red-500/10"
        title="삭제"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </li>
  );
}

function ChannelForm({
  onSubmit,
}: {
  onSubmit: (body: NotificationChannelInput) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<NotificationChannelType>('slack');
  const [minSeverity, setMinSeverity] = useState('warning');
  const [configText, setConfigText] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  const placeholderByType: Record<NotificationChannelType, string> = {
    slack: '{"webhook_url": "https://hooks.slack.com/..."}',
    email: '{"smtp_host": "...", "to": ["ops@example.com"]}',
    webhook: '{"url": "https://...", "headers": {}}',
    k8s_event: '{"namespace": "k8s-monitor"}',
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-3 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="채널 이름"
          className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
        />
        <select
          value={channelType}
          onChange={(e) => setChannelType(e.target.value as NotificationChannelType)}
          className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
        >
          {CHANNEL_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <select
          value={minSeverity}
          onChange={(e) => setMinSeverity(e.target.value)}
          className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="warning">warning 이상</option>
          <option value="critical">critical 만</option>
        </select>
      </div>
      <textarea
        value={configText}
        onChange={(e) => {
          setConfigText(e.target.value);
          setError(null);
        }}
        placeholder={placeholderByType[channelType]}
        rows={4}
        className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-mono resize-y"
      />
      {error && <div className="text-sm text-red-500">{error}</div>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={async () => {
            let config: Record<string, unknown> | null = null;
            try {
              config = configText.trim() ? JSON.parse(configText) : {};
            } catch (e) {
              setError(`config JSON 파싱 실패: ${(e as Error).message}`);
              return;
            }
            if (!name) {
              setError('이름을 입력하세요.');
              return;
            }
            await onSubmit({
              name,
              channelType,
              enabled: true,
              clusterId: null,
              minSeverity,
              config,
            });
            setName('');
            setConfigText('{}');
          }}
          className="rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:opacity-90"
        >
          채널 추가
        </button>
      </div>
    </div>
  );
}
