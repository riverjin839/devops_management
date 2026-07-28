import { Terminal, Globe, Server, Database, KeyRound, AlertTriangle, Info, Target } from 'lucide-react';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import type { CheckMatrixRunbook, CheckMatrixRunbookCommand, CheckMatrixRunbookInput } from '@/types';

interface Props {
  runbook?: CheckMatrixRunbook | null;
  isLoading?: boolean;
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

function InputsBlock({ inputs }: { inputs: CheckMatrixRunbookInput[] }) {
  if (!inputs || inputs.length === 0) return null;
  // 그룹 순서는 백엔드가 보낸 순서를 그대로 따른다(params → thresholds 순).
  const groups: { group: string; rows: CheckMatrixRunbookInput[] }[] = [];
  for (const row of inputs) {
    const last = groups[groups.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        적용되는 설정값
      </h3>
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
 * 셀의 실행 계획(런북) — "PEP 가 내 운영 클러스터에서 실제로 무슨 명령을 도는가".
 *
 * 실행하지 않고 조립된 계획만 보여준다. 실제로 나간 명령은 실행 로그 탭의
 * "실행된 명령" 목록에서 종료 코드·출력과 함께 확인한다.
 */
export function CheckMatrixRunbookPanel({ runbook, isLoading }: Props) {
  if (isLoading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">실행 계획 불러오는 중…</div>;
  }
  if (!runbook) {
    return <div className="py-8 text-center text-sm text-muted-foreground">실행 계획을 불러오지 못했습니다.</div>;
  }

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

      {runbook.steps.length > 0 && <ExecutionStepsTimeline stepPlan={runbook.steps} />}

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

      <InputsBlock inputs={runbook.inputs} />

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
