import type { ComponentType } from 'react';
import { Pin, History, ExternalLink, Ship, KeyRound, Bug, Hammer, RefreshCw, Package, Layers, PenLine } from 'lucide-react';
import { RichContent } from '@/components/editor';
import { ReactionBar } from '@/components/common';
import type { OpsNote } from '@/types';
import { formatRelativeTime } from '@/lib/utils';

// 서비스 배지 — OpsNotesPage 의 서비스 메타와 같은 lucide 아이콘·chart 토큰(D-126/§12.12-7).
const SERVICES: { value: string; label: string; Icon: ComponentType<{ className?: string }>; soft: string }[] = [
  { value: 'k8s',      label: 'Kubernetes', Icon: Ship,      soft: 'bg-chart-1/15 text-chart-1-text' },
  { value: 'keycloak', label: 'Keycloak',   Icon: KeyRound,  soft: 'bg-chart-7/15 text-chart-7-text' },
  { value: 'cilium',   label: 'Cilium',     Icon: Bug,       soft: 'bg-chart-3/15 text-chart-3-text' },
  { value: 'jenkins',  label: 'Jenkins',    Icon: Hammer,    soft: 'bg-chart-6/15 text-chart-6-text' },
  { value: 'argocd',   label: 'ArgoCD',     Icon: RefreshCw, soft: 'bg-chart-4/15 text-chart-4-text' },
  { value: 'nexus',    label: 'Nexus',      Icon: Package,   soft: 'bg-chart-2/15 text-chart-2-text' },
  { value: 'etc',      label: '기타',        Icon: Layers,    soft: 'bg-chart-8/15 text-chart-8-text' },
];
const SERVICE_MAP = Object.fromEntries(SERVICES.map((s) => [s.value, s]));

interface OpsNoteReadViewProps {
  note: OpsNote;
}

export function OpsNoteReadView({ note }: OpsNoteReadViewProps) {
  const svc = SERVICE_MAP[note.service];
  const hasAnswer = Boolean(note.content?.trim());
  const hasHistory = Boolean(note.backContent?.trim());

  return (
    <div className="space-y-5">
      {/* 메타 정보 */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-md ${svc?.soft ?? 'bg-secondary text-muted-foreground'}`}>
          {svc && <svc.Icon className="w-3 h-3" />} {svc?.label ?? note.service}
        </span>
        {note.pinned && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/15 text-primary font-semibold">
            <Pin className="w-3 h-3" /> 고정
          </span>
        )}
        {note.author && <span className="inline-flex items-center gap-1 text-muted-foreground"><PenLine className="w-3 h-3" aria-hidden />{note.author}</span>}
        {note.confluenceUrl && (
          <a
            href={note.confluenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-semibold"
            title={note.confluenceUrl}
          >
            <ExternalLink className="w-3 h-3" /> Confluence
          </a>
        )}
        {note.dlUrl && (
          <a
            href={note.dlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-semibold"
            title={note.dlUrl}
          >
            <ExternalLink className="w-3 h-3" /> DL
          </a>
        )}
        <span className="text-muted-foreground ml-auto">
          {formatRelativeTime(note.updatedAt)}
        </span>
      </div>

      {/* 질문 */}
      <div>
        <div className="flex items-start gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-primary text-primary-foreground text-sm font-bold flex-shrink-0">
            Q
          </span>
          <h1 className="text-xl font-semibold leading-snug">{note.title}</h1>
        </div>
      </div>

      {/* 답변 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-secondary text-foreground text-sm font-bold flex-shrink-0">
            A
          </span>
          <span className="text-sm font-semibold text-foreground">답변 / 핵심 요약</span>
        </div>
        <div className="bg-secondary/30 rounded-lg px-4 py-3">
          {hasAnswer
            ? <RichContent content={note.content!} />
            : <span className="italic text-sm opacity-60">답변이 아직 없습니다.</span>}
        </div>
      </div>

      {/* 히스토리 */}
      {hasHistory && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">상세 / 히스토리</span>
          </div>
          <div className="bg-secondary/30 rounded-lg px-4 py-3">
            <RichContent content={note.backContent!} />
          </div>
        </div>
      )}

      {/* 공감(이모지 리액션) */}
      <div className="border-t border-border pt-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">공감</span>
        <ReactionBar targetType="ops_note" targetId={note.id} />
      </div>

      <div className="text-sm text-muted-foreground flex gap-6">
        <span>등록: {note.createdAt?.slice(0, 10)}</span>
        {note.updatedAt !== note.createdAt && (
          <span>수정: {note.updatedAt?.slice(0, 10)}</span>
        )}
      </div>
    </div>
  );
}
