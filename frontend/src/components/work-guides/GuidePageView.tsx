import {
  Plus, Pencil, Trash2, GitFork,
  ChevronRight, FileText, CheckCircle, Archive, FileText as FileTextIcon, ExternalLink,
} from 'lucide-react';
import { RichContent } from '@/components/editor';
import { ReactionBar } from '@/components/common';
import type { WorkGuide } from '@/types';

const STATUS_CFG: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  draft:    { label: '초안', icon: <FileTextIcon className="w-3 h-3" />, cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  active:   { label: '활성', icon: <CheckCircle className="w-3 h-3" />,  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  archived: { label: '보관', icon: <Archive className="w-3 h-3" />,      cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30' },
};

const PRIORITY_DOT: Record<string, { dot: string; cls: string; label: string }> = {
  high:   { dot: 'bg-red-400',   cls: 'text-red-400',   label: '높음' },
  medium: { dot: 'bg-blue-400',  cls: 'text-blue-400',  label: '보통' },
  low:    { dot: 'bg-slate-400', cls: 'text-slate-400', label: '낮음' },
};

function Breadcrumb({ guide, allGuides, onSelect }: { guide: WorkGuide; allGuides: WorkGuide[]; onSelect: (id: string) => void }) {
  const ancestors: WorkGuide[] = [];
  let cur: WorkGuide | undefined = guide;
  while (cur?.parentId) {
    const parent = allGuides.find((g) => g.id === cur!.parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    cur = parent;
  }
  if (ancestors.length === 0) return null;
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground mb-4 flex-wrap">
      {ancestors.map((a) => (
        <span key={a.id} className="flex items-center gap-1">
          <button onClick={() => onSelect(a.id)} className="hover:text-primary transition-colors truncate max-w-[140px]">
            {a.title}
          </button>
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
        </span>
      ))}
      <span className="text-foreground font-medium truncate max-w-[200px]">{guide.title}</span>
    </div>
  );
}

interface GuidePageViewProps {
  guide: WorkGuide;
  allGuides: WorkGuide[];
  onSelect: (id: string) => void;
  onEdit: () => void;
  onAddChild: () => void;
  onAddToWorkflow: () => void;
  onDelete: () => void;
}

export function GuidePageView({ guide, allGuides, onSelect, onEdit, onAddChild, onAddToWorkflow, onDelete }: GuidePageViewProps) {
  const sc = STATUS_CFG[guide.status] ?? STATUS_CFG.draft;
  const pc = PRIORITY_DOT[guide.priority] ?? PRIORITY_DOT.medium;
  const tagList = guide.tags ? guide.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const childPages = allGuides.filter((g) => g.parentId === guide.id);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-10 py-8">
        <Breadcrumb guide={guide} allGuides={allGuides} onSelect={onSelect} />

        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight mb-3">{guide.title}</h1>
            <div className="flex items-center gap-2 flex-wrap text-sm">
              {guide.category && (
                <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  {guide.category}
                </span>
              )}
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${sc.cls}`}>
                {sc.icon}{sc.label}
              </span>
              <span className={`font-medium ${pc.cls}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${pc.dot} mr-1`} />
                {pc.label}
              </span>
              {guide.author && <span className="text-muted-foreground">✍ {guide.author}</span>}
              {guide.confluenceUrl && (
                <a
                  href={guide.confluenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-semibold transition-colors"
                  title={guide.confluenceUrl}
                >
                  <ExternalLink className="w-2.5 h-2.5" /> Confluence
                </a>
              )}
              <span className="text-muted-foreground">{guide.updatedAt?.slice(0, 10)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={onAddToWorkflow}
              className="p-2 rounded-lg hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
              title="워크플로에 추가">
              <GitFork className="w-4 h-4" />
            </button>
            <button onClick={onAddChild}
              className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title="하위 페이지 추가">
              <Plus className="w-4 h-4" />
            </button>
            <button onClick={onEdit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              title="수정">
              <Pencil className="w-3.5 h-3.5" /> 수정
            </button>
            <button onClick={onDelete}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10 border border-border rounded-lg transition-colors"
              title="삭제">
              <Trash2 className="w-3.5 h-3.5" /> 삭제
            </button>
          </div>
        </div>

        {tagList.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-5">
            {tagList.map((t) => (
              <span key={t} className="text-sm px-2 py-0.5 rounded bg-secondary text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}

        <div className="min-h-[120px]">
          <RichContent content={guide.content ?? ''} />
        </div>

        {/* 공감(이모지 리액션) */}
        <div className="mt-6 pt-4 border-t border-border flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">공감</span>
          <ReactionBar targetType="work_guide" targetId={guide.id} />
        </div>

        {childPages.length > 0 && (
          <div className="mt-10 pt-6 border-t border-border">
            <h2 className="text-sm font-semibold text-muted-foreground mb-3">하위 페이지 ({childPages.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {childPages.map((child) => {
                const csc = STATUS_CFG[child.status] ?? STATUS_CFG.draft;
                return (
                  <button key={child.id} onClick={() => onSelect(child.id)}
                    className="flex items-center gap-2 p-3 bg-secondary/40 hover:bg-secondary rounded-lg text-left transition-colors group">
                    <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 text-sm font-medium group-hover:text-primary transition-colors truncate">
                      {child.title}
                    </span>
                    <span className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full border flex-shrink-0 ${csc.cls}`}>
                      {csc.icon}{csc.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
