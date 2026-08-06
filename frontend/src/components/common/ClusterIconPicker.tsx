import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw, Upload, Image as ImageIcon, Wand2 } from 'lucide-react';
import {
  CLUSTER_ICON_GROUPS,
  CLUSTER_EMOJI_GROUPS,
  resolveClusterIcon,
} from '@/lib/clusterIcons';
import {
  buildClusterIconSvg, svgToDataUrl, suggestInitials, suggestRegionAbbr,
  suggestAttribute,
} from '@/lib/clusterIconBuilder';
import { useOperationLevels } from '@/hooks/useOperationLevels';
import { COLOR_PATTERNS } from '@/lib/colorPatterns';
import { resolveIconSeed, themePatternSeedHex } from '@/lib/clusterIconTheme';
import { useThemeStore } from '@/stores/themeStore';
import type { ClusterIconConfig } from '@/types';

/** 빌더 탭에 프리필할 클러스터 속성 — 전달되면 "빌더" 탭이 노출된다. */
export interface IconBuilderContext {
  name?: string | null;
  region?: string | null;
  operationLevel?: string | null;
  /** 기존에 저장된 아이콘 빌더 레시피 — 있으면 재편집 시 그대로 복원한다(패턴/커스텀 색 포함). */
  iconConfig?: ClusterIconConfig | null;
}

interface ClusterIconPickerProps {
  /** 현재 저장된 icon 값 (lucide 이름 / emoji / data URL / null). */
  value: string | null | undefined;
  /** 새 값 선택 시 호출. null 이면 기본값(자동 status 아이콘) 으로 되돌림.
   *  빌더 탭에서 고른 경우 iconConfig 도 함께 전달된다 — 다른 탭(아이콘/이모지/업로드) 선택
   *  또는 기본값 되돌리기에서는 iconConfig 를 명시적으로 null 로 전달해 해제해야 한다. */
  onChange: (next: string | null, iconConfig?: ClusterIconConfig | null) => void;
  onClose: () => void;
  /** 항목 이름 (cluster 명 / service 라벨 등) — 헤더 노출. */
  clusterName?: string;
  /** 헤더 텍스트 — "아이콘 선택" 이외 라벨을 쓰고 싶을 때 (예: "서비스 아이콘 선택"). */
  title?: string;
  /** popover 기준 좌표 — 우클릭 위치 등에서 띄울 때 사용. 지정하지 않으면 화면 중앙 모달. */
  anchorRect?: DOMRect | null;
  /** 클러스터 속성(이름/지역/운영등급) — 전달 시 이니셜+환경색+지역 조합 "빌더" 탭 활성. */
  builderContext?: IconBuilderContext;
}

