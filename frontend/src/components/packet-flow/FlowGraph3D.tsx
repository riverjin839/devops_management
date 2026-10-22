import { useCallback, useEffect, useMemo, useRef } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import type { TopologyTraceHopV2, HopVerdict } from '@/types';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';
import { escapeHtml } from '@/lib/html';

interface Props {
  hops: TopologyTraceHopV2[];
  onSelectHop: (idx: number | null) => void;
  selectedIndex: number | null;
  width: number;
  height: number;
}

// ── 엔티티 타입 → 색 토큰 ──────────────────────────────────────────────────
// three.js 는 CSS var() 를 못 읽으므로 토큰명을 들고 있다가 cssVarColor 로 현재 테마 값을 읽는다(R-1).
// 종류 구분은 --chart-1..8, 오류만 상태 토큰(DESIGN_SYSTEM §12.12-7).
const ENTITY_TOKEN: Record<string, { token: string; lighten?: number }> = {
  external:           { token: '--chart-1' },
  dns:                { token: '--chart-6' },
  ingress_controller: { token: '--chart-4' },
  ingress:            { token: '--chart-4', lighten: 12 },
  service:            { token: '--chart-2' },
  pod:                { token: '--chart-3' },
  node:               { token: '--chart-7' },
  switch:             { token: '--chart-5' },
  error:              { token: '--status-critical' },
};
const ENTITY_FALLBACK = { token: '--chart-8' };

const ENTITY_SIZE: Record<string, number> = {
  external: 12,
  dns: 8,
  ingress_controller: 10,
  ingress: 9,
  service: 10,
  pod: 11,
  node: 10,
  switch: 11,
  error: 8,
};

// 정상(allow)·정보(info)는 무채색, 비정상만 상태색(DESIGN_SYSTEM §12.12-3) — 둘은 투명도로 구분한다.
const VERDICT_LINK: Record<HopVerdict, { token: string; alpha: number }> = {
  allow: { token: '--muted-foreground', alpha: 0.7 },
  deny:  { token: '--status-critical', alpha: 0.85 },
  warn:  { token: '--status-warning', alpha: 0.85 },
  info:  { token: '--muted-foreground', alpha: 0.4 },
};
/** 툴팁(DOM)용 — var() 를 그대로 쓴다. */
const VERDICT_TEXT: Record<HopVerdict, string> = {
  allow: 'hsl(var(--muted-foreground))',
  deny:  'hsl(var(--status-critical))',
  warn:  'hsl(var(--status-warning))',
  info:  'hsl(var(--muted-foreground))',
};

interface FlowColors {
  entity: Record<string, string>;
  entityFallback: string;
  link: Record<HopVerdict, string>;
}

function flowColors(): FlowColors {
  const entity: Record<string, string> = Object.fromEntries(
    Object.entries(ENTITY_TOKEN).map(([k, t]) => [k, cssVarColor(t.token, { lighten: t.lighten })]),
  );
  const link = Object.fromEntries(
    (Object.entries(VERDICT_LINK) as Array<[HopVerdict, { token: string; alpha: number }]>)
      .map(([k, v]) => [k, cssVarColor(v.token, { alpha: v.alpha })]),
  ) as Record<HopVerdict, string>;
  return { entity, entityFallback: cssVarColor(ENTITY_FALLBACK.token), link };
}

/** 툴팁 HTML 에 넣는 서버 값(홉 이름·인터페이스) 이스케이프. */
interface GNode extends NodeObject {
  id: string;
  label: string;
  entityType: string;
  hopIndex: number;
}
interface GLink extends LinkObject {
  source: string;
  target: string;
  verdict: HopVerdict;
}

