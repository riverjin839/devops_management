// 공개 화면 공유 링크 관리(admin) — 만료 기한·화면 범위·클러스터 제한을 가진 접근 링크를 발급·폐기한다.
// 링크가 실제로 필요해지는 건 화면 설정의 공개 방식이 "공유 링크만"일 때다. 토큰 원문은 발급 직후 한 번만 보인다.
import { useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { useToast } from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useClusters } from '@/hooks/useCluster';
import { usePublicShareLinks, usePublicShareMutations } from '@/hooks/usePublicShare';
import { formatApiError } from '@/lib/utils';
import type { PublicShareLink, PublicSharePage } from '@/types';

const INPUT = 'w-full text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';

const PAGE_LABEL: Record<PublicSharePage, string> = {
  all: '두 화면 모두',
  daily_report: '일일 자원 리포트',
  external_services: '외부 서비스',
};
const STATE_LABEL: Record<PublicShareLink['state'], string> = { active: '사용 중', expired: '만료', revoked: '폐기' };

function linkUrl(page: PublicSharePage, token: string): string {
  const path = page === 'external_services' ? '/external-services' : '/daily-report';
  return `${window.location.origin}${path}?t=${encodeURIComponent(token)}`;
}

const fmt = (iso: string | null) => (iso ? new Date(`${iso}Z`).toLocaleString() : '—');

export function ShareLinksDialog({ open, onClose, defaultPage }: {
  open: boolean; onClose: () => void; defaultPage: PublicSharePage;
}) {
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const { data: links = [], isLoading } = usePublicShareLinks(open, showInactive);
  const { data: clusters = [] } = useClusters();
  const { create, revoke } = usePublicShareMutations();
  const [label, setLabel] = useState('');
  const [page, setPage] = useState<PublicSharePage>(defaultPage);
  const [days, setDays] = useState(7);
  const [clusterIds, setClusterIds] = useState<string[]>([]);
  const [created, setCreated] = useState<PublicShareLink | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('링크를 복사했다');
    } catch {
      toast.error('복사 실패', '링크를 직접 선택해 복사한다');
    }
  };

  const onCreate = async () => {
    try {
      const link = await create.mutateAsync({ label: label.trim(), page, expiresDays: days, clusterIds });
      setCreated(link);
      setLabel('');
    } catch (e) {
      toast.error('공유 링크 발급 실패', formatApiError(e));
    }
  };

  const onRevoke = async (id: string) => {
    try {
      await revoke.mutateAsync(id);
      setConfirmRevoke(null);
      toast.success('공유 링크를 폐기했다');
    } catch (e) {
      toast.error('폐기 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setCreated(null); onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>공유 링크</DialogTitle>
          <DialogDescription>
            화면 설정의 공개 방식이 "공유 링크만"이면 이 링크로만 열린다. 링크는 만료일이 지나거나 폐기하면 바로 막힌다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto px-5 pb-5">
          <section className="space-y-2" aria-label="새 공유 링크">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className="text-xs sm:col-span-1">
                <span className="text-muted-foreground">이름(받는 사람·용도)</span>
                <input className={INPUT} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 고객사 A 점검" maxLength={200} />
              </label>
              <label className="text-xs">
                <span className="text-muted-foreground">화면</span>
                <select className={INPUT} value={page} onChange={(e) => setPage(e.target.value as PublicSharePage)}>
                  {(Object.keys(PAGE_LABEL) as PublicSharePage[]).map((p) => <option key={p} value={p}>{PAGE_LABEL[p]}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="text-muted-foreground">유효 기간(일, 1~365)</span>
                <input type="number" min={1} max={365} className={INPUT} value={days}
                  onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
              </label>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                볼 수 있는 클러스터 제한 {clusterIds.length ? `(${clusterIds.length}개 선택)` : '(제한 없음 — 화면의 공개 클러스터 전체)'}
              </summary>
              <div className="mt-1 max-h-32 overflow-y-auto rounded-xl border border-border p-2 space-y-1">
                {clusters.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-primary" checked={clusterIds.includes(c.id)}
                      onChange={(e) => setClusterIds(e.target.checked ? [...clusterIds, c.id] : clusterIds.filter((x) => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </details>
            <button type="button" className={BTN_PRIMARY} disabled={!label.trim() || create.isPending} onClick={() => void onCreate()}>
              <Link2 className="w-4 h-4" /> {create.isPending ? '발급 중…' : '링크 만들기'}
            </button>
            {created?.token && (
              <div className="rounded-xl border border-border bg-secondary/40 p-2 text-xs space-y-1" role="status">
                <p className="text-foreground">
                  <span className="font-medium">{created.label}</span> — {fmt(created.expiresAt)} 까지 유효. 이 링크는 지금만 볼 수 있다.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all font-mono text-foreground">{linkUrl(created.page, created.token)}</code>
                  <button type="button" className={BTN} onClick={() => void copy(linkUrl(created.page, created.token as string))}
                    title="링크 복사" aria-label="링크 복사">
                    <Copy className="w-3.5 h-3.5" /> 복사
                  </button>
                </div>
              </div>
            )}
          </section>

          <section aria-label="발급한 공유 링크" className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">발급한 링크 {links.length}개</span>
              <label className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <input type="checkbox" className="accent-primary" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                만료·폐기 포함
              </label>
            </div>
            {isLoading ? (
              <p className="text-xs text-muted-foreground">불러오는 중…</p>
            ) : links.length === 0 ? (
              <p className="text-xs text-muted-foreground">발급한 링크가 없다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">이름</th>
                      <th className="text-left px-2 py-1 font-medium">화면</th>
                      <th className="text-left px-2 py-1 font-medium">만료</th>
                      <th className="text-left px-2 py-1 font-medium">마지막 사용</th>
                      <th className="text-right px-2 py-1 font-medium">사용</th>
                      <th className="text-left px-2 py-1 font-medium">상태</th>
                      <th className="px-2 py-1"><span className="sr-only">작업</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-0">
                        <td className="px-2 py-1">
                          <span className="text-foreground">{l.label}</span>
                          <span className="block font-mono text-muted-foreground">{l.tokenPrefix}… · {l.createdBy ?? ''}</span>
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {PAGE_LABEL[l.page]}{l.clusterIds.length ? ` · 클러스터 ${l.clusterIds.length}` : ''}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">{fmt(l.expiresAt)}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{fmt(l.lastUsedAt)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{l.useCount}</td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          <span className={l.state === 'active' ? 'text-foreground' : 'text-muted-foreground'}>{STATE_LABEL[l.state]}</span>
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          {l.state === 'active' && (confirmRevoke === l.id ? (
                            <span className="inline-flex gap-1">
                              <button type="button" className={BTN} onClick={() => void onRevoke(l.id)} disabled={revoke.isPending}>폐기 확인</button>
                              <button type="button" className={BTN} onClick={() => setConfirmRevoke(null)}>취소</button>
                            </span>
                          ) : (
                            <button type="button" className={BTN} onClick={() => setConfirmRevoke(l.id)}>폐기</button>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
