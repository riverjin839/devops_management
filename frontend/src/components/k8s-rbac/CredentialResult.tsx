/**
 * 발급된 kubeconfig 표시(파일명이 `kubeconfig*` 면 .gitignore 에 걸려 CredentialResult 로 둔다) — 본문 + 복사 + .yaml 저장 + "이 화면에서만 볼 수 있음" 안내.
 * 액세스 발급 마법사 결과와 ServiceAccount 탭 재발급이 같은 블록을 쓴다.
 */
import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';

interface Props {
  kubeconfig: string;
  /** 저장 파일 이름 — `kubeconfig-<sa>-<ns>.yaml`. */
  fileName: string;
  maxHeight?: string;
}

/** 클립보드 복사 — 브라우저가 막으면 사용자가 직접 선택할 수 있게 조용히 실패한다. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 클립보드 권한 없음 — 아래 텍스트를 직접 선택해 복사 */
    }
  };
  return { copied, copy };
}

export function CredentialResult({ kubeconfig, fileName, maxHeight = 'max-h-56' }: Props) {
  const { copied, copy } = useCopy();

  const download = () => {
    const blob = new Blob([kubeconfig], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <pre className={`bg-secondary border border-border rounded-md p-3 text-xs font-mono overflow-x-auto ${maxHeight} text-foreground`}>
        {kubeconfig}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => copy(kubeconfig)}
          title="kubeconfig 복사"
          aria-label="kubeconfig 복사"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? '복사됨' : 'kubeconfig 복사'}
        </button>
        <button
          type="button"
          onClick={download}
          title="kubeconfig 파일로 저장"
          aria-label="kubeconfig 파일로 저장"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
        >
          <Download className="w-3.5 h-3.5" /> .yaml 저장
        </button>
        <span role="status" className="sr-only">
          {copied ? '클립보드에 복사됨' : ''}
        </span>
      </div>
      <p className="text-xs leading-relaxed rounded-md border border-status-warning/30 bg-status-warning/10 text-foreground px-3 py-2">
        토큰은 이 화면에서만 볼 수 있습니다. 창을 닫으면 다시 발급해야 합니다 — 감사 로그에는 발급 사실만
        남고 토큰 값은 남지 않습니다.
      </p>
    </div>
  );
}
