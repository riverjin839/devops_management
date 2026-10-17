// 클러스터 연결 검증 SSE(`POST /clusters/{id}/verify/stream`)를 표준 실행 로그(D-089·D-135)로 소비한다.
// 이 엔드포인트는 표준 SSE 규약(log/step{name}/result)과 이벤트 모양이 달라 streamLogged 대신
// postSse 로 직접 매핑한다 — `step{check,label,status: running|ok|fail|skip,detail}` · `done{…동기 /verify 응답}` ·
// `error{message}`. 클러스터 관리(/cluster-manage)와 설정 → 클러스터 탭이 함께 쓴다.
// 중간에 끊으면(signal abort) 서버는 남은 단계를 실행하지 않고 cluster.status 도 바꾸지 않는다(감사: aborted).
import { postSse } from '@/lib/sse';
import { elapsed, type RunLog, type RunLoggedResult } from '@/hooks/useRunLog';
import { formatApiError } from '@/lib/utils';
import { camelizeKeys, clustersVerifyStreamUrl } from '@/services/api';

export interface ClusterVerifyCheck {
  check: string;
  ok: boolean | null;
  detail: string;
}

export interface ClusterVerifyResult {
  ok: boolean;
  clusterName?: string;
  /** 반영된 cluster.status — healthy | warning(kubeconfig 부재/인증불가) | pending(API 도달 불가) */
  status?: string;
  statusReason?: string | null;
  results: ClusterVerifyCheck[];
}

export const VERIFY_CHECK_LABEL: Record<string, string> = {
  api_server: 'API server',
  kubeconfig_auth: 'kubeconfig 인증',
  kubectl_nodes: 'kubectl get nodes',
};

function detailText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function isAbort(e: unknown): boolean {
  const x = e as { name?: string } | null;
  return x?.name === 'AbortError';
}

/** 연결 검증 1회 — 단계마다 칩(setStep)과 로그 줄을 남기고, 끝나면 판정 결과를 돌려준다.
 *  throw 하지 않는다(`runLogged` 와 같은 결과 union). 검증 자체가 "실패 항목 있음"이어도 요청이
 *  끝까지 갔으면 `ok: true` 이고 판정은 `data.ok` 로 본다. */
export async function verifyClusterLogged(
  runLog: Pick<RunLog, 'begin'>,
  cluster: { id: string; name: string },
  signal?: AbortSignal,
): Promise<RunLoggedResult<ClusterVerifyResult>> {
  const t0 = performance.now();
  // 실행별 핸들 — 다른 클러스터 검증과 동시에 돌아도 줄이 섞이거나 서로를 끝내지 않는다.
  const run = runLog.begin(
    `연결 검증 — ${cluster.name}`,
    `${cluster.name} 연결 검증 요청 — API server → kubeconfig 인증 → kubectl 순서로 점검`,
  );
  let result: ClusterVerifyResult | undefined;
  let streamError: string | null = null;
  try {
    await postSse(clustersVerifyStreamUrl(cluster.id), {}, (evt) => {
      if (evt.type === 'step') {
        const check = String(evt.check ?? '');
        const label = VERIFY_CHECK_LABEL[check] ?? String(evt.label ?? check);
        const detail = detailText(evt.detail);
        const tail = detail ? ` — ${detail}` : '';
        if (evt.status === 'running') {
          run.setStep(check, label, 'running');
          run.log('info', `${label} 확인 중`);
        } else if (evt.status === 'ok') {
          run.setStep(check, label, 'done');
          run.log('info', `${label} 통과${tail}`);
        } else if (evt.status === 'fail') {
          run.setStep(check, label, 'failed');
          run.log('error', `${label} 실패${tail}`);
        } else {
          run.setStep(check, label, 'done');
          run.log('warn', `${label} 건너뜀${tail}`);
        }
      } else if (evt.type === 'done') {
        result = camelizeKeys<ClusterVerifyResult>(evt);
      } else if (evt.type === 'error') {
        streamError = String(evt.message ?? '검증 결과 반영 실패');
      }
    }, signal);
    if (streamError) throw new Error(streamError);
    if (!result) throw new Error('결과 없이 스트림이 끊겼습니다.');
    const r: ClusterVerifyResult = result;
    const reason = r.statusReason ? ` (${r.statusReason})` : '';
    run.log(
      r.ok ? 'info' : 'error',
      `${cluster.name} 검증 ${r.ok ? '통과' : '실패 항목 있음'} — 상태 ${r.status ?? '-'} 반영${reason}`,
    );
    run.log('info', `총 소요 ${elapsed(t0)}`);
    run.end();
    return { ok: true, data: r, run };
  } catch (error) {
    const aborted = !!signal?.aborted || isAbort(error);
    if (aborted) {
      run.log('warn', `사용자 중지 · ${elapsed(t0)} — 남은 단계는 실행하지 않았고 상태는 그대로`);
    } else {
      const msg = error instanceof Error && !('response' in error) ? error.message : formatApiError(error);
      run.log('error', `실패 · ${elapsed(t0)} — ${msg}`);
    }
    run.end();
    return { ok: false, error, aborted, run };
  }
}
