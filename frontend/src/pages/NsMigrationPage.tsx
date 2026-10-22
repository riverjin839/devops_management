/**
 * NS 마이그레이션 (`/ns-migration`)
 *
 * 개발 클러스터의 네임스페이스 리소스(Namespace · ServiceAccount · RBAC · ConfigMap · 쿼터 + 선택 시
 * 워크로드·Secret)를 운영 클러스터로 옮긴다. 소스 수집 → 정리(uid·status·할당 IP 제거) → 치환 규칙 →
 * 타깃과 비교(diff)·서버 dry-run → server-side apply. YAML 번들만 내려받아 GitOps 로 반영할 수도 있다.
 *
 * 두 클러스터(소스/타깃)를 동시에 고르는 화면이라 per-cluster 화면의 ClusterSidebar 대신 소스 → 타깃
 * 선택 카드를 쓴다(DESIGN_SYSTEM.md §12.5 예외).
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Download, Eye, Loader2, Rocket, Save, Trash2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, PageShell, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { NsMigrationRunPanel, RuleEditor } from '@/components/ns-migration';
import { RunStatePill } from '@/components/k8s-allocation/EfficiencyRunLog';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useClusters } from '@/hooks/useCluster';
import {
  useNsMigKinds, useNsMigMutations, useNsMigNamespaces, useNsMigProfiles, useNsMigRuns,
} from '@/hooks/useNsMigration';
import { nsMigrationApi } from '@/services/api';
import { formatApiError, formatDateTime } from '@/lib/utils';
import type { NsMigKind, NsMigProfile, NsMigRule, NsMigSpec } from '@/types';

const fieldCls = 'w-full px-2 py-1.5 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50';
const btnCls = 'shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const GROUP_LABEL: Record<NsMigKind['group'], string> = { base: '기본', workload: '워크로드 (선택)', secret: 'Secret' };
const NS_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function NsMigrationPage() {
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const { data: catalog } = useNsMigKinds();
  const { data: profiles = [] } = useNsMigProfiles();
  const { data: runs = [] } = useNsMigRuns();
  const { createRun, saveProfile, deleteProfile } = useNsMigMutations();

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [sourceNs, setSourceNs] = useState('');
  const [targetNs, setTargetNs] = useState('');
  const [targetNsTouched, setTargetNsTouched] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [rules, setRules] = useState<NsMigRule[]>([]);
  const [keepNodePorts, setKeepNodePorts] = useState(false);
  const [forceConflicts, setForceConflicts] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [exporting, setExporting] = useState(false);

  const { canOperate, withHint, ariaWithHint } = useCanOperate(targetId || null);
  const { data: srcNsList, isFetching: nsLoading } = useNsMigNamespaces(sourceId || null);

  useEffect(() => {
    if (catalog && kinds.length === 0 && !profileId) setKinds(catalog.defaultKinds);
  }, [catalog, kinds.length, profileId]);
  useEffect(() => {
    if (!targetNsTouched) setTargetNs(sourceNs);
  }, [sourceNs, targetNsTouched]);

  const clusterName = useMemo(() => {
    const m = new Map(clusters.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [clusters]);
  const groups = useMemo(() => {
    const g: Record<NsMigKind['group'], NsMigKind[]> = { base: [], workload: [], secret: [] };
    (catalog?.data ?? []).forEach((k) => g[k.group].push(k));
    return g;
  }, [catalog]);

  const spec: NsMigSpec = {
    sourceClusterId: sourceId, targetClusterId: targetId, sourceNamespace: sourceNs, targetNamespace: targetNs,
    kinds: kinds.filter((k) => k !== 'Secret'), includeSecrets,
    rules: rules.filter((r) => r.to.trim() !== '' || r.from.trim() !== ''),
    options: { keepNodePorts, forceConflicts },
  };
  const invalid =
    !sourceId ? '소스 클러스터를 고르세요'
      : !targetId ? '타깃 클러스터를 고르세요'
        : sourceId === targetId ? '소스와 타깃 클러스터가 같습니다'
          : !sourceNs ? '소스 네임스페이스를 고르세요'
            : !NS_RE.test(targetNs) ? '타깃 네임스페이스 이름이 올바르지 않습니다' : null;

  const toggleKind = (k: string) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const loadProfile = (p: NsMigProfile | undefined) => {
    if (!p) { setProfileId(null); setProfileName(''); return; }
    setProfileId(p.id); setProfileName(p.name);
    setSourceId(p.sourceClusterId); setTargetId(p.targetClusterId);
    setSourceNs(p.sourceNamespace); setTargetNs(p.targetNamespace); setTargetNsTouched(true);
    setKinds(p.kinds); setIncludeSecrets(p.includeSecrets); setRules(p.rules);
    setKeepNodePorts(!!p.options?.keepNodePorts); setForceConflicts(!!p.options?.forceConflicts);
  };

  const start = (mode: 'plan' | 'apply') => {
    createRun.mutate({ ...spec, mode }, {
      onSuccess: (run) => {
        setRunId(run.id);
        toast.success(mode === 'apply' ? '운영 적용을 시작했습니다' : '계획(dry-run)을 시작했습니다', '실행 로그에서 진행을 확인하세요');
      },
      onError: (e) => toast.error('실행 실패', formatApiError(e, '실행을 큐잉하지 못했습니다.')),
    });
  };

  const download = async () => {
    setExporting(true);
    try {
      const res = await nsMigrationApi.exportBundle(spec);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ns-migration-${sourceNs}-to-${targetNs}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('YAML 번들을 내려받았습니다');
    } catch (e) {
      toast.error('YAML 다운로드 실패', formatApiError(e, '소스 리소스를 수집하지 못했습니다.'));
    } finally {
      setExporting(false);
    }
  };

  const onSaveProfile = () => {
    const name = profileName.trim() || `${sourceNs} → ${clusterName(targetId)}`;
    saveProfile.mutate({ ...spec, name, id: profileId }, {
      onSuccess: (p) => { setProfileId(p.id); setProfileName(p.name); toast.success('프로필 저장됨', p.name); },
      onError: (e) => toast.error('프로필 저장 실패', formatApiError(e, '프로필을 저장하지 못했습니다.')),
    });
  };

  const targetName = targetId ? clusterName(targetId) : '';
  const busy = createRun.isPending;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" sidebar={false} className="space-y-3">
        <PageHeader
          icon={ArrowRightLeft}
          title="NS 마이그레이션"
          description="개발 클러스터의 네임스페이스 리소스를 운영 클러스터로 옮긴다 — 미리보기(diff·서버 dry-run) 후 적용하거나 YAML 로 내려받는다."
        />
        <div className="flex gap-3 items-start flex-col xl:flex-row">
          {/* 좌: 컨트롤 */}
          <div className="w-full xl:w-[440px] shrink-0 space-y-3">
            <MacCard title="프로필">
              <div className="space-y-2">
                <select value={profileId ?? ''} aria-label="저장된 프로필"
                  onChange={(e) => loadProfile(profiles.find((p) => p.id === e.target.value))} className={fieldCls}>
                  <option value="">새 마이그레이션</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div className="flex gap-2">
                  <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="프로필 이름"
                    aria-label="프로필 이름" className={fieldCls} />
                  <button type="button" onClick={onSaveProfile} disabled={!canOperate || !!invalid || saveProfile.isPending}
                    title={withHint(invalid ?? '현재 설정을 프로필로 저장')} aria-label={ariaWithHint('프로필 저장')} className={btnCls}>
                    <Save className="w-4 h-4" /> 저장
                  </button>
                  {profileId && (
                    <button type="button" disabled={!canOperate || deleteProfile.isPending}
                      onClick={() => deleteProfile.mutate(profileId, { onSuccess: () => loadProfile(undefined) })}
                      title={withHint('프로필 삭제')} aria-label={ariaWithHint('프로필 삭제')} className={btnCls}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </MacCard>

            <MacCard title="소스 → 타깃">
              <div className="space-y-3">
                <fieldset className="space-y-1.5">
                  <legend className="text-xs text-muted-foreground mb-1">소스 (개발)</legend>
                  <select value={sourceId} aria-label="소스 클러스터"
                    onChange={(e) => { setSourceId(e.target.value); setSourceNs(''); }} className={fieldCls}>
                    <option value="">클러스터 선택</option>
                    {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={sourceNs} aria-label="소스 네임스페이스" disabled={!sourceId || nsLoading}
                    onChange={(e) => setSourceNs(e.target.value)} className={fieldCls}>
                    <option value="">{nsLoading ? '네임스페이스 불러오는 중…' : '네임스페이스 선택'}</option>
                    {(srcNsList?.data ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
                    {sourceNs && !(srcNsList?.data ?? []).includes(sourceNs) && <option value={sourceNs}>{sourceNs}</option>}
                  </select>
                  {srcNsList?.error && <p className="text-xs text-status-critical break-all">{srcNsList.error}</p>}
                </fieldset>
                <fieldset className="space-y-1.5">
                  <legend className="text-xs text-muted-foreground mb-1">타깃 (운영)</legend>
                  <select value={targetId} aria-label="타깃 클러스터" onChange={(e) => setTargetId(e.target.value)} className={fieldCls}>
                    <option value="">클러스터 선택</option>
                    {clusters.filter((c) => c.id !== sourceId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input value={targetNs} aria-label="타깃 네임스페이스" placeholder="타깃 네임스페이스(기본: 소스와 동일)"
                    onChange={(e) => { setTargetNs(e.target.value); setTargetNsTouched(true); }} className={fieldCls} />
                </fieldset>
              </div>
            </MacCard>

            <MacCard title="리소스 종류">
              <div className="space-y-3">
                {(['base', 'workload'] as const).map((g) => (
                  <div key={g}>
                    <p className="text-xs text-muted-foreground mb-1">{GROUP_LABEL[g]}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                      {groups[g].map((k) => (
                        <label key={k.kind} className="inline-flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={kinds.includes(k.kind)} onChange={() => toggleKind(k.kind)} />
                          {k.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="space-y-1">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
                    Secret 포함
                  </label>
                  <p className="text-xs text-muted-foreground">
                    기본 제외. 포함해도 ServiceAccount 토큰·Helm release Secret 은 항상 제외되고, 로그·미리보기에서는 값이 가려진다.
                    YAML 번들에는 원문이 들어간다.
                  </p>
                </div>
                <div className="space-y-1 pt-1 border-t border-border">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={keepNodePorts} onChange={(e) => setKeepNodePorts(e.target.checked)} />
                    Service nodePort 유지
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={forceConflicts} onChange={(e) => setForceConflicts(e.target.checked)} />
                    필드 소유권 충돌 시 덮어쓰기(force)
                  </label>
                </div>
              </div>
            </MacCard>

            <MacCard title="치환 규칙">
              <RuleEditor rules={rules} onChange={setRules} kinds={kinds} />
            </MacCard>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => start('plan')} disabled={!!invalid || busy || !canOperate}
                title={withHint(invalid ?? '타깃과 비교하고 서버 dry-run 으로 검증한다(쓰기 없음)')}
                aria-label={ariaWithHint('미리보기')} className={btnCls}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} 미리보기
              </button>
              <button type="button" onClick={download} disabled={!!invalid || exporting || !canOperate}
                title={withHint(invalid ?? '변환된 다중 문서 YAML 다운로드(GitOps·수동 적용용)')}
                aria-label={ariaWithHint('YAML 다운로드')} className={btnCls}>
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} YAML 다운로드
              </button>
              <button type="button" onClick={() => { setConfirmText(''); setConfirmOpen(true); }}
                disabled={!!invalid || busy || !canOperate}
                title={withHint(invalid ?? '타깃 클러스터에 server-side apply')} aria-label={ariaWithHint('운영 적용')}
                className={`${btnCls} bg-primary text-primary-foreground border-primary hover:bg-primary/90`}>
                <Rocket className="w-4 h-4" /> 운영 적용
              </button>
            </div>
          </div>

          {/* 우: 결과 */}
          <div className="flex-1 min-w-0 w-full space-y-3">
            {runId ? (
              <NsMigrationRunPanel runId={runId} clusterName={clusterName} onClose={() => setRunId(null)} />
            ) : (
              <MacCard title="실행 결과">
                <EmptyState compact icon={ArrowRightLeft} title="아직 실행한 계획이 없습니다"
                  description="소스·타깃을 고르고 미리보기를 누르면 리소스별 생성/갱신/동일 여부와 diff, 실시간 로그가 여기에 표시된다." />
              </MacCard>
            )}
            <MacCard title="실행 이력" bodyPadding="p-0">
              {runs.length === 0 ? (
                <div className="p-4"><EmptyState compact title="실행 이력이 없습니다" /></div>
              ) : (
                <ul>
                  {runs.map((r) => (
                    <li key={r.id} className="border-b border-border/60 last:border-b-0">
                      <button type="button" onClick={() => setRunId(r.id)} aria-current={r.id === runId}
                        className={`w-full text-left px-3 py-2 flex items-center gap-2 flex-wrap text-sm hover:bg-secondary ${r.id === runId ? 'bg-secondary' : ''}`}>
                        <RunStatePill state={r.runState} />
                        <span className="font-medium">{r.mode === 'apply' ? '적용' : '계획'}</span>
                        <span className="text-muted-foreground">
                          {clusterName(r.sourceClusterId)}/{r.sourceNamespace} → {clusterName(r.targetClusterId)}/{r.targetNamespace}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {r.triggeredBy ?? '—'} · {r.queuedAt ? formatDateTime(r.queuedAt) : '-'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </MacCard>
          </div>
        </div>
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="운영 클러스터에 적용"
        description={`${clusterName(sourceId)}/${sourceNs} 의 리소스를 ${targetName}/${targetNs} 에 server-side apply 한다. 타깃에만 있는 리소스는 지우지 않는다.`}
        confirmLabel="적용"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          if (confirmText.trim() !== targetName) return;
          setConfirmOpen(false);
          start('apply');
        }}
      >
        <label className="block text-sm space-y-1">
          <span className="text-muted-foreground">확인을 위해 타깃 클러스터 이름 <b className="text-foreground">{targetName}</b> 을 입력하세요.</span>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="타깃 클러스터 이름 확인"
            className={fieldCls} autoComplete="off" />
          {confirmText && confirmText.trim() !== targetName && (
            <span className="text-xs text-status-critical">이름이 일치하지 않습니다.</span>
          )}
        </label>
        <p className="text-xs text-muted-foreground">
          {kinds.length + (includeSecrets ? 1 : 0)}종 리소스 · 치환 규칙 {spec.rules.length}개
          {includeSecrets && ' · Secret 포함'}. 먼저 미리보기로 diff 를 확인하는 것을 권장한다.
        </p>
      </ConfirmDialog>
    </div>
  );
}
