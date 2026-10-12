import { useId, useMemo } from 'react';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { CRON_PRESETS, checkCron, formatWallClock, timezoneLabel, DEFAULT_CRON_TIMEZONE } from '@/lib/cron';

interface CronInputProps {
  value: string;
  onChange: (v: string) => void;
  /** 디스패처 기준 시간대(`grid.timezone`) — 다음 실행 시각을 이 시간대 벽시계로 보여 준다. */
  timezone?: string;
  disabled?: boolean;
  /** 라벨 텍스트(시각적으로 보이는 라벨) — 기본 "실행 주기 (cron)". */
  label?: string;
  /** 프리셋 버튼 줄을 숨길 때(좁은 팝오버 등). */
  hidePresets?: boolean;
  autoFocus?: boolean;
}

/**
 * 점검 주기 입력 — 셀 상세·항목 상세 적용 탭·클러스터 열 헤더 팝오버가 같은 입력을 쓴다.
 *
 * 입력하는 즉시 형식·최소 간격(5분)을 검사하고, "평일 09:00" 처럼 사람 말 설명과 다음 실행 3회를
 * 기준 시간대(KST 등)로 보여 준다. 흔한 주기는 프리셋 한 번으로 채운다. 저장 버튼 활성 판정은
 * 부모가 같은 규칙의 `checkCron(value, tz).ok`(`@/lib/cron`)로 한다.
 */
export function CronInput({
  value, onChange, timezone = DEFAULT_CRON_TIMEZONE, disabled, label = '실행 주기 (cron)', hidePresets, autoFocus,
}: CronInputProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const check = useMemo(() => checkCron(value, timezone), [value, timezone]);
  const tzLabel = timezoneLabel(timezone);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {label} <span className="font-normal text-muted-foreground">· {tzLabel} 기준 · 분 시 일 월 요일</span>
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder="비우면 자동 실행 안 함 (예: 15 9,13,18 * * *)"
        aria-invalid={!check.ok || undefined}
        aria-describedby={helpId}
        className={`w-full text-xs font-mono border rounded-xl px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 disabled:opacity-60 ${
          check.ok ? 'border-border focus:ring-primary' : 'border-status-critical focus:ring-status-critical'
        }`}
      />
      {!hidePresets && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="자주 쓰는 주기">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(p.value)}
              aria-pressed={value.trim() === p.value}
              className={`px-2 py-0.5 text-[11px] rounded-xl border transition-colors disabled:opacity-50 ${
                value.trim() === p.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div id={helpId} className="text-[11px] leading-relaxed" aria-live="polite">
        {check.ok ? (
          <div className="text-muted-foreground space-y-0.5">
            {check.description && <p className="text-foreground">{check.description}</p>}
            {check.next.length > 0 && (
              <p className="inline-flex items-center gap-1 flex-wrap">
                <CalendarClock className="w-3 h-3" aria-hidden="true" />
                다음 실행: {check.next.map(formatWallClock).join(' · ')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-status-critical inline-flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
            {check.error}
          </p>
        )}
      </div>
    </div>
  );
}
