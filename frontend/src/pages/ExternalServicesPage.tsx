// 외부 서비스 — 로그인 없이 여는 공개 화면(App.tsx 가 AuthGate 바깥에서 렌더).
// 클러스터가 밖으로 노출한 도메인·IP:Port 목록. 데이터는 저장된 수집 스냅샷(비인증 공개 API)이며,
// 로그인한 operator 는 같은 화면에서 "지금 수집"(노드 nslookup 역조회 포함, 실시간 로그)을 돌린다.
// 클러스터·유형·검색어를 URL 쿼리(c, k, q)에 담아 링크로 공유한다.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Globe, RefreshCw, Search, X } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { CollectPanel, ExternalServicesTable, KIND_OPTIONS, domainOf, matches, toCsv } from '@/components/external-services';
import { PublicPageLinks } from '@/components/public-pages';
import { useExternalServiceClusters, useExternalServices } from '@/hooks/useExternalServices';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import type { ExternalServiceKind } from '@/types';

const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
const ICON_BTN = 'inline-flex items-center justify-center w-8 h-8 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
const CHIP = 'text-sm px-3 py-1 rounded-xl border transition-colors';
const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
const CHIP_OFF = 'border-border bg-card text-foreground hover:bg-secondary';

const isKind = (v: string | null): v is ExternalServiceKind => KIND_OPTIONS.some((o) => o.value === v);

