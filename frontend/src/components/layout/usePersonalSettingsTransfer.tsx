import { useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog, useToast } from '@/components/common';
import { exportPersonalSettings, importPersonalSettings } from '@/lib/personalSettingsFile';
import { formatApiError } from '@/lib/utils';

/**
 * 사용자 메뉴의 "개인 설정 내보내기/가져오기" — 메뉴(flyout)는 고르는 즉시 닫히므로 파일 선택 input 과
 * 확인 창은 메뉴 밖(Sidebar 루트)에 둬야 한다. 이 훅이 그 둘을 `element` 로 돌려준다.
 */
export function usePersonalSettingsTransfer(): {
  startExport: () => void;
  startImport: () => void;
  element: ReactNode;
} {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const startExport = () => {
    exportPersonalSettings()
      .then((name) => toast.success('개인 설정을 내보냈습니다.', name))
      .catch((e) => toast.error('내보내기 실패', formatApiError(e)));
  };

  const runImport = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await importPersonalSettings(pending);
      const skipped = r.skipped.length ? ` · 건너뜀: ${r.skipped.join(', ')}` : '';
      toast.success('개인 설정을 가져왔습니다. 화면을 새로 고칩니다.', `서버 ${r.applied.length}개 · 브라우저 ${r.localCount}개${skipped}`);
      // 테마 등 모듈 로드 시점에 읽는 값이 있어 새로 고쳐야 전부 반영된다.
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      toast.error('가져오기 실패', e instanceof Error && !('response' in e) ? e.message : formatApiError(e));
      setBusy(false);
    }
    setPending(null);
  };

  const element = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (f) setPending(f);
        }}
      />
      <ConfirmDialog
        open={pending !== null}
        title="개인 설정 가져오기"
        description="지금 내 개인 설정(홈·사이드바·즐겨찾기·터미널 색상·테마 등)을 파일 내용으로 바꿉니다. 비밀번호·자격증명은 파일에 들어 있지 않습니다."
        confirmLabel="가져오기"
        busy={busy}
        onConfirm={() => { void runImport(); }}
        onCancel={() => setPending(null)}
      >
        {pending && <p className="text-xs text-muted-foreground">파일: {pending.name}</p>}
      </ConfirmDialog>
    </>
  );

  return { startExport, startImport: () => inputRef.current?.click(), element };
}
