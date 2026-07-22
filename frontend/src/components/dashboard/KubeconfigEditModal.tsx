import { useEffect, useId, useRef, useState } from 'react';
import { X, AlertTriangle, Loader2, Upload, Save, Eye, EyeOff } from 'lucide-react';
import { useKubeconfig, useUpdateKubeconfig } from '@/hooks/useCluster';
import { useModalA11y } from '@/components/common/useModalA11y';
import { formatApiError } from '@/lib/utils';

interface KubeconfigEditModalProps {
  clusterId: string;
  clusterName: string;
  isOpen: boolean;
  onClose: () => void;
}

function extractApiError(err: unknown): string {
  return formatApiError(err, '알 수 없는 오류가 발생했습니다.');
}

export function KubeconfigEditModal({
  clusterId,
  clusterName,
  isOpen,
  onClose,
}: KubeconfigEditModalProps) {
  const [editContent, setEditContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: kubeconfig, isLoading, isError, error } = useKubeconfig(isOpen ? clusterId : '');
  const updateKubeconfig = useUpdateKubeconfig();
  const dialogRef = useModalA11y(isOpen, onClose);
  const headingId = useId();

  // Sync textarea with loaded content when entering edit mode
  useEffect(() => {
    if (isEditing && kubeconfig) {
      setEditContent(kubeconfig.content);
    }
  }, [isEditing, kubeconfig]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsEditing(false);
      setEditContent('');
      setSaveError('');
      setSaveSuccess(false);
    }
  }, [isOpen]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === 'string') setEditContent(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSave = async () => {
    setSaveError('');
    setSaveSuccess(false);
    if (!editContent.trim()) {
      setSaveError('kubeconfig 내용이 비어 있습니다.');
      return;
    }
    try {
      await updateKubeconfig.mutateAsync({ id: clusterId, content: editContent.trim() });
      setSaveSuccess(true);
      setIsEditing(false);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(extractApiError(err));
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent('');
    setSaveError('');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId} className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 id={headingId} className="text-lg font-semibold">Kubeconfig 관리</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{clusterName}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">불러오는 중...</span>
          </div>
        ) : isError ? (
          /* No kubeconfig yet — start in edit mode to create one */
          <div className="space-y-3">
            <div className="flex items-start gap-2 px-3 py-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                {extractApiError(error)}
                <br />
                아래에 kubeconfig를 입력하면 새로 등록됩니다.
              </span>
            </div>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="kubeconfig YAML 내용을 붙여넣으세요..."
              rows={10}
              className="w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                파일에서 불러오기
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.conf,.config"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
            {saveError && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{saveError}</span>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={updateKubeconfig.isPending}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {updateKubeconfig.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                저장
              </button>
            </div>
          </div>
        ) : isEditing ? (
          /* Edit mode */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">kubeconfig YAML 편집</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                파일에서 불러오기
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.conf,.config"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={14}
              className="w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
            />
            {saveError && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{saveError}</span>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-1">
              <button
                onClick={handleCancelEdit}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={updateKubeconfig.isPending}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {updateKubeconfig.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                저장
              </button>
            </div>
          </div>
        ) : (
          /* View mode */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Eye className="w-3.5 h-3.5" />
                <span>경로: {kubeconfig?.path}</span>
              </div>
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-lg transition-colors"
              >
                <EyeOff className="w-3.5 h-3.5" />
                수정
              </button>
            </div>
            <pre className="w-full px-3 py-3 bg-secondary border border-border rounded-lg text-sm font-mono text-foreground overflow-auto max-h-80 whitespace-pre-wrap break-all">
              {kubeconfig?.content}
            </pre>
            {saveSuccess && (
              <div className="px-3 py-2.5 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-400">
                kubeconfig가 저장되었습니다.
              </div>
            )}
            <div className="flex justify-end pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                닫기
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
