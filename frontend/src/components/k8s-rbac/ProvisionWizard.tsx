/**
 * 개발자 권한 발급 마법사 — 프리셋 → 대상 → 권한 규칙 → (고급: 바인딩 방식·토큰) → 실행.
 * 고르는 동안 발급이 여는 범위·위험도를 하단 바에 실시간으로 보여주고, 모의 실행은 보조 버튼으로 둔다.
 *
 * 개발자는 보통 자기 네임스페이스 하나에 배포하지만 다른 네임스페이스도 필요할 때가 있어,
 * 주 네임스페이스와 추가 네임스페이스를 함께 받아 한 번에 붙인다.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ChevronRight, FlaskConical, Play, Plus, X } from 'lucide-react';
import { SwitchToggle } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import type {
  RbacBindingMode,
  RbacNamespace,
  RbacPolicyRule,
  RbacPresetCatalog,
  RbacProvisionRequest,
} from '@/types';
import { grantRiskReasons, isClusterWideMode, isWriteVerb, radioArrowKey, saNameProblem } from './rbacShared';
import { useClusters } from '@/hooks/useCluster';
import { GrantRiskDialog } from './GrantRiskDialog';
import { RiskBadge } from './RbacTags';
import { RuleEditor } from './RuleEditor';

interface ProvisionWizardProps {
  /** 테넌트 바인딩까지 반영한 실행 권한 판정용(§12.9). */
  clusterId: string;
  catalog: RbacPresetCatalog | undefined;
  namespaces: RbacNamespace[];
  /** 네임스페이스 조회 상태 — 실패면 상단 배너 + 발급 버튼 비활성(사유)(D-139). */
  namespacesLoading?: boolean;
  namespacesError?: unknown;
  onRetryNamespaces?: () => void;
  running: boolean;
  onRun: (req: RbacProvisionRequest) => void;
}

const NS_ERROR_PROBLEM = '네임스페이스 목록을 불러오지 못했습니다 — 다시 시도한 뒤 발급하세요.';

/** 0 = 만료 없는 Secret 토큰(TokenRequest 가 아님). 토큰 방식과 유효기간을 하나의 선택으로 합쳤다. */
const NO_EXPIRY = 0;
const TTL_OPTIONS = [
  { label: '4시간', value: 4 * 3600 },
  { label: '1일', value: 24 * 3600 },
  { label: '7일', value: 7 * 24 * 3600 },
  { label: '30일', value: 30 * 24 * 3600 },
  { label: '90일', value: 90 * 24 * 3600 },
  { label: '만료 없음 (Secret 토큰)', value: NO_EXPIRY },
];
const DEFAULT_TTL = 7 * 24 * 3600; // 기존 기본값(7일) 유지 — 옵션 순서가 바뀌어도 기본값이 따라 바뀌지 않게 값으로 고정

