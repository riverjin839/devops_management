import { ImagePlus, ExternalLink } from 'lucide-react';
import { WorkItem } from '@/types';
import { stripHtml } from '@/lib/utils';
import { loadWorkItemImages } from '@/lib/workItemImages';
import { KANBAN_STATUS_LABEL, MODULE_CONFIG, TYPE_LABEL_CONFIG } from './workItemKanbanUtils';
import { RichContent } from '@/components/editor';
import { CommentThread } from './CommentThread';
import { ActivityTimeline } from './ActivityTimeline';
import { useWorkItemCustomFields, sortedWorkItemFields } from '@/hooks/useWorkItemCustomFields';

interface WorkItemReadViewProps {
  item: WorkItem;
}

const PRIORITY_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  high: { dot: 'bg-red-500', label: '높음', text: 'text-red-400' },
  medium: { dot: 'bg-blue-500', label: '보통', text: 'text-blue-400' },
  low: { dot: 'bg-slate-400', label: '낮음', text: 'text-slate-400' },
};

function formatDateTime(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground mb-1">{label}</p>
      <p className="text-sm whitespace-pre-wrap break-words">{value}</p>
    </div>
  );
}

/**
 * 업무 상세 read 뷰 본문. `WorkItemDetailPage` (`/work-items/:id`) 에서 사용.
 * 헤더(배지·수정 버튼)는 호출 측이 그림.
 */
export function WorkItemReadView({ item }: WorkItemReadViewProps) {
  const images = loadWorkItemImages(item.id);
  const isCompleted = !!item.closedAt;
  const pStyle = PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.medium;
  const moduleCfg = item.module ? MODULE_CONFIG[item.module] : null;
  const typeCfg = item.typeLabel ? TYPE_LABEL_CONFIG[item.typeLabel] : null;
  const kanbanLabel = KANBAN_STATUS_LABEL[item.kanbanStatus ?? 'todo'];
  const { data: cfRaw } = useWorkItemCustomFields();
  const cv = (item.customValues ?? {}) as Record<string, unknown>;
  const filledCustomFields = sortedWorkItemFields(cfRaw).filter(
    (f) => cv[f.key] !== undefined && cv[f.key] !== '' && cv[f.key] !== null,
  );
  const fmtCustom = (v: unknown) => (typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v));
  // 제목 — 미설정 시 내용 앞부분으로 폴백.
  const displayTitle = item.title?.trim() || stripHtml(item.content).slice(0, 80) || '(제목 없음)';
  const period = [formatDateTime(item.startedAt), formatDateTime(item.closedAt)].filter(Boolean).join(' ~ ');

  return (
    <div className="space-y-4">
      {/* 옵션 정보 — 한 줄 압축 (상태·우선순위·분류·모듈/타입 + 담당자·클러스터·기간·공수) */}
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs">
        <span className={`flex items-center gap-1 font-medium px-2 py-0.5 rounded-full border ${
          isCompleted
            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
            : 'bg-amber-500/10 text-amber-500 border-amber-500/30'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isCompleted ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {kanbanLabel}
        </span>
        <span className={`flex items-center gap-1 font-medium ${pStyle.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${pStyle.dot}`} />
          {pStyle.label}
        </span>
        <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
          {item.category}
        </span>
        {moduleCfg && (
          <span className={`px-2 py-0.5 rounded-full border font-medium ${moduleCfg.cls}`}>{moduleCfg.label}</span>
        )}
        {typeCfg && (
          <span className={`px-2 py-0.5 rounded-full ${typeCfg.cls}`}>{typeCfg.label}</span>
        )}
        {item.allAttendees && (
          <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/30 font-medium">
            👥 전체 참석
          </span>
        )}
        <span className="inline-flex items-center gap-x-2 flex-wrap text-muted-foreground">
          {item.assignee && <span>👤 {item.assignee}</span>}
          {(item.clusterNames?.length ? item.clusterNames.join(', ') : item.clusterName) && (
            <span>· {item.clusterNames?.length ? item.clusterNames.join(', ') : item.clusterName}</span>
          )}
          {period && <span>· {period}</span>}
          {item.effortHours ? <span>· {item.effortHours}h</span> : null}
        </span>
      </div>

      {/* 업무 제목 */}
      <h1 className="text-xl font-bold tracking-tight leading-snug break-words">{displayTitle}</h1>

      {/* 업무 내용 */}
      <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
        <RichContent content={item.content} />
      </div>

      {item.resolution && (
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">업무 결과</p>
          <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
            <RichContent content={item.resolution} />
          </div>
        </div>
      )}

      {item.doneCondition && (
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">완료 조건</p>
          <p className="text-sm text-foreground/80 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2">
            ✓ {item.doneCondition}
          </p>
        </div>
      )}

      <Field label="비고" value={item.remarks} />

      {item.confluenceUrl && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Confluence 링크</p>
          <a
            href={item.confluenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline break-all"
          >
            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate max-w-md">{item.confluenceUrl}</span>
          </a>
        </div>
      )}

      {images.length > 0 && (
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <ImagePlus className="w-3.5 h-3.5" />
            첨부 이미지 ({images.length}개)
          </p>
          <div className="grid grid-cols-3 gap-2">
            {images.map((src, idx) => (
              <img
                key={idx}
                src={src}
                alt={`첨부 이미지 ${idx + 1}`}
                className="w-full aspect-video object-cover rounded-lg border border-border cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => window.open(src, '_blank')}
              />
            ))}
          </div>
        </div>
      )}

      <div className="text-sm text-muted-foreground border-t border-border pt-3 flex gap-6">
        <span>등록: {item.createdAt?.slice(0, 10)}</span>
        {item.updatedAt !== item.createdAt && (
          <span>수정: {item.updatedAt?.slice(0, 10)}</span>
        )}
      </div>

      {filledCustomFields.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-sm font-medium text-muted-foreground mb-2">사용자 정의 필드</p>
          <div className="grid grid-cols-2 gap-3">
            {filledCustomFields.map((f) => (
              <Field key={f.id} label={f.label} value={fmtCustom(cv[f.key])} />
            ))}
          </div>
        </div>
      )}

      <ActivityTimeline workItemId={item.id} />

      <CommentThread workItemId={item.id} />
    </div>
  );
}
