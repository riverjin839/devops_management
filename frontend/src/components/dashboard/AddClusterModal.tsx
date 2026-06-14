import { useId, useRef, useState } from 'react';
import {
  X, AlertTriangle, Loader2, Upload, WifiOff,
  ChevronRight, ChevronLeft, Check, Server,
  Cloud, Box, Layers, Cpu, Zap, Globe,
} from 'lucide-react';
import { useCreateCluster } from '@/hooks/useCluster';
import { formatApiError } from '@/lib/utils';

// ── Provider / Environment Types ────────────────────────────────────────────
interface ProviderOption {
  id: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
  color: string;
  defaultPort: string;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'on-prem',
    label: 'On-Premises',
    sub: 'Bare metal / VM',
    icon: <Server className="w-6 h-6" />,
    color: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
    defaultPort: '6443',
  },
  {
    id: 'aws-eks',
    label: 'AWS EKS',
    sub: 'Amazon Elastic K8s',
    icon: <Cloud className="w-6 h-6" />,
    color: 'border-orange-500/40 bg-orange-500/10 text-orange-400',
    defaultPort: '443',
  },
  {
    id: 'gcp-gke',
    label: 'GCP GKE',
    sub: 'Google Kubernetes Engine',
    icon: <Globe className="w-6 h-6" />,
    color: 'border-green-500/40 bg-green-500/10 text-green-400',
    defaultPort: '443',
  },
  {
    id: 'azure-aks',
    label: 'Azure AKS',
    sub: 'Azure Kubernetes Service',
    icon: <Layers className="w-6 h-6" />,
    color: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
    defaultPort: '443',
  },
  {
    id: 'rancher',
    label: 'Rancher',
    sub: 'Rancher Managed',
    icon: <Zap className="w-6 h-6" />,
    color: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400',
    defaultPort: '6443',
  },
  {
    id: 'kind',
    label: 'Kind / k3s',
    sub: 'Local Dev Cluster',
    icon: <Box className="w-6 h-6" />,
    color: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
    defaultPort: '6443',
  },
  {
    id: 'openshift',
    label: 'OpenShift',
    sub: 'Red Hat OpenShift',
    icon: <Cpu className="w-6 h-6" />,
    color: 'border-red-500/40 bg-red-500/10 text-red-400',
    defaultPort: '6443',
  },
];

// ── Steps ────────────────────────────────────────────────────────────────────
const STEPS = ['환경 선택', '기본 정보', 'Kubeconfig'] as const;
type Step = 0 | 1 | 2;

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractApiError(err: unknown): string {
  // formatApiError 는 FastAPI 422 detail(객체 배열) 도 안전하게 문자열화 → React #31 방지
  return formatApiError(err, 'Failed to create cluster');
}

// ── Modal ────────────────────────────────────────────────────────────────────
interface AddClusterModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddClusterModal({ isOpen, onClose }: AddClusterModalProps) {
  const [step, setStep] = useState<Step>(0);
  const [provider, setProvider] = useState<string>('on-prem');
  const [name, setName] = useState('');
  // 표준 네이밍 — [업무명]-[운영타입]-[속성] 조합. 비표준 이름은 직접 입력 모드(manualName)로.
  const [bizName, setBizName] = useState('');
  const [opsType, setOpsType] = useState('');
  const [attribute, setAttribute] = useState('');
  const [manualName, setManualName] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState('');
  const [region, setRegion] = useState('');

  const composedName = [bizName, opsType, attribute].map((s) => s.trim()).filter(Boolean).join('-');
  const effectiveName = (manualName ? name : composedName).trim();
  const [skipConnectivity, setSkipConnectivity] = useState(false);
  const [kubeconfigContent, setKubeconfigContent] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const apiEndpointId = useId();
  const regionId = useId();
  const kubeconfigId = useId();

  const createCluster = useCreateCluster();
  const isSubmitting = createCluster.isPending;

