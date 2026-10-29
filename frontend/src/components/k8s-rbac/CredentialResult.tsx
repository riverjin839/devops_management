/**
 * 발급된 kubeconfig 표시(파일명이 `kubeconfig*` 면 .gitignore 에 걸려 CredentialResult 로 둔다) — 본문 + 복사 + .yaml 저장 + "이 화면에서만 볼 수 있음" 안내.
 * 토큰 값은 기본으로 가려 보여준다(화면 공유·어깨너머 노출 방지). 복사·저장은 항상 원문이다.
 * 액세스 발급 마법사 결과와 ServiceAccount 탭 재발급이 같은 블록을 쓴다(`IssuedCredentialCard`).
 */
import { useMemo, useState } from 'react';
import { Check, Copy, Download, Eye, EyeOff } from 'lucide-react';
import { maskKubeconfig } from './rbacShared';

interface Props {
  kubeconfig: string;
  /** 저장 파일 이름 — `kubeconfig-<cluster>-<sa>-<ns>.yaml`. */
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
      /* 클립보드 권한 없음 — 토큰 보기를 켠 뒤 아래 텍스트를 직접 선택해 복사 */
    }
  };
  return { copied, copy };
}

export function CredentialResult({ kubeconfig, fileName, maxHeight = 'max-h-56' }: Props) {
  const { copied, copy } = useCopy();
  const [reveal, setReveal] = useState(false);
  const masked = useMemo(() => maskKubeconfig(kubeconfig), [kubeconfig]);

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
      <pre
        aria-label={reveal ? 'kubeconfig 원문' : 'kubeconfig (토큰 가림)'}
        className={`bg-secondary border border-border rounded-md p-3 text-xs font-mono overflow-x-auto ${maxHeight} text-foreground`}
      >
        {reveal ? kubeconfig : masked}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => copy(kubeconfig)}
          title="kubeconfig 원문 복사"
          aria-label="kubeconfig 복사"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? '복사됨' : 'kubeconfig 복사'}
        </button>
        <button
          type="button"
          onClick={download}
          title={`${fileName} 로 저장`}
          aria-label="kubeconfig 파일로 저장"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
        >
          <Download className="w-3.5 h-3.5" /> .yaml 저장
        </button>
        <button
          type="button"
          onClick={() => setReveal(!reveal)}
          aria-pressed={reveal}
          title={reveal ? '토큰 다시 가리기' : '토큰 값 보기 — 화면 공유 중이면 켜지 마세요'}
          aria-label={reveal ? '토큰 가리기' : '토큰 보기'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary"
        >
          {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {reveal ? '토큰 가리기' : '토큰 보기'}
        </button>
        <span role="status" className="sr-only">
          {copied ? '클립보드에 복사됨' : ''}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        토큰은 이 화면에서만 볼 수 있습니다 — 감사 로그에는 발급 사실만 남고 토큰 값은 남지 않습니다. 개발자에게
        전달한 뒤 <span className="text-foreground">닫기</span> 를 누르세요. 메신저로 보냈다면 대화에서도 지우는 게 좋습니다.
      </p>
    </div>
  );
}