export function ProvisionWizard({
  clusterId, catalog, namespaces, namespacesLoading = false, namespacesError, onRetryNamespaces, running, onRun,
}: ProvisionWizardProps) {
  const { canOperate, hint, withHint } = useCanOperate(clusterId);
  const { data: clusters = [] } = useClusters();
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? '';

  const [presetKey, setPresetKey] = useState<string>('dev-deploy');
  const [rules, setRules] = useState<RbacPolicyRule[]>([]);
  const [rulesTouched, setRulesTouched] = useState(false);
  const [saName, setSaName] = useState('');
  const [primaryNs, setPrimaryNs] = useState('');
  const [extraNs, setExtraNs] = useState<string[]>([]);
  const [extraInput, setExtraInput] = useState('');
  const [bindingMode, setBindingMode] = useState<RbacBindingMode>('clusterrole-rolebinding');
  const [createNamespace, setCreateNamespace] = useState(false);
  const [issueKubeconfig, setIssueKubeconfig] = useState(true);
  const [verify, setVerify] = useState(true);
  const [ttl, setTtl] = useState(DEFAULT_TTL);
  const longLived = ttl === NO_EXPIRY;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  const preset = useMemo(
    () => catalog?.presets.find((p) => p.key === presetKey),
    [catalog, presetKey],
  );

  // 프리셋을 고르면 규칙을 그 템플릿으로 갈아끼운다 — 프리셋 **키가 바뀔 때만**.
  // `preset` 객체는 카탈로그 리패치마다 새로 만들어질 수 있어, 객체에 걸면 사용자가 좁혀 둔
  // 규칙이 프리셋 기본값(더 넓은 권한)으로 조용히 되돌아간 채 발급될 수 있다.
  const [appliedPresetKey, setAppliedPresetKey] = useState<string | null>(null);
  useEffect(() => {
    if (!preset || appliedPresetKey === preset.key) return;
    setRules(preset.rules.map((r) => ({ ...r })));
    setRulesTouched(false);
    setBindingMode(preset.recommendedBindingMode);
    setAppliedPresetKey(preset.key);
  }, [preset, appliedPresetKey]);

  // 위험한 발급(모든 네임스페이스·와일드카드·Secret·exec·권한 상승·만료 없는 토큰)은 실행 전에 SA 이름을 다시 입력받는다(GrantRiskDialog).
  const [confirming, setConfirming] = useState(false);
  const riskReasons = useMemo(
    () => grantRiskReasons({ clusterWide: isClusterWideMode(bindingMode), rules, longLivedToken: longLived, presetRisk: rulesTouched ? undefined : preset?.risk }),
    [bindingMode, rules, longLived, rulesTouched, preset],
  );

  // 네임스페이스 목록이 오면 첫 값을 기본 선택으로.
  useEffect(() => {
    if (!primaryNs && namespaces.length > 0) setPrimaryNs(namespaces[0].name);
  }, [namespaces, primaryNs]);

  const addExtra = () => {
    const name = extraInput.trim();
    if (!name || name === primaryNs || extraNs.includes(name)) {
      setExtraInput('');
      return;
    }
    setExtraNs([...extraNs, name]);
    setExtraInput('');
  };

  const targetNamespaces = useMemo(
    () => [primaryNs, ...extraNs.filter((n) => n !== primaryNs)].filter(Boolean),
    [primaryNs, extraNs],
  );

  const problems = useMemo(() => {
    const out: string[] = [];
    if (namespacesError) out.push(NS_ERROR_PROBLEM);
    if (!saName.trim()) out.push('ServiceAccount 이름을 입력하세요.');
    const nameProblem = saNameProblem(saName);
    if (nameProblem) out.push(nameProblem);
    if (!primaryNs) out.push('주 네임스페이스를 고르세요.');
    if (rules.length === 0) out.push('권한 규칙이 최소 한 줄은 있어야 합니다.');
    if (rules.some((r) => r.verbs.length === 0)) out.push('동작(verb)이 비어 있는 규칙이 있습니다.');
    if (rules.some((r) => r.resources.length === 0)) out.push('리소스가 비어 있는 규칙이 있습니다.');
    return out;
  }, [saName, primaryNs, rules, namespacesError]);

  const objectSummary = useMemo(() => {
    if (bindingMode === 'clusterrole-clusterrolebinding') return 'ServiceAccount 1 · ClusterRole 1 · ClusterRoleBinding 1';
    if (bindingMode === 'role-per-namespace')
      return `ServiceAccount 1 · Role ${targetNamespaces.length} · RoleBinding ${targetNamespaces.length}`;
    return `ServiceAccount 1 · ClusterRole 1 · RoleBinding ${targetNamespaces.length}`;
  }, [bindingMode, targetNamespaces.length]);

  // 지금 입력이 여는 범위 — 고르는 동안 하단 바에서 실시간으로 보여준다(위험을 마지막에야 알게 되지 않도록).
  const scopeLabel = isClusterWideMode(bindingMode)
    ? '전체 네임스페이스'
    : targetNamespaces.length > 0
      ? `네임스페이스 ${targetNamespaces.length}개`
      : '네임스페이스 미선택';
  const writes = useMemo(() => rules.some((r) => r.verbs.some((v) => isWriteVerb(v))), [rules]);
  const expiryLabel = longLived ? '만료 없음' : `${TTL_OPTIONS.find((o) => o.value === ttl)?.label ?? ''} 후 만료`;

  const requestRun = () => {
    if (problems.length > 0 || !canOperate) return;
    if (riskReasons.length > 0) {
      setConfirming(true);
      return;
    }
    run(false);
  };

  // 모의 실행은 아무것도 만들지 않으니 확인 없이 바로 보낸다.
  const run = (dryRun: boolean) => {
    if (problems.length > 0 || !canOperate) return;
    setConfirming(false);
    onRun({
      namespace: primaryNs,
      serviceAccount: saName.trim(),
      extraNamespaces: extraNs.filter((n) => n !== primaryNs),
      bindingMode,
      rules,
      roleName: null,
      bindingName: null,
      presetKey: rulesTouched ? null : presetKey,
      createNamespace,
      verify,
      issueKubeconfig,
      longLivedToken: longLived,
      tokenTtlSeconds: longLived ? DEFAULT_TTL : ttl,
      dryRun,
    });
  };

  const inputCls =
    'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

  // 파워 유저·긴급 대응용 — 폼 어디서든 Ctrl/⌘+Enter 로 발급(위험 사유가 있으면 확인 대화상자를 거친다).
  const onFormKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !running) {
      e.preventDefault();
      requestRun();
    }
  };
  const presetKeys = (catalog?.presets ?? []).map((p) => p.key);
  const modeKeys = (catalog?.bindingModes ?? []).map((m) => m.key);
  const problemsId = 'rbac-wizard-problems';

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 폼 전체의 단축키(Ctrl+Enter) 위임
    <div className="space-y-3" onKeyDown={onFormKeyDown}>
      {/* 1. 프리셋 */}
      <MacCard title="권한 프리셋">
        <div
          className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]"
          role="radiogroup"
          aria-label="권한 프리셋"
        >
          {(catalog?.presets ?? []).map((p) => {
            const on = p.key === presetKey;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on || !presetKeys.includes(presetKey) ? 0 : -1}
                onClick={() => setPresetKey(p.key)}
                onKeyDown={(e) => radioArrowKey(e, presetKeys, presetKey, setPresetKey)}
                className={`text-left p-3 rounded-xl border transition-colors ${
                  on
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border bg-secondary hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-sm font-semibold">{p.name}</span>
                  <RiskBadge risk={p.risk} />
                </div>
                <div className="text-xs text-muted-foreground leading-relaxed">{p.summary}</div>
              </button>
            );
          })}
        </div>
      </MacCard>

      {/* 2. 대상 */}
      <MacCard title="대상">
        {namespacesError ? (
          <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">네임스페이스 목록을 불러오지 못했습니다 — 발급을 막아 두었습니다</p>
              <p className="mt-0.5 break-words">{formatApiError(namespacesError)}</p>
            </div>
            {onRetryNamespaces && (
              <button
                type="button"
                onClick={onRetryNamespaces}
                className="shrink-0 px-2 py-1 rounded-xl border border-border bg-card text-foreground hover:bg-secondary"
              >
                다시 시도
              </button>
            )}
          </div>
        ) : null}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            ServiceAccount 이름
            <input
              id="rbac-sa-name"
              value={saName}
              onChange={(e) => setSaName(e.target.value)}
              placeholder="dev-hjkim"
              spellCheck={false}
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            주 네임스페이스 (배포 대상)
            <select
              id="rbac-primary-ns"
              value={primaryNs}
              onChange={(e) => setPrimaryNs(e.target.value)}
              className={`${inputCls} font-mono`}
            >
              {namespaces.length === 0 && (
                <option value="">
                  {namespacesError ? '네임스페이스 조회 실패' : namespacesLoading ? '불러오는 중…' : '네임스페이스가 없습니다'}
                </option>
              )}
              {namespaces.map((ns) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <div className="text-xs text-muted-foreground font-medium mb-1.5">
            추가 네임스페이스 <span className="font-normal">— 같은 권한을 함께 붙입니다</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {primaryNs && (
              <span className="inline-flex items-center gap-1.5 font-mono text-xs px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 text-primary font-semibold">
                {primaryNs}
                <span className="text-xs font-normal opacity-70">주</span>
              </span>
            )}
            {extraNs
              .filter((n) => n !== primaryNs)
              .map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-1 font-mono text-xs pl-2.5 pr-1 py-1 rounded-full bg-secondary border border-border"
                >
                  {n}
                  <button
                    type="button"
                    onClick={() => setExtraNs(extraNs.filter((x) => x !== n))}
                    title={`${n} 제외`}
                    aria-label={`${n} 제외`}
                    className="p-0.5 rounded-md hover:text-destructive"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            <span className="inline-flex items-center gap-1">
              <input
                id="rbac-extra-ns"
                list="rbac-namespaces"
                value={extraInput}
                onChange={(e) => setExtraInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExtra();
                  }
                }}
                placeholder="네임스페이스 추가"
                aria-label="추가 네임스페이스 이름"
                className="w-40 px-2.5 py-1 bg-card border border-dashed border-border rounded-full text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <button
                type="button"
                onClick={addExtra}
                title="추가 네임스페이스 등록"
                aria-label="추가 네임스페이스 등록"
                className="p-1 rounded-xl border border-border hover:border-primary hover:text-primary"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </span>
            <datalist id="rbac-namespaces">
              {namespaces.map((ns) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        <div className="mt-3">
          <SwitchToggle
            checked={createNamespace}
            onChange={setCreateNamespace}
            label="네임스페이스가 없으면 함께 생성"
            disabled={!canOperate}
            hint={hint}
          />
        </div>
      </MacCard>

      {/* 4. 규칙 */}
      <MacCard title="권한 규칙">
        <details
          open={rulesOpen}
          onToggle={(e) => setRulesOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${rulesOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
            규칙 {rules.length}개 · {writes ? '쓰기 포함' : '읽기 전용'}
            <span className="text-xs font-normal text-muted-foreground">
              {rulesTouched ? '프리셋에서 수정됨' : `프리셋 ${preset?.name ?? '—'} 그대로`} — 눈으로 확인하거나 고치려면 펼치세요
            </span>
          </summary>
          <div className="mt-3">
            <RuleEditor
              rules={rules}
              onChange={(next) => {
                setRules(next);
                setRulesTouched(true);
              }}
              disabled={!canOperate}
              disabledHint={hint}
            />
          </div>
        </details>
      </MacCard>

      {/* 고급 — 기본값으로 충분한 대부분의 발급에서는 접어 둔다. 현재 값은 접힌 줄에 요약한다. */}
      <MacCard>
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${advancedOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
            고급 설정
            <span className="text-xs font-normal text-muted-foreground">
              바인딩 방식 · 토큰 유효기간 · 검증 — 현재 {isClusterWideMode(bindingMode) ? '전체 네임스페이스' : '네임스페이스 단위'} · {expiryLabel}
            </span>
          </summary>
          <div className="mt-3 space-y-4">
      <section aria-labelledby="rbac-binding-mode-h" className="space-y-2">
        <h3 id="rbac-binding-mode-h" className="text-xs font-semibold text-foreground">
          바인딩 방식 <span className="font-normal text-muted-foreground">— 권한을 어떻게 붙일 것인가</span>
        </h3>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="바인딩 방식">
          {(catalog?.bindingModes ?? []).map((m) => {
            const on = m.key === bindingMode;
            return (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on || !modeKeys.includes(bindingMode) ? 0 : -1}
                onKeyDown={(e) => radioArrowKey(e, modeKeys, bindingMode, (k) => setBindingMode(k as RbacBindingMode))}
                aria-labelledby={`rbac-bm-${m.key}-n`}
                aria-describedby={`rbac-bm-${m.key}-d`}
                onClick={() => setBindingMode(m.key)}
                className={`grid grid-cols-[18px_1fr] gap-3 items-start text-left p-3 rounded-xl border transition-colors ${
                  on ? 'border-primary bg-primary/5' : 'border-border bg-secondary hover:border-primary/40'
                }`}
              >
                <span
                  className={`w-4 h-4 mt-0.5 rounded-full bg-card ${
                    on ? 'border-[5px] border-primary' : 'border border-border'
                  }`}
                />
                <span>
                  <span id={`rbac-bm-${m.key}-n`} className="block text-sm font-semibold">{m.name}</span>
                  <span id={`rbac-bm-${m.key}-d`} className="block text-xs text-muted-foreground leading-relaxed mt-0.5">
                    {m.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="rbac-token-h" className="space-y-2">
        <h3 id="rbac-token-h" className="text-xs font-semibold text-foreground">토큰·검증</h3>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium sm:max-w-xs">
          토큰 유효기간
          <select
            id="rbac-token-ttl"
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            className={inputCls}
          >
            {TTL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {longLived && (
          <p
            role="note"
            className="mt-3 flex items-start gap-2 text-xs leading-relaxed rounded-md border border-status-warning/40 bg-status-warning/10 text-foreground px-3 py-2"
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
            만료 없는 토큰은 Secret 을 지우기 전까지 계속 유효합니다 — 노트북·채팅에 한 번 흘러나가면 회수할 때까지
            누구든 쓸 수 있습니다. 사람에게 주는 kubeconfig 라면 단기 토큰을 쓰고, CI 처럼 사람이 갱신할 수 없는 곳에만 쓰세요. 회수는 그 Secret 을 지워서 합니다.
          </p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
          <SwitchToggle checked={issueKubeconfig} onChange={setIssueKubeconfig} label="kubeconfig 발급" disabled={!canOperate} hint={hint} />
          <SwitchToggle checked={verify} onChange={setVerify} label="생성 후 권한 검증" disabled={!canOperate} hint={hint} />
        </div>
      </section>

          </div>
        </details>
      </MacCard>

      {/* 실행 — 이 발급이 여는 범위를 고르는 동안 실시간으로 보여준다 */}
      <div className="sticky bottom-3 z-10 space-y-2 p-3 rounded-md bg-card border border-border shadow-sm">
        <div aria-live="polite" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {clusterName && <span>클러스터 <span className="font-mono font-semibold text-foreground">{clusterName}</span></span>}
          <span>범위 <span className="font-medium text-foreground">{scopeLabel}</span></span>
          <span>동작 <span className="font-medium text-foreground">{writes ? '읽기 + 쓰기' : '읽기 전용'}</span></span>
          <span>토큰 <span className="font-medium text-foreground">{expiryLabel}</span></span>
          <span className="font-mono">{objectSummary}</span>
          {riskReasons.length > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <AlertTriangle className="w-3.5 h-3.5 text-status-warning" aria-hidden="true" />
              확인 필요 {riskReasons.length}건 — 발급 전에 다시 확인받습니다
            </span>
          ) : (
            <span>위험 사유 없음</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={requestRun}
            disabled={!canOperate || running || problems.length > 0}
            title={
              !canOperate
                ? hint
                : problems.length > 0
                  ? problems[0]
                  : withHint('권한 발급 실행')
            }
            aria-label="권한 발급 실행"
            aria-describedby={problems.length > 0 ? problemsId : undefined}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-4 h-4" />
            {running ? '실행 중…' : '권한 발급 실행'}
          </button>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!canOperate || running || problems.length > 0}
            title={
              !canOperate
                ? hint
                : problems.length > 0
                  ? problems[0]
                  : withHint('모의 실행 — 아무것도 만들지 않고 같은 로그를 냅니다')
            }
            aria-label="모의 실행"
            aria-describedby={problems.length > 0 ? problemsId : undefined}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-secondary text-sm font-medium hover:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FlaskConical className="w-4 h-4" aria-hidden="true" />
            모의 실행
          </button>
          <span className="text-xs text-muted-foreground">Ctrl+Enter 로 발급</span>
        </div>
        {problems.length > 0 && (
          <ul id={problemsId} role="status" aria-label="발급을 막는 항목" className="space-y-0.5 text-xs text-status-critical">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
      </div>

      <GrantRiskDialog
        clusterId={clusterId}
        open={confirming}
        title="넓은 권한을 발급할까요?"
        description="발급한 토큰은 ServiceAccount 탭에서 권한을 회수해야만 무효화됩니다."
        reasons={riskReasons}
        details={[
          { label: '대상', value: `${primaryNs}/${saName.trim()}` },
          { label: '네임스페이스', value: isClusterWideMode(bindingMode) ? '전체 네임스페이스' : targetNamespaces.join(', ') },
          { label: '만들 오브젝트', value: objectSummary },
          { label: '토큰', value: longLived ? '만료 없음' : `${TTL_OPTIONS.find((o) => o.value === ttl)?.label ?? ''} 후 만료` },
        ]}
        confirmName={saName.trim()}
        confirmNameLabel="ServiceAccount 이름"
        confirmLabel="발급 실행"
        onConfirm={() => run(false)}
        onCancel={() => setConfirming(false)}
      >
        <p className="text-xs text-muted-foreground">
          확신이 없으면 <span className="text-foreground">모의 실행</span> 을 먼저 해 보세요 — 아무것도 만들지 않습니다.
        </p>
      </GrantRiskDialog>
    </div>
  );
}
