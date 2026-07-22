import { useEffect, useId, useMemo, useState } from 'react';
import { X, Plus, Pencil, Trash2, FileCode2, ListTree, Save, Loader2 } from 'lucide-react';
import { Playbook } from '@/types';
import {
  usePlaybookFiles, useCreatePlaybookFile, useUpdatePlaybookFile, useDeletePlaybookFile,
  useInventories, useCreateInventory, useUpdateInventory, useDeleteInventory,
} from '@/hooks/useAnsibleAssets';
import { formatApiError } from '@/lib/utils';
import { useModalA11y } from '@/components/common/useModalA11y';

export interface PlaybookFormSubmit {
  name: string;
  description: string;
  /** DB 관리형 — 둘 다 비면 path 기반(advanced) */
  playbookFileId?: string;
  inventoryId?: string;
  /** 구 호환용. advanced 모드에서만 사용. */
  playbookPath?: string;
  inventoryPath?: string;
  tags: string;
  clusterId: string;
}

interface AddPlaybookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: PlaybookFormSubmit) => void;
  clusters: { id: string; name: string }[];
  defaultClusterId?: string;
  initialData?: Playbook | null;
}

const inputCls =
  'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm';

// ── Inline 새 Playbook 파일 등록 ───────────────────────────────────────

function NewPlaybookFileForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const create = useCreatePlaybookFile();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('---\n- name: New playbook\n  hosts: all\n  tasks: []\n');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!name.trim() || !content.trim()) {
      setError('이름과 본문(YAML)은 필수입니다.');
      return;
    }
    create.mutate(
      { name: name.trim(), description: description.trim() || undefined, content },
      {
        onSuccess: (pf) => onCreated(pf.id),
        onError: (e) => setError(formatApiError(e)),
      },
    );
  };

  return (
    <div className="border border-primary/30 rounded-lg p-3 space-y-2 bg-primary/5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-primary">새 Playbook 파일 등록</p>
        <button onClick={onCancel} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: check_ntp)" className={inputCls} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명 (선택)" className={inputCls} />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={10}
        spellCheck={false}
        className={`${inputCls} font-mono text-sm resize-y`}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-sm bg-secondary border border-border rounded">취소</button>
        <button
          onClick={submit}
          disabled={create.isPending}
          className="flex items-center gap-1 px-3 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50"
        >
          {create.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          등록
        </button>
      </div>
    </div>
  );
}

function NewInventoryForm({
  clusterId, onCreated, onCancel,
}: { clusterId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const create = useCreateInventory();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('[all]\n# host1 ansible_host=10.0.0.1\n');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!name.trim() || !content.trim()) {
      setError('이름과 본문은 필수입니다.');
      return;
    }
    create.mutate(
      { clusterId, name: name.trim(), description: description.trim() || undefined, content, isDefault },
      {
        onSuccess: (inv) => onCreated(inv.id),
        onError: (e) => setError(formatApiError(e)),
      },
    );
  };

  return (
    <div className="border border-primary/30 rounded-lg p-3 space-y-2 bg-primary/5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-primary">새 Inventory 등록</p>
        <button onClick={onCancel} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: prod-masters)" className={inputCls} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명 (선택)" className={inputCls} />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        spellCheck={false}
        className={`${inputCls} font-mono text-sm resize-y`}
      />
      <label className="flex items-center gap-2 text-sm text-foreground/80">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        이 클러스터의 기본 inventory 로 설정 (기존 default 는 해제됨)
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-sm bg-secondary border border-border rounded">취소</button>
        <button
          onClick={submit}
          disabled={create.isPending}
          className="flex items-center gap-1 px-3 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50"
        >
          {create.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          등록
        </button>
      </div>
    </div>
  );
}

// ── Edit existing playbook file / inventory inline ─────────────────────

