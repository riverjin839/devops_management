import { useMemo, useState } from 'react';
import {
  Terminal, Globe, Server, Database, KeyRound, AlertTriangle, Info, Target, Pencil, Save, Plus, X,
} from 'lucide-react';
import { StatusBadge, useToast } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { useUpdateSourceConfig } from '@/hooks/useCheckMatrix';
import { formatApiError } from '@/lib/utils';
import { RunStateBadge } from './CheckMatrixRunBadges';
import type {
  CheckMatrixRunbook, CheckMatrixRunbookCommand, CheckMatrixRunbookInput,
  CheckMatrixRunDetail, CheckMatrixSourceConfigEntry,
} from '@/types';

interface Props {
  runbook?: CheckMatrixRunbook | null;
  isLoading?: boolean;
  /** 지정하면 소스 설정 편집(연필)이 활성화된다 — 수행 로그의 과거 스냅샷에는 넘기지 않는다. */
  editTarget?: { itemId: string; clusterId: string };
  /** 이 셀의 가장 최근 수행 — 있으면 계획(회색) 대신 실제 결과로 단계를 색칠하고 상단에 상태를 보여준다.
   *  수행 로그의 과거 스냅샷 보기에는 넘기지 않는다(그 화면은 이미 자기 run 을 보여주고 있으므로). */
  latestRun?: CheckMatrixRunDetail | null;
}

const KIND_META: Record<
  CheckMatrixRunbookCommand['kind'],
  { label: string; icon: typeof Terminal; hint: string }
> = {
  kubectl: { label: 'kubectl', icon: Terminal, hint: 'PEP 백엔드에서 kubectl 프로세스로 실행' },
  k8s_api: { label: 'K8s API', icon: Server, hint: 'kubernetes SDK 로 API 서버 직접 호출' },
  http: { label: 'HTTP', icon: Globe, hint: '대상 엔드포인트로 직접 HTTP 호출' },
  ssh: { label: 'SSH', icon: KeyRound, hint: '대상 장비에 SSH 접속해 읽기 명령 실행' },
  db: { label: 'PEP DB', icon: Database, hint: '대상 클러스터 접속 없이 PEP 내부 데이터만 사용' },
};

function CommandRow({ cmd, index }: { cmd: CheckMatrixRunbookCommand; index: number }) {
  const meta = KIND_META[cmd.kind] ?? KIND_META.kubectl;
  const Icon = meta.icon;
  return (
    <li className="rounded-md border border-border bg-secondary/30 p-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] tabular-nums text-muted-foreground w-4 text-right">{index + 1}</span>
        <span
          title={meta.hint}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] font-medium text-muted-foreground"
        >
          <Icon className="w-3 h-3" /> {meta.label}
        </span>
        {!cmd.readonly && (
          <span
            title="대상에 변경을 일으킬 수 있는 명령입니다."
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-status-warning/50 text-[10px] font-medium text-status-warning"
          >
            <AlertTriangle className="w-3 h-3" /> 변경
          </span>
        )}
      </div>
      <code className="block text-xs font-mono break-all text-foreground/90 pl-6">{cmd.command}</code>
      <p className="text-[11px] text-muted-foreground mt-1 pl-6">{cmd.description}</p>
    </li>
  );
}

const GROUP_LABEL: Record<string, string> = {
  params: '파라미터 (params)',
  thresholds: '임계값 (thresholds)',
  cluster: '클러스터 설정',
  config: '애드온 config',
};

