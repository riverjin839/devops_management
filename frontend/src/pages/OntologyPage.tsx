import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { AlertTriangle, Filter, Info, List, Loader2, Plus, RefreshCw, Search, Share2, X, Zap } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import {
  useOntologyGraph, useAnalyzeImpact, useCreateOntologyEntity, useCreateOntologyRelationship,
} from '@/hooks/useOntology';
import { useCanOperate, type CanOperate } from '@/hooks/useCanOperate';
import type { OntologyEntity, OntologyEntityType, OntologyImpactResponse } from '@/types';
import {
  PageHeader, LoadingState, EmptyState, ErrorState, SelectClusterEmptyState, RunLogPanel, ClusterSidebar, useToast,
} from '@/components/common';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';
import { escapeHtml } from '@/lib/html';
import { formatApiError } from '@/lib/utils';

// ── 엔티티 타입별 색상 (D-120: 차트 토큰) ─────────────────────────────────────
// three.js 재질·DOM 둘 다 쓰므로 토큰명을 들고 있다가 cssVarColor 로 현재 테마 값을 읽는다.
// 분류색이 8종이라 10종 중 2종은 같은 계열의 명도 변형(lighten)으로 구분한다.
const ENTITY_TOKEN: Record<OntologyEntityType, { token: string; lighten?: number }> = {
  node:              { token: '--chart-1' },              // blue
  hardware:          { token: '--chart-8' },              // slate
  os:                { token: '--chart-2' },              // teal
  kernel_param:      { token: '--chart-3' },              // amber
  network:           { token: '--chart-6' },              // cyan
  k8s_component:     { token: '--chart-4' },              // violet
  cilium_component:  { token: '--chart-6', lighten: 16 }, // 네트워크 계열 명도 변형
  workload:          { token: '--chart-7' },              // orange
  service:           { token: '--chart-5' },              // rose
  config_item:       { token: '--chart-3', lighten: 16 }, // 설정 계열 명도 변형
};

/** three.js 재질용 색 — 캔버스는 CSS 클래스를 못 쓰므로 현재 테마 값을 읽어 넘긴다. */
interface EntityColors { solid: string }

function entityColors(): Record<OntologyEntityType, EntityColors> {
  return Object.fromEntries(
    (Object.entries(ENTITY_TOKEN) as Array<[OntologyEntityType, { token: string; lighten?: number }]>).map(([t, { token, lighten }]) => [t, {
      solid: cssVarColor(token, { lighten }),
    }]),
  ) as Record<OntologyEntityType, EntityColors>;
}

/** DOM(칩·점·상세 패널) 색 — 같은 chart 번호의 Tailwind 토큰 클래스(테마를 바로 따른다, 인라인 style 금지).
 *  JIT 가 찾도록 리터럴로 적는다. 명도 변형 2종은 점 밝기(brightness)와 칩 점선 테두리로 구분한다. */
interface EntityClasses { dot: string; chipOn: string; chipEdge: string; accent: string }
const ENTITY_CLASS: Record<OntologyEntityType, EntityClasses> = {
  node:             { dot: 'bg-chart-1', chipOn: 'bg-chart-1/[0.13]', chipEdge: 'border-chart-1/40', accent: 'border-l-chart-1' },
  hardware:         { dot: 'bg-chart-8', chipOn: 'bg-chart-8/[0.13]', chipEdge: 'border-chart-8/40', accent: 'border-l-chart-8' },
  os:               { dot: 'bg-chart-2', chipOn: 'bg-chart-2/[0.13]', chipEdge: 'border-chart-2/40', accent: 'border-l-chart-2' },
  kernel_param:     { dot: 'bg-chart-3', chipOn: 'bg-chart-3/[0.13]', chipEdge: 'border-chart-3/40', accent: 'border-l-chart-3' },
  network:          { dot: 'bg-chart-6', chipOn: 'bg-chart-6/[0.13]', chipEdge: 'border-chart-6/40', accent: 'border-l-chart-6' },
  k8s_component:    { dot: 'bg-chart-4', chipOn: 'bg-chart-4/[0.13]', chipEdge: 'border-chart-4/40', accent: 'border-l-chart-4' },
  cilium_component: { dot: 'bg-chart-6 brightness-125', chipOn: 'bg-chart-6/[0.08]', chipEdge: 'border-chart-6/40 border-dashed', accent: 'border-l-chart-6' },
  workload:         { dot: 'bg-chart-7', chipOn: 'bg-chart-7/[0.13]', chipEdge: 'border-chart-7/40', accent: 'border-l-chart-7' },
  service:          { dot: 'bg-chart-5', chipOn: 'bg-chart-5/[0.13]', chipEdge: 'border-chart-5/40', accent: 'border-l-chart-5' },
  config_item:      { dot: 'bg-chart-3 brightness-125', chipOn: 'bg-chart-3/[0.08]', chipEdge: 'border-chart-3/40 border-dashed', accent: 'border-l-chart-3' },
};

function entityClass(t: OntologyEntityType | string | undefined): EntityClasses {
  return ENTITY_CLASS[t as OntologyEntityType] ?? ENTITY_CLASS.hardware;
}

