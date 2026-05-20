import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw, Upload, Image as ImageIcon } from 'lucide-react';
import {
  CLUSTER_ICON_GROUPS,
  CLUSTER_EMOJI_GROUPS,
  resolveClusterIcon,
} from '@/lib/clusterIcons';

interface ClusterIconPickerProps {
  /** 현재 저장된 icon 값 (lucide 이름 / emoji / data URL / null). */
  value: string | null | undefined;
  /** 새 값 선택 시 호출. null 이면 기본값(자동 status 아이콘) 으로 되돌림. */
  onChange: (next: string | null) => void;
  onClose: () => void;
  /** 항목 이름 (cluster 명 / service 라벨 등) — 헤더 노출. */
  clusterName?: string;
  /** 헤더 텍스트 — "아이콘 선택" 이외 라벨을 쓰고 싶을 때 (예: "서비스 아이콘 선택"). */
  title?: string;
  /** popover 기준 좌표 — 우클릭 위치 등에서 띄울 때 사용. 지정하지 않으면 화면 중앙 모달. */
  anchorRect?: DOMRect | null;
}

type Tab = 'icons' | 'emoji' | 'upload';

/** 업로드된 이미지를 64×64 정사각형 JPEG dataURL 로 리사이즈 (DB 저장 부담 최소화). */
async function resizeImageToDataUrl(file: File, maxSize = 64): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('이미지 디코딩 실패'));
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = maxSize;
  canvas.height = maxSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  // 비율 유지하며 중앙 크롭 (정사각형으로).
  const size = Math.min(img.width, img.height);
  const sx = (img.width - size) / 2;
  const sy = (img.height - size) / 2;
  ctx.drawImage(img, sx, sy, size, size, 0, 0, maxSize, maxSize);
  // PNG 는 투명 보존, JPEG 는 크기 작음. 이모지/로고는 보통 알파 필요 → PNG 우선.
  // 8KB 넘으면 JPEG 로 폴백.
  let out = canvas.toDataURL('image/png');
  if (out.length > 8 * 1024) {
    out = canvas.toDataURL('image/jpeg', 0.85);
  }
  return out;
}

const POPOVER_WIDTH = 360;
const POPOVER_MAX_HEIGHT = 520;

/** 클러스터 사이드바 아이콘을 사용자가 선택하는 picker.
 *  - lucide 아이콘 그리드 (화이트리스트)
 *  - emoji 입력 + 추천 그리드
 *  - "기본값으로 되돌리기" 버튼 (icon=null) */
