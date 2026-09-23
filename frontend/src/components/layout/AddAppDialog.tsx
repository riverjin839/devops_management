import { Check, Plus, LayoutGrid, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { InstallableAppSection } from './installableApps';

interface AddAppDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  sections: InstallableAppSection[];
  installedApps: string[];
  onToggle: (id: string) => void;
}

/**
 * "앱 추가" 온보딩 카탈로그 — 카드형으로 브라우징하며 켜고 끈다(SaaS 앱스토어 UX).
 * Sidebar(플랫폼/시스템 도메인)와 AppTopBar(업무 도메인) 양쪽이 이 컴포넌트를 공유하고,
 * 각자의 섹션 목록(installableApps.ts 의 sidebarAppSections/topbarAppSections)만 다르게 넘긴다.
 * 설치 단위는 그룹이 아니라 leaf 페이지 하나하나라, 그룹 헤더로 섹션을 나눠 스캔하기 쉽게 한다.
 * 순서는 설치한 순서 그대로 레일/상단바에 반영된다(재정렬은 아직 지원하지 않음 — 후속 과제).
 */
export function AddAppDialog({ open, onClose, title, description, sections, installedApps, onToggle }: AddAppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="flex-row items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <LayoutGrid className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-4">
          {sections.map((section) => (
            <div
              key={section.label}
              className={section.tone === 'danger' ? 'rounded-xl border border-status-warning/40 bg-status-warning/5 p-2.5' : undefined}
            >
              <p className={`flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                section.tone === 'danger' ? 'text-status-warning' : 'text-muted-foreground'
              } ${section.description ? 'pb-0.5' : 'pb-1.5'}`}>
                {section.tone === 'danger' && <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
                {section.label}
              </p>
              {section.description && (
                <p className="px-0.5 pb-1.5 text-[11px] text-muted-foreground">{section.description}</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                {section.apps.map((app) => {
                  const installed = installedApps.includes(app.id);
                  return (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => onToggle(app.id)}
                      aria-pressed={installed}
                      className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                        installed
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border bg-card hover:border-primary/30 hover:bg-secondary/40'
                      }`}
                    >
                      <app.icon className={`w-4.5 h-4.5 mt-0.5 flex-shrink-0 ${app.iconColor || 'text-muted-foreground'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{app.label}</div>
                        {app.description && (
                          <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{app.description}</div>
                        )}
                      </div>
                      <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                        installed ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'
                      }`}>
                        {installed ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