function makeNodeMesh(node: NodeObject, selectedIdx: number | null, colors: FlowColors): THREE.Mesh {
  const n = node as GNode;
  const size = ENTITY_SIZE[n.entityType] ?? 8;
  const color = colors.entity[n.entityType] ?? colors.entityFallback;
  const geo = new THREE.SphereGeometry(size, 20, 20);
  const mat = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity: selectedIdx !== null && n.hopIndex !== selectedIdx ? 0.45 : 0.95,
    emissive: selectedIdx === n.hopIndex ? color : 0x000000,
    emissiveIntensity: selectedIdx === n.hopIndex ? 0.4 : 0,
  });
  return new THREE.Mesh(geo, mat);
}

export function FlowGraph3D({ hops, onSelectHop, selectedIndex, width, height }: Props) {
  const graphRef = useRef<ForceGraph3DInstance>();
  // 테마·강조색이 바뀌면 색을 다시 읽고, 아래 접근자(useCallback)가 새로 만들어져 다시 칠해진다.
  const themeKey = useThemeColorKey();
  const colors = useMemo(() => { void themeKey; return flowColors(); }, [themeKey]);

  const graphData = useMemo(() => {
    // 각 hop = 노드. 인접 hop 간에 verdict 기반 edge 생성.
    const nodes: GNode[] = hops.map((h, idx) => ({
      id: `${idx}:${h.entityId}`,
      label: h.name,
      entityType: h.entityType,
      hopIndex: idx,
    }));
    const links: GLink[] = [];
    for (let i = 0; i < hops.length - 1; i++) {
      const curr = hops[i];
      const next = hops[i + 1];
      // next 홉의 verdict 를 edge 색상으로
      links.push({
        source: `${i}:${curr.entityId}`,
        target: `${i + 1}:${next.entityId}`,
        verdict: next.verdict,
      });
    }
    return { nodes, links };
  }, [hops]);

  // 초기 카메라를 왼쪽→오른쪽 플로우처럼 보이게
  useEffect(() => {
    if (!graphRef.current) return;
    graphRef.current.cameraPosition({ x: 0, y: 0, z: 220 }, { x: 0, y: 0, z: 0 }, 600);
  }, [hops.length]);

  const handleNodeClick = useCallback((n: NodeObject) => {
    onSelectHop((n as GNode).hopIndex);
    if (graphRef.current && n.x !== undefined) {
      graphRef.current.cameraPosition(
        { x: n.x! + 30, y: n.y! + 20, z: n.z! + 70 },
        { x: n.x!, y: n.y!, z: n.z! },
        700,
      );
    }
  }, [onSelectHop]);

  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    const hop = hops[node.hopIndex];
    // three-render-objects 가 문자열을 DOM 툴팁에 넣으므로 var() 토큰이 그대로 풀린다.
    return `<div style="background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));padding:6px 10px;border-radius:var(--radius);font-size:12px;font-family:ui-monospace,monospace">
      <div style="font-weight:600">${escapeHtml(node.label)}</div>
      <div style="color:hsl(var(--muted-foreground))">${escapeHtml(hop?.entityType)}</div>
      ${hop?.interface ? `<div style="color:hsl(var(--muted-foreground))">${escapeHtml(hop.interface)}</div>` : ''}
      ${hop?.verdict && hop.verdict !== 'info' ? `<div style="color:${VERDICT_TEXT[hop.verdict]}">● ${escapeHtml(hop.verdict)}</div>` : ''}
    </div>`;
  }, [hops]);

  const linkColor = useCallback((l: LinkObject) => colors.link[(l as GLink).verdict] ?? colors.link.info, [colors]);

  // 선택·테마가 바뀌면 메시를 다시 만든다.
  const nodeThreeObject = useCallback((n: NodeObject) => makeNodeMesh(n, selectedIndex, colors), [selectedIndex, colors]);

  return (
    <ForceGraph3D
      ref={graphRef}
      graphData={graphData}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      nodeThreeObject={nodeThreeObject}
      nodeLabel={nodeLabel}
      linkColor={linkColor}
      linkWidth={2}
      linkDirectionalArrowLength={5}
      linkDirectionalArrowRelPos={1}
      linkDirectionalParticles={2}
      onNodeClick={handleNodeClick}
    />
  );
}
