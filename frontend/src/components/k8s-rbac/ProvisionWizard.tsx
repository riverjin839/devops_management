/**
 * 개발자 액세스 발급 마법사 — 프리셋 → 대상 → 바인딩 방식 → 규칙 → 옵션 → 실행.
 *
 * 개발자는 보통 자기 네임스페이스 하나에 배포하지만 다른 네임스페이스도 필요할 때가 있어,
 * 주 네임스페이스와 추가 네임스페이스를 함께 받아 한 번에 붙인다.
 */
import { useEffect, useMemo, useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import type {
  RbacBindingMode,
  RbacNamespace,
  RbacPolicyRule,
  RbacPresetCatalog,
  RbacProvisionRequest,
} from '@/types';
import { RiskBadge } from './RbacTags';
import { RuleEditor } from './RuleEditor';

interface ProvisionWizardProps {
  catalog: RbacPresetCatalog | undefined;
  namespaces: RbacNamespace[];
  running: boolean;
  onRun: (req: RbacProvisionRequest) => void;
}

const TTL_OPTIONS = [
  { label: '1일', value: 24 * 3600 },
  { label: '7일', value: 7 * 24 * 3600 },
  { label: '30일', value: 30 * 24 * 3600 },
  { label: '90일', value: 90 * 24 * 3600 },
];

function StepHeader({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="w-5 h-5 shrink-0 grid place-items-center rounded-full bg-primary/10 border border-primary/30 text-primary text-[11px] font-bold font-mono">
        {n}
      </span>
      <span className="text-sm font-semibold">{title}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={disabled ? hint : label}
      aria-label={disabled ? `${label} — ${hint ?? ''}` : label}
      className="inline-flex items-center gap-2 text-sm text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <span
        className={`w-9 h-5 shrink-0 rounded-full border relative transition-colors ${
          checked ? 'bg-primary border-primary' : 'bg-secondary border-border'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card shadow-sm transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
      {label}
    </button>
  );
}

export function ProvisionWizard({ catalog, namespaces, running, onRun }: ProvisionWizardProps) {
  const { canOperate, hint, withHint } = useCanOperate();

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
  const [dryRun, setDryRun] = useState(false);
  const [longLived, setLongLived] = useState(false);
  const [ttl, setTtl] = useState(TTL_OPTIONS[1].value);

  const preset = useMemo(
    () => catalog?.presets.find((p) => p.key === presetKey),
    [catalog, presetKey],
  );

  // 프리셋을 고르면 규칙을 그 템플릿으로 갈아끼운다. 단, 사용자가 이미 규칙을 손댔으면
  // 프리셋을 새로 고를 때만 덮어쓴다(편집 중인 내용을 카탈로그 리패치가 날리지 않게).
  useEffect(() => {
    if (!preset) return;
    setRules(preset.rules.map((r) => ({ ...r })));
    setRulesTouched(false);
    setBindingMode(preset.recommendedBindingMode);
  }, [preset]);

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
    if (!saName.trim()) out.push('ServiceAccount 이름을 입력하세요.');
    if (!primaryNs) out.push('주 네임스페이스를 고르세요.');
    if (rules.length === 0) out.push('권한 규칙이 최소 한 줄은 있어야 합니다.');
    if (rules.some((r) => r.verbs.length === 0)) out.push('동작(verb)이 비어 있는 규칙이 있습니다.');
    if (rules.some((r) => r.resources.length === 0)) out.push('리소스가 비어 있는 규칙이 있습니다.');
    return out;
  }, [saName, primaryNs, rules]);

  const objectSummary = useMemo(() => {
    if (bindingMode === 'clusterrole-clusterrolebinding') return 'SA 1 · ClusterRole 1 · ClusterRoleBinding 1';
    if (bindingMode === 'role-per-namespace')
      return `SA 1 · Role ${targetNamespaces.length} · RoleBinding ${targetNamespaces.length}`;
    return `SA 1 · ClusterRole 1 · RoleBinding ${targetNamespaces.length}`;
  }, [bindingMode, targetNamespaces.length]);

  const run = () => {
    if (problems.length > 0 || !canOperate) return;
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
      tokenTtlSeconds: ttl,
      dryRun,
    });
  };

  const inputCls =
    'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

  return (
    <div className="space-y-3">
      {/* 1. 프리셋 */}
      <MacCard title="권한 프리셋">
        <StepHeader n={1} title="무엇을 할 수 있게 할 것인가" hint="고른 뒤 아래 규칙 표에서 그대로 고친다" />
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          {(catalog?.presets ?? []).map((p) => {
            const on = p.key === presetKey;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={on}
                onClick={() => setPresetKey(p.key)}
                title={p.description}
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
        {preset && (
          <p className="mt-3 text-xs text-muted-foreground leading-relaxed">{preset.description}</p>
        )}
      </MacCard>

      {/* 2. 대상 */}
      <MacCard title="대상">
        <StepHeader n={2} title="누구에게, 어느 네임스페이스에" />
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
              {namespaces.length === 0 && <option value="">네임스페이스를 불러오는 중…</option>}
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
            추가 네임스페이스 <span className="font-normal">— 같은 권한을 함께 붙인다</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {primaryNs && (
              <span className="inline-flex items-center gap-1.5 font-mono text-xs px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 text-primary font-semibold">
                {primaryNs}
                <span className="text-[10px] font-normal opacity-70">주</span>
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
                    className="p-0.5 rounded hover:text-destructive"
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
                className="w-40 px-2.5 py-1 bg-card border border-dashed border-border rounded-full text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <button
                type="button"
                onClick={addExtra}
                title="추가 네임스페이스 등록"
                aria-label="추가 네임스페이스 등록"
                className="p-1 rounded-lg border border-border hover:border-primary hover:text-primary"
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
          <Toggle
            checked={createNamespace}
            onChange={setCreateNamespace}
            label="네임스페이스가 없으면 함께 생성"
            disabled={!canOperate}
            hint={hint}
          />
        </div>
      </MacCard>

      {/* 3. 바인딩 방식 */}
      <MacCard title="바인딩 방식">
        <StepHeader n={3} title="권한을 어떻게 붙일 것인가" />
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="바인딩 방식">
          {(catalog?.bindingModes ?? []).map((m) => {
            const on = m.key === bindingMode;
            return (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={m.name}
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
                  <span className="block text-sm font-semibold">{m.name}</span>
                  <span className="block text-xs text-muted-foreground leading-relaxed mt-0.5">
                    {m.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </MacCard>

      {/* 4. 규칙 */}
      <MacCard title="권한 규칙">
        <StepHeader
          n={4}
          title="실제로 적용될 규칙"
          hint={rulesTouched ? '프리셋에서 수정됨' : `프리셋: ${preset?.name ?? '-'}`}
        />
        <RuleEditor
          rules={rules}
          onChange={(next) => {
            setRules(next);
            setRulesTouched(true);
          }}
          disabled={!canOperate}
          disabledHint={hint}
        />
      </MacCard>

      {/* 5. 옵션 */}
      <MacCard title="발급 옵션">
        <StepHeader n={5} title="토큰과 검증" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            토큰 방식
            <select
              id="rbac-token-mode"
              value={longLived ? 'long' : 'short'}
              onChange={(e) => setLongLived(e.target.value === 'long')}
              className={inputCls}
            >
              <option value="short">단기 토큰 (TokenRequest)</option>
              <option value="long">만료 없는 Secret 토큰</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            유효기간
            <select
              id="rbac-token-ttl"
              value={ttl}
              disabled={longLived}
              onChange={(e) => setTtl(Number(e.target.value))}
              className={`${inputCls} disabled:opacity-50`}
            >
              {TTL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
          <Toggle checked={issueKubeconfig} onChange={setIssueKubeconfig} label="kubeconfig 발급" />
          <Toggle checked={verify} onChange={setVerify} label="생성 후 권한 검증" />
          <Toggle checked={dryRun} onChange={setDryRun} label="모의 실행 (변경 없음)" />
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed rounded-md border border-primary/30 bg-primary/5 text-primary px-3 py-2">
          단기 토큰은 만료되면 개발자가 다시 받아야 한다. CI 처럼 사람이 갱신할 수 없는 곳에는 만료 없는
          Secret 토큰을 쓰고, 회수는 그 Secret 을 지워서 한다.
        </p>
      </MacCard>

      {/* 실행 */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 p-3 rounded-md bg-card border border-border shadow-sm">
        <button
          type="button"
          onClick={run}
          disabled={!canOperate || running || problems.length > 0}
          title={
            !canOperate
              ? hint
              : problems.length > 0
                ? problems[0]
                : withHint(dryRun ? '모의 실행' : '액세스 발급 실행')
          }
          aria-label={dryRun ? '모의 실행' : '액세스 발급 실행'}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-4 h-4" />
          {running ? '실행 중…' : dryRun ? '모의 실행' : '액세스 발급 실행'}
        </button>
        <span className="text-xs text-muted-foreground">
          {problems.length > 0 ? problems[0] : objectSummary}
        </span>
      </div>
    </div>
  );
}
