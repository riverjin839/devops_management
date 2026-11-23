// 요약 탭 — 서비스 상태를 한 화면에: 상태(사유 문장) / 기준 버전과 다른 노드 값(그룹별 다시 적용) /
// 열린 알람·최근 변경(LINUX, 노드 파라미터 에이전트) / 최근 적용. KPI 타일 대신 문장·표로(DESIGN_SYSTEM §12.12).
import { Link } from 'react-router-dom';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { EmptyState, InfoHint, StatusBadge } from '@/components/common';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import type { ServiceConfigDriftRow, ServiceConfigStatus } from '@/types';
import { RUN_STATUS } from './runStatus';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-3 py-2 border-b border-border align-top text-sm';
const BASELINE_LABEL: Record<string, string> = { imported: '가져옴', applied: '적용됨' };
const SOURCE_LABEL: Record<string, string> = { agent: '노드 에이전트', k8s_api: 'K8S API 수집', ssh: 'SSH 수집', apply: 'PEP 적용' };
/** 서비스별 자동 감시 경로(툴팁). */
const WATCH_SOURCE_HINT: Record<string, string> = {
  etcd: '정적 파드는 K8S API 로 주기 수집(감시 설정 주기), systemd 는 SSH 수동 수집 때 감지한다.',
  containerd: '노드 파라미터 에이전트가 config.toml 을 읽어 보고한다.',
  cilium: 'cilium-config 를 K8S API 로 주기 수집한다.',
  'kube-apiserver': '정적 파드를 K8S API 로 주기 수집한다.',
  'kube-controller-manager': '정적 파드를 K8S API 로 주기 수집한다.',
  'kube-scheduler': '정적 파드를 K8S API 로 주기 수집한다.',
  kubelet: '노드 파라미터 에이전트가 kubelet 설정 파일을 읽어 보고한다.',
};

interface Props {
  status: ServiceConfigStatus;
  clusterId: string;
  hasAgentData: boolean;
  canApply: boolean;
  applyHint?: string;
  /** 키 → OS 파라미터 감시 변경 이력 주소. */
  changesHref: (key?: string) => string;
  onReapply: (groupId: string | null, nodes: string[]) => void;
  onOpenHistory: () => void;
}

function groupRows(rows: ServiceConfigDriftRow[]) {
  const out = new Map<string, { groupId: string | null; groupName: string; version: number; rows: ServiceConfigDriftRow[] }>();
  for (const r of rows) {
    const k = r.groupId ?? '';
    if (!out.has(k)) out.set(k, { groupId: r.groupId, groupName: r.groupName, version: r.baselineVersionNo, rows: [] });
    out.get(k)?.rows.push(r);
  }
  return [...out.values()];
}

