import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentApi, promqlApi } from '@/services/api';
import { useSummary, useAddons } from './useCluster';
import { Server } from 'lucide-react';
import { statusToVariant, type StatusVariant } from '@/components/common/StatusBadge';
import {
  PEP_NODES, PEP_EDGES, PEP_DIAGRAM_WIDTH, PEP_DIAGRAM_HEIGHT, type PepNodeId,
} from '@/components/architecture/pepArchitecture';
import type { FlowNodeDef, FlowEdgeDef } from '@/components/architecture/flowTypes';

export function useAgentHealthProbe() {
  return useQuery({
    queryKey: ['architecture', 'agentHealth'],
    queryFn: async () => (await agentApi.health()).data,
    refetchInterval: 60000,
    retry: false,
  });
}

export function usePrometheusHealthProbe() {
  return useQuery({
    queryKey: ['architecture', 'prometheusHealth'],
    queryFn: async () => (await promqlApi.health()).data,
    refetchInterval: 60000,
    retry: false,
  });
}

interface NodeState {
  status: StatusVariant;
  sublabel?: string;
  muted?: boolean;
  tooltip?: string;
}

const NO_LIVE_SIGNAL: NodeState = {
  status: 'neutral',
  muted: true,
  tooltip: '라이브 상태 확인 API 없음 — 구조만 표시',
};

/** PEP 자체 서비스 모듈(프론트/백엔드/DB/큐/외부 연동)의 실시간 헬스 상태를 흐름도 노드/엣지로 매핑 */
export function usePepArchitectureGraph() {
  const summary = useSummary();
  const agentHealth = useAgentHealthProbe();
  const promHealth = usePrometheusHealthProbe();

  const backendState: NodeState = summary.isError
    ? { status: 'critical', tooltip: 'API 응답 없음' }
    : summary.isSuccess
      ? { status: 'healthy', tooltip: '정상 응답' }
      : { status: 'info', tooltip: '확인 중' };

  const k8sState: NodeState = useMemo(() => {
    if (summary.isError) return { status: 'critical', tooltip: 'API 응답 없음' };
    if (!summary.data) return { status: 'info', tooltip: '확인 중' };
    const { healthy, warning, critical, totalClusters } = summary.data;
    if (totalClusters === 0) return { status: 'neutral', sublabel: '등록된 클러스터 없음' };
    const status: StatusVariant = critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy';
    return { status, sublabel: `정상 ${healthy} · 경고 ${warning} · 위험 ${critical}` };
  }, [summary.data, summary.isError]);

  const ollamaState: NodeState = agentHealth.isError
    ? { status: 'warning', tooltip: 'AI 기능 오프라인 (선택 기능)' }
    : agentHealth.data
      ? agentHealth.data.status === 'online'
        ? { status: 'healthy' }
        : { status: 'warning', tooltip: agentHealth.data.detail ?? '오프라인 (선택 기능)' }
      : { status: 'info', tooltip: '확인 중' };

  const promState: NodeState = promHealth.isError
    ? { status: 'warning', tooltip: 'Prometheus 오프라인 (선택 기능)' }
    : promHealth.data
      ? promHealth.data.status === 'online'
        ? { status: 'healthy' }
        : { status: 'warning', tooltip: promHealth.data.detail ?? '오프라인 (선택 기능)' }
      : { status: 'info', tooltip: '확인 중' };

  const stateById: Record<PepNodeId, NodeState> = {
    frontend: { status: 'healthy', tooltip: '현재 세션이 렌더링 중 — 항상 정상' },
    backend: backendState,
    // /health/summary 조회 자체가 DB 를 거치므로 backend 와 동일 신호를 공유
    postgres: backendState,
    redis: NO_LIVE_SIGNAL,
    celeryBeat: NO_LIVE_SIGNAL,
    celeryWorker: NO_LIVE_SIGNAL,
    k8s: k8sState,
    ollama: ollamaState,
    prometheus: promState,
  };

  const nodes: FlowNodeDef[] = PEP_NODES.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    label: n.label,
    icon: n.icon,
    ...stateById[n.id],
  }));

  const edges: FlowEdgeDef[] = PEP_EDGES.map((e) => {
    const target = stateById[e.to];
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      fromSide: e.fromSide,
      toSide: e.toSide,
      status: target.status,
      muted: target.muted,
    };
  });

  return {
    nodes,
    edges,
    width: PEP_DIAGRAM_WIDTH,
    height: PEP_DIAGRAM_HEIGHT,
    isLoading: summary.isLoading,
  };
}

const ADDON_HUB_ID = '__cluster__';
const ADDON_HUB_W = 220;
const ADDON_HUB_H = 90;
const ADDON_NODE_W = 260;
const ADDON_NODE_H = 62;
const ADDON_ROW_GAP = 84;
const ADDON_DIAGRAM_WIDTH = 700;

/** 선택된 클러스터의 애드온을 hub(클러스터) → spoke(애드온) 흐름도로 매핑 */
export function useClusterAddonGraph(clusterId: string, clusterName: string, clusterStatus: StatusVariant) {
  const addonsQuery = useAddons(clusterId);
  const addons = useMemo(() => addonsQuery.data ?? [], [addonsQuery.data]);

  const height = Math.max(320, 40 + addons.length * ADDON_ROW_GAP);

  const nodes: FlowNodeDef[] = useMemo(() => {
    const hub: FlowNodeDef = {
      id: ADDON_HUB_ID,
      x: 20,
      y: height / 2 - ADDON_HUB_H / 2,
      w: ADDON_HUB_W,
      h: ADDON_HUB_H,
      label: clusterName || '클러스터',
      sublabel: `애드온 ${addons.length}개`,
      icon: Server,
      status: clusterStatus,
    };
    const spokes: FlowNodeDef[] = addons.map((a, i) => ({
      id: a.id,
      x: 400,
      y: 20 + i * ADDON_ROW_GAP,
      w: ADDON_NODE_W,
      h: ADDON_NODE_H,
      label: a.name,
      sublabel: a.type,
      emoji: a.icon,
      status: statusToVariant(a.status),
      tooltip: a.responseTime != null ? `응답시간 ${a.responseTime}ms` : undefined,
    }));
    return [hub, ...spokes];
  }, [addons, clusterName, clusterStatus, height]);

  const edges: FlowEdgeDef[] = useMemo(
    () => addons.map((a) => ({
      id: `hub-${a.id}`,
      from: ADDON_HUB_ID,
      to: a.id,
      status: statusToVariant(a.status),
    })),
    [addons],
  );

  return {
    nodes,
    edges,
    width: ADDON_DIAGRAM_WIDTH,
    height,
    isLoading: addonsQuery.isLoading,
    addons,
  };
}
