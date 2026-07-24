// frontend/src/components/batch-jobs/BatchJobClusterGroup.tsx
// "전체" 모드에서 배치잡을 클러스터 단위 섹션으로 묶어 보여주는 collapsible 그룹.
// 클러스터가 많아질수록 단일 flat 테이블보다 어느 클러스터에 무엇이 등록됐는지
// 한눈에 파악하기 쉽다 — 섹션 헤더에 클러스터명/등급 + 잡 통계, 본문은 기존
// BatchJobTable(클러스터 컬럼 없이) + 미등록 타입 칩.
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { BatchJob, BatchJobTypeDescriptor } from '@/services/api';
import type { Cluster } from '@/types';
import { BatchJobTable } from './BatchJobTable';
import { UnregisteredTypeChips } from './UnregisteredTypeChips';
import { FAILED_STATUSES, type SortState } from './types';

const LEVEL_LABEL: Record<string, string> = {
  prod: 'PROD',
  production: 'PROD',
  dr: 'DR',
  staging: 'STG',
  dev: 'DEV',
  development: 'DEV',
};

interface BatchJobClusterGroupProps {
  cluster: Cluster;
  /** 이 클러스터에 속하며 이미 상태필터/검색이 적용된 잡 목록 (표에 표시). */
  jobs: BatchJob[];
  /** 상태필터/검색 적용 전, 이 클러스터에 등록된 전체 잡 — 미등록 타입 판정용
      (필터로 화면에서 가려진 타입을 "미등록"으로 오판하지 않기 위함). */
  allClusterJobs: BatchJob[];
  allTypes: BatchJobTypeDescriptor[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedJobId: string | null;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  onSelectJob: (job: BatchJob) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onCreateForType: (jobType: string) => void;
}

export function BatchJobClusterGroup({
  cluster, jobs, allClusterJobs, allTypes, collapsed, onToggleCollapsed,
  selectedJobId, sort, onSortChange, onSelectJob,
  selectedIds, onToggleSelect, onToggleAll, onCreateForType,
}: BatchJobClusterGroupProps) {
  // 통계는 필터와 무관하게 클러스터의 실제 상태를 반영 (원래 단일 클러스터 모드와 동일 기준).
  const failed = allClusterJobs.filter((j) => FAILED_STATUSES.has(j.lastStatus)).length;
  const running = allClusterJobs.filter((j) => j.lastStatus === 'running').length;
  const level = cluster.operationLevel ? LEVEL_LABEL[cluster.operationLevel.toLowerCase()] : undefined;
  const filtered = jobs.length !== allClusterJobs.length;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="w-full px-3 py-2 flex items-center gap-2 bg-secondary/40 hover:bg-secondary/60 transition-colors text-left"
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <span className="font-semibold text-sm truncate">{cluster.name}</span>
        {cluster.region && <span className="text-xs text-muted-foreground">· {cluster.region}</span>}
        {level && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
            {level}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
          <span>잡 {allClusterJobs.length}{filtered ? ` (${jobs.length}건 표시)` : ''}</span>
          {failed > 0 && <span className="text-red-500 font-medium">실패 {failed}</span>}
          {running > 0 && <span className="text-blue-500 font-medium">실행 중 {running}</span>}
        </span>
      </button>
      {!collapsed && (
        <div className="p-3 space-y-3">
          <BatchJobTable
            jobs={jobs}
            selectedJobId={selectedJobId}
            sort={sort}
            onSortChange={onSortChange}
            onSelectJob={onSelectJob}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onToggleAll={onToggleAll}
            emptyMessage="필터에 일치하는 잡이 없습니다."
          />
          <UnregisteredTypeChips clusterJobs={allClusterJobs} allTypes={allTypes} onPick={onCreateForType} />
        </div>
      )}
    </div>
  );
}