export function ServiceSummary({ status, clusterId, hasAgentData, canApply, applyHint, changesHref, onReapply, onOpenHistory }: Props) {
  const d = status.drift;
  const lastRun = status.lastRun;
  const runSt = lastRun ? RUN_STATUS[lastRun.status] : null;
  const isLinux = status.service === 'linux';
  return (
    <div className="space-y-3">
      <MacCard title="상태"
        actions={status.level !== 'ok' ? <StatusBadge variant={status.level} label={status.level === 'critical' ? '위험' : '확인 필요'} /> : undefined}>
        <ul className="space-y-1.5 text-sm">
          {status.reasons.length === 0 ? (
            <li className="text-muted-foreground">정상</li>
          ) : status.reasons.map((r) => <li key={r} className="text-foreground">{r}</li>)}
          <li className="text-muted-foreground">
            <InfoHint label="기준 버전" text="마지막으로 가져오거나 적용한 버전. 노드 값이 이 버전과 다르면 드리프트로 본다." side="right" />
            기준 버전: {d.baselineVersionNo ? `V${d.baselineVersionNo}(${BASELINE_LABEL[d.baselineStatus ?? ''] ?? d.baselineStatus})` : '없음 — 설정 탭에서 V1 을 만든다'}
            {' · '}노드 {d.nodeCount}개{d.lastCollectedAt ? ` · 현재 값 마지막 수집 ${formatRelativeTime(d.lastCollectedAt)}` : ''}
          </li>
          <li className="text-muted-foreground">
            미적용 저장본: {status.pending && status.pending.count > 0 ? `V${status.pending.versionNo} · 변경 ${status.pending.count}건` : '없음'}
          </li>
          <li className="text-muted-foreground">
            마지막 적용: {lastRun && runSt ? (
              <>V{lastRun.versionNo} <StatusBadge variant={runSt.variant} label={runSt.label} />{lastRun.startedAt ? ` · ${formatRelativeTime(lastRun.startedAt)}` : ''}{lastRun.startedBy ? ` · ${lastRun.startedBy}` : ''}</>
            ) : '없음'}
          </li>
          {status.offlineNodes.length > 0 && (
            <li className="text-status-warning">에이전트 무응답: {status.offlineNodes.join(', ')}</li>
          )}
          {status.errors.map((e) => <li key={e} className="text-status-warning">{e}</li>)}
        </ul>
      </MacCard>

      <MacCard title="기준 버전과 다른 노드 값" bodyPadding="p-0" titleExtra={(
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{d.rows.length}건
          <InfoHint label="기준 버전과 다른 노드 값" text="기준 버전 = 마지막으로 가져오거나 적용한 버전(노드 그룹은 그 그룹의 마지막 적용 재정의 포함). 저장만 하고 적용하지 않은 버전은 비교 대상이 아니다. 노드에서 값이 바뀌면 여기와 설정 탭 위 배너에 나타난다." />
        </span>
      )}>
        {d.rows.length === 0 ? (
          <EmptyState compact title={d.baselineVersionNo ? '모든 노드가 기준 버전과 같음' : '기준 버전 없음'} />
        ) : groupRows(d.rows).map((g) => {
          const nodes = [...new Set(g.rows.map((r) => r.node))];
          return (
            <div key={g.groupId ?? 'default'} className="border-b border-border last:border-0">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium text-foreground">{g.groupName} 그룹</span>
                <span className="text-xs text-muted-foreground">기준 V{g.version} · 노드 {nodes.length}개</span>
                <Button size="sm" className="ml-auto" disabled={!canApply} title={applyHint} onClick={() => onReapply(g.groupId, nodes)}
                  aria-label={`${g.groupName} 그룹 V${g.version} 을(를) 다른 노드 ${nodes.length}개에 다시 적용`}>다시 적용…</Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px]">
                  <thead><tr><th className={TH}>키</th><th className={TH}>노드</th><th className={TH}>현재</th><th className={TH}>기준</th></tr></thead>
                  <tbody>
                    {g.rows.slice(0, 200).map((r) => (
                      <tr key={`${r.key}|${r.node}`}>
                        <td className={`${TD} font-mono text-xs break-all`}>{r.key}</td>
                        <td className={`${TD} text-xs`}>{r.node}</td>
                        <td className={`${TD} font-mono text-xs text-status-warning break-all`}>{r.current}</td>
                        <td className={`${TD} font-mono text-xs break-all`}>{r.expected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </MacCard>

      {(
        <MacCard title="열린 알람" titleExtra={(
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{status.alerts.length}건
            <InfoHint label="열린 알람" text={!isLinux ? `${WATCH_SOURCE_HINT[status.service] ?? ''} 바뀐 값은 변경 알람, 기준 버전과 다른 값은 드리프트 알람으로 열리고, 값이 기준으로 돌아오면 드리프트 알람은 닫힌다. 확인(ack)한 알람은 빠진다.`
              : hasAgentData ? '노드 파라미터 에이전트가 만든 알람 중 확인(ack)하지 않은 것. 값이 기준으로 돌아오면 위반 알람은 다음 보고 때 닫힌다.' : 'OS 파라미터 감시 화면의 설치 안내대로 노드 파라미터 에이전트를 배포하면 변경·위반 알람이 여기에 모인다.'} />
          </span>
        )}
          actions={<Link to={`/alerts?cluster=${clusterId}`} className="text-xs text-primary hover:underline">알람 인박스</Link>} bodyPadding="p-0">
          {status.alerts.length === 0 ? (
            <EmptyState compact title={!isLinux || hasAgentData ? '열린 알람 없음' : '노드 파라미터 에이전트 보고 없음'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead><tr><th className={TH}>심각도</th><th className={TH}>노드</th><th className={TH}>내용</th><th className={TH}>시작</th></tr></thead>
                <tbody>
                  {status.alerts.map((a) => (
                    <tr key={a.id}>
                      <td className={TD}><StatusBadge variant={a.severity === 'critical' ? 'critical' : 'warning'} label={a.severity} /></td>
                      <td className={`${TD} text-xs`}>{a.node ?? '—'}</td>
                      <td className={`${TD} text-xs break-all`}>
                        <Link to={`/alerts?cluster=${clusterId}&q=${encodeURIComponent(a.keys[0] ?? a.alertname)}`} className="text-primary hover:underline">{a.summary ?? a.alertname}</Link>
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>{a.startsAt ? formatRelativeTime(a.startsAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </MacCard>
      )}

      {(
        <MacCard title="최근 변경" titleExtra={<span className="text-xs text-muted-foreground">24시간 · {status.recentChanges.length}건</span>}
          actions={isLinux ? <Link to={changesHref()} className="text-xs text-primary hover:underline">변경 이력 전체</Link> : undefined} bodyPadding="p-0">
          {status.recentChanges.length === 0 ? <EmptyState compact title="24시간 안 변경 없음" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead><tr><th className={TH}>시각</th><th className={TH}>노드</th><th className={TH}>키</th><th className={TH}>전 → 후</th>{!isLinux && <th className={TH}>감지</th>}</tr></thead>
                <tbody>
                  {status.recentChanges.map((c, i) => (
                    <tr key={`${c.node}|${c.key}|${i}`}>
                      <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>{c.detectedAt ? formatDateTime(c.detectedAt) : '—'}</td>
                      <td className={`${TD} text-xs`}>{c.node}</td>
                      <td className={`${TD} font-mono text-xs break-all`}>{isLinux ? <Link to={changesHref(c.key)} className="text-primary hover:underline">{c.key}</Link> : c.key}</td>
                      <td className={`${TD} font-mono text-xs break-all`}>{c.oldValue ?? '없음'} → {c.newValue ?? '없음'}</td>
                      {!isLinux && <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>{SOURCE_LABEL[c.source ?? ''] ?? c.source ?? '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </MacCard>
      )}

      <MacCard title="최근 적용" actions={<Button size="sm" variant="outline" onClick={onOpenHistory}>적용 이력</Button>} bodyPadding="p-0">
        {status.recentRuns.length === 0 ? <EmptyState compact title="적용 이력 없음" /> : (
          <table className="w-full">
            <thead><tr><th className={TH}>시작</th><th className={TH}>버전</th><th className={TH}>대상</th><th className={TH}>결과</th><th className={TH}>시작한 사람</th></tr></thead>
            <tbody>
              {status.recentRuns.map((r) => {
                const st = RUN_STATUS[r.status];
                return (
                  <tr key={r.id}>
                    <td className={`${TD} text-xs text-muted-foreground`}>{r.startedAt ? formatDateTime(r.startedAt) : '—'}</td>
                    <td className={TD}>V{r.versionNo}</td>
                    <td className={`${TD} text-xs`}>{r.targetMode === 'nodes' ? `고른 노드 ${r.targetCount}` : `범위 전체 ${r.targetCount}`}</td>
                    <td className={TD}><StatusBadge variant={st.variant} label={st.label} /></td>
                    <td className={`${TD} text-xs`}>{r.startedBy ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </MacCard>
    </div>
  );
}
