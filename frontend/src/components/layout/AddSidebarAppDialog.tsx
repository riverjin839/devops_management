import { Check, Plus, LayoutGrid } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { SIDEBAR_APP_CATALOG } from './sidebarApps';

interface AddSidebarAppDialogProps {
  open: boolean;
  onClose: () => void;
  installedApps: string[];
  onToggle: (id: string) => void;
  isAdmin: boolean;
}

/**
 * 사이드바 "앱 추가" 온보딩 카탈로그 — 카드형으로 브라우징하며 켜고 끈다(SaaS 앱스토어 UX).
 * 순서는 설치한 순서 그대로 레일에 반영된다(재정렬은 아직 지원하지 않음 — 후속 과제).
 */
export function AddSidebarAppDialog({ open, onClose, installedApps, onToggle, isAdmin }: AddSidebarAppDialogProps) {
  const apps = SIDEBAR_APP_CATALOG.filter((a) => !a.adminOnly || isAdmin);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="flex-row items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <LayoutGrid className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>사이드바에 앱 추가</DialogTitle>
            <DialogDescription>필요한 기능만 골라 레일에 추가한다.</DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5 grid grid-cols-2 gap-2">
          {apps.map((app) => {
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
                <app.icon className="w-4.5 h-4.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
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
      </DialogContent>
    </Dialog>
  );
}