// §12.12-11 — 화면 용어는 한국어 표준어(고유명 OS·K8s·Cilium 은 그대로).
const ENTITY_LABEL: Record<OntologyEntityType, string> = {
  node:              '노드',
  hardware:          '하드웨어',
  os:                'OS',
  kernel_param:      '커널 파라미터',
  network:           '네트워크',
  k8s_component:     'K8s 구성요소',
  cilium_component:  'Cilium',
  workload:          '워크로드',
  service:           '서비스',
  config_item:       '설정 항목',
};

function entityLabel(t: OntologyEntityType | string): string {
  return ENTITY_LABEL[t as OntologyEntityType] ?? t;
}

/** 관계 타입 — 서버 영향 가중치(`ontology_service.RELATION_WEIGHTS`)가 아는 값. 그 외 값은 원문 그대로 보인다. */
const RELATION_LABEL: Record<string, string> = {
  runs:         '실행',
  depends_on:   '의존',
  uses_config:  '설정 사용',
  connected_to: '연결',
  hosts:        '호스팅',
};
const RELATION_TYPES = Object.keys(RELATION_LABEL);

function relationLabel(t: string): string {
  return RELATION_LABEL[t] ?? t;
}

const ALL_TYPES = Object.keys(ENTITY_TOKEN) as OntologyEntityType[];

/** 영향 분석 대상 — 설정이 바뀔 수 있는 엔티티(상세 패널·목록 동일 기준). */
function isImpactTarget(t: OntologyEntityType): boolean {
  return t === 'config_item' || t === 'kernel_param';
}
const IMPACT_TARGET_HINT = '설정 항목·커널 파라미터만 영향 분석을 할 수 있습니다';

const IMPACT_MAX_DEPTH = 4;
const LOG_ITEM_CAP = 200;
const VIEW_KEY = 'ontology-view';

type ViewMode = 'graph' | 'list';

function loadViewMode(): ViewMode {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'graph'; } catch { return 'graph'; }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/** 영향 분석 응답 → 실행 로그 줄(영향 엔티티·경로는 한 건당 한 줄, 200건 초과분은 "외 N건"). */
function impactLines(r: OntologyImpactResponse): RunLogEntry[] {
  const out: RunLogEntry[] = [[
    'info',
    `분석 완료 — 영향 반경 점수 ${pct(r.blastRadiusScore)} · 영향 엔티티 ${r.impactedEntities.length} · 영향 경로 ${r.impactPaths.length} · 최대 깊이 ${IMPACT_MAX_DEPTH} · 기록 ${r.eventId.slice(0, 8)}`,
  ]];
  if (r.impactedEntities.length === 0) out.push(['info', '영향 받는 엔티티 없음']);
  for (const e of r.impactedEntities.slice(0, LOG_ITEM_CAP)) {
    out.push(['info', `영향 엔티티 — ${e.name} (${entityLabel(e.entityType)})`]);
  }
  if (r.impactedEntities.length > LOG_ITEM_CAP) out.push(['info', `영향 엔티티 외 ${r.impactedEntities.length - LOG_ITEM_CAP}건`]);
  r.impactPaths.slice(0, LOG_ITEM_CAP).forEach((p, i) => {
    out.push(['info', `경로 ${i + 1} · ${pct(p.score)} · 깊이 ${Math.max(p.pathNames.length - 1, 0)} — ${p.pathNames.join(' → ')}`]);
  });
  if (r.impactPaths.length > LOG_ITEM_CAP) out.push(['info', `경로 외 ${r.impactPaths.length - LOG_ITEM_CAP}건`]);
  return out;
}

// ── 그래프 노드/링크 타입 ──────────────────────────────────────────────────────
interface GNode extends NodeObject {
  id: string;
  name: string;
  entityType: OntologyEntityType;
  version?: string;
  properties: Record<string, unknown>;
  __degree?: number;
}

interface GLink extends LinkObject {
  source: string;
  target: string;
  relationType: string;
  weight: number;
}

/** 상세 패널·목록이 보여주는 관계 한 줄. */
interface RelationRow { key: string; dir: 'out' | 'in'; relationType: string; otherName: string; weight: number }

/** 화면에 붙어 있는 영향 분석 결과 — 요청 시점의 클러스터·엔티티를 같이 들고 있다(A-21). */
interface ImpactView extends OntologyImpactResponse { clusterId: string; entityId: string; entityName: string }

// ── 노드 Three.js 객체 생성 ────────────────────────────────────────────────────
function makeNodeObject(node: NodeObject, colors: Record<OntologyEntityType, EntityColors>): THREE.Mesh {
  const n = node as GNode;
  // MeshLambertMaterial 은 hsl(…) 을 파싱한다 — alpha 없는 solid 만 넘긴다.
  const color = colors[n.entityType]?.solid ?? cssVarColor('--chart-8');
  const size = 4 + Math.min((n.__degree ?? 1) * 0.8, 8);
  const geo = new THREE.SphereGeometry(size, 16, 16);
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geo, mat);
}

