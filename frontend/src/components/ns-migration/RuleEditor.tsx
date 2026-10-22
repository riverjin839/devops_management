// 치환 규칙 편집기 — 개발 → 운영 사이에 달라지는 값(레지스트리·문자열·replicas·라벨)을 화면에서 정한다(UI-First).
import { Plus, Trash2 } from 'lucide-react';
import type { NsMigRule, NsMigRuleType } from '@/types';

const RULE_META: Record<NsMigRuleType, { label: string; from: string; to: string; help: string }> = {
  image_registry: { label: '이미지 레지스트리', from: 'dev-registry.local/', to: 'prod-registry.local/',
    help: '컨테이너 이미지가 이 접두어로 시작하면 바꾼다' },
  string: { label: '문자열 치환', from: 'dev.example.com', to: 'prod.example.com',
    help: '모든 문자열 값에서 치환(Secret 값 제외)' },
  replicas: { label: 'replicas', from: '', to: '3', help: 'Deployment/StatefulSet replicas 덮어쓰기' },
  label: { label: '라벨 추가', from: 'env', to: 'prod', help: 'metadata.labels 에 키=값 추가' },
};

const inputCls = 'min-w-0 px-2 py-1 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring';

export function RuleEditor({ rules, onChange, kinds, disabled }: {
  rules: NsMigRule[];
  onChange: (rules: NsMigRule[]) => void;
  /** 규칙을 특정 종류에만 적용할 때 고를 수 있는 목록 */
  kinds: string[];
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<NsMigRule>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i));
  const add = () => onChange([...rules, { type: 'image_registry', from: '', to: '', kind: null, name: null }]);

  return (
    <div className="space-y-2">
      {rules.length === 0 && (
        <p className="text-xs text-muted-foreground">
          규칙 없이 그대로 복사한다. NS 이름이 바뀌면 metadata.namespace · RoleBinding subject · 내부 DNS(.ns.svc)는 자동으로 바뀐다.
        </p>
      )}
      {rules.map((r, i) => {
        const meta = RULE_META[r.type];
        return (
          <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <select value={r.type} disabled={disabled} aria-label={`규칙 ${i + 1} 종류`}
                onChange={(e) => update(i, { type: e.target.value as NsMigRuleType })}
                className={`${inputCls} flex-1`}>
                {(Object.keys(RULE_META) as NsMigRuleType[]).map((t) => (
                  <option key={t} value={t}>{RULE_META[t].label}</option>
                ))}
              </select>
              <select value={r.kind ?? ''} disabled={disabled} aria-label={`규칙 ${i + 1} 적용 종류`}
                onChange={(e) => update(i, { kind: e.target.value || null })}
                className={`${inputCls} w-36`}>
                <option value="">모든 종류</option>
                {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button type="button" onClick={() => remove(i)} disabled={disabled}
                title="규칙 삭제" aria-label={`규칙 ${i + 1} 삭제`}
                className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {r.type !== 'replicas' && (
                <input value={r.from} disabled={disabled} placeholder={meta.from}
                  aria-label={`규칙 ${i + 1} ${r.type === 'label' ? '라벨 키' : '원래 값'}`}
                  onChange={(e) => update(i, { from: e.target.value })} className={`${inputCls} flex-1`} />
              )}
              <span className="text-xs text-muted-foreground shrink-0">{r.type === 'label' ? '=' : '→'}</span>
              <input value={r.to} disabled={disabled} placeholder={meta.to}
                aria-label={`규칙 ${i + 1} ${r.type === 'label' ? '라벨 값' : '바꿀 값'}`}
                onChange={(e) => update(i, { to: e.target.value })} className={`${inputCls} flex-1`} />
            </div>
            <div className="flex items-center gap-2">
              <input value={r.name ?? ''} disabled={disabled} placeholder="리소스 이름(비우면 전체)"
                aria-label={`규칙 ${i + 1} 대상 이름`}
                onChange={(e) => update(i, { name: e.target.value || null })} className={`${inputCls} w-full`} />
            </div>
            <p className="text-[11px] text-muted-foreground">{meta.help}</p>
          </div>
        );
      })}
      <button type="button" onClick={add} disabled={disabled}
        className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50">
        <Plus className="w-3.5 h-3.5" /> 규칙 추가
      </button>
    </div>
  );
}
