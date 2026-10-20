import { useMemo, useState } from 'react';
import { FileCode2, Lock } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog, EmptyState, PageShell } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { ScriptListPanel, ScriptCreateForm, ScriptDetailPanel } from '@/components/scripts';
import { useScripts } from '@/hooks/useScripts';
import { formatApiError } from '@/lib/utils';
import type { ScriptKind } from '@/types';

/** 다음에 열 대상 — 미저장 편집본이 있으면 확인 후 이동한다(D-146). */
type PendingNav = { kind: 'select'; id: string } | { kind: 'create' };

/** 스크립트 라이브러리 — DB 저장·버전관리되는 Python/Ansible/Shell 실행 스크립트 (Phase 1).
 *  ClusterSidebar 미사용(스크립트는 클러스터 종속이 아님) — 설계 문서 §5.4. */
export function ScriptsPage() {
  const [kind, setKind] = useState<ScriptKind | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 상세 패널의 본문 편집이 저장되지 않았는지 — 다른 스크립트로 옮기기 전에 확인한다.
  const [detailDirty, setDetailDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<PendingNav | null>(null);

  const filter = useMemo(
    () => ({ kind: kind ?? undefined, q: search.trim() || undefined }),
    [kind, search],
  );
  const { data: scripts, isLoading, isError, error, refetch } = useScripts(filter);
  // 목록 조회부터 operator 이상(관리자 전용 설정 시 admin) — 403 은 빈 라이브러리가 아니라 권한 안내(D-138).
  const forbidden = isError && (error as { response?: { status?: number } } | null)?.response?.status === 403;

  const applyNav = (nav: PendingNav) => {
    setDetailDirty(false);
    if (nav.kind === 'select') {
      setSelectedId(nav.id);
      setCreating(false);
    } else {
      setCreating(true);
      setSelectedId(null);
    }
  };
  const requestNav = (nav: PendingNav) => {
    if (nav.kind === 'select' && nav.id === selectedId && !creating) return;
    if (detailDirty && selectedId && !creating) setPendingNav(nav);
    else applyNav(nav);
  };

  return (
    <PageShell density="hub" className="space-y-4">
      <PageHeader
        icon={FileCode2}
        title="스크립트 라이브러리"
        description="Python / Ansible Playbook / Shell 스크립트를 DB 에 저장·버전관리하고 화면에서 바로 편집·테스트 실행합니다."
      />

      {forbidden ? (
        <div role="alert">
          <EmptyState
            icon={Lock}
            title="스크립트 라이브러리를 볼 권한이 없습니다"
            description={`스크립트 라이브러리는 operator 이상(관리자 전용 설정 시 admin)만 볼 수 있습니다. 필요하면 관리자에게 권한을 요청하세요. (${formatApiError(error)})`}
          />
        </div>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* D-122: 제목 없이 패널 하나만 감싸던 카드에 제목을 달아 마스터·디테일 두 칸을 섹션으로 만든다 */}
        <MacCard
          title="스크립트 목록"
          titleExtra={scripts ? <span className="text-xs text-muted-foreground tabular-nums">{scripts.length}</span> : undefined}
          rootClassName="lg:col-span-3 min-w-0"
          bodyPadding="p-0"
          className="lg:h-[calc(100vh-260px)] overflow-hidden"
        >
          <ScriptListPanel
            scripts={scripts ?? []}
            isLoading={isLoading}
            error={isError && !scripts ? error : undefined}
            onRetry={() => void refetch()}
            selectedId={selectedId}
            onSelect={(id) => requestNav({ kind: 'select', id })}
            kind={kind}
            onKindChange={setKind}
            search={search}
            onSearchChange={setSearch}
            onCreateNew={() => requestNav({ kind: 'create' })}
          />
        </MacCard>

        <MacCard
          title={creating ? '새 스크립트' : '스크립트 상세'}
          rootClassName="lg:col-span-9 min-w-0"
          bodyPadding="p-0"
          className="lg:h-[calc(100vh-260px)] overflow-hidden"
        >
          {creating ? (
            <div className="h-full overflow-y-auto">
              <ScriptCreateForm
                onCreated={(id) => { setCreating(false); setSelectedId(id); }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : selectedId ? (
            <ScriptDetailPanel
              scriptId={selectedId}
              onDeleted={() => { setSelectedId(null); setDetailDirty(false); }}
              onDirtyChange={setDetailDirty}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                icon={FileCode2}
                title="선택된 스크립트가 없습니다."
                description="왼쪽 목록에서 스크립트를 고르거나 '새 스크립트'로 만드세요."
              />
            </div>
          )}
        </MacCard>
      </div>
      )}

      <ConfirmDialog
        open={!!pendingNav}
        title="저장하지 않은 편집본"
        description="지금 스크립트 본문에 저장하지 않은 변경이 있습니다. 다른 화면으로 옮기면 편집본은 버려집니다. 계속할까요?"
        confirmLabel="버리고 이동"
        cancelLabel="계속 편집"
        danger
        onConfirm={() => {
          if (pendingNav) applyNav(pendingNav);
          setPendingNav(null);
        }}
        onCancel={() => setPendingNav(null)}
      />
    </PageShell>
  );
}
