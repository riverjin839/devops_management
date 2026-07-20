import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Play, Trash2, AlertCircle, BookOpen, History, ChevronRight,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog } from '@/components/common';
import { HealthBadge, ServiceTypeIcon } from '@/components/lake-services';
import { RichContent } from '@/components/editor/RichContent';
import {
  useLakeService,
  useLakeServiceTypes,
  useLakeServiceChecks,
  useRunLakeServiceCheck,
  useDeleteLakeService,
} from '@/hooks/useLakeServices';
import { serviceEntriesApi } from '@/services/api';
import type { ServiceEntry } from '@/types';
import { parseUTC } from '@/lib/utils';

interface TimelineItem {
  source: 'check' | 'entry';
  id: string;
  at: string;
  title: string;
  body?: string;
  status?: string;
  severity?: string | null;
  author?: string | null;
}

export function LakeServiceDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: svc, isLoading, error } = useLakeService(id || undefined);
  const { data: types = [] } = useLakeServiceTypes();
  const { data: checksData } = useLakeServiceChecks(id || undefined, { limit: 50 });
  const runCheck = useRunLakeServiceCheck();
  const delMutation = useDeleteLakeService();

  // ServiceEntry 가이드 / 히스토리 — service 슬러그 매칭
  const serviceSlug = svc?.serviceType;
  const { data: entriesData } = useQuery({
    queryKey: ['serviceEntries', 'lake', serviceSlug],
    queryFn: async () =>
      (await serviceEntriesApi.list(serviceSlug!, { clusterId: undefined })).data,
    enabled: !!serviceSlug,
  });
  const entries: ServiceEntry[] = useMemo(
    () => entriesData?.data ?? [],
    [entriesData?.data],
  );
  const guides = useMemo(() => entries.filter((e) => e.kind === 'guide'), [entries]);
  const historyEntries = useMemo(
    () => entries.filter((e) => e.kind === 'history' || e.kind === 'troubleshoot'),
    [entries],
  );

  const typeInfo = types.find((t) => t.serviceType === svc?.serviceType);

  // Unified timeline — LakeServiceCheck + ServiceEntry(history/troubleshoot)
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    for (const c of checksData?.data ?? []) {
      items.push({
        source: 'check',
        id: c.id,
        at: c.checkedAt,
        title: `${c.status} — ${c.message ?? '점검 완료'}`,
        status: c.status,
        author: c.triggeredByUser ?? null,
      });
    }
    for (const e of historyEntries) {
      items.push({
        source: 'entry',
        id: e.id,
        at: e.occurredAt ?? e.updatedAt ?? e.createdAt,
        title: e.title,
        body: e.content,
        severity: e.severity,
        author: e.author,
      });
    }
    return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [checksData?.data, historyEntries]);

  const doDelete = () => {
    setConfirmDelete(false);
    delMutation.mutate(id, { onSuccess: () => navigate('/lake-services') });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-[1400px] mx-auto space-y-3">
          <div className="h-8 w-48 bg-muted/30 animate-pulse rounded" />
          <div className="h-48 bg-muted/30 animate-pulse rounded-md" />
        </div>
      </div>
    );
  }

  if (error || !svc) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-[800px] mx-auto">
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-4 flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">LAKE 서비스 조회 실패</div>
              <div className="text-sm text-muted-foreground mt-0.5">
                {error instanceof Error ? error.message : '서비스를 찾을 수 없습니다.'}
              </div>
              <Link to="/lake-services" className="inline-block mt-2 text-sm underline">
                목록으로
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="max-w-[1400px] mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            to="/lake-services"
            aria-label="LAKE 서비스 목록으로"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            목록
          </Link>
          <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
            <ServiceTypeIcon serviceType={svc.serviceType} className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-[180px]">
            <h1 className="text-lg font-semibold">{svc.name}</h1>
            <p className="text-sm text-muted-foreground">
              {typeInfo?.label ?? svc.serviceType} · {svc.category} · {svc.endpointUrl}
            </p>
          </div>
          <HealthBadge status={svc.status} size="md" />
          <button
            type="button"
            onClick={() => runCheck.mutate(id)}
            disabled={runCheck.isPending}
            aria-label="지금 점검"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {runCheck.isPending ? '실행 중…' : '지금 점검'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="서비스 삭제"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
            삭제
          </button>
        </div>

        {/* Health summary */}
        <MacCard title="현재 상태">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <HealthBadge status={svc.status} />
              <span className="text-muted-foreground">
                {svc.lastCheckedAt
                  ? `마지막 점검: ${parseUTC(svc.lastCheckedAt).toLocaleString('ko-KR')}`
                  : '점검 기록 없음'}
              </span>
            </div>
            {svc.lastMessage && (
              <p className="text-sm text-muted-foreground italic">{svc.lastMessage}</p>
            )}
            {checksData?.data?.[0]?.details && (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                  최근 점검 details (JSON)
                </summary>
                <pre className="mt-2 rounded bg-muted p-2 text-xs overflow-x-auto max-h-64">
                  {JSON.stringify(checksData.data[0].details, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </MacCard>

        {/* Troubleshoot guides */}
        <MacCard title="트러블슈팅 가이드">
          {guides.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">
              <BookOpen className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
              <code className="font-mono">service={svc.serviceType}</code> 슬러그로 등록된 가이드가 없습니다.{' '}
              <Link
                to={`/services/${svc.serviceType}`}
                className="underline hover:text-foreground"
              >
                ServiceHub 에서 작성하기 →
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {guides.map((g) => (
                <GuideItem key={g.id} entry={g} />
              ))}
            </ul>
          )}
        </MacCard>

        {/* History timeline (LakeServiceCheck + ServiceEntry kind=history) */}
        <MacCard title="히스토리 timeline">
          {timeline.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">
              <History className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
              아직 점검 기록이 없습니다. 상단 "지금 점검" 버튼으로 첫 회차를 생성하세요.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {timeline.slice(0, 50).map((t) => (
                <li
                  key={`${t.source}-${t.id}`}
                  className="flex items-start gap-2 text-sm border-b border-border/40 py-1.5 last:border-b-0"
                >
                  <span className="text-xs font-mono text-muted-foreground w-32 flex-shrink-0">
                    {parseUTC(t.at).toLocaleString('ko-KR')}
                  </span>
                  <span
                    className={`flex-shrink-0 inline-flex items-center text-xs rounded px-1.5 py-0.5 ${
                      t.source === 'check'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {t.source === 'check' ? '점검' : '히스토리'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">{t.title}</span>
                    {t.author && (
                      <span className="text-muted-foreground ml-2">· {t.author}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </MacCard>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="LAKE 서비스 삭제"
        description={`"${svc.name}" 인스턴스를 삭제하시겠습니까? 헬스체크 history 도 함께 삭제됩니다.`}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function GuideItem({ entry }: { entry: ServiceEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/40"
      >
        <BookOpen className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
        <span className="flex-1 min-w-0">
          <span className="font-medium truncate">{entry.title}</span>
          {entry.severity && (
            <span className="ml-2 text-xs text-muted-foreground">
              · {entry.severity}
            </span>
          )}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-3 py-3 border-t border-border bg-muted/20">
          <RichContent content={entry.content} />
        </div>
      )}
    </li>
  );
}