function InputsBlock({ inputs, action }: { inputs: CheckMatrixRunbookInput[]; action?: React.ReactNode }) {
  if ((!inputs || inputs.length === 0) && !action) return null;
  // 그룹 순서는 백엔드가 보낸 순서를 그대로 따른다(params → thresholds 순).
  const groups: { group: string; rows: CheckMatrixRunbookInput[] }[] = [];
  for (const row of inputs ?? []) {
    const last = groups[groups.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          적용되는 설정값
        </h3>
        {action}
      </div>
      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground italic">저장된 설정값이 없습니다 — 기본값으로 동작합니다.</p>
      )}
      <div className="space-y-3">
        {groups.map(({ group, rows }) => (
          <div key={group}>
            <p className="text-[11px] text-muted-foreground mb-1">{GROUP_LABEL[group] ?? group}</p>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {rows.map((r) => (
                <div key={`${group}.${r.name}`} className="flex gap-2 min-w-0">
                  <dt className="font-mono text-muted-foreground flex-shrink-0">{r.name}</dt>
                  <dd className="font-mono truncate text-foreground/90" title={r.value}>
                    {r.value || <span className="text-muted-foreground/60">(비어 있음)</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 소스 설정 인라인 편집기 — 기본 등록 점검의 params/thresholds(또는 addon config)를
 * 매트릭스에서 바로 고친다. 값은 문자열로 보내고 서버가 spec 타입으로 강제한다.
 * 비운 필드는 오버라이드 제거(기본값 복귀)로 처리된다.
 */
function SourceConfigEditor({
  runbook, editTarget, onDone,
}: {
  runbook: CheckMatrixRunbook;
  editTarget: { itemId: string; clusterId: string };
  onDone: () => void;
}) {
  const toast = useToast();
  const saveMut = useUpdateSourceConfig();
  const isAddon = runbook.sourceType === 'addon';

  const valueByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of runbook.inputs) m.set(`${row.group}.${row.name}`, row.value);
    return m;
  }, [runbook.inputs]);

  // deep_check: spec 필드 전체를 폼으로. addon: 기존 config 키 + 새 키 추가 가능.
  const initialRows = useMemo<CheckMatrixSourceConfigEntry[]>(() => {
    if (!isAddon) {
      return runbook.fieldSpecs.map((f) => ({
        group: f.group, name: f.name, value: valueByKey.get(`${f.group}.${f.name}`) ?? '',
      }));
    }
    return runbook.inputs
      .filter((r) => r.group === 'config')
      .map((r) => ({ group: 'config', name: r.name, value: r.value }));
  }, [isAddon, runbook.fieldSpecs, runbook.inputs, valueByKey]);

  const [rows, setRows] = useState<CheckMatrixSourceConfigEntry[]>(initialRows);
  const [newKey, setNewKey] = useState('');
  const specByKey = useMemo(
    () => new Map(runbook.fieldSpecs.map((f) => [`${f.group}.${f.name}`, f])),
    [runbook.fieldSpecs],
  );

  const setValue = (idx: number, value: string) =>
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, value } : r)));

  const handleSave = async () => {
    try {
      const res = await saveMut.mutateAsync({
        itemId: editTarget.itemId, clusterId: editTarget.clusterId, entries: rows,
      });
      toast.success(
        '소스 설정을 저장했습니다.',
        res.scope === 'global' ? '글로벌 정의라 모든 클러스터에 적용됩니다.' : undefined,
      );
      onDone();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <div className="rounded-md border border-primary/40 bg-secondary/20 p-3 space-y-3">
      {runbook.definitionScope === 'global' && (
        <p className="flex items-start gap-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>이 셀은 <b>글로벌 정의</b>를 쓰고 있습니다 — 여기서 저장하면 이 점검을 쓰는
            <b> 모든 클러스터</b>에 적용됩니다. 클러스터별로 다르게 두려면 운영 점검(Ops Checks)
            화면에서 클러스터 전용 정의를 만드세요.</span>
        </p>
      )}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const spec = specByKey.get(`${r.group}.${r.name}`);
          return (
            <div key={`${r.group}.${r.name}`} className="flex items-center gap-2 min-w-0">
              <span
                className="text-xs font-mono text-muted-foreground w-44 flex-shrink-0 truncate"
                title={spec ? `${spec.label}${spec.help ? ` — ${spec.help}` : ''} (${spec.type})` : r.name}
              >
                {r.name}
              </span>
              {spec?.type === 'boolean' ? (
                <select
                  value={r.value.toLowerCase() === 'true' ? 'true' : 'false'}
                  onChange={(e) => setValue(i, e.target.value)}
                  aria-label={r.name}
                  className="text-xs border border-border rounded-lg px-2 py-1 bg-background"
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  type="text"
                  value={r.value}
                  onChange={(e) => setValue(i, e.target.value)}
                  placeholder={spec ? `${spec.label} (비우면 기본값)` : '비우면 키 제거'}
                  aria-label={r.name}
                  className="flex-1 min-w-0 text-xs font-mono border border-border rounded-lg px-2 py-1 bg-background"
                />
              )}
              {spec && (
                <span className="text-[10px] text-muted-foreground w-24 truncate flex-shrink-0" title={spec.label}>
                  {spec.label}
                </span>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground italic">편집할 설정이 없습니다{isAddon ? ' — 아래에서 키를 추가하세요.' : '.'}</p>
        )}
      </div>
      {isAddon && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="새 config 키 (예: url)"
            className="text-xs font-mono border border-border rounded-lg px-2 py-1 bg-background w-44"
          />
          <button
            onClick={() => {
              const k = newKey.trim();
              if (!k || rows.some((r) => r.name === k)) return;
              setRows((cur) => [...cur, { group: 'config', name: k, value: '' }]);
              setNewKey('');
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-border hover:bg-secondary"
          >
            <Plus className="w-3 h-3" /> 키 추가
          </button>
        </div>
      )}
      <div className="flex justify-end gap-1.5">
        <button
          onClick={onDone}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-border hover:bg-secondary"
        >
          <X className="w-3 h-3" /> 취소
        </button>
        <button
          onClick={handleSave}
          disabled={saveMut.isPending}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="w-3 h-3" /> 저장
        </button>
      </div>
    </div>
  );
}

/**
 * 셀의 실행 계획(런북) — "PEP 가 내 운영 클러스터에서 실제로 무슨 명령을 도는가".
 *
 * 실행하지 않고 조립된 계획만 보여준다. 실제로 나간 명령은 실행 로그 탭의
 * "실행된 명령" 목록에서 종료 코드·출력과 함께 확인한다.
 */
export function CheckMatrixRunbookPanel({ runbook, isLoading, editTarget, latestRun }: Props) {
  const [editing, setEditing] = useState(false);
  if (isLoading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">실행 계획 불러오는 중…</div>;
  }
  if (!runbook) {
    return <div className="py-8 text-center text-sm text-muted-foreground">실행 계획을 불러오지 못했습니다.</div>;
  }
  const canEdit = !!editTarget && runbook.configEditable;
  const running = latestRun?.runState === 'queued' || latestRun?.runState === 'running';

  return (
    <div className="space-y-5">
      <section className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
        <div className="flex items-start gap-2 text-sm">
          <Target className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <span className="text-muted-foreground text-xs">실행 대상 </span>
            <span className="font-medium break-all">{runbook.target ?? '해석되지 않음'}</span>
          </div>
        </div>
        {runbook.blockedReason && (
          <p className="flex items-start gap-2 text-xs text-status-warning">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{runbook.blockedReason}</span>
          </p>
        )}
        {runbook.kubectlPrefix && (
          <p className="text-[11px] text-muted-foreground pl-6">
            아래 kubectl 명령은 실제로 <code className="font-mono">{runbook.kubectlPrefix}</code> 접두사와 함께 실행됩니다.
          </p>
        )}
      </section>

      {/* 가장 최근 수행 상태 — 실행 중이면 잠시 후 자동으로 결과가 반영된다(폴링). */}
      {latestRun && (
        <section className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">최근 수행</span>
            <RunStateBadge state={latestRun.runState} />
            {latestRun.status && <StatusBadge variant={latestRun.status} size="sm" />}
            {running && (
              <span className="text-[11px] text-status-warning">
                진행 중입니다 — 완료되면 아래 실행 단계가 자동으로 색칠됩니다.
              </span>
            )}
          </div>
          {(latestRun.message || latestRun.error) && (
            <p className={`text-xs break-all ${latestRun.error ? 'text-status-critical' : 'text-foreground/90'}`}>
              {latestRun.error || latestRun.message}
            </p>
          )}
        </section>
      )}

      {runbook.steps.length > 0 && (
        <ExecutionStepsTimeline stepPlan={runbook.steps} steps={running ? undefined : latestRun?.steps} />
      )}

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          수행되는 명령
        </h3>
        {runbook.commands.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">등록된 명령 정보가 없습니다.</p>
        ) : (
          <ol className="space-y-2">
            {runbook.commands.map((c, i) => (
              <CommandRow key={`${c.kind}-${i}`} cmd={c} index={i} />
            ))}
          </ol>
        )}
      </section>

      {canEdit && editing && editTarget ? (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            소스 설정 편집
          </h3>
          <SourceConfigEditor runbook={runbook} editTarget={editTarget} onDone={() => setEditing(false)} />
        </section>
      ) : (
        <InputsBlock
          inputs={runbook.inputs}
          action={canEdit ? (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-border hover:bg-secondary text-muted-foreground"
              title="이 점검의 임계값/파라미터를 여기서 바로 수정"
              aria-label="소스 설정 편집"
            >
              <Pencil className="w-3 h-3" /> 설정 편집
            </button>
          ) : undefined}
        />
      )}

      {runbook.notes.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            알아둘 점
          </h3>
          <ul className="space-y-1.5">
            {runbook.notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
