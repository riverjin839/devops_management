// 외부 서비스 목록 표 — 도메인 / 주소(IP:Port) / 유형 / 네임스페이스·이름 / 대상 / 도메인 출처.
import { ExternalLink } from 'lucide-react';
import type { ExternalServiceEntry } from '@/types';
import { addressOf, domainOf } from './format';

const TH = 'px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap';
const TD = 'px-3 py-2 align-top';

export function ExternalServicesTable({ rows, nodeHint }: { rows: ExternalServiceEntry[]; nodeHint?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={TH}>도메인</th>
            <th className={TH}>주소 (IP:Port)</th>
            <th className={TH}>유형</th>
            <th className={TH}>네임스페이스 / 이름</th>
            <th className={TH}>대상</th>
            <th className={TH}>도메인 출처</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const d = domainOf(e);
            const url = e.kind === 'Ingress' && e.host && e.scheme ? `${e.scheme}://${e.host}` : null;
            return (
              <tr key={`${e.kind}-${e.namespace}-${e.name}-${e.ip ?? e.hostname ?? ''}-${e.host ?? ''}-${e.port}-${i}`}
                className="border-b border-border last:border-0 hover:bg-secondary/50">
                <td className={TD}>
                  {d.primary ? (
                    <span className="inline-flex items-center gap-1 font-mono text-foreground break-all">
                      {d.primary}
                      {url && (
                        <a href={url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground"
                          title={`${url} 새 창으로 열기`} aria-label={`${url} 새 창으로 열기`}>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">이름 미확인</span>
                  )}
                  {d.extra.length > 0 && (
                    <div className="text-xs text-muted-foreground font-mono break-all">{d.extra.join(', ')}</div>
                  )}
                </td>
                <td className={`${TD} font-mono whitespace-nowrap tabular-nums`}
                  title={e.kind === 'NodePort' ? nodeHint : undefined}>
                  {addressOf(e)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {e.scheme ? e.scheme.toUpperCase() : e.protocol}
                  </span>
                </td>
                <td className={`${TD} whitespace-nowrap`}>{e.kind}</td>
                <td className={`${TD} font-mono whitespace-nowrap`}>
                  <span className="text-muted-foreground">{e.namespace}/</span>{e.name}
                </td>
                <td className={`${TD} text-xs text-muted-foreground font-mono`}>
                  {e.paths.length > 0 ? e.paths.map((p) => <div key={p}>{p}</div>)
                    : e.target ? `→ ${e.portName ? `${e.portName} ` : ''}${e.target}` : '—'}
                </td>
                <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>{d.source ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