  const selectedProvider = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === 'string') setKubeconfigContent(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (typeof ev.target?.result === 'string') setKubeconfigContent(ev.target.result);
    };
    reader.readAsText(file);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    setStep(0);
    setProvider('on-prem');
    setName('');
    setBizName('');
    setOpsType('');
    setAttribute('');
    setManualName(false);
    setApiEndpoint('');
    setRegion('');
    setSkipConnectivity(false);
    setKubeconfigContent('');
    setError('');
    onClose();
  };

  const goNext = () => {
    setError('');
    if (step === 1) {
      if (!effectiveName) { setError(manualName ? '클러스터 이름은 필수입니다.' : '업무명·운영타입을 입력해 클러스터명을 구성하세요.'); return; }
      if (!skipConnectivity && !apiEndpoint.trim()) { setError('API Endpoint를 입력하거나 임시 등록을 선택하세요.'); return; }
    }
    setStep((s) => Math.min(s + 1, 2) as Step);
  };

  const goPrev = () => {
    setError('');
    setStep((s) => Math.max(s - 1, 0) as Step);
  };

  const handleSubmit = async () => {
    setError('');
    if (!effectiveName) { setError('클러스터 이름은 필수입니다.'); return; }

    try {
      await createCluster.mutateAsync({
        name: effectiveName,
        apiEndpoint: apiEndpoint.trim(),
        region: region.trim() || undefined,
        ...(kubeconfigContent.trim() ? { kubeconfigContent: kubeconfigContent.trim() } : {}),
        skipConnectivityCheck: skipConnectivity,
      });
      handleClose();
    } catch (err: unknown) {
      setError(extractApiError(err));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-[hsl(var(--card))] border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden"
           style={{ maxHeight: '90vh' }}>

        {/* ── Top bar ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg border ${selectedProvider.color}`}>
              {selectedProvider.icon}
            </div>
            <div>
              <h2 className="text-base font-semibold">클러스터 등록</h2>
              <p className="text-sm text-muted-foreground">{selectedProvider.label} — {STEPS[step]}</p>
            </div>
          </div>
          <button onClick={handleClose} disabled={isSubmitting}
            className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Step progress bar ── */}
        <div className="px-6 pt-4 pb-0">
          <div className="flex items-center gap-0">
            {STEPS.map((label, idx) => (
              <div key={label} className="flex items-center flex-1 last:flex-none">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                    idx < step ? 'bg-primary text-primary-foreground'
                    : idx === step ? 'bg-primary/20 border-2 border-primary text-primary'
                    : 'bg-secondary text-muted-foreground'
                  }`}>
                    {idx < step ? <Check className="w-3 h-3" /> : idx + 1}
                  </div>
                  <span className={`text-sm font-medium ${idx === step ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {label}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div className={`flex-1 h-px mx-3 ${idx < step ? 'bg-primary' : 'bg-border'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Content ── */}
        <div className="px-6 py-5 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 200px)' }}>

          {/* Step 0: Provider selection */}
          {step === 0 && (
            <div>
              <p className="text-sm text-muted-foreground mb-4">클러스터 환경을 선택하세요</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setProvider(p.id)}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-center ${
                      provider === p.id
                        ? `${p.color} shadow-lg scale-[1.02]`
                        : 'border-border bg-card hover:border-primary/30 hover:bg-secondary/50'
                    }`}
                  >
                    {provider === p.id && (
                      <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-primary-foreground" />
                      </div>
                    )}
                    <div className={provider === p.id ? '' : 'text-muted-foreground'}>
                      {p.icon}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${provider === p.id ? '' : 'text-foreground'}`}>{p.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.sub}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: Basic Info */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor={nameId} className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                      Cluster Name *
                    </label>
                    <button
                      type="button"
                      onClick={() => setManualName((v) => !v)}
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      {manualName ? '구조화 입력' : '직접 입력'}
                    </button>
                  </div>

                  {manualName ? (
                    <input
                      id={nameId}
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={`e.g. ${selectedProvider.id}-prod-01`}
                      autoFocus
                      className="w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        <input
                          id={nameId}
                          type="text"
                          value={bizName}
                          onChange={(e) => setBizName(e.target.value)}
                          placeholder="업무명"
                          autoFocus
                          className="flex-1 min-w-0 px-2.5 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                        />
                        <span className="text-muted-foreground font-mono">-</span>
                        <select
                          value={opsType}
                          onChange={(e) => setOpsType(e.target.value)}
                          className="w-28 px-2 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                        >
                          <option value="">운영타입</option>
                          <option value="prod">prod</option>
                          <option value="dev">dev</option>
                          <option value="test">test</option>
                          <option value="stage">stage</option>
                        </select>
                        <span className="text-muted-foreground font-mono">-</span>
                        <input
                          type="text"
                          value={attribute}
                          onChange={(e) => setAttribute(e.target.value)}
                          placeholder="속성"
                          className="flex-1 min-w-0 px-2.5 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        클러스터명:{' '}
                        <span className="font-mono text-foreground">{composedName || '업무명-운영타입-속성'}</span>
                        <span className="ml-2 text-muted-foreground/60">· 지역은 아래에 별도로 입력</span>
                      </p>
                    </>
                  )}
                </div>

                <div className="col-span-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor={apiEndpointId} className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                      API Endpoint {skipConnectivity ? '' : '*'}
                    </label>
                    {skipConnectivity && (
                      <span className="text-xs bg-amber-500/15 text-amber-400 border border-amber-500/25 px-1.5 py-0.5 rounded-full">
                        임시 등록 모드
                      </span>
                    )}
                  </div>
                  <input
                    id={apiEndpointId}
                    type="text"
                    value={apiEndpoint}
                    onChange={(e) => setApiEndpoint(e.target.value)}
                    placeholder={`https://your-cluster.example.com:${selectedProvider.defaultPort}`}
                    className={`w-full px-3 py-2.5 bg-secondary border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary ${
                      skipConnectivity ? 'border-amber-500/30' : 'border-border'
                    }`}
                  />
                  <p className="mt-1 text-xs text-muted-foreground font-mono">
                    kubectl config view --minify -o jsonpath=&#39;&#123;.clusters[0].cluster.server&#125;&#39;
                  </p>
                </div>

                <div>
                  <label htmlFor={regionId} className="block text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                    Region
                  </label>
                  <input
                    id={regionId}
                    type="text"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="e.g. ap-northeast-2, 서울"
                    className="w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setSkipConnectivity(!skipConnectivity)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 transition-all text-sm font-medium ${
                      skipConnectivity
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                        : 'bg-secondary border-border text-muted-foreground hover:border-amber-500/30 hover:text-amber-300'
                    }`}
                  >
                    <WifiOff className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm">임시 가등록</span>
                    {skipConnectivity && <Check className="w-3.5 h-3.5 ml-auto" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Kubeconfig */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Kubeconfig를 등록하면 노드 라벨, kubectl 기반 헬스체크 등 모든 기능을 사용할 수 있습니다.
                <span className="ml-1 text-primary/70">(선택사항)</span>
              </p>

              {/* Drag & drop zone */}
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => !kubeconfigContent && fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl transition-all cursor-pointer ${
                  kubeconfigContent
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border hover:border-primary/40 hover:bg-primary/5'
                }`}
              >
                {kubeconfigContent ? (
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 text-sm text-primary">
                        <Check className="w-4 h-4" />
                        <span>Kubeconfig 로드됨</span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setKubeconfigContent(''); }}
                        className="text-sm text-muted-foreground hover:text-destructive transition-colors"
                      >
                        제거
                      </button>
                    </div>
                    <pre className="text-xs font-mono text-muted-foreground bg-secondary/50 rounded-lg p-3 max-h-40 overflow-auto">
                      {kubeconfigContent.slice(0, 500)}{kubeconfigContent.length > 500 ? '\n...' : ''}
                    </pre>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                    <Upload className="w-8 h-8 opacity-40" />
                    <div className="text-center">
                      <p className="text-sm font-medium">드래그 &amp; 드롭 또는 클릭하여 업로드</p>
                      <p className="text-sm mt-0.5 opacity-60">.yaml, .yml, .conf 파일</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Manual paste */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor={kubeconfigId} className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    또는 직접 붙여넣기
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Upload className="w-3 h-3" />
                    파일 선택
                  </button>
                </div>
                <textarea
                  id={kubeconfigId}
                  value={kubeconfigContent}
                  onChange={(e) => setKubeconfigContent(e.target.value)}
                  placeholder="여기에 kubeconfig YAML 내용을 붙여넣으세요 (비워두면 kubeconfig 없이 등록)"
                  rows={6}
                  className="w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none"
                />
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.conf,.config"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive mt-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Verifying */}
          {isSubmitting && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-blue-400 mt-4">
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
              <span>클러스터 연결 검증 중... (최대 5초)</span>
            </div>
          )}
        </div>

        {/* ── Footer actions ── */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-secondary/20">
          <button
            type="button"
            onClick={step === 0 ? handleClose : goPrev}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors disabled:opacity-40"
          >
            {step > 0 && <ChevronLeft className="w-4 h-4" />}
            {step === 0 ? '취소' : '이전'}
          </button>

          <div className="flex items-center gap-1.5">
            {STEPS.map((_, idx) => (
              <div key={idx} className={`w-1.5 h-1.5 rounded-full transition-colors ${idx === step ? 'bg-primary' : 'bg-border'}`} />
            ))}
          </div>

          {step < 2 ? (
            <button
              type="button"
              onClick={goNext}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
            >
              다음
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className={`flex items-center gap-2 px-5 py-2 text-sm font-medium text-primary-foreground rounded-lg transition-colors disabled:opacity-50 ${
                skipConnectivity
                  ? 'bg-amber-500 hover:bg-amber-500/90'
                  : 'bg-primary hover:bg-primary/90'
              }`}
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {skipConnectivity ? '임시 가등록' : '클러스터 등록'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