function EditPlaybookFileForm({
  fileId, onClose,
}: { fileId: string; onClose: () => void }) {
  const filesQ = usePlaybookFiles();
  const update = useUpdatePlaybookFile();
  const remove = useDeletePlaybookFile();
  const file = filesQ.data?.find((f) => f.id === fileId);

  const [name, setName] = useState(file?.name ?? '');
  const [description, setDescription] = useState(file?.description ?? '');
  const [content, setContent] = useState(file?.content ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    setName(file.name);
    setDescription(file.description ?? '');
    setContent(file.content);
  }, [file]);

  if (!file) return null;

  const submit = () => {
    setError(null);
    update.mutate(
      { id: fileId, data: { name: name.trim(), description, content } },
      { onSuccess: () => onClose(), onError: (e) => setError(formatApiError(e)) },
    );
  };
  const handleDelete = () => {
    if (!confirm(`"${file.name}" 파일을 삭제하시겠습니까? 이 파일을 참조하는 Playbook 이 있다면 실패합니다.`)) return;
    remove.mutate(fileId, { onSuccess: () => onClose(), onError: (e) => setError(formatApiError(e)) });
  };

  return (
    <div className="border border-amber-500/40 rounded-lg p-3 space-y-2 bg-amber-500/5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-amber-500">Playbook 파일 편집</p>
        <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명" className={inputCls} />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10}
        spellCheck={false} className={`${inputCls} font-mono text-sm resize-y`} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-between gap-2">
        <button onClick={handleDelete}
          className="flex items-center gap-1 px-3 py-1 text-sm bg-red-500/10 text-red-500 border border-red-500/30 rounded">
          <Trash2 className="w-3 h-3" /> 삭제
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm bg-secondary border border-border rounded">취소</button>
          <button onClick={submit} disabled={update.isPending}
            className="flex items-center gap-1 px-3 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50">
            {update.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 저장
          </button>
        </div>
      </div>
    </div>
  );
}

