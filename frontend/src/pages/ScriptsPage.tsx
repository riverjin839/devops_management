import { useMemo, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { ScriptListPanel, ScriptCreateForm, ScriptDetailPanel } from '@/components/scripts';
import { useScripts } from '@/hooks/useScripts';
import type { ScriptKind } from '@/types';

/** 스크립트 라이브러리 — DB 저장·버전관리되는 Python/Ansible/Shell 실행 스크립트 (Phase 1).
 *  ClusterSidebar 미사용(스크립트는 클러스터 종속이 아님) — 설계 문서 §5.4. */
export function ScriptsPage() {
  const [kind, setKind] = useState<ScriptKind | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const filter = useMemo(
    () => ({ kind: kind ?? undefined, q: search.trim() || undefined }),
    [kind, search],
  );
  const { data: scripts, isLoading } = useScripts(filter);

  return (
    <main className="mx-auto p-5 space-y-4 max-w-[1400px]">
      <PageHeader
        icon={FileCode2}
        title="스크립트 라이브러리"
        description="Python / Ansible Playbook / Shell 스크립트를 DB 에 저장·버전관리하고 화면에서 바로 편집·테스트 실행합니다."
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <MacCard rootClassName="lg:col-span-3 min-w-0" bodyPadding="p-0" className="lg:h-[calc(100vh-220px)] overflow-hidden">
          <ScriptListPanel
            scripts={scripts ?? []}
            isLoading={isLoading}
            selectedId={selectedId}
            onSelect={(id) => { setSelectedId(id); setCreating(false); }}
            kind={kind}
            onKindChange={setKind}
            search={search}
            onSearchChange={setSearch}
            onCreateNew={() => { setCreating(true); setSelectedId(null); }}
          />
        </MacCard>

        <MacCard rootClassName="lg:col-span-9 min-w-0" bodyPadding="p-0" className="lg:h-[calc(100vh-220px)] overflow-hidden">
          {creating ? (
            <div className="h-full overflow-y-auto">
              <ScriptCreateForm
                onCreated={(id) => { setCreating(false); setSelectedId(id); }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : selectedId ? (
            <ScriptDetailPanel scriptId={selectedId} onDeleted={() => setSelectedId(null)} />
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
    </main>
  );
}
