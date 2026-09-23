/**
 * 권한 규칙(PolicyRule) 편집 표.
 *
 * 프리셋은 시작 템플릿일 뿐이고 **실행 전에 여기서 그대로 고친다** — 현장마다 쓰는 CRD 와
 * 정책이 달라서 규칙을 코드에 박아두면 운영자가 손댈 수 없다(CLAUDE.md UI-First 원칙).
 */
import { useState } from 'react';
import { Plus, Trash2, Code2, Table2 } from 'lucide-react';
import type { RbacPolicyRule } from '@/types';
import {
  COMMON_API_GROUPS,
  VERB_OPTIONS,
  emptyRule,
  groupLabel,
  groupsToText,
  isWriteVerb,
  splitGroups,
  splitList,
} from './rbacShared';

interface RuleEditorProps {
  rules: RbacPolicyRule[];
  onChange: (rules: RbacPolicyRule[]) => void;
  /** viewer 등 편집 불가일 때 — 값은 보이되 입력이 잠긴다. */
  disabled?: boolean;
  disabledHint?: string;
}

function toYaml(rules: RbacPolicyRule[]): string {
  return [
    'rules:',
    ...rules.flatMap((r) => [
      `  - apiGroups: [${(r.apiGroups.length ? r.apiGroups : ['']).map((g) => `"${g}"`).join(', ')}]`,
      `    resources: [${r.resources.map((x) => `"${x}"`).join(', ')}]`,
      `    verbs: [${r.verbs.map((x) => `"${x}"`).join(', ')}]`,
      ...(r.resourceNames.length
        ? [`    resourceNames: [${r.resourceNames.map((x) => `"${x}"`).join(', ')}]`]
        : []),
    ]),
  ].join('\n');
}

export function RuleEditor({ rules, onChange, disabled, disabledHint }: RuleEditorProps) {
  const [view, setView] = useState<'table' | 'yaml'>('table');

  const update = (idx: number, patch: Partial<RbacPolicyRule>) => {
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const remove = (idx: number) => onChange(rules.filter((_, i) => i !== idx));
  const add = () => onChange([...rules, emptyRule()]);

  const toggleVerb = (idx: number, verb: string) => {
    const cur = rules[idx].verbs;
    update(idx, { verbs: cur.includes(verb) ? cur.filter((v) => v !== verb) : [...cur, verb] });
  };

  const writeCount = rules.filter((r) => r.verbs.some(isWriteVerb)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-secondary rounded-xl p-1">
          <button
            type="button"
            onClick={() => setView('table')}
            title="표로 편집"
            aria-label="표로 편집"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${
              view === 'table' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <Table2 className="w-3.5 h-3.5" /> 표
          </button>
          <button
            type="button"
            onClick={() => setView('yaml')}
            title="YAML 로 보기"
            aria-label="YAML 로 보기"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${
              view === 'yaml' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" /> YAML
          </button>
        </div>
        <span className="text-xs text-muted-foreground">
          {rules.length}줄 · 쓰기 권한 {writeCount}줄
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          title={disabled ? disabledHint : '규칙 추가'}
          aria-label={disabled ? disabledHint : '규칙 추가'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" /> 규칙 추가
        </button>
      </div>

      {view === 'yaml' ? (
        <pre className="bg-secondary border border-border rounded-md p-3 text-[11.5px] font-mono overflow-x-auto text-foreground">
          {toYaml(rules) || 'rules: []'}
        </pre>
      ) : rules.length === 0 ? (
        <div className="border border-dashed border-border rounded-md py-8 text-center text-sm text-muted-foreground">
          규칙이 없다 — 최소 한 줄은 있어야 발급할 수 있다.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-md">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="bg-secondary">
                <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-[180px]">
                  API 그룹
                </th>
                <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  리소스
                </th>
                <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-[330px]">
                  동작(verb)
                </th>
                <th className="w-10"><span className="sr-only">규칙 삭제</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, idx) => (
                <tr key={idx} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <input
                      id={`rule-groups-${idx}`}
                      aria-label={`${idx + 1}번째 규칙의 API 그룹`}
                      list="rbac-api-groups"
                      value={groupsToText(rule.apiGroups)}
                      disabled={disabled}
                      onChange={(e) => update(idx, { apiGroups: splitGroups(e.target.value) })}
                      placeholder="core, apps"
                      className="w-full font-mono text-xs px-2 py-1.5 bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      id={`rule-resources-${idx}`}
                      aria-label={`${idx + 1}번째 규칙의 리소스`}
                      value={rule.resources.join(', ')}
                      disabled={disabled}
                      onChange={(e) => update(idx, { resources: splitList(e.target.value) })}
                      placeholder="pods, deployments, pods/log"
                      className="w-full font-mono text-xs px-2 py-1.5 bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {VERB_OPTIONS.map((verb) => {
                        const on = rule.verbs.includes(verb);
                        const write = isWriteVerb(verb);
                        return (
                          <button
                            key={verb}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleVerb(idx, verb)}
                            title={disabled ? disabledHint : `${verb} ${on ? '해제' : '추가'}`}
                            aria-pressed={on}
                            className={`font-mono text-[11px] px-1.5 py-0.5 rounded border disabled:opacity-60 ${
 on
 ? write
 ? 'bg-status-warning/15 border-status-warning/40 text-status-warning font-semibold'
 : 'bg-primary/15 border-primary/40 text-primary font-semibold'
 : 'bg-secondary border-border text-muted-foreground hover:border-primary/40'
 }`}
                          >
                            {verb}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      disabled={disabled}
                      title={disabled ? disabledHint : '이 규칙 삭제'}
                      aria-label={disabled ? disabledHint : '이 규칙 삭제'}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <datalist id="rbac-api-groups">
        {COMMON_API_GROUPS.map((g) => (
          <option key={g || 'core'} value={groupLabel(g)}>
            {groupLabel(g)}
          </option>
        ))}
      </datalist>
    </div>
  );
}