export function ClusterIconPicker({
  value, onChange, onClose, clusterName, title, anchorRect,
}: ClusterIconPickerProps) {
  const resolved = resolveClusterIcon(value);
  const initialTab: Tab =
    resolved?.kind === 'text' ? 'emoji'
    : resolved?.kind === 'image' ? 'upload'
    : 'icons';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [emojiInput, setEmojiInput] = useState(resolved?.kind === 'text' ? resolved.value : '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 외부 클릭으로 닫기
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 다음 tick 에서 등록 — 이번 클릭(picker 를 여는 클릭)을 먹지 않도록.
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  // anchor 기반 위치 계산 — viewport 안에 들어오도록 우측/아래 클램프
  const positionStyle = (() => {
    if (!anchorRect) {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } as React.CSSProperties;
    }
    let left = anchorRect.right + 8;
    let top = anchorRect.top;
    if (typeof window !== 'undefined') {
      if (left + POPOVER_WIDTH > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8);
      }
      if (top + POPOVER_MAX_HEIGHT > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - POPOVER_MAX_HEIGHT - 8);
      }
    }
    return { top, left } as React.CSSProperties;
  })();

  const handleSelectLucide = (name: string) => {
    onChange(name);
    onClose();
  };

  const handleSelectEmoji = (emoji: string) => {
    onChange(emoji);
    onClose();
  };

  const handleReset = () => {
    onChange(null);
    onClose();
  };

  const handleEmojiSubmit = () => {
    const v = emojiInput.trim();
    if (!v) {
      handleReset();
      return;
    }
    handleSelectEmoji(v);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 가능하도록 reset
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('이미지 파일만 업로드 가능합니다.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('5MB 이하의 이미지만 업로드 가능합니다.');
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 64);
      onChange(dataUrl);
      onClose();
    } catch (err) {
      setUploadError((err as Error).message || '업로드 실패');
    } finally {
      setUploading(false);
    }
  };

  const currentImage = resolved?.kind === 'image' ? resolved.value : null;

  return createPortal(
    <>
      {!anchorRect && (
        <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm" aria-hidden />
      )}
      <div
        ref={containerRef}
        role="dialog"
        aria-label={title ?? '아이콘 선택'}
        style={{ width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT, ...positionStyle }}
        className="fixed z-[60] bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{title ?? '아이콘 선택'}</p>
            {clusterName && <p className="text-xs font-semibold truncate">{clusterName}</p>}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border bg-secondary/30">
          <TabButton active={tab === 'icons'} onClick={() => setTab('icons')}>아이콘</TabButton>
          <TabButton active={tab === 'emoji'} onClick={() => setTab('emoji')}>이모지</TabButton>
          <TabButton active={tab === 'upload'} onClick={() => setTab('upload')}>
            <span className="inline-flex items-center gap-1">
              <ImageIcon className="w-3 h-3" />업로드
            </span>
          </TabButton>
          <button
            onClick={handleReset}
            className="ml-auto px-3 py-1.5 text-[11px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title="status 기반 기본 아이콘으로 되돌리기"
          >
            <RotateCcw className="w-3 h-3" />
            기본값
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {tab === 'icons' && (
            CLUSTER_ICON_GROUPS.map((group) => (
              <section key={group.key}>
                <header className="flex items-baseline gap-2 px-1 mb-1.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </h3>
                  {group.hint && (
                    <p className="text-[10px] text-muted-foreground/70 truncate">{group.hint}</p>
                  )}
                </header>
                <div className="grid grid-cols-7 gap-1">
                  {group.items.map(({ name, Component: Icon }) => {
                    const isActive = value === name;
                    return (
                      <button
                        key={name}
                        onClick={() => handleSelectLucide(name)}
                        title={name}
                        className={`flex items-center justify-center aspect-square rounded-md transition-colors ${
                          isActive
                            ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
          {tab === 'emoji' && (
            <div className="space-y-3">
              <div className="flex items-center gap-1 px-1">
                <input
                  type="text"
                  value={emojiInput}
                  onChange={(e) => setEmojiInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleEmojiSubmit(); }}
                  placeholder="이모지 1자 입력 (예: 🚀)"
                  maxLength={4}
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={handleEmojiSubmit}
                  disabled={!emojiInput.trim()}
                  className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40"
                >
                  적용
                </button>
              </div>
              {CLUSTER_EMOJI_GROUPS.map((group) => (
                <section key={group.key}>
                  <header className="flex items-baseline gap-2 px-1 mb-1.5">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </h3>
                    {group.hint && (
                      <p className="text-[10px] text-muted-foreground/70 truncate">{group.hint}</p>
                    )}
                  </header>
                  <div className="grid grid-cols-10 gap-1">
                    {group.items.map((e) => {
                      const isActive = value === e;
                      return (
                        <button
                          key={e}
                          onClick={() => handleSelectEmoji(e)}
                          title={e}
                          className={`flex items-center justify-center aspect-square rounded-md text-lg leading-none transition-colors ${
                            isActive
                              ? 'bg-primary/15 ring-1 ring-primary/40'
                              : 'hover:bg-secondary'
                          }`}
                        >
                          {e}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
          {tab === 'upload' && (
            <div className="space-y-3 px-1">
              <p className="text-[11px] text-muted-foreground">
                이미지 파일을 업로드하면 64×64 정사각형으로 자동 크롭/축소돼 저장됩니다.
                보통 PNG (투명 보존) 로 저장되며, 너무 크면 JPEG 로 변환됩니다.
              </p>

              {currentImage && (
                <div className="rounded-lg border border-border bg-muted/20 p-2 flex items-center gap-2">
                  <img src={currentImage} alt="현재 아이콘" className="w-10 h-10 rounded-md object-cover border border-border" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium">현재 업로드된 이미지</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {Math.round(currentImage.length * 0.75 / 1024)} KB (base64)
                    </p>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                {uploading ? '처리 중…' : '이미지 선택'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />

              {uploadError && (
                <p className="text-[11px] text-red-500">{uploadError}</p>
              )}

              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                • 권장 사이즈: 정사각형 (예: 256×256)<br />
                • 최대 5MB · 자동 64×64 축소<br />
                • 저장 후 사이드바/카드/카탈로그 어디든 표시됩니다
              </p>
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground/70">
          ESC · 외부 클릭으로 닫기
        </div>
      </div>
    </>,
    document.body,
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
        active
          ? 'text-primary border-primary'
          : 'text-muted-foreground border-transparent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
