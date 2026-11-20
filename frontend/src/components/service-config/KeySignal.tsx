// 행 배지 — 이 키에 열린 노드 파라미터 알람(심각도별 수)과 최근 24시간 변경(노드·전→후·언제).
// 클릭하면 OS 파라미터 감시 화면의 변경 이력(키 필터)으로 간다. 정상이면 아무것도 그리지 않는다(중립 원칙).
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/common';
import { formatRelativeTime } from '@/lib/utils';
import type { ServiceConfigKeySignal } from '@/types';

interface Props {
  paramKey: string;
  signal?: ServiceConfigKeySignal;
  /** 변경 이력 화면 주소(키 필터 포함). 없으면 링크 없이 글자만. */
  href?: string;
}

export function KeySignal({ paramKey, signal, href }: Props) {
  if (!signal) return null;
  const { critical, warning } = signal.alerts;
  const ch = signal.lastChange;
  if (!critical && !warning && !ch) return null;
  const text = ch ? `${ch.detectedAt ? formatRelativeTime(ch.detectedAt) : ''} 변경 · ${ch.node} ${ch.oldValue ?? '없음'} → ${ch.newValue ?? '없음'}` : '';
  return (
    <div className="mt-1 space-y-1">
      {(critical > 0 || warning > 0) && (
        <div className="flex flex-wrap gap-1">
          {critical > 0 && <StatusBadge variant="critical" label={`알람 ${critical}`} title={`${paramKey} critical 알람 ${critical}건`} />}
          {warning > 0 && <StatusBadge variant="warning" label={`알람 ${warning}`} title={`${paramKey} warning 알람 ${warning}건`} />}
        </div>
      )}
      {ch && (href ? (
        <Link to={href} className="block text-xs text-primary hover:underline break-all" aria-label={`${paramKey} 변경 이력 보기 — ${text}`}>{text}</Link>
      ) : (
        <span className="block text-xs text-muted-foreground break-all">{text}</span>
      ))}
    </div>
  );
}
