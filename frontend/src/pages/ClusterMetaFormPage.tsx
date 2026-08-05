import {
  useEffect, useId, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Cpu, Network, RefreshCw, Server } from 'lucide-react';
import type { Cluster, ClusterManageUpdate } from '@/types';
import { clustersApi } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useQueryClient } from '@tanstack/react-query';
import { useOperationLevels } from '@/hooks/useOperationLevels';
import { ConfirmDialog, Skeleton, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { formatApiError } from '@/lib/utils';

const TABS = [
  { id: 'node',    label: '노드 스펙 / NIC', icon: Cpu },
  { id: 'network', label: 'N/W CIDR',        icon: Network },
  { id: 'extra',   label: '기타',             icon: Server },
] as const;

type TabId = 'node' | 'network' | 'extra';

// ── 입력 형식 검증 (D-033) ───────────────────────────────────────────────────
// 전부 "값이 있을 때만" 검사한다 — 빈 값은 해제(null)로 정상 처리되므로 통과시킨다.
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAC_RE = /^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

function isIpv4(v: string): boolean {
  return IPV4_RE.test(v) && v.split('.').every((o) => Number(o) <= 255);
}
function isCidr(v: string): boolean {
  const parts = v.split('/');
  if (parts.length !== 2) return false;
  const [ip, prefix] = parts;
  return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32 && isIpv4(ip);
}
/** bond NIC 는 `10.0.0.1` 과 `10.0.0.1/24` 를 모두 허용한다. */
function isIpOrCidr(v: string): boolean {
  return v.includes('/') ? isCidr(v) : isIpv4(v);
}

/** 검증 대상 필드 → 소속 탭. 오류 시 해당 탭으로 자동 전환하기 위한 맵. */
const FIELD_TAB: Record<string, TabId> = {
  bond0Ip: 'node', bond0Mac: 'node', bond1Ip: 'node', bond1Mac: 'node', asNumber: 'node',
  cidr: 'network', firstHost: 'network', lastHost: 'network',
  podCidr: 'network', podFirstHost: 'network', podLastHost: 'network',
  svcCidr: 'network', svcFirstHost: 'network', svcLastHost: 'network',
};

export function ClusterMetaFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // D-032: 이전엔 반환값을 버려 isLoading/isError 를 쓰지 않아, 목록이 도착하기 전에
  // 빈 폼이 그대로 렌더되고(입력 시 hydration 이 덮어씀) 저장은 무반응이었다.
  const { isLoading: clustersLoading, isError: clustersError, refetch: refetchClusters } = useClusters();
  const { clusters } = useClusterStore();
  const cluster: Cluster | undefined = clusters.find((c) => c.id === id);
  const { data: opsLevels = [] } = useOperationLevels();

  const [region, setRegion]             = useState('');
  const [operationLevel, setLevel]      = useState('');
  const [nodeCount, setNodeCount]       = useState('');
  const [maxPod, setMaxPod]             = useState('');
  const [hostname, setHostname]         = useState('');
  const [cidr, setCidr]                 = useState('');
  const [internalIps, setInternalIps]   = useState('');
  const [firstHost, setFirstHost]       = useState('');
  const [lastHost, setLastHost]         = useState('');
  const [podCidr, setPodCidr]           = useState('');
  const [podFirstHost, setPodFirstHost] = useState('');
  const [podLastHost, setPodLastHost]   = useState('');
  const [svcCidr, setSvcCidr]           = useState('');
  const [svcFirstHost, setSvcFirst]     = useState('');
  const [svcLastHost, setSvcLast]       = useState('');
  const [bond0Ip, setBond0Ip]           = useState('');
  const [bond0Mac, setBond0Mac]         = useState('');
  const [bond1Ip, setBond1Ip]           = useState('');
  const [bond1Mac, setBond1Mac]         = useState('');
  const [ciliumConfig, setCilium]       = useState('');
  const [description, setDescription]   = useState('');
  const [bgpEnabled, setBgpEnabled]     = useState(false);
  const [asNumber, setAsNumber]         = useState('');
  const [prometheusUrl, setPrometheusUrl] = useState('');
  const [prometheusEnabled, setPrometheusEnabled] = useState(false);
  const [alertmanagerUrl, setAlertmanagerUrl] = useState('');
  const [observabilityMode, setObservabilityMode] = useState<'pull' | 'push'>('pull');
  const [observabilityEnabled, setObservabilityEnabled] = useState(false);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [fieldErrors, setFieldErrors]   = useState<Record<string, string>>({});
  // D-039: 이전엔 boolean 이라, 라우트 재사용(`/A/edit` → `/B/edit`)시 재하이드레이션이
  // 일어나지 않아 A 의 값으로 B 를 저장할 수 있었다. 하이드레이션한 클러스터 id 를 기억한다.
  const [hydratedId, setHydratedId]     = useState<string | null>(null);
  const toast = useToast();

  // D-038: 활성 탭을 URL(`?tab=`)에 보존 — 새로고침·공유·저장 실패 후에도 작업 탭 유지.
  // `replace: true` 로 써서 탭 전환이 히스토리에 쌓이지 않게 한다(전역 뒤로가기가
  // 탭 이동을 되짚지 않도록 — D-029 연계).
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'node';
  const setTab = (next: TabId) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // D-037: 미저장 변경 감지용 기준 스냅샷. 키 순서에 의존하지 않도록 정렬 후 직렬화.
  const baselineRef = useRef<string | null>(null);
  const serialize = (o: Record<string, string | boolean>) =>
    JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

  useEffect(() => {
    if (!cluster || hydratedId === cluster.id) return;
    // 폼 상태와 기준 스냅샷을 같은 객체 하나에서 만들어 둘이 어긋나지 않게 한다.
    const next = {
      region: cluster.region ?? '',
      operationLevel: cluster.operationLevel ?? '',
      nodeCount: cluster.nodeCount?.toString() ?? '',
      maxPod: cluster.maxPod?.toString() ?? '',
      hostname: cluster.hostname ?? '',
      cidr: cluster.cidr ?? '',
      internalIps: cluster.internalIps ?? '',
      firstHost: cluster.firstHost ?? '',
      lastHost: cluster.lastHost ?? '',
      podCidr: cluster.podCidr ?? '',
      podFirstHost: cluster.podFirstHost ?? '',
      podLastHost: cluster.podLastHost ?? '',
      svcCidr: cluster.svcCidr ?? '',
      svcFirstHost: cluster.svcFirstHost ?? '',
      svcLastHost: cluster.svcLastHost ?? '',
      bond0Ip: cluster.bond0Ip ?? '',
      bond0Mac: cluster.bond0Mac ?? '',
      bond1Ip: cluster.bond1Ip ?? '',
      bond1Mac: cluster.bond1Mac ?? '',
      ciliumConfig: cluster.ciliumConfig ?? '',
      description: cluster.description ?? '',
      bgpEnabled: cluster.bgpEnabled ?? false,
      asNumber: cluster.asNumber ?? '',
      prometheusUrl: cluster.prometheusUrl ?? '',
      prometheusEnabled: cluster.prometheusEnabled ?? false,
      alertmanagerUrl: cluster.alertmanagerUrl ?? '',
      observabilityMode: (cluster.observabilityMode ?? 'pull') as 'pull' | 'push',
      observabilityEnabled: cluster.observabilityEnabled ?? false,
    };
    setRegion(next.region);
    setLevel(next.operationLevel);
    setNodeCount(next.nodeCount);
    setMaxPod(next.maxPod);
    setHostname(next.hostname);
    setCidr(next.cidr);
    setInternalIps(next.internalIps);
    setFirstHost(next.firstHost);
    setLastHost(next.lastHost);
    setPodCidr(next.podCidr);
    setPodFirstHost(next.podFirstHost);
    setPodLastHost(next.podLastHost);
    setSvcCidr(next.svcCidr);
    setSvcFirst(next.svcFirstHost);
    setSvcLast(next.svcLastHost);
    setBond0Ip(next.bond0Ip);
    setBond0Mac(next.bond0Mac);
    setBond1Ip(next.bond1Ip);
    setBond1Mac(next.bond1Mac);
    setCilium(next.ciliumConfig);
    setDescription(next.description);
    setBgpEnabled(next.bgpEnabled);
    setAsNumber(next.asNumber);
    setPrometheusUrl(next.prometheusUrl);
    setPrometheusEnabled(next.prometheusEnabled);
    setAlertmanagerUrl(next.alertmanagerUrl);
    setObservabilityMode(next.observabilityMode);
    setObservabilityEnabled(next.observabilityEnabled);
    baselineRef.current = serialize(next);
    setFieldErrors({});
    setError('');
    setHydratedId(cluster.id);
  }, [cluster, hydratedId]);

  // ── D-037: 미저장 변경 감지 ────────────────────────────────────────────────
  const snapshot = useMemo(() => ({
    region, operationLevel, nodeCount, maxPod, hostname, cidr, internalIps,
    firstHost, lastHost, podCidr, podFirstHost, podLastHost,
    svcCidr, svcFirstHost, svcLastHost,
    bond0Ip, bond0Mac, bond1Ip, bond1Mac,
    ciliumConfig, description, bgpEnabled, asNumber, prometheusUrl, prometheusEnabled,
    alertmanagerUrl, observabilityMode, observabilityEnabled,
  }), [
    region, operationLevel, nodeCount, maxPod, hostname, cidr, internalIps,
    firstHost, lastHost, podCidr, podFirstHost, podLastHost,
    svcCidr, svcFirstHost, svcLastHost,
    bond0Ip, bond0Mac, bond1Ip, bond1Mac,
    ciliumConfig, description, bgpEnabled, asNumber, prometheusUrl, prometheusEnabled,
    alertmanagerUrl, observabilityMode, observabilityEnabled,
  ]);
  const isDirty = baselineRef.current !== null && serialize(snapshot) !== baselineRef.current;

  // 새로고침·탭 닫기는 브라우저 기본 경고로 막는다. (앱 내 사이드바 이동은 선언형
  // BrowserRouter 라 `useBlocker` 를 쓸 수 없어 차단 대상이 아니다 — DESIGN.md D-037 참고)
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const [leaveOpen, setLeaveOpen] = useState(false);
  /** 목록으로 나가기 — 미저장 변경이 있으면 확인을 받는다. */
  const requestLeave = () => {
    if (isDirty) setLeaveOpen(true);
    else navigate('/cluster-manage');
  };

  // ── D-032: 로딩/에러/미발견 3분기 — 데이터가 확정되기 전엔 폼을 렌더하지 않는다 ──
  const shell = (children: ReactNode) => (
    <div className="app-min-h-screen bg-background">
      <main className="max-w-[1200px] mx-auto px-8 py-8">{children}</main>
    </div>
  );

  // `clusters.length === 0` 를 로딩 신호로 쓰면 "등록된 클러스터 0개"일 때 skeleton 이
  // 영원히 남는다. 로딩 여부는 쿼리 상태(isLoading)만 신뢰한다.
  if (!cluster && clustersLoading && !clustersError) {
    // 아직 목록을 못 받은 상태. 빈 폼 대신 실제 폼 구조를 흉내낸 skeleton 을 보여 준다.
    return shell(
      <div aria-busy="true" aria-label="클러스터 정보 불러오는 중">
        <div className="flex items-center gap-3 mb-6">
          <Skeleton height={32} width={32} />
          <div className="space-y-1.5">
            <Skeleton height={18} width={180} />
            <Skeleton height={12} width={120} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <Skeleton key={i} height={38} />)}
          </div>
          <Skeleton height={34} width="45%" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} height={38} />)}
          </div>
        </div>
      </div>,
    );
  }

  if (!cluster && clustersError) {
    return shell(
      <div className="text-center py-20">
        <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-status-critical" />
        <p className="font-medium mb-1">클러스터 목록을 불러오지 못했습니다.</p>
        <p className="text-sm text-muted-foreground mb-4">
          네트워크 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button type="button" onClick={() => refetchClusters()}>
            <RefreshCw className="w-3.5 h-3.5" /> 다시 시도
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/cluster-manage')}>
            클러스터 목록으로
          </Button>
        </div>
      </div>,
    );
  }

  if (!cluster) {
    return shell(
      <div className="text-center py-20">
        <Server className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
        <p className="text-muted-foreground mb-4">클러스터를 찾을 수 없습니다.</p>
        <Button type="button" onClick={() => navigate('/cluster-manage')}>
          클러스터 목록으로
        </Button>
      </div>,
    );
  }

  // 입력은 표준 라운딩 `rounded-xl` (버튼/입력 규격, CLAUDE.md UI 컨벤션) — D-035
  const ic = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const lc = 'block text-sm font-medium text-muted-foreground mb-1';

  // 탭 좌우/Home/End 키 이동 — WAI-ARIA tabs 패턴 (D-036)
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    const n = TABS.length;
    let next: number;
    if (e.key === 'ArrowRight') next = (idx + 1) % n;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(f(`tab-${TABS[next].id}`))?.focus();
  };

  // 검증 실패 필드 강조 + 인라인 사유 (D-033)
  const invalidCls = (k: string) =>
    fieldErrors[k] ? ' border-status-critical focus:ring-status-critical' : '';
  const fieldMsg = (k: string) =>
    fieldErrors[k] ? <p className="mt-1 text-xs text-status-critical">{fieldErrors[k]}</p> : null;

  /** 빈 입력을 `null` 로 — 값 해제가 서버에 반영되도록 (D-031). */
  const orNull = (v: string) => v.trim() || null;

  /** 값이 있을 때만 형식 검증. 반환값이 비어 있으면 통과. (D-033) */
  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    const checkAll = (
      entries: [string, string][],
      ok: (v: string) => boolean,
      message: string,
    ) => {
      for (const [key, raw] of entries) {
        const v = raw.trim();
        if (v && !ok(v)) errs[key] = message;
      }
    };

    checkAll(
      [['cidr', cidr], ['podCidr', podCidr], ['svcCidr', svcCidr]],
      isCidr,
      'CIDR 형식이 아닙니다 (예: 10.244.0.0/16)',
    );
    checkAll(
      [
        ['firstHost', firstHost], ['lastHost', lastHost],
        ['podFirstHost', podFirstHost], ['podLastHost', podLastHost],
        ['svcFirstHost', svcFirstHost], ['svcLastHost', svcLastHost],
      ],
      isIpv4,
      'IPv4 주소 형식이 아닙니다 (예: 10.244.0.1)',
    );
    checkAll(
      [['bond0Ip', bond0Ip], ['bond1Ip', bond1Ip]],
      isIpOrCidr,
      'IPv4 주소 또는 CIDR 형식이 아닙니다 (예: 192.168.0.10 또는 192.168.0.10/24)',
    );
    checkAll(
      [['bond0Mac', bond0Mac], ['bond1Mac', bond1Mac]],
      (v) => MAC_RE.test(v),
      'MAC 주소 형식이 아닙니다 (예: aa:bb:cc:dd:ee:ff)',
    );
    if (bgpEnabled) {
      const v = asNumber.trim();
      if (v && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 4294967295)) {
        errs.asNumber = 'AS Number 는 1~4294967295 사이 숫자여야 합니다';
      }
    }
    return errs;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cluster || saving) return;

    const errs = validate();
    setFieldErrors(errs);
    const keys = Object.keys(errs);
    if (keys.length > 0) {
      // 오류가 있는 첫 필드의 탭으로 이동시켜, 다른 탭에 숨은 오류로 막히지 않게 한다.
      const firstTab = FIELD_TAB[keys[0]];
      if (firstTab) setTab(firstTab);
      setError(`입력값 ${keys.length}건을 확인해 주세요.`);
      return;
    }

    setSaving(true);
    setError('');
    try {
      // 빈 값은 `null` 로 보내야 실제로 해제된다 — `undefined` 는 직렬화에서 사라지고
      // 백엔드가 `exclude_unset=True` 라 "미전송 = 기존 값 유지"가 된다. (D-031)
      const payload: ClusterManageUpdate = {
        region: orNull(region),
        operationLevel: operationLevel || null,
        nodeCount: nodeCount.trim() ? Number(nodeCount) : null,
        maxPod: maxPod.trim() ? Number(maxPod) : null,
        hostname: orNull(hostname),
        cidr: orNull(cidr),
        internalIps: orNull(internalIps),
        firstHost: orNull(firstHost),
        lastHost: orNull(lastHost),
        podCidr: orNull(podCidr),
        podFirstHost: orNull(podFirstHost),
        podLastHost: orNull(podLastHost),
        svcCidr: orNull(svcCidr),
        svcFirstHost: orNull(svcFirstHost),
        svcLastHost: orNull(svcLastHost),
        bond0Ip: orNull(bond0Ip),
        bond0Mac: orNull(bond0Mac),
        bond1Ip: orNull(bond1Ip),
        bond1Mac: orNull(bond1Mac),
        ciliumConfig: orNull(ciliumConfig),
        description: orNull(description),
        bgpEnabled,
        asNumber: orNull(asNumber),
        prometheusUrl: orNull(prometheusUrl),
        prometheusEnabled,
        alertmanagerUrl: orNull(alertmanagerUrl),
        observabilityMode,
        observabilityEnabled,
      };
      await clustersApi.update(cluster.id, payload as Record<string, unknown>);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      // 저장 성공을 명시적으로 알린다 — 이전엔 목록으로 튕기기만 해 반영 여부가 불확실했다 (D-037)
      toast.success('클러스터 정보를 저장했습니다.', cluster.name);
      baselineRef.current = serialize(snapshot);   // 이탈 경고가 뜨지 않도록 기준 갱신
      navigate('/cluster-manage');
    } catch (err) {
      // 실제 API 오류(422 검증 실패 등)를 그대로 노출 — 이전엔 고정 문구로 덮여 있었다.
      setError(formatApiError(err, '저장에 실패했습니다. 다시 시도해 주세요.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-min-h-screen bg-background">
      <main className="max-w-[1200px] mx-auto px-8 py-8">
        {/* Page header */}
        <div className="flex items-center gap-3 mb-6">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={requestLeave}
            title="목록으로"
            aria-label="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Server className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold">클러스터 정보 수정</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{cluster?.name}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <MacCard title="클러스터 정보" bodyPadding="p-0">
          {/* 공통 상단 필드 */}
          <div className="px-6 pt-5 pb-5 grid grid-cols-1 md:grid-cols-3 gap-4 border-b border-border">
            <div>
              <label htmlFor={f('region')} className={lc}>지역</label>
              <input id={f('region')} type="text" value={region} onChange={(e) => setRegion(e.target.value)}
                placeholder="예: 서울, ap-northeast-2" className={ic} />
            </div>
            <div>
              <label htmlFor={f('opsLevel')} className={lc}>운영레벨</label>
              <select id={f('opsLevel')} value={operationLevel} onChange={(e) => setLevel(e.target.value)} className={ic}>
                <option value="">— 선택 —</option>
                {opsLevels.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={f('hostname')} className={lc}>호스트명</label>
              <input id={f('hostname')} type="text" value={hostname} onChange={(e) => setHostname(e.target.value)}
                placeholder="k8s-prod-master.example.com" className={ic} />
            </div>
          </div>

          {/* 탭 — WAI-ARIA tabs 패턴(roving tabindex + 좌우/Home/End 이동), D-036 */}
          <div role="tablist" aria-label="클러스터 정보 항목" className="flex gap-1 px-6 pt-4 border-b border-border">
            {TABS.map((t, idx) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  id={f(`tab-${t.id}`)}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={f(`panel-${t.id}`)}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => onTabKeyDown(e, idx)}
                  className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    active
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="p-6 space-y-5">
            {/* 저장 실패·검증 오류는 스크린리더에도 즉시 고지 (D-036) */}
            {error && (
              <div role="alert" className="px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-md text-sm text-destructive">
                {error}
              </div>
            )}

            <div
              role="tabpanel"
              id={f(`panel-${tab}`)}
              aria-labelledby={f(`tab-${tab}`)}
              className="space-y-5"
            >
            {tab === 'node' && (
              <>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">노드 스펙</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor={f('nodeCount')} className={lc}>노드 수</label>
                      <input id={f('nodeCount')} type="number" min="0" value={nodeCount} onChange={(e) => setNodeCount(e.target.value)}
                        placeholder="예: 5" className={ic} />
                    </div>
                    <div>
                      <label htmlFor={f('maxPod')} className={lc}>Max Pod (노드당)</label>
                      <input id={f('maxPod')} type="number" min="0" value={maxPod} onChange={(e) => setMaxPod(e.target.value)}
                        placeholder="예: 110" className={ic} />
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">NIC 정보 (ifconfig)</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-3 border border-border rounded-md p-4 bg-muted/10">
                      <p className="text-sm font-semibold text-primary">bond0</p>
                      <div>
                        <label htmlFor={f('bond0Ip')} className={lc}>IP 주소</label>
                        <input id={f('bond0Ip')} type="text" value={bond0Ip} onChange={(e) => setBond0Ip(e.target.value)}
                          aria-invalid={!!fieldErrors.bond0Ip}
                          placeholder="192.168.0.10/24" className={ic + invalidCls('bond0Ip')} />
                        {fieldMsg('bond0Ip')}
                      </div>
                      <div>
                        <label htmlFor={f('bond0Mac')} className={lc}>MAC 주소</label>
                        <input id={f('bond0Mac')} type="text" value={bond0Mac} onChange={(e) => setBond0Mac(e.target.value)}
                          aria-invalid={!!fieldErrors.bond0Mac}
                          placeholder="aa:bb:cc:dd:ee:ff" className={ic + invalidCls('bond0Mac')} />
                        {fieldMsg('bond0Mac')}
                      </div>
                    </div>
                    <div className="space-y-3 border border-border rounded-md p-4 bg-muted/10">
                      <p className="text-sm font-semibold text-primary">bond1</p>
                      <div>
                        <label htmlFor={f('bond1Ip')} className={lc}>IP 주소</label>
                        <input id={f('bond1Ip')} type="text" value={bond1Ip} onChange={(e) => setBond1Ip(e.target.value)}
                          aria-invalid={!!fieldErrors.bond1Ip}
                          placeholder="172.16.0.10/24" className={ic + invalidCls('bond1Ip')} />
                        {fieldMsg('bond1Ip')}
                      </div>
                      <div>
                        <label htmlFor={f('bond1Mac')} className={lc}>MAC 주소</label>
                        <input id={f('bond1Mac')} type="text" value={bond1Mac} onChange={(e) => setBond1Mac(e.target.value)}
                          aria-invalid={!!fieldErrors.bond1Mac}
                          placeholder="aa:bb:cc:dd:ee:f0" className={ic + invalidCls('bond1Mac')} />
                        {fieldMsg('bond1Mac')}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">BGP 설정</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center gap-3 px-3 py-2.5 bg-background border border-border rounded-xl">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={bgpEnabled}
                          onChange={(e) => setBgpEnabled(e.target.checked)}
                          className="w-4 h-4 accent-primary rounded"
                        />
                        <span className="text-sm text-foreground">BGP 사용</span>
                      </label>
                    </div>
                    <div>
                      <label htmlFor={f('asNumber')} className={lc}>AS Number</label>
                      <input
                        id={f('asNumber')}
                        type="text"
                        value={asNumber}
                        onChange={(e) => setAsNumber(e.target.value)}
                        disabled={!bgpEnabled}
                        aria-invalid={!!fieldErrors.asNumber}
                        placeholder="예: 64512"
                        className={`${ic} disabled:opacity-40${invalidCls('asNumber')}`}
                      />
                      {fieldMsg('asNumber')}
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'network' && (
              <div className="space-y-5">
                {/* 네트워크 도메인 3종(Node/Pod/Service)은 의미색이 아니라 범주 구분이므로
                    categorical chart 토큰을 쓴다 — 고정 팔레트는 테마 전환 시 톤이 어긋난다 (D-034) */}
                <div className="rounded-md border border-chart-1/20 bg-chart-1/5 p-4 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-chart-1 uppercase tracking-wider">INTERNAL_IP — 수동 입력</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      자동수집(kubectl) nodeIps &gt; 수동 IP 리스트(정규식) &gt; fallback CIDR 순으로 표시됩니다.
                    </p>
                  </div>

                  <div>
                    <label htmlFor={f('internalIps')} className={lc}>
                      IP 리스트 (정규식)
                      <span className="ml-1.5 text-xs text-muted-foreground/70 font-normal normal-case">
                        한 줄에 한 그룹, 마지막 옥텟은 <code className="font-mono">[5-7,10]</code> 형태로 압축
                      </span>
                    </label>
                    <textarea
                      id={f('internalIps')}
                      value={internalIps}
                      onChange={(e) => setInternalIps(e.target.value)}
                      placeholder={`10.0.1.[5-7,10]\n10.0.2.[1-3]`}
                      rows={3}
                      spellCheck={false}
                      className={`${ic} resize-none font-mono text-sm`}
                    />
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Fallback CIDR
                      <span className="ml-1.5 text-xs text-muted-foreground/70 font-normal normal-case">
                        — IP 리스트가 비었을 때 표시 + CIDR Calculator 의 겹침 검사에 사용
                      </span>
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div><label htmlFor={f('cidr')} className={lc}>Fallback CIDR</label>
                        <input id={f('cidr')} type="text" value={cidr} onChange={(e) => setCidr(e.target.value)} aria-invalid={!!fieldErrors.cidr} placeholder="192.168.0.0/24" className={ic + invalidCls('cidr')} />
                        {fieldMsg('cidr')}</div>
                      <div><label htmlFor={f('firstHost')} className={lc}>First Host</label>
                        <input id={f('firstHost')} type="text" value={firstHost} onChange={(e) => setFirstHost(e.target.value)} aria-invalid={!!fieldErrors.firstHost} placeholder="192.168.0.1" className={ic + invalidCls('firstHost')} />
                        {fieldMsg('firstHost')}</div>
                      <div><label htmlFor={f('lastHost')} className={lc}>Last Host</label>
                        <input id={f('lastHost')} type="text" value={lastHost} onChange={(e) => setLastHost(e.target.value)} aria-invalid={!!fieldErrors.lastHost} placeholder="192.168.0.254" className={ic + invalidCls('lastHost')} />
                        {fieldMsg('lastHost')}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-md border border-chart-2/20 bg-chart-2/5 p-4">
                  <p className="text-sm font-semibold text-chart-2 uppercase tracking-wider mb-3">Pod CIDR 대역</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div><label htmlFor={f('podCidr')} className={lc}>Pod CIDR</label>
                      <input id={f('podCidr')} type="text" value={podCidr} onChange={(e) => setPodCidr(e.target.value)} aria-invalid={!!fieldErrors.podCidr} placeholder="10.244.0.0/16" className={ic + invalidCls('podCidr')} />
                      {fieldMsg('podCidr')}</div>
                    <div><label htmlFor={f('podFirstHost')} className={lc}>First Host</label>
                      <input id={f('podFirstHost')} type="text" value={podFirstHost} onChange={(e) => setPodFirstHost(e.target.value)} aria-invalid={!!fieldErrors.podFirstHost} placeholder="10.244.0.1" className={ic + invalidCls('podFirstHost')} />
                      {fieldMsg('podFirstHost')}</div>
                    <div><label htmlFor={f('podLastHost')} className={lc}>Last Host</label>
                      <input id={f('podLastHost')} type="text" value={podLastHost} onChange={(e) => setPodLastHost(e.target.value)} aria-invalid={!!fieldErrors.podLastHost} placeholder="10.244.255.254" className={ic + invalidCls('podLastHost')} />
                      {fieldMsg('podLastHost')}</div>
                  </div>
                </div>

                <div className="rounded-md border border-chart-3/20 bg-chart-3/5 p-4">
                  <p className="text-sm font-semibold text-chart-3 uppercase tracking-wider mb-3">Service CIDR 대역</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div><label htmlFor={f('svcCidr')} className={lc}>Service CIDR</label>
                      <input id={f('svcCidr')} type="text" value={svcCidr} onChange={(e) => setSvcCidr(e.target.value)} aria-invalid={!!fieldErrors.svcCidr} placeholder="10.96.0.0/12" className={ic + invalidCls('svcCidr')} />
                      {fieldMsg('svcCidr')}</div>
                    <div><label htmlFor={f('svcFirstHost')} className={lc}>First Host</label>
                      <input id={f('svcFirstHost')} type="text" value={svcFirstHost} onChange={(e) => setSvcFirst(e.target.value)} aria-invalid={!!fieldErrors.svcFirstHost} placeholder="10.96.0.1" className={ic + invalidCls('svcFirstHost')} />
                      {fieldMsg('svcFirstHost')}</div>
                    <div><label htmlFor={f('svcLastHost')} className={lc}>Last Host</label>
                      <input id={f('svcLastHost')} type="text" value={svcLastHost} onChange={(e) => setSvcLast(e.target.value)} aria-invalid={!!fieldErrors.svcLastHost} placeholder="10.111.255.254" className={ic + invalidCls('svcLastHost')} />
                      {fieldMsg('svcLastHost')}</div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'extra' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor={f('cilium')} className={lc}>주요 Cilium 설정</label>
                  <textarea id={f('cilium')} value={ciliumConfig} onChange={(e) => setCilium(e.target.value)}
                    placeholder={`tunnel: vxlan\nkubeProxyReplacement: strict\nipv4NativeRoutingCIDR: 10.0.0.0/8`}
                    rows={6} className={`${ic} resize-none font-mono text-sm`} />
                </div>
                <div>
                  <label htmlFor={f('desc')} className={lc}>정보 / 설명</label>
                  <textarea id={f('desc')} value={description} onChange={(e) => setDescription(e.target.value)}
                    placeholder="클러스터에 대한 추가 정보나 메모"
                    rows={5} className={`${ic} resize-none`} />
                </div>

                {/* Cluster Trends — per-cluster Prometheus 연동 (노드 메트릭 추이) */}
                <div className="rounded-md border border-chart-4/20 bg-chart-4/5 p-4 space-y-3">
                  <p className="text-sm font-semibold text-chart-4 uppercase tracking-wider">메트릭 추이 (Prometheus)</p>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="accent-primary" checked={prometheusEnabled}
                      onChange={(e) => setPrometheusEnabled(e.target.checked)} />
                    이 클러스터에서 클러스터 추이(Prometheus) 사용
                  </label>
                  <div>
                    <label htmlFor={f('prometheusUrl')} className={lc}>Prometheus URL (선택 — 전역값 오버라이드)</label>
                    <input id={f('prometheusUrl')} type="text" value={prometheusUrl}
                      onChange={(e) => setPrometheusUrl(e.target.value)}
                      placeholder="비우면 전역 PROMETHEUS_URL 사용" className={ic} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    node-exporter 메트릭의 노드 식별 라벨(<code>PROMETHEUS_NODE_LABEL</code>, 기본 <code>instance</code>)
                    값이 k8s 노드명과 일치해야 per-node 추이가 매칭됩니다.
                  </p>

                  {/* Observability 대시보드(/observability) 연동 — Trends 와 독립 토글 */}
                  <div className="pt-3 mt-3 border-t border-border space-y-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" className="accent-primary" checked={observabilityEnabled}
                        onChange={(e) => setObservabilityEnabled(e.target.checked)} />
                      이 클러스터에서 Observability 대시보드 사용
                    </label>
                    <div>
                      <label htmlFor={f('alertmanagerUrl')} className={lc}>Alertmanager URL (선택 — 전역값 오버라이드)</label>
                      <input id={f('alertmanagerUrl')} type="text" value={alertmanagerUrl}
                        onChange={(e) => setAlertmanagerUrl(e.target.value)}
                        placeholder="비우면 전역 ALERTMANAGER_URL 사용" className={ic} />
                    </div>
                    <div>
                      <label htmlFor={f('observabilityMode')} className={lc}>수집 모드</label>
                      <select id={f('observabilityMode')} value={observabilityMode}
                        onChange={(e) => setObservabilityMode(e.target.value as 'pull' | 'push')}
                        className={ic}>
                        <option value="pull">pull — PEP 가 Prometheus/Alertmanager 를 직접 조회</option>
                        <option value="push">push — in-cluster 수집기가 PEP 로 스냅샷 전송</option>
                      </select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      PEP 백엔드에서 이 클러스터의 Prometheus 에 네트워크로 닿지 않으면
                      <code> push</code> 를 선택하고, 클러스터 안에 수집기 CronJob
                      (<code>k8s/base/observability/pep-collector-cronjob.yaml</code>)을 배포하세요.
                    </p>
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>

          <div className="flex justify-end gap-3 px-6 py-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={requestLeave}>
              취소
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '저장 중...' : '저장'}
            </Button>
          </div>
          </MacCard>
        </form>

        {/* 미저장 변경 이탈 확인 (D-037) */}
        <ConfirmDialog
          open={leaveOpen}
          title="저장하지 않고 나갈까요?"
          description="입력한 내용이 저장되지 않고 사라집니다."
          confirmLabel="나가기"
          cancelLabel="계속 편집"
          danger
          onConfirm={() => { setLeaveOpen(false); navigate('/cluster-manage'); }}
          onCancel={() => setLeaveOpen(false)}
        />
      </main>
    </div>
  );
}