type Tab = 'builder' | 'icons' | 'emoji' | 'upload';

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
  value, onChange, onClose, clusterName, title, anchorRect, builderContext,
}: ClusterIconPickerProps) {
  const resolved = resolveClusterIcon(value);
  const hasBuilder = !!builderContext;
  const initialTab: Tab =
    resolved?.kind === 'text' ? 'emoji'
    : resolved?.kind === 'image' ? 'upload'
    : hasBuilder ? 'builder'
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
    onChange(name, null);
    onClose();
  };

  const handleSelectEmoji = (emoji: string) => {
    onChange(emoji, null);
    onClose();
  };

  const handleReset = () => {
    onChange(null, null);
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
      onChange(dataUrl, null);
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
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{title ?? '아이콘 선택'}</p>
            {clusterName && <p className="text-sm font-semibold truncate">{clusterName}</p>}
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
          {hasBuilder && (
            <TabButton active={tab === 'builder'} onClick={() => setTab('builder')}>
              <span className="inline-flex items-center gap-1">
                <Wand2 className="w-3 h-3" />빌더
              </span>
            </TabButton>
          )}
          <TabButton active={tab === 'icons'} onClick={() => setTab('icons')}>아이콘</TabButton>
          <TabButton active={tab === 'emoji'} onClick={() => setTab('emoji')}>이모지</TabButton>
          <TabButton active={tab === 'upload'} onClick={() => setTab('upload')}>
            <span className="inline-flex items-center gap-1">
              <ImageIcon className="w-3 h-3" />업로드
            </span>
          </TabButton>
          <button
            onClick={handleReset}
            className="ml-auto px-3 py-1.5 text-xs inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title="status 기반 기본 아이콘으로 되돌리기"
          >
            <RotateCcw className="w-3 h-3" />
            기본값
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {tab === 'builder' && hasBuilder && (
            <BuilderTab
              context={builderContext!}
              onApply={(dataUrl, iconConfig) => { onChange(dataUrl, iconConfig); onClose(); }}
            />
          )}
          {tab === 'icons' && (
            CLUSTER_ICON_GROUPS.map((group) => (
              <section key={group.key}>
                <header className="flex items-baseline gap-2 px-1 mb-1.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </h3>
                  {group.hint && (
                    <p className="text-xs text-muted-foreground/70 truncate">{group.hint}</p>
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
                        aria-label={name}
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
                  className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40"
                >
                  적용
                </button>
              </div>
              {CLUSTER_EMOJI_GROUPS.map((group) => (
                <section key={group.key}>
                  <header className="flex items-baseline gap-2 px-1 mb-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </h3>
                    {group.hint && (
                      <p className="text-xs text-muted-foreground/70 truncate">{group.hint}</p>
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
              <p className="text-xs text-muted-foreground">
                이미지 파일을 업로드하면 64×64 정사각형으로 자동 크롭/축소돼 저장됩니다.
                보통 PNG (투명 보존) 로 저장되며, 너무 크면 JPEG 로 변환됩니다.
              </p>

              {currentImage && (
                <div className="rounded-lg border border-border bg-muted/20 p-2 flex items-center gap-2">
                  <img src={currentImage} alt="현재 아이콘" className="w-10 h-10 rounded-md object-cover border border-border" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">현재 업로드된 이미지</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {Math.round(currentImage.length * 0.75 / 1024)} KB (base64)
                    </p>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
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
                <p className="text-xs text-red-500">{uploadError}</p>
              )}

              <p className="text-xs text-muted-foreground/70 leading-relaxed">
                • 권장 사이즈: 정사각형 (예: 256×256)<br />
                • 최대 5MB · 자동 64×64 축소<br />
                • 저장 후 사이드바/카드/카탈로그 어디든 표시됩니다
              </p>
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1.5 border-t border-border text-xs text-muted-foreground/70">
          ESC · 외부 클릭으로 닫기
        </div>
      </div>
    </>,
    document.body,
  );
}

/** "빌더" 탭 — 업무명/속성(+지역, 옵션) 가로 밴드 + k8s 워터마크를 조합해 SVG 아이콘 생성.
 *  운영타입은 별도 밴드 없이 테두리/배경 색으로만 반영된다.
 *  색상은 기본적으로 "테마 동기화"(뷰어의 활성 UI 테마가 배색 패턴과 일치하면 그 색, 아니면
 *  운영타입 색상) 이고, 배색 패턴을 직접 고르면 그 색이 테마와 무관하게 항상 우선한다.
 *  클러스터의 name/region/operationLevel(+기존 iconConfig)로 자동 프리필되고 모든 값은 편집 가능. */
function BuilderTab({ context, onApply }: { context: IconBuilderContext; onApply: (dataUrl: string, iconConfig: ClusterIconConfig) => void }) {
  const { data: levels } = useOperationLevels();
  const activeTheme = useThemeStore((s) => s.theme);
  const existing = context.iconConfig;
  const [workName, setWorkName] = useState(() => existing?.workName ?? suggestInitials(context.name));
  const [level, setLevel] = useState(existing?.level ?? context.operationLevel ?? '');
  const [attribute, setAttribute] = useState(() => existing?.attribute ?? suggestAttribute(context.name));
  const [regionAbbr, setRegionAbbr] = useState(() => existing?.regionAbbr ?? suggestRegionAbbr(context.region));
  const [watermark, setWatermark] = useState(existing?.watermark ?? true);
  const [shape, setShape] = useState<'square' | 'circle'>(existing?.shape ?? 'square');
  /** 배색 패턴에서 직접 고른 시드 색상 — 지정되면 "커스텀"(colorMode: 'custom')이 되어
   *  테마 동기화 대신 이 색을 항상 우선 사용한다. null 이면 "테마 동기화"(colorMode: 'theme'). */
  const [patternHex, setPatternHex] = useState<string | null>(
    existing?.colorMode === 'custom' ? existing.customHex ?? null : null,
  );

  const colorMode: ClusterIconConfig['colorMode'] = patternHex ? 'custom' : 'theme';
  const previewConfig: ClusterIconConfig = { workName, attribute, regionAbbr, shape, watermark, level, colorMode, customHex: patternHex };
  const { colorToken, customHex } = resolveIconSeed(previewConfig, levels, activeTheme);
  const svg = useMemo(
    () => buildClusterIconSvg({ workName, attribute, regionAbbr, colorToken, customHex, k8sWatermark: watermark, shape }),
    [workName, attribute, regionAbbr, colorToken, customHex, watermark, shape],
  );
  const previewUrl = useMemo(() => svgToDataUrl(svg), [svg]);
  const themeSeedHex = themePatternSeedHex(activeTheme);

  return (
    <div className="space-y-3 px-1">
      <p className="text-xs text-muted-foreground">
        업무명 / 속성(+지역, 선택 시) 밴드를 위→아래로 쌓은 아이콘을 생성합니다. 운영타입은
        전용 밴드를 두지 않고 테두리·배경 색으로만 구분되며, 지역을 비우면 그 공간은
        업무명/속성 밴드에 재할당됩니다. 사이드바 레일에서도 클러스터를 한눈에 구분할 수 있습니다.
      </p>

      <p className="text-xs px-2 py-1.5 rounded-md bg-secondary/50 text-muted-foreground">
        {colorMode === 'custom'
          ? '커스텀 색상 적용됨 — 앞으로 UI 테마가 바뀌어도 이 색을 계속 사용합니다.'
          : themeSeedHex
            ? `현재 테마(${activeTheme})에 동기화됩니다 — UI 테마를 바꾸면 아이콘 색도 함께 바뀝니다.`
            : '현재 테마는 배색 패턴이 없어 운영타입 색상을 사용합니다 — 배색 패턴이 있는 테마를 쓰면 자동으로 그 색에 동기화됩니다.'}
      </p>

      {/* 미리보기 — 실제 크기(40px)와 확대(64px) 나란히 */}
      <div className="rounded-lg border border-border bg-muted/20 p-3 flex items-center justify-center gap-6">
        <div className="flex flex-col items-center gap-1">
          <img src={previewUrl} alt="미리보기 64px" className="w-16 h-16" />
          <span className="text-[10px] text-muted-foreground">64px</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <img src={previewUrl} alt="미리보기 40px (사이드바)" className="w-10 h-10" />
          <span className="text-[10px] text-muted-foreground">사이드바</span>
        </div>
      </div>

      {/* 업무명 / 속성 — 아이콘에 실제로 표시되는 정보 */}
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">업무명 (1~5자)</span>
        <input
          type="text"
          value={workName}
          onChange={(e) => setWorkName(e.target.value.slice(0, 5))}
          maxLength={5}
          className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">속성 — 클러스터 기능 (예: Computing/Storage)</span>
        <input
          type="text"
          value={attribute}
          onChange={(e) => setAttribute(e.target.value.slice(0, 5))}
          maxLength={5}
          placeholder="예: Compute"
          className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">지역 약어 (선택 — 비우면 남는 공간을 업무명/속성에 재할당)</span>
        <input
          type="text"
          value={regionAbbr}
          onChange={(e) => setRegionAbbr(e.target.value.slice(0, 5))}
          maxLength={5}
          placeholder="예: 이천 (선택)"
          className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      {/* 운영타입 — 아이콘 내부에 전용 밴드를 두지 않고 테두리/배경 색으로만 반영 */}
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">운영타입 (색상만 반영 — 테두리·배경, 전용 밴드 없음)</span>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">(미지정 — 회색)</option>
          {(levels ?? []).map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </label>

      {/* 배색 패턴 — 큐레이션 팔레트에서 색을 직접 고르면 운영타입 색상을 덮어쓴다.
          같은 이름의 앱 테마(Settings 와 무관하게 사이드바 테마 순환 버튼에서도 선택 가능)와
          팔레트를 맞춰, 특정 테마를 쓸 때 그 테마 색으로 아이콘도 통일할 수 있게 한다. */}
      <div className="flex flex-col gap-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">배색 패턴 (선택 — 고르면 운영타입 색상 대신 적용)</span>
          {patternHex && (
            <button
              type="button"
              onClick={() => setPatternHex(null)}
              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              테마 동기화로 되돌리기
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {COLOR_PATTERNS.map((pattern) => (
            <div key={pattern.key} className="flex items-center gap-1.5">
              <span className="w-24 shrink-0 truncate text-muted-foreground/80">{pattern.label}</span>
              <div className="flex items-center gap-1">
                {pattern.colors.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setPatternHex(hex)}
                    title={hex}
                    aria-label={`${pattern.label} ${hex}`}
                    style={{ backgroundColor: hex }}
                    className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 ${
                      patternHex === hex ? 'border-primary ring-1 ring-primary' : 'border-border/60'
                    }`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} className="accent-primary" />
          k8s 휠 워터마크
        </label>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => setShape('square')}
            className={`px-2 py-1 ${shape === 'square' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            사각
          </button>
          <button
            type="button"
            onClick={() => setShape('circle')}
            className={`px-2 py-1 border-l border-border ${shape === 'circle' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            원형
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onApply(previewUrl, { workName, attribute, regionAbbr, shape, watermark, level, colorMode, customHex: patternHex })}
        disabled={!workName.trim()}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
      >
        <Wand2 className="w-3.5 h-3.5" />
        이 아이콘 적용
      </button>

      <p className="text-xs text-muted-foreground/70 leading-relaxed">
        • SVG 로 저장되어 어느 크기에서도 선명합니다<br />
        • 우상단은 상태 표시(dot) 자리라 비워둡니다<br />
        • 운영타입별 기본 색은 Settings ▸ 운영등급에서 바꿀 수 있습니다<br />
        • 배색 패턴을 고르면 이 아이콘 1개에만 커스텀 색이 고정되고, 이후 테마를 바꿔도 유지됩니다<br />
        • 패턴을 고르지 않으면 이 아이콘은 모든 뷰어의 활성 테마를 계속 따라갑니다
      </p>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'text-primary border-primary'
          : 'text-muted-foreground border-transparent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