function EditInventoryForm({
  inventoryId, onClose,
}: { inventoryId: string; onClose: () => void }) {
  const invQ = useInventories();
  const update = useUpdateInventory();
  const remove = useDeleteInventory();
  const inv = invQ.data?.find((i) => i.id === inventoryId);

  const [name, setName] = useState(inv?.name ?? '');
  const [description, setDescription] = useState(inv?.description ?? '');
  const [content, setContent] = useState(inv?.content ?? '');
  const [isDefault, setIsDefault] = useState(inv?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inv) return;
    setName(inv.name);
    setDescription(inv.description ?? '');
    setContent(inv.content);
    setIsDefault(inv.isDefault);
  }, [inv]);

  if (!inv) return null;

  const submit = () => {
    setError(null);
    update.mutate(
      { id: inventoryId, data: { name: name.trim(), description, content, isDefault } },
      { onSuccess: () => onClose(), onError: (e) => setError(formatApiError(e)) },
    );
  };
  const handleDelete = () => {
    if (!confirm(`"${inv.name}" inventory 를 삭제하시겠습니까?`)) return;
    remove.mutate(inventoryId, { onSuccess: () => onClose(), onError: (e) => setError(formatApiError(e)) });
  };

  return (
    <div className="border border-amber-500/40 rounded-lg p-3 space-y-2 bg-amber-500/5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-amber-500">Inventory 편집</p>
        <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명" className={inputCls} />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8}
        spellCheck={false} className={`${inputCls} font-mono text-sm resize-y`} />
      <label className="flex items-center gap-2 text-sm text-foreground/80">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        기본 inventory
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-between gap-2">
        <button onClick={handleDelete}
          className="flex items-center gap-1 px-3 py-1 text-sm bg-red-500/10 text-red-500 border border-red-500/30 rounded">
          <Trash2 className="w-3 h-3" /> 삭제
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm bg-secondary border border-border rounded">취소</button>
          <button onClick={submit} disabled={update.isPending}
            className="flex items-center gap-1 px-3 py-1 text-sm bg-primary text-primary-foreground rounded disabled:opacity-50">
            {update.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 저장
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 메인 모달 ───────────────────────────────────────────────────────────

export function AddPlaybookModal({
  isOpen,
  onClose,
  onSubmit,
  clusters,
  defaultClusterId,
  initialData,
}: AddPlaybookModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [clusterId, setClusterId] = useState('');

  // 신: DB 관리 모드 (기본). advanced 토글 시 path 기반 fallback.
  const [advanced, setAdvanced] = useState(false);
  const [playbookFileId, setPlaybookFileId] = useState('');
  const [inventoryId, setInventoryId] = useState('');
  const [playbookPath, setPlaybookPath] = useState('');
  const [inventoryPath, setInventoryPath] = useState('');

  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewInv, setShowNewInv] = useState(false);
  const [editFileId, setEditFileId] = useState<string | null>(null);
  const [editInvId, setEditInvId] = useState<string | null>(null);

  const titleId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);
  const clusterSelectId = useId();
  const nameId = useId();
  const descId = useId();
  const playbookFileSelectId = useId();
  const inventorySelectId = useId();
  const playbookPathId = useId();
  const inventoryPathId = useId();
  const tagsId = useId();

  const filesQ = usePlaybookFiles();
  const invQ = useInventories(clusterId || undefined);

  const inventories = useMemo(() => invQ.data ?? [], [invQ.data]);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialData?.name ?? '');
    setDescription(initialData?.description ?? '');
    setTags(initialData?.tags ?? '');
    setClusterId(initialData?.clusterId ?? defaultClusterId ?? clusters[0]?.id ?? '');
    setPlaybookFileId(initialData?.playbookFileId ?? '');
    setInventoryId(initialData?.inventoryId ?? '');
    setPlaybookPath(initialData?.playbookPath ?? '');
    setInventoryPath(initialData?.inventoryPath ?? '');
    // 기존 데이터가 path 기반이면 advanced 모드로 시작, 아니면 DB 모드.
    setAdvanced(!!(initialData?.playbookPath && !initialData?.playbookFileId));
    setShowNewFile(false);
    setShowNewInv(false);
    setEditFileId(null);
    setEditInvId(null);
  }, [isOpen, initialData, defaultClusterId, clusters]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !clusterId) return;
    if (advanced) {
      if (!playbookPath.trim()) return;
      onSubmit({
        name, description, tags, clusterId,
        playbookPath: playbookPath.trim(),
        inventoryPath: inventoryPath.trim() || undefined,
      });
    } else {
      if (!playbookFileId) return;
      onSubmit({
        name, description, tags, clusterId,
        playbookFileId,
        inventoryId: inventoryId || undefined,
      });
    }
    onClose();
  };

  const canSubmit = name.trim() && clusterId && (
    advanced ? !!playbookPath.trim() : !!playbookFileId
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id={titleId} className="text-lg font-semibold">{initialData ? 'Edit Playbook' : 'Register Playbook'}</h2>
          <button onClick={onClose} className="p-1 hover:bg-secondary rounded-md">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Cluster */}
          <div>
            <label htmlFor={clusterSelectId} className="block text-sm font-medium mb-1">Cluster</label>
            <select
              id={clusterSelectId}
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
              className={inputCls}
            >
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label htmlFor={nameId} className="block text-sm font-medium mb-1">Name</label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Check NTP Sync"
              className={inputCls}
              required
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor={descId} className="block text-sm font-medium mb-1">Description</label>
            <input
              id={descId}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className={inputCls}
            />
          </div>

          {/* 모드 토글 */}
          <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2">
            <p className="text-sm text-foreground/80">
              {advanced
                ? '고급: 호스트 경로 직접 지정'
                : '기본: DB 에 저장된 Playbook/Inventory 사용 (공용)'}
            </p>
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="text-xs text-primary hover:underline"
            >
              {advanced ? 'DB 관리 모드로' : '고급 (path) 모드로'}
            </button>
          </div>

          {!advanced ? (
            <>
              {/* Playbook 파일 (공용) */}
              <div>
                <label htmlFor={playbookFileSelectId} className="block text-sm font-medium mb-1 flex items-center gap-1">
                  <FileCode2 className="w-3.5 h-3.5" /> Playbook 파일 (공용 라이브러리)
                </label>
                <div className="flex items-center gap-2">
                  <select
                    id={playbookFileSelectId}
                    value={playbookFileId}
                    onChange={(e) => setPlaybookFileId(e.target.value)}
                    disabled={filesQ.isLoading}
                    className={inputCls + ' flex-1'}
                  >
                    <option value="">— 선택 —</option>
                    {(filesQ.data ?? []).map((f) => (
                      <option key={f.id} value={f.id}>{f.name}{f.description ? ` — ${f.description}` : ''}</option>
                    ))}
                  </select>
                  {playbookFileId && (
                    <button
                      type="button" onClick={() => setEditFileId(playbookFileId)}
                      className="p-2 text-muted-foreground hover:text-foreground border border-border rounded-lg"
                      title="이 파일 편집"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button" onClick={() => { setShowNewFile(true); setEditFileId(null); }}
                    className="flex items-center gap-1 px-3 py-2 text-sm bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg"
                  >
                    <Plus className="w-3.5 h-3.5" /> 새 파일
                  </button>
                </div>
                {showNewFile && (
                  <div className="mt-2">
                    <NewPlaybookFileForm
                      onCancel={() => setShowNewFile(false)}
                      onCreated={(id) => { setPlaybookFileId(id); setShowNewFile(false); }}
                    />
                  </div>
                )}
                {editFileId && (
                  <div className="mt-2">
                    <EditPlaybookFileForm fileId={editFileId} onClose={() => setEditFileId(null)} />
                  </div>
                )}
              </div>

              {/* Inventory (per-cluster) */}
              <div>
                <label htmlFor={inventorySelectId} className="block text-sm font-medium mb-1 flex items-center gap-1">
                  <ListTree className="w-3.5 h-3.5" /> Inventory (이 클러스터)
                </label>
                <div className="flex items-center gap-2">
                  <select
                    id={inventorySelectId}
                    value={inventoryId}
                    onChange={(e) => setInventoryId(e.target.value)}
                    disabled={!clusterId || invQ.isLoading}
                    className={inputCls + ' flex-1'}
                  >
                    <option value="">— 선택 안 함 (Ansible 기본 inventory 사용) —</option>
                    {inventories.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.isDefault ? '★ ' : ''}{i.name}{i.description ? ` — ${i.description}` : ''}
                      </option>
                    ))}
                  </select>
                  {inventoryId && (
                    <button
                      type="button" onClick={() => setEditInvId(inventoryId)}
                      className="p-2 text-muted-foreground hover:text-foreground border border-border rounded-lg"
                      title="이 inventory 편집"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setShowNewInv(true); setEditInvId(null); }}
                    disabled={!clusterId}
                    className="flex items-center gap-1 px-3 py-2 text-sm bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" /> 새 inventory
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  한 클러스터에 여러 inventory 를 등록할 수 있습니다(예: prod / dr / 일부 노드만).
                </p>
                {showNewInv && clusterId && (
                  <div className="mt-2">
                    <NewInventoryForm
                      clusterId={clusterId}
                      onCancel={() => setShowNewInv(false)}
                      onCreated={(id) => { setInventoryId(id); setShowNewInv(false); }}
                    />
                  </div>
                )}
                {editInvId && (
                  <div className="mt-2">
                    <EditInventoryForm inventoryId={editInvId} onClose={() => setEditInvId(null)} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Path 기반 (구 호환) */}
              <div>
                <label htmlFor={playbookPathId} className="block text-sm font-medium mb-1">Playbook Path</label>
                <input
                  id={playbookPathId}
                  type="text"
                  value={playbookPath}
                  onChange={(e) => setPlaybookPath(e.target.value)}
                  placeholder="/home/ansible/playbooks/check_ntp.yml"
                  className={`${inputCls} font-mono`}
                  required={advanced}
                />
                <p className="text-sm text-muted-foreground mt-1">실행 호스트(master#1) 상의 절대 경로</p>
              </div>
              <div>
                <label htmlFor={inventoryPathId} className="block text-sm font-medium mb-1">Inventory Path (optional)</label>
                <input
                  id={inventoryPathId}
                  type="text"
                  value={inventoryPath}
                  onChange={(e) => setInventoryPath(e.target.value)}
                  placeholder="/etc/ansible/inventory/hosts.yml"
                  className={`${inputCls} font-mono`}
                />
              </div>
            </>
          )}

          {/* Tags */}
          <div>
            <label htmlFor={tagsId} className="block text-sm font-medium mb-1">Tags (optional)</label>
            <input
              id={tagsId}
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. check,validate"
              className={inputCls}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50"
            >
              {initialData ? 'Save' : 'Register'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