// ── 상세 패널 ─────────────────────────────────────────────────────────────────
function NodeDetailPanel({ node, relations, onClose, onAnalyzeImpact, analyzing, onAddRelation, op, canRelate }: {
  node: GNode;
  relations: RelationRow[];
  onClose: () => void;
  onAnalyzeImpact: () => void;
  analyzing: boolean;
  onAddRelation: () => void;
  op: CanOperate;
  /** 이을 다른 엔티티가 있는지 */
  canRelate: boolean;
}) {
  const relationHint = !canRelate ? '관계를 이을 다른 엔티티가 없습니다' : undefined;
  const relationDisabled = !op.canOperate || !canRelate;

  return (
    <section
      aria-label={`${node.name} 상세`}
      className="absolute top-4 right-4 w-72 bg-card border border-border rounded-md shadow-card overflow-hidden z-10"
    >
      <div className={`flex items-center justify-between px-4 py-3 border-b border-border border-l-4 ${entityClass(node.entityType).accent}`}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{entityLabel(node.entityType)}</p>
          <p className="text-sm font-bold text-foreground truncate">{node.name}</p>
        </div>
        <button type="button" onClick={onClose} title="닫기" aria-label="상세 닫기" className="p-1 hover:bg-secondary rounded-xl text-muted-foreground flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 max-h-[420px] overflow-y-auto">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-0.5">버전</p>
          <p className="text-sm font-mono text-foreground">{node.version || '—'}</p>
        </div>
        {Object.keys(node.properties).length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">속성</p>
            <dl className="space-y-1">
              {Object.entries(node.properties).map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-2 text-sm">
                  <dt className="text-muted-foreground flex-shrink-0">{k}</dt>
                  <dd className="font-mono text-foreground text-right break-all">{v === null || v === undefined || v === '' ? '—' : String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">관계 ({relations.length})</p>
          {relations.length === 0 ? (
            <p className="text-sm text-muted-foreground">이어진 관계가 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {relations.map((r) => (
                <li key={r.key} className="text-sm text-foreground break-all">
                  <span className="text-muted-foreground">{r.dir === 'out' ? '→' : '←'} {relationLabel(r.relationType)}</span>{' '}
                  {r.otherName}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border space-y-2">
        {isImpactTarget(node.entityType) && (
          // 영향 분석은 조회(클러스터 read) 권한이라 viewer 도 실행할 수 있다.
          <button
            type="button"
            onClick={onAnalyzeImpact}
            disabled={analyzing}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-secondary hover:bg-muted text-foreground border border-border rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            변경 영향 분석
          </button>
        )}
        <button
          type="button"
          onClick={onAddRelation}
          disabled={relationDisabled}
          title={op.hint ?? relationHint ?? '이 엔티티에서 다른 엔티티로 관계 추가'}
          aria-label={op.hint ? op.ariaWithHint('관계 추가') : relationHint ? `관계 추가 — ${relationHint}` : '관계 추가'}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-secondary hover:bg-muted text-foreground border border-border rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" />
          관계 추가
        </button>
      </div>
    </section>
  );
}

// ── 영향 분석 결과 패널 ───────────────────────────────────────────────────────
function ImpactPanel({ result, onClose }: { result: ImpactView; onClose: () => void }) {
  const scoreColor = result.blastRadiusScore >= 0.7 ? 'text-status-critical' : result.blastRadiusScore >= 0.4 ? 'text-status-warning' : 'text-foreground';

  return (
    <section
      aria-label="변경 영향 분석 결과"
      className="absolute bottom-4 left-4 w-80 bg-card border border-border rounded-md shadow-card overflow-hidden z-10"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground truncate">변경 영향 분석 — {result.entityName}</p>
        </div>
        <button type="button" onClick={onClose} title="닫기" aria-label="영향 분석 결과 닫기" className="p-1 hover:bg-secondary rounded-xl text-muted-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[320px] overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">영향 반경 점수</p>
          <p className={`text-lg font-bold ${scoreColor}`}>{pct(result.blastRadiusScore)}</p>
        </div>
        {result.impactedEntities.length === 0 ? (
          <p className="text-sm text-muted-foreground">영향 받는 엔티티가 없습니다.</p>
        ) : (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              영향 받는 엔티티 ({result.impactedEntities.length})
            </p>
            <ul className="space-y-1">
              {result.impactedEntities.slice(0, 8).map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entityClass(e.entityType).dot}`} aria-hidden="true" />
                  <span className="text-foreground truncate">{e.name}</span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">{entityLabel(e.entityType)}</span>
                </li>
              ))}
            </ul>
            {result.impactedEntities.length > 8 && (
              <p className="text-xs text-muted-foreground mt-1">외 {result.impactedEntities.length - 8}개…</p>
            )}
          </div>
        )}
        {result.impactPaths.slice(0, 3).map((path, i) => (
          <div key={i} className="rounded-md bg-secondary/40 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">경로 {i + 1}</p>
              <p className="text-xs font-semibold text-foreground tabular-nums">{pct(path.score)}</p>
            </div>
            <p className="text-xs text-foreground font-mono">{path.pathNames.join(' → ')}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── 목록 보기 (A-16 — 3D 캔버스의 키보드·스크린리더 대안) ─────────────────────
function EntityTable({ nodes, selectedId, onDetail, onAnalyze, analyzingId }: {
  nodes: GNode[];
  selectedId: string | null;
  onDetail: (n: GNode) => void;
  onAnalyze: (n: GNode) => void;
  analyzingId: string | null;
}) {
  if (nodes.length === 0) {
    return (
      <EmptyState
        compact
        icon={Search}
        title="조건에 맞는 엔티티가 없습니다"
        description="검색어를 지우거나 위의 타입 필터를 다시 켜 보세요."
      />
    );
  }
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">온톨로지 엔티티 목록 — 행의 버튼으로 상세와 변경 영향 분석을 연다</caption>
      <thead className="sticky top-0 bg-card z-[1]">
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th scope="col" className="px-4 py-2 font-medium">이름</th>
          <th scope="col" className="px-3 py-2 font-medium">타입</th>
          <th scope="col" className="px-3 py-2 font-medium">버전</th>
          <th scope="col" className="px-3 py-2 font-medium text-right">관계 수</th>
          <th scope="col" className="px-4 py-2 font-medium text-right">동작</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n) => {
          const selected = n.id === selectedId;
          const target = isImpactTarget(n.entityType);
          const busy = analyzingId === n.id;
          return (
            <tr key={n.id} aria-current={selected ? 'true' : undefined} className={`border-b border-border/60 ${selected ? 'bg-secondary/60' : 'hover:bg-secondary/30'}`}>
              <td className="px-4 py-2">
                <button type="button" onClick={() => onDetail(n)} className="text-left text-foreground hover:text-primary font-medium break-all rounded-xl">
                  {n.name}
                </button>
              </td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entityClass(n.entityType).dot}`} aria-hidden="true" />
                  {entityLabel(n.entityType)}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-muted-foreground">{n.version || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{n.__degree ?? 0}</td>
              <td className="px-4 py-2">
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => onDetail(n)}
                    aria-label={`${n.name} 상세`}
                    className="px-2.5 py-1 text-xs font-medium bg-secondary hover:bg-muted border border-border rounded-xl text-foreground"
                  >
                    상세
                  </button>
                  <button
                    type="button"
                    onClick={() => onAnalyze(n)}
                    disabled={!target || analyzingId !== null}
                    title={target ? '변경 영향 분석' : IMPACT_TARGET_HINT}
                    aria-label={target ? `${n.name} 변경 영향 분석` : `${n.name} 변경 영향 분석 — ${IMPACT_TARGET_HINT}`}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-secondary hover:bg-muted border border-border rounded-xl text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                    영향 분석
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── 엔티티 추가 다이얼로그 ────────────────────────────────────────────────────
/** `key=value` 한 줄씩 → 속성 객체. 빈 줄·`=` 없는 줄은 건너뛴다. */
function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

const inputCls = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary';
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

function CreateEntityDialog({ open, clusterId, clusterName, onClose }: {
  open: boolean; clusterId: string; clusterName: string; onClose: () => void;
}) {
  const uid = useId();
  const toast = useToast();
  const create = useCreateOntologyEntity();
  const [entityType, setEntityType] = useState<OntologyEntityType>('config_item');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [props, setProps] = useState('');

  useEffect(() => {
    if (open) { setEntityType('config_item'); setName(''); setVersion(''); setProps(''); }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || create.isPending) return;
    try {
      await create.mutateAsync({
        clusterId,
        entityType,
        name: name.trim(),
        version: version.trim() || undefined,
        properties: parseProperties(props),
      });
      toast.success(`"${name.trim()}" 엔티티를 추가했습니다`);
      onClose();
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      toast.error(status === 403 ? '엔티티 추가 실패 — 권한이 없습니다' : '엔티티 추가 실패', formatApiError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>엔티티 추가</DialogTitle>
            <DialogDescription>{clusterName} 클러스터의 온톨로지에 엔티티를 등록합니다.</DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-3 space-y-3">
            <div>
              <label htmlFor={`${uid}-type`} className={labelCls}>타입</label>
              <select id={`${uid}-type`} value={entityType} onChange={(e) => setEntityType(e.target.value as OntologyEntityType)} className={inputCls}>
                {ALL_TYPES.map((t) => <option key={t} value={t}>{entityLabel(t)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-name`} className={labelCls}>이름 *</label>
              <input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} required autoFocus
                placeholder="예: net.core.somaxconn" className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${uid}-version`} className={labelCls}>버전 (선택)</label>
              <input id={`${uid}-version`} value={version} onChange={(e) => setVersion(e.target.value)} maxLength={100} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${uid}-props`} className={labelCls}>속성 (선택, 한 줄에 key=value)</label>
              <textarea id={`${uid}-props`} value={props} onChange={(e) => setProps(e.target.value)} rows={3}
                placeholder="value=4096" className={`${inputCls} font-mono`} />
            </div>
          </div>
          <DialogFooter className="justify-end">
            <button type="button" onClick={onClose} disabled={create.isPending}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-xl">
              취소
            </button>
            <button type="submit" disabled={create.isPending || !name.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl disabled:opacity-50">
              {create.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {create.isPending ? '추가 중…' : '추가'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── 관계 추가 다이얼로그 ──────────────────────────────────────────────────────
function CreateRelationDialog({ open, clusterId, source, entities, onClose }: {
  open: boolean; clusterId: string; source: GNode | null; entities: OntologyEntity[]; onClose: () => void;
}) {
  const uid = useId();
  const toast = useToast();
  const create = useCreateOntologyRelationship();
  const targets = useMemo(
    () => entities.filter((e) => e.id !== source?.id).sort((a, b) => a.name.localeCompare(b.name)),
    [entities, source],
  );
  const [relationType, setRelationType] = useState(RELATION_TYPES[0]);
  const [targetId, setTargetId] = useState('');
  const [weight, setWeight] = useState('1');

  useEffect(() => {
    if (open) { setRelationType(RELATION_TYPES[0]); setTargetId(''); setWeight('1'); }
  }, [open]);

  const w = Number(weight);
  const weightOk = weight.trim() !== '' && Number.isFinite(w) && w >= 0 && w <= 1;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source || !targetId || !weightOk || create.isPending) return;
    try {
      await create.mutateAsync({ clusterId, sourceEntityId: source.id, relationType, targetEntityId: targetId, weight: w });
      toast.success('관계를 추가했습니다');
      onClose();
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      toast.error(status === 403 ? '관계 추가 실패 — 권한이 없습니다' : '관계 추가 실패', formatApiError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>관계 추가</DialogTitle>
            <DialogDescription>{source ? `${source.name}(${entityLabel(source.entityType)})에서 시작하는 관계를 잇습니다.` : '—'}</DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-3 space-y-3">
            <div>
              <label htmlFor={`${uid}-rel`} className={labelCls}>관계</label>
              <select id={`${uid}-rel`} value={relationType} onChange={(e) => setRelationType(e.target.value)} className={inputCls}>
                {RELATION_TYPES.map((t) => <option key={t} value={t}>{relationLabel(t)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-target`} className={labelCls}>대상 엔티티 *</label>
              <select id={`${uid}-target`} value={targetId} onChange={(e) => setTargetId(e.target.value)} required className={inputCls}>
                <option value="">선택하세요</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name} · {entityLabel(t.entityType)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-weight`} className={labelCls}>가중치 (0 ~ 1)</label>
              <input id={`${uid}-weight`} type="number" min={0} max={1} step={0.05} value={weight} onChange={(e) => setWeight(e.target.value)}
                aria-invalid={!weightOk || undefined} className={inputCls} />
            </div>
          </div>
          <DialogFooter className="justify-end">
            <button type="button" onClick={onClose} disabled={create.isPending}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-xl">
              취소
            </button>
            <button type="submit" disabled={create.isPending || !targetId || !weightOk}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl disabled:opacity-50">
              {create.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {create.isPending ? '추가 중…' : '추가'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export function OntologyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  // 선택은 URL(/ontology/:clusterId)이 원천. 지식 허브 탭에 마운트될 땐(embedded) URL 을 건드리지 않는다.
  const { clusterId, selectCluster } = useClusterRouteParam('/ontology', clusters, { local: embedded });
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId ?? '';
  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<OntologyEntityType>>(new Set(ALL_TYPES));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impactResult, setImpactResult] = useState<ImpactView | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(true);
  const [view, setView] = useState<ViewMode>(loadViewMode);
  const [entityDialogOpen, setEntityDialogOpen] = useState(false);
  const [relationDialogOpen, setRelationDialogOpen] = useState(false);

  const graphQ = useOntologyGraph(clusterId || null);
  const graph = graphQ.data;
  const { mutateAsync: analyzeImpact } = useAnalyzeImpact();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('ontology-impact');
  // 엔티티·관계 추가는 operator + 이 클러스터 operate. 영향 분석은 조회 권한이라 막지 않는다.
  const op = useCanOperate(clusterId || null);

  // 영향 분석 응답이 돌아왔을 때 요청 시점과 비교할 현재 값 — 바뀌었으면 결과를 버린다(A-21).
  const clusterIdRef = useRef(clusterId);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { clusterIdRef.current = clusterId; }, [clusterId]);

  const selectEntity = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setImpactResult(null);
  }, []);

  const changeView = (v: ViewMode) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* noop */ }
  };

  // 컨테이너 크기 추적
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        setDimensions({
          w: containerRef.current.clientWidth,
          h: containerRef.current.clientHeight,
        });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 클러스터가 바뀌면 이전 클러스터의 노드 상세·영향 분석 결과를 닫는다.
  useEffect(() => {
    selectEntity(null);
    setRelationDialogOpen(false);
  }, [clusterId, selectEntity]);

  // 테마·강조색이 바뀌면 키가 달라진다 → 색 맵·nodeThreeObject·linkColor identity 가 바뀌어
  // ForceGraph3D 가 노드 객체를 다시 만들고 링크·배경을 다시 칠한다.
  const themeKey = useThemeColorKey();
  const colors = useMemo(() => { void themeKey; return entityColors(); }, [themeKey]);
  const canvasColors = useMemo(() => {
    void themeKey;
    return { background: cssVarColor('--background'), foreground: cssVarColor('--foreground') };
  }, [themeKey]);
  const nodeThreeObject = useCallback((n: NodeObject) => makeNodeObject(n, colors), [colors]);

  // degree 계산
  const degreeMap = useMemo<Record<string, number>>(() => {
    if (!graph) return {};
    const m: Record<string, number> = {};
    for (const r of graph.relationships) {
      m[r.sourceEntityId] = (m[r.sourceEntityId] ?? 0) + 1;
      m[r.targetEntityId] = (m[r.targetEntityId] ?? 0) + 1;
    }
    return m;
  }, [graph]);

  const toGNode = useCallback((e: OntologyEntity): GNode => ({
    id: e.id,
    name: e.name,
    entityType: e.entityType,
    version: e.version,
    properties: e.properties ?? {},
    __degree: degreeMap[e.id] ?? 0,
  }), [degreeMap]);

  // ForceGraph3D graphData 변환 (목록 보기도 같은 필터 결과를 쓴다)
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [] as GNode[], links: [] as GLink[] };

    const q = search.toLowerCase();
    const filteredIds = new Set(
      graph.entities
        .filter((e) => activeTypes.has(e.entityType) && (!q || e.name.toLowerCase().includes(q)))
        .map((e) => e.id)
    );

    const nodes: GNode[] = graph.entities.filter((e) => filteredIds.has(e.id)).map(toGNode);

    const links: GLink[] = graph.relationships
      .filter((r) => filteredIds.has(r.sourceEntityId) && filteredIds.has(r.targetEntityId))
      .map((r) => ({
        source: r.sourceEntityId,
        target: r.targetEntityId,
        relationType: r.relationType,
        weight: r.weight,
      }));

    return { nodes, links };
  }, [graph, activeTypes, search, toGNode]);

  // 선택은 id 로 들고 최신 그래프에서 다시 찾는다 — 관계 추가 뒤 refetch 돼도 상세가 최신 값을 보인다.
  const selectedNode = useMemo<GNode | null>(() => {
    const e = selectedId ? graph?.entities.find((x) => x.id === selectedId) : undefined;
    return e ? toGNode(e) : null;
  }, [selectedId, graph, toGNode]);

  const selectedRelations = useMemo<RelationRow[]>(() => {
    if (!graph || !selectedId) return [];
    const nameOf = new Map(graph.entities.map((e) => [e.id, e.name]));
    return graph.relationships
      .filter((r) => r.sourceEntityId === selectedId || r.targetEntityId === selectedId)
      .map((r) => {
        const out = r.sourceEntityId === selectedId;
        const other = out ? r.targetEntityId : r.sourceEntityId;
        return { key: r.id, dir: out ? 'out' : 'in', relationType: r.relationType, otherName: nameOf.get(other) ?? other.slice(0, 8), weight: r.weight };
      });
  }, [graph, selectedId]);

  const handleNodeClick = useCallback((nodeObj: NodeObject) => {
    const n = nodeObj as GNode;
    selectEntity(n.id);
    // 카메라 포커스
    if (graphRef.current && n.x !== undefined) {
      graphRef.current.cameraPosition(
        { x: n.x! + 60, y: n.y! + 30, z: n.z! + 80 },
        { x: n.x!, y: n.y!, z: n.z! },
        800,
      );
    }
  }, [selectEntity]);

  const handleAnalyzeImpact = useCallback(async (node: GNode) => {
    if (!clusterId) return;
    const reqCluster = clusterId;
    const reqEntity = node.id;
    setAnalyzingId(reqEntity);
    try {
      const r = await runLogged(runLog, {
        title: '변경 영향 분석',
        first: `${clusterName} · ${node.name} (${entityLabel(node.entityType)}) — 변경 영향 분석 요청(최대 깊이 ${IMPACT_MAX_DEPTH})`,
        fn: () => analyzeImpact({
          clusterId: reqCluster,
          configEntityId: reqEntity,
          // 가정 분석(what-if) — 실제 변경 이벤트(config_change)가 아니다(A-17).
          category: 'impact_simulation',
          severity: 'info',
          title: `${node.name} 변경 영향 분석`,
          maxDepth: IMPACT_MAX_DEPTH,
        }),
        summarize: impactLines,
        keepOpen: true,
      });
      if (!r.ok) return; // 실패는 runLogged 가 error 줄 + end 를 남겼다
      if (clusterIdRef.current !== reqCluster || selectedIdRef.current !== reqEntity) {
        r.run.log('warn', '분석 중에 클러스터나 선택한 엔티티가 바뀌어 결과를 화면에 붙이지 않았습니다(로그에만 남김)');
        r.run.end();
        return;
      }
      r.run.end();
      setImpactResult({ ...r.data, clusterId: reqCluster, entityId: reqEntity, entityName: node.name });
    } finally {
      setAnalyzingId((cur) => (cur === reqEntity ? null : cur));
    }
  }, [clusterId, clusterName, analyzeImpact, runLog]);

  const analyzeFromRow = useCallback((n: GNode) => {
    selectEntity(n.id);
    void handleAnalyzeImpact(n);
  }, [selectEntity, handleAnalyzeImpact]);

  const toggleType = (t: OntologyEntityType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  // float-tooltip 은 문자열을 innerHTML 로 넣는다 — 사용자가 저장한 값은 전부 escapeHtml 을 거친다(A-2, 저장형 XSS).
  // 색은 인라인 style 대신 토큰 클래스(JIT 가 이 리터럴을 찾는다).
  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    const version = node.version ? `<br/><span class="text-muted-foreground">v${escapeHtml(node.version)}</span>` : '';
    return `<div class="bg-popover text-popover-foreground border border-border rounded-md px-2 py-1 text-xs"><b>${escapeHtml(node.name)}</b><br/><span class="text-muted-foreground">${escapeHtml(entityLabel(node.entityType))}</span>${version}</div>`;
  }, []);

  const linkLabel = useCallback((l: LinkObject) => escapeHtml(relationLabel((l as GLink).relationType)), []);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as GLink;
    // 가중치 0→1 을 불투명도 0.16→0.63 으로 (기존 hex alpha 40→160/255 와 같은 구간).
    // 링크마다 getComputedStyle 을 부르지 않도록 memo 한 전경색 hsl 에 alpha 만 붙인다.
    const alpha = Math.round(((40 + link.weight * 120) / 255) * 100) / 100;
    return canvasColors.foreground.replace(/^hsl\((.*)\)$/, `hsla($1, ${alpha})`);
  }, [canvasColors]);

  const hasEntities = !!graph && graph.entities.length > 0;
  const addEntityDisabled = !op.canOperate || !clusterId || !graph;

  const addEntityButton = (
    <button
      type="button"
      onClick={() => setEntityDialogOpen(true)}
      disabled={addEntityDisabled}
      title={op.withHint('엔티티 추가')}
      aria-label={op.ariaWithHint('엔티티 추가')}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm border bg-secondary border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Plus className="w-3.5 h-3.5" />엔티티 추가
    </button>
  );

  // 본문 — 로딩 → 실패 → 빈 상태 순(A-12)
  let body: React.ReactNode;
  if (clustersQ.isError) {
    body = <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />;
  } else if (clustersQ.isLoading && !clustersQ.data) {
    body = <LoadingState />;
  } else if (clusters.length === 0) {
    body = <SelectClusterEmptyState description="등록된 클러스터가 없습니다. 클러스터 관리에서 클러스터를 먼저 등록하면 온톨로지 그래프를 볼 수 있습니다." />;
  } else if (!clusterId) {
    body = <SelectClusterEmptyState />;
  } else if (graphQ.isLoading) {
    body = <LoadingState />;
  } else if (graphQ.isError) {
    body = <ErrorState error={graphQ.error} title="온톨로지 그래프를 불러오지 못했습니다" onRetry={() => { void graphQ.refetch(); }} />;
  } else if (!hasEntities) {
    body = (
      <EmptyState
        icon={Share2}
        title="이 클러스터에는 아직 온톨로지 엔티티가 없습니다"
        description={
          '엔티티는 아직 수집기로 자동 생성되지 않아 직접 등록해야 그래프가 그려집니다. '
          + '「엔티티 추가」로 노드·설정 항목 등을 등록하고, 엔티티 상세의 「관계 추가」로 이으면 변경 영향 분석을 쓸 수 있습니다.'
          + (op.canOperate ? '' : ` 등록은 operator 이상이면서 이 클러스터에 실행 권한이 있어야 하니 담당자에게 요청하세요.`)
        }
      >
        <div className="mt-4">{addEntityButton}</div>
      </EmptyState>
    );
  } else if (view === 'list') {
    body = (
      <div className="h-full overflow-auto">
        <EntityTable
          nodes={graphData.nodes}
          selectedId={selectedId}
          onDetail={(n) => selectEntity(n.id)}
          onAnalyze={analyzeFromRow}
          analyzingId={analyzingId}
        />
      </div>
    );
  } else {
    body = (
      <>
        <p className="sr-only">3D 그래프는 마우스로만 조작할 수 있습니다. 키보드·스크린리더로는 상단의 「목록 보기」를 사용하세요.</p>
        <ForceGraph3D
          ref={graphRef as React.MutableRefObject<ForceGraph3DInstance>}
          graphData={graphData}
          width={dimensions.w}
          height={dimensions.h}
          backgroundColor={canvasColors.background}
          nodeId="id"
          nodeLabel={nodeLabel}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend={false}
          nodeVal={(n) => Math.max(1, (n as GNode).__degree ?? 1)}
          linkSource="source"
          linkTarget="target"
          linkLabel={linkLabel}
          linkColor={linkColor}
          linkWidth={(l: LinkObject) => 0.5 + (l as GLink).weight * 1.5}
          linkOpacity={0.6}
          linkDirectionalArrowLength={6}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={linkColor}
          linkDirectionalParticles={(l: LinkObject) => Math.round((l as GLink).weight * 3)}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleColor={linkColor}
          onNodeClick={handleNodeClick}
          enableNodeDrag
          enableNavigationControls
          showNavInfo={false}
          warmupTicks={80}
          cooldownTicks={200}
        />
      </>
    );
  }

  return (
    <div className="app-h-screen bg-background flex overflow-hidden">
      {/* 클러스터 레일 (D-113) — 메인 사이드바에 flush, 좌측 패딩 없음 */}
      <div className="py-3 flex-shrink-0">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={selectCluster} iconOnly />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* 상단 툴바 */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-shrink-0 z-20">
          <PageHeader
            className="flex-1 items-center"
            icon={Share2}
            title="온톨로지 그래프"
            titleExtra={<>
              {/* 검색 */}
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="노드 검색…"
                  aria-label="노드 검색"
                  className="pl-7 pr-3 py-1 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary w-44"
                />
              </div>

              {/* 통계 */}
              {graph && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span><b className="text-foreground">{graphData.nodes.length}</b>/{graph.entities.length} 노드</span>
                  <span><b className="text-foreground">{graphData.links.length}</b> 관계</span>
                </div>
              )}
            </>}
            actions={<>
              {addEntityButton}

              {/* 목록 보기 토글 (A-16) — 선택은 브라우저에 기억 */}
              <button
                type="button"
                onClick={() => changeView(view === 'list' ? 'graph' : 'list')}
                aria-pressed={view === 'list'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm border transition-colors ${
                  view === 'list' ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary border-border text-muted-foreground'
                }`}
              >
                <List className="w-3.5 h-3.5" />목록 보기
              </button>

              {/* 범례 토글 */}
              {view === 'graph' && (
                <button
                  type="button"
                  onClick={() => setShowLegend((v) => !v)}
                  aria-pressed={showLegend}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm border transition-colors ${
                    showLegend ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary border-border text-muted-foreground'
                  }`}
                >
                  <Info className="w-3.5 h-3.5" />범례
                </button>
              )}

              {/* 필터 초기화 */}
              {activeTypes.size < ALL_TYPES.length && (
                <button
                  type="button"
                  onClick={() => setActiveTypes(new Set(ALL_TYPES))}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-sm bg-secondary border border-border text-muted-foreground hover:text-foreground"
                >
                  <Filter className="w-3.5 h-3.5" />전체
                </button>
              )}

              {/* 새로고침 */}
              <button
                type="button"
                onClick={() => { void graphQ.refetch(); }}
                disabled={!clusterId || graphQ.isFetching}
                title="새로고침"
                aria-label="새로고침"
                className="p-1.5 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${graphQ.isFetching ? 'animate-spin' : ''}`} />
              </button>
            </>}
          />
        </div>

        {/* 타입 필터 바 */}
        <div className="flex items-center gap-1.5 px-4 py-2 bg-card border-b border-border/60 flex-shrink-0 overflow-x-auto">
          {ALL_TYPES.map((t) => {
            const active = activeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                onClick={() => toggleType(t)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-foreground border flex-shrink-0 transition-opacity ${
                  entityClass(t).chipEdge} ${active ? `opacity-100 ${entityClass(t).chipOn}` : 'opacity-35 bg-transparent'
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entityClass(t).dot}`} />
                {entityLabel(t)}
              </button>
            );
          })}
        </div>

        {/* 영향 분석 실행 로그 — 캔버스를 가리지 않도록 툴바 아래 고정 영역 */}
        {(runLog.running || runLog.lines.length > 0) && (
          <div className="px-4 py-2 bg-card border-b border-border/60 flex-shrink-0">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-40" />
          </div>
        )}

        {/* 그래프/목록 영역 */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden">
          {analyzingId && (
            <div role="status" className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card border border-border rounded-full px-4 py-2 text-sm text-muted-foreground shadow-card z-20">
              <Loader2 className="w-4 h-4 animate-spin" />영향 분석 중…
            </div>
          )}

          {hasEntities && !graphQ.isError ? body : (
            <div className="flex items-center justify-center h-full">{body}</div>
          )}

          {/* 범례 패널 */}
          {hasEntities && view === 'graph' && showLegend && (
            <div className="absolute top-4 left-4 bg-card border border-border rounded-md px-4 py-3 space-y-1.5 z-10">
              <p className="text-xs font-medium text-muted-foreground mb-2">엔티티 타입</p>
              {ALL_TYPES.map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${entityClass(t).dot}`} />
                  <span className="text-sm text-muted-foreground">{entityLabel(t)}</span>
                </div>
              ))}
              <div className="pt-2 mt-2 border-t border-border/40 space-y-1">
                <p className="text-xs text-muted-foreground">구체 크기 = 관계 수</p>
                <p className="text-xs text-muted-foreground">파티클 = 관계 방향</p>
                <p className="text-xs text-muted-foreground">링크 굵기 = 가중치</p>
                <p className="text-xs text-muted-foreground">드래그로 노드 이동</p>
              </div>
            </div>
          )}

          {/* 선택된 노드 상세 패널 */}
          {hasEntities && selectedNode && (
            <NodeDetailPanel
              node={selectedNode}
              relations={selectedRelations}
              onClose={() => selectEntity(null)}
              onAnalyzeImpact={() => { void handleAnalyzeImpact(selectedNode); }}
              analyzing={analyzingId !== null}
              onAddRelation={() => setRelationDialogOpen(true)}
              op={op}
              canRelate={(graph?.entities.length ?? 0) > 1}
            />
          )}

          {/* 영향 분석 결과 패널 — 지금 클러스터·선택과 같은 요청의 결과만 */}
          {impactResult && impactResult.clusterId === clusterId && impactResult.entityId === selectedId && (
            <ImpactPanel result={impactResult} onClose={() => setImpactResult(null)} />
          )}
        </div>
      </div>

      {clusterId && (
        <>
          <CreateEntityDialog
            open={entityDialogOpen}
            clusterId={clusterId}
            clusterName={clusterName}
            onClose={() => setEntityDialogOpen(false)}
          />
          <CreateRelationDialog
            open={relationDialogOpen}
            clusterId={clusterId}
            source={selectedNode}
            entities={graph?.entities ?? []}
            onClose={() => setRelationDialogOpen(false)}
          />
        </>
      )}
    </div>
  );
}
