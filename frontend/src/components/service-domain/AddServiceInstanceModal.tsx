import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useLakeServiceTypeRows, useCreateLakeService } from '@/hooks/useLakeServices';
import { ServiceTypeIcon } from '@/components/lake-services';
import type { ServiceCategory, ServiceDomain } from '@/types';

interface AddServiceInstanceModalProps {
  open: boolean;
  domain: ServiceDomain;
  categories: ServiceCategory[];
  defaultClusterId?: string;
  defaultCategoryKey?: string | null;
  onClose: () => void;
  onCreated?: (id: string) => void;
}

/** PEP/APP 서비스 페이지의 서비스 등록 모달 — AddLakeServiceModal 과 동일 흐름이지만
 *  domain 으로 타입 목록을 좁히고, 타입별 상위 카테고리 라벨을 함께 보여준다. */
export function AddServiceInstanceModal({
  open, domain, categories, defaultClusterId, defaultCategoryKey, onClose, onCreated,
}: AddServiceInstanceModalProps) {
  const { data: clusters = [] } = useClusters();
  const { data: typeRows } = useLakeServiceTypeRows({ domain, enabled: true, limit: 200 });
  const types = typeRows?.data ?? [];
  const create = useCreateLakeService();

  const categoryLabel = (categoryId?: string | null) =>
    categories.find((c) => c.id === categoryId)?.label ?? '미분류';

  const [clusterId, setClusterId] = useState(defaultClusterId ?? '');
  const [serviceType, setServiceType] = useState('');
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [namespace, setNamespace] = useState('');
  const [tlsVerify, setTlsVerify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setClusterId(defaultClusterId ?? '');
    const preselected = defaultCategoryKey
      ? types.find((t) => categories.find((c) => c.id === t.categoryId)?.key === defaultCategoryKey)
      : undefined;
    setServiceType(preselected?.serviceType ?? '');
    setName('');
    setEndpointUrl('');
    setNamespace('');
    setTlsVerify(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultClusterId, defaultCategoryKey]);

  // ESC 닫기 · 포커스 트랩 · 초점 복원 (공용 훅)
  const dialogRef = useModalA11y(open, onClose);

  if (!open) return null;

  const selectedType = types.find((t) => t.serviceType === serviceType);

  const handleSubmit = async () => {
    setError(null);
    if (!clusterId) { setError('클러스터를 선택하세요.'); return; }
    if (!serviceType) { setError('서비스 타입을 선택하세요.'); return; }
    if (!name.trim()) { setError('인스턴스 이름을 입력하세요.'); return; }
    if (!endpointUrl.trim().match(/^https?:\/\//)) {
      setError('endpoint URL 은 http:// 또는 https:// 로 시작해야 합니다.');
      return;
    }
    try {
      const { data } = await create.mutateAsync({
        clusterId,
        serviceType,
        name: name.trim(),
        endpointUrl: endpointUrl.trim(),
        namespace: namespace.trim() || null,
        tlsVerify,
      });
      onCreated?.(data.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '등록 실패');
    }
  };

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="서비스 등록">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">서비스 등록</h2>
          <button type="button" onClick={onClose} aria-label="닫기" className="p-1 rounded hover:bg-secondary text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">클러스터 *</span>
            <select
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
              aria-label="클러스터 선택"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">— 선택 —</option>
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">서비스 타입 *</span>
            <select
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              aria-label="서비스 타입 선택"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">— 선택 —</option>
              {types.map((t) => (
                <option key={t.serviceType} value={t.serviceType}>
                  {t.label} ({categoryLabel(t.categoryId)})
                </option>
              ))}
            </select>
            {types.length === 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
                등록 가능한 서비스 타입이 없습니다 — Settings → "관리 서비스"에서 먼저 타입을 추가하세요.
              </p>
            )}
            {selectedType && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <ServiceTypeIcon serviceType={selectedType.serviceType} className="w-3 h-3" />
                {selectedType.description ?? '—'} · 기본 헬스 경로:{' '}
                <span className="font-mono">{selectedType.defaultPath}</span>
              </p>
            )}
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">인스턴스 이름 *</span>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="예: Prod StarRocks" maxLength={100} aria-label="인스턴스 이름"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">Endpoint URL *</span>
            <input
              type="text" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://starrocks.prod.example.local" aria-label="endpoint URL"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-muted-foreground">Namespace (옵션)</span>
            <input
              type="text" value={namespace} onChange={(e) => setNamespace(e.target.value)}
              placeholder="lake-prod" maxLength={100} aria-label="namespace"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox" checked={tlsVerify} onChange={(e) => setTlsVerify(e.target.checked)}
              aria-label="TLS 인증서 검증" className="w-4 h-4"
            />
            <span className="text-sm">TLS 인증서 검증 (폐쇄망 자체 인증서면 끄세요 — 기본 off)</span>
          </label>

          {error && (
            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
            취소
          </button>
          <button
            type="button" onClick={handleSubmit} disabled={create.isPending} autoFocus
            className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? '등록 중…' : '등록'}
          </button>
        </div>
      </div>
    </div>
  );
}