export function ExternalServicesPage() {
  const [params, setParams] = useSearchParams();
  const loggedIn = useAuthStore((s) => !!s.token && !!s.user);
  const meta = useExternalServiceClusters();
  const clusters = useMemo(() => meta.data?.clusters ?? [], [meta.data]);
  const clusterId = params.get('c') && clusters.some((c) => c.id === params.get('c'))
    ? (params.get('c') as string) : (clusters[0]?.id ?? '');
  const kind = isKind(params.get('k')) ? (params.get('k') as ExternalServiceKind) : null;
  const q = params.get('q') ?? '';
  const [qInput, setQInput] = useState(q);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    if (qInput === q) return undefined;
    const t = setTimeout(() => update({ q: qInput.trim() }), 250);
    return () => clearTimeout(t);
    // update 는 params 기반이라 qInput 변화에만 반응하면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  useEffect(() => {
    if (clusterId && params.get('c') !== clusterId) {
      const next = new URLSearchParams(params);
      next.set('c', clusterId);
      setParams(next, { replace: true });
    }
  }, [clusterId, params, setParams]);

  const view = useExternalServices(clusterId);
  const data = view.data;
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of entries) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [entries]);
  const rows = useMemo(
    // 도메인이 확인된 행을 먼저(도메인 순), 이름 미확인은 뒤로(주소 순).
    () => entries.filter((e) => (!kind || e.kind === kind) && matches(e, q))
      .map((e) => ({ e, d: domainOf(e).primary }))
      .sort((x, y) => (x.d ? 0 : 1) - (y.d ? 0 : 1)
        || (x.d ?? x.e.ip ?? '').localeCompare(y.d ?? y.e.ip ?? '') || x.e.port - y.e.port)
      .map(({ e }) => e),
    [entries, kind, q],
  );
  const nodeHint = data?.nodeIps.length
    ? `노드 주소: ${data.nodeIps.map((n) => n.externalIp || n.internalIp).filter(Boolean).join(', ')}` : undefined;
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? '';

  const downloadCsv = () => {
    const blob = new Blob([`\uFEFF${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `external-services-${clusterName || 'cluster'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const header = (
    <PageHeader
      icon={Globe}
      title="외부 서비스"
      description="클러스터가 외부로 노출한 도메인 · IP:Port 목록 — Ingress · LoadBalancer · ExternalIP · NodePort"
      actions={<PublicPageLinks />}
    />
  );

  if (meta.isLoading) {
    return <div className="min-h-screen bg-background"><PageShell density="hub" className="mx-auto">{header}<LoadingState /></PageShell></div>;
  }
  if (meta.isError) {
    const status = (meta.error as { response?: { status?: number } })?.response?.status;
    return (
      <div className="min-h-screen bg-background">
        <PageShell density="hub" className="mx-auto space-y-4">
          {header}
          {status === 404
            ? <EmptyState title="외부 서비스 목록이 공개되어 있지 않습니다" description="관리자가 외부 서비스 설정에서 공개 페이지를 끈 상태입니다." />
            : <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />}
        </PageShell>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageShell density="hub" className="mx-auto space-y-4">
        {header}
        {clusters.length === 0 ? (
          <EmptyState title="공개된 클러스터가 없습니다"
            description="테넌트에 묶이지 않은 클러스터가 없거나, 설정의 공개 클러스터 목록이 비어 있습니다." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="클러스터 선택">
                {clusters.map((c) => (
                  <button key={c.id} type="button" aria-pressed={c.id === clusterId}
                    className={cn(CHIP, c.id === clusterId ? CHIP_ON : CHIP_OFF)} onClick={() => update({ c: c.id })}>
                    {c.name}
                  </button>
                ))}
              </div>
              <label className="relative flex items-center">
                <Search className="absolute left-2.5 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)}
                  placeholder="도메인 · IP · 포트 · 네임스페이스 검색" aria-label="도메인·IP·포트·네임스페이스 검색"
                  className="w-72 max-w-full text-sm pl-8 pr-8 py-1.5 rounded-xl border border-border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                {qInput && (
                  <button type="button" className="absolute right-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setQInput('')} title="검색어 지우기" aria-label="검색어 지우기">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </label>
              <button type="button" className={cn(ICON_BTN, 'ml-auto')} onClick={() => void view.refetch()}
                title="다시 불러오기" aria-label="다시 불러오기" disabled={view.isFetching}>
                <RefreshCw className={cn('w-4 h-4', view.isFetching && 'animate-spin')} />
              </button>
            </div>

            {loggedIn && clusterId && <CollectPanel clusterId={clusterId} clusterName={clusterName} />}

            {view.isError ? (
              <ErrorState error={view.error} onRetry={() => void view.refetch()} />
            ) : !data ? (
              <LoadingState />
            ) : !data.collectedAt ? (
              <EmptyState icon={Globe} title="아직 수집된 목록이 없습니다"
                description="정기 수집(기본 매시)이 돌면 채워진다. 운영자는 로그인 후 이 화면의 '지금 수집'으로 바로 채울 수 있다." />
            ) : (
              <MacCard
                title={`${data.cluster.name} · ${rows.length}/${entries.length}건`}
                description={`${new Date(`${data.collectedAt}Z`).toLocaleString()} ${data.collectedBy ?? ''} · 도메인 확인 ${data.summary?.resolved ?? 0}/${data.summary?.ips ?? 0} IP`}
                actions={(
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" aria-pressed={!kind} className={cn(CHIP, 'text-xs px-2.5', !kind ? CHIP_ON : CHIP_OFF)}
                      onClick={() => update({ k: '' })}>전체 {entries.length}</button>
                    {KIND_OPTIONS.map((o) => (
                      <button key={o.value} type="button" title={o.help} aria-pressed={kind === o.value}
                        className={cn(CHIP, 'text-xs px-2.5', kind === o.value ? CHIP_ON : CHIP_OFF)}
                        onClick={() => update({ k: o.value })}>
                        {o.label} {counts[o.value] ?? 0}
                      </button>
                    ))}
                    <button type="button" className={cn(BTN, 'text-xs px-2.5 py-1')} onClick={downloadCsv} disabled={rows.length === 0}>
                      <Download className="w-3.5 h-3.5" /> CSV
                    </button>
                  </div>
                )}
                bodyPadding="p-0"
              >
                {data.error && (
                  <p className="px-4 py-2 text-xs text-status-warning border-b border-border">
                    마지막 수집 시도 실패 — 아래는 직전 성공 스냅샷이다: {data.error}
                  </p>
                )}
                {rows.length === 0 ? (
                  <EmptyState compact icon={Search} title="조건에 맞는 엔드포인트가 없습니다"
                    description="유형 필터나 검색어를 바꿔본다." />
                ) : (
                  <ExternalServicesTable rows={rows} nodeHint={nodeHint} />
                )}
              </MacCard>
            )}

            {data && data.nodeIps.length > 0 && (counts.NodePort ?? 0) > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">NodePort 접근 노드 주소 {data.nodeIps.length}개</summary>
                <p className="mt-1 font-mono leading-relaxed">
                  {data.nodeIps.map((n) => `${n.name} ${n.externalIp ?? n.internalIp ?? ''}`).join(' · ')}
                </p>
              </details>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed">
              도메인은 Ingress 에 선언된 host → LB 호스트명 → 외부 IP 역조회(노드 nslookup 또는 PTR) 순으로 고른다.
              목록은 저장된 수집 결과이며 실시간 상태가 아니다.
            </p>
          </>
        )}
      </PageShell>
    </div>
  );
}
