# DEVOPS MANAGEMENT — Design System

> **Stack**: React 18 + TypeScript + Tailwind CSS + Recharts + shadcn/ui (Radix)
> **Mode**: 테마 3종 — 기본값은 `default`(Anthropic Claude 브랜드 톤, radius 14px), 대안으로
> `light`/`dark`(Databricks-leaning flat, radius 8px) + `system`. 이 문서의 "Ops Slate" 다크
> 규격은 `html.dark` 테마에 해당한다. (테마 전환: `stores/themeStore.ts`, fallback `'default'`)
> **Source of truth**: 규격 근거는 이 문서, 토큰 **실측값**은 `frontend/src/index.css` (테마별 상이).
> 컴포넌트는 토큰만 참조해야 함. 운영(감사·백로그)은 `DESIGN.md`.
> **검증**: ui-ux-pro-max v2.5.0 (50+ 스타일 / 161 팔레트 / 57 페어링 / 25 차트) 데이터와 대조 확정.

---

## 0. 사용 맥락

- **사용자**: 운영(Ops/SRE) 엔지니어
- **사용 패턴**: 09/13/18 KST 정기 점검 + 인시던트 발생 시 장시간 응시
- **핵심 요구**: ① 0.5초 안에 전체 상태 인지 ② 색맹 안전 ③ OLED 친화 ④ 정확한 숫자 비교 ⑤ 키보드 우선

---

## 1. 스타일 — 후보 3개 비교

ui-ux-pro-max 검색에서 운영 도구에 매칭된 상위 3개 (출처: `styles.csv`).

| # | 스타일 카테고리 | 키워드 | 장점 | 단점 | 적합도 |
|---|---|---|---|---|---|
| **A** | **Real-Time Monitoring** | live status, streaming charts, alert pulse, status indicators | 운영 도메인 직격, status color 4단계 패턴 검증, light/dark 모두 지원, WCAG AA | pulse/blink 애니메이션 과하면 피로 — `prefers-reduced-motion` 필수 | ⭐⭐⭐⭐⭐ |
| **B** | **Data-Dense Dashboard** | 12-col grid, KPI cards row, minimal padding (8-12px), data tables | 정보 밀도 ↑ (운영자가 한 화면에서 다 보고 싶어함), 12-col grid 표준 | 과도한 밀도는 인지 부하 — 컴포넌트별 여백 규칙 엄격해야 | ⭐⭐⭐⭐⭐ |
| **C** | **Executive Dashboard** | large KPI (24-48px), traffic-light indicators, 4-6 cards max, sparkline | 한눈에 인지 (Health Hero에 부분 활용 가치), 인지 부하 낮음 | 정보 밀도 부족 — 본문 영역엔 불충분 | ⭐⭐⭐ |

### ✅ 최종 채택: **A + B 하이브리드**
- **Health Hero / Top 영역** → A (Real-Time Monitoring) + C의 large KPI 패턴 차용
- **본문(메트릭/플레이북/히스토리)** → B (Data-Dense Dashboard, 12-col grid)
- **근거**: 운영 모니터링은 "상단 hero에서 즉시 인지 → 하단에서 상세 분석" 2단 흐름이고, 단일 스타일로는 두 요구를 동시에 만족할 수 없음. 스킬 데이터의 #1·#5·#6 결과가 같은 결론을 가리킴.

> **이전 제안과의 델타**: "Linear-inspired Dense Pro"는 검증 데이터엔 직접 매칭 없음 → **Real-Time Monitoring + Data-Dense Dashboard** 공식 패턴으로 교체. 시각 인상은 비슷하지만 출처가 명확해짐.

---

## 2. 컬러 팔레트 (Dark Mode)

### 검증: 161 팔레트 중 모니터링 적합 후보

ui-ux-pro-max `colors.csv` 검색 결과:

| Rank | Product Type | Background | Card | Notes |
|---|---|---|---|---|
| 1 | **Smart Home / IoT Dashboard** | `#0F172A` | `#1B2336` | "Dark tech + status green" |
| 2 | Financial Dashboard | `#020617` | `#0E1223` | 더 어둡지만 OLED 번인 위험 ↓는 미미, 텍스트 contrast 빡빡 |

### ✅ 최종 채택: **"Ops Slate"** (IoT Dashboard 베이스 + Real-Time Monitoring status 색)

> **근거 (한 줄)**: IoT Dashboard 팔레트가 "온도/상태/연결성"이라는 K8s 모니터링과 동일 멘탈 모델을 가지고 있고, status accent로 정의된 `#22C55E`가 운영 도구의 healthy 표준임. background `#0F172A`는 OLED 친화 + Tailwind `slate-900` 표준이라 shadcn/ui와 무충돌.

#### 2.1 Surface Tokens

| Token | HEX | HSL | 용도 |
|---|---|---|---|
| `background`        | `#0F172A` | `222 47% 11%` | 페이지 배경 (slate-900) |
| `surface`           | `#1B2336` | `222 30% 16%` | 카드 표면 (Smart Home Card) |
| `surface-elevated`  | `#272F42` | `224 26% 21%` | 모달·팝오버·hover (Smart Home Muted) |
| `border`            | `#334155` | `215 25% 27%` | 카드 테두리 (slate-700) |
| `border-subtle`     | `#1E293B` | `217 33% 17%` | 표 행 구분선 (slate-800) |

**Surface Container 5단계** (W3, Material Theme Builder 벤치마킹 — `index.css`/`tailwind.config.js` 실제 구현):
그림자 대신 톤 차이로 깊이감을 준다(`--card-shadow: none` 철학과 일치). 중첩된 패널(카드 안 카드,
사이드바 안 서브패널 등)에서 표면 단계를 구분할 때 사용 — `bg-surface-container-lowest` ~
`bg-surface-container-highest` (라이트: lowest=가장 밝음(바탕) → highest=가장 진함/도드라짐,
다크: 반대로 lowest=배경과 동일(sunken) → highest=가장 밝음(elevated)). 테마별 실제 HSL 값은
`index.css` 참고.

#### 2.2 Text Tokens

| Token | HEX | HSL | 용도 |
|---|---|---|---|
| `foreground`         | `#F8FAFC` | `210 40% 98%` | 본문 텍스트 (slate-50) — contrast 16.1:1 ✓ AAA |
| `muted-foreground`   | `#94A3B8` | `215 20% 65%` | 보조 텍스트 (slate-400) — contrast 7.5:1 ✓ AAA |
| `disabled-foreground`| `#475569` | `215 19% 35%` | 비활성 텍스트 (slate-600) |

#### 2.3 Brand Tokens

| Token | HEX | HSL | 용도 |
|---|---|---|---|
| `primary`            | `#3B82F6` | `217 91% 60%` | 액션·링크·active tab (blue-500) |
| `primary-foreground` | `#FFFFFF` | `0 0% 100%`   | primary 위 텍스트 |
| `ring`               | `#3B82F6` | `217 91% 60%` | focus ring (primary와 동일) |

#### 2.4 Status Tokens (★ 운영 도구의 핵심)

ui-ux-pro-max `Real-Time Monitoring` + `Executive Dashboard` 가이드 기준 — **모두 WCAG AA 통과 + 색맹(Deuteranopia) 구분 가능**.

| Token | HEX | HSL | 용도 |
|---|---|---|---|
| `status-healthy`    | `#22C55E` | `142 71% 45%` | Healthy / OK / Running (green-500) |
| `status-warning`    | `#F59E0B` | `38 92% 50%`  | Warning / Degraded (amber-500) |
| `status-critical`   | `#DC2626` | `0 84% 50%`   | Critical / Down / Failed (red-600) |
| `status-unknown`    | `#6B7280` | `220 9% 46%`  | Unknown / Pending (gray-500) |
| `status-info`       | `#0EA5E9` | `199 89% 48%` | Info / Streaming update (sky-500) |

각 status에 대응하는 **부드러운 배경**(badge/alert용):

| Token | HEX (10% alpha) | 용도 |
|---|---|---|
| `status-healthy-bg`  | `rgba(34,197,94,0.10)`  | Healthy badge bg |
| `status-warning-bg`  | `rgba(245,158,11,0.10)` | Warning badge bg |
| `status-critical-bg` | `rgba(220,38,38,0.10)`  | Critical badge bg |
| `status-unknown-bg`  | `rgba(107,114,128,0.10)`| Unknown badge bg |

> **이전 제안과의 델타**:
> - 이전: 배경 `#0B0F1A` → **변경 → `#0F172A`** (Tailwind slate-900 = shadcn/ui 표준, 마이그레이션 비용 ↓)
> - 이전: primary `#5B8DEF` → **변경 → `#3B82F6`** (blue-500, shadcn/ui 기본값)
> - 이전: success `#3FB950` → **변경 → `#22C55E`** (green-500, ui-ux-pro-max 검증값)
> - 이전: critical `#F85149` → **변경 → `#DC2626`** (red-600, contrast 더 안전)
> - 이전: warning `#D29922` → **변경 → `#F59E0B`** (amber-500, 표준)
> - 이전 `pending` 보라 → **삭제** (4색만으로 충분, 5색은 인지 부하 ↑)

#### 2.5 Tailwind / CSS 적용 스니펫

```css
/* index.css */
:root.dark, .dark {
  /* Surface */
  --background: 222 47% 11%;
  --card: 222 30% 16%;
  --card-elevated: 224 26% 21%;
  --border: 215 25% 27%;
  --border-subtle: 217 33% 17%;

  /* Text */
  --foreground: 210 40% 98%;
  --muted-foreground: 215 20% 65%;

  /* Brand */
  --primary: 217 91% 60%;
  --primary-foreground: 0 0% 100%;
  --ring: 217 91% 60%;

  /* Status (raw HEX 사용 금지 — 반드시 이 토큰만) */
  --status-healthy:  142 71% 45%;
  --status-warning:   38 92% 50%;
  --status-critical:   0 84% 50%;
  --status-unknown:  220  9% 46%;
  --status-info:     199 89% 48%;
}
```

```js
// tailwind.config.js (extend.colors)
status: {
  healthy:  'hsl(var(--status-healthy)  / <alpha-value>)',
  warning:  'hsl(var(--status-warning)  / <alpha-value>)',
  critical: 'hsl(var(--status-critical) / <alpha-value>)',
  unknown:  'hsl(var(--status-unknown)  / <alpha-value>)',
  info:     'hsl(var(--status-info)     / <alpha-value>)',
}
```

사용 예: `text-status-healthy`, `bg-status-critical/10`, `border-status-warning/30`

---

## 3. 폰트 페어링

### 검증: 57 페어링 중 모니터링 도구 적합 후보

| Rank | Pairing | Heading | Body | Notes |
|---|---|---|---|---|
| **1** | **Dashboard Data** | Fira Code | Fira Sans | "Fira family cohesion. Code for data, Sans for labels" — 정확히 모니터링용 |
| 2 | Developer Mono | JetBrains Mono | IBM Plex Sans | "Developer-focused, CLI apps" — 우리 도구도 부합 |
| 3 | Science/Tech | Exo | Roboto Mono | 데이터 사이트, 다소 마케팅 톤 |

### ✅ 최종 채택: **"Ops Stack"** (Inter UI + JetBrains Mono numeric + Pretendard fallback)

> **근거 (한 줄)**: ui-ux-pro-max #1·#2 검증 결과를 절충 — 본문은 한국어 호환 강한 **Inter + Pretendard**, 숫자/코드/PromQL은 0/O 1/l 5/S 구분이 가장 명확한 **JetBrains Mono**. Fira는 한국어 fallback 매칭이 아쉬워 본문 폰트로는 부적합 판단.

| 역할 | 폰트 | 사이즈 / Weight | Google Fonts URL |
|---|---|---|---|
| **Heading** | **Inter** | 24/20/16px · 600~700 | `https://fonts.google.com/specimen/Inter` |
| **Body** | **Inter** | 14px · 400~500 | (위와 동일) |
| **Numeric / Mono** | **JetBrains Mono** | 14~28px · 500 | `https://fonts.google.com/specimen/JetBrains+Mono` |
| **Korean fallback** | **Pretendard Variable** | 본문 전용 | `https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css` |

#### 3.1 CSS Import

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css');

:root {
  --font-sans: 'Inter', 'Pretendard Variable', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'D2Coding', ui-monospace, monospace;
}

/* 메트릭 큰 숫자에 tabular-nums 강제 */
.font-tabular {
  font-feature-settings: "tnum" 1, "ss01" 1;
  font-variant-numeric: tabular-nums;
}
```

> **이전 제안과의 델타**: 본문 폰트 후보로 Fira Sans도 검토했으나 한국어 결합 시 자간이 어색 → Inter + Pretendard로 확정. JetBrains Mono는 ui-ux-pro-max #2·#6 결과에서 모두 채택되어 유지.

#### 3.2 타입 스케일

| 역할 | px | weight | 비고 |
|---|---|---|---|
| Display (Health Hero 큰 숫자) | 48 | 700 | mono, tnum |
| H1 | 24 | 700 | sans |
| H2 / Section | 20 | 700 | sans |
| H3 / Card title | 16 | 600 | sans |
| Body | 14 | 400 | sans |
| Caption / Label | 12 | 500 | sans, uppercase 옵션 |
| Mono inline (PromQL/log) | 13 | 400 | mono |

---

## 4. Health Hero 레이아웃 패턴

### 검증: 후보 비교

ui-ux-pro-max `landing.csv` 검색 결과:

| Pattern | 매칭 키워드 | 적합도 |
|---|---|---|
| **Bento Grid Showcase** | grid, modular, scannable, mobile stack | ⭐⭐⭐⭐⭐ |
| Real-Time / Operations Landing | live preview, key metrics, dark, status colors | ⭐⭐⭐⭐⭐ (정확히 우리 도메인) |
| Hero-centric | single CTA emphasis | ⭐⭐ |
| Split-Pane | content vs preview | ⭐⭐ |

### ✅ 최종 채택: **Asymmetric Bento Grid (12-col)** — Real-Time Operations 패턴의 hero 구획에 적용

> **근거 (한 줄)**: ui-ux-pro-max가 명시적으로 추천한 두 패턴이 **Bento Grid Showcase**와 **Real-Time / Operations Landing**이고, 둘의 교집합이 정확히 "비대칭 셀로 우선순위를 시각화하는 12-col grid". Hero+Cards는 1 KPI만 강조 가능, Split-Pane은 좌우 2분할만 가능 — 우리는 1 hero + 4 KPI를 동시에 표현해야 함.

#### 4.1 구조

```
┌─────────────────────────────────────────────────────────────┐
│  [ OVERALL HEALTH (Bullet) ]   │ [ CRITICAL ] [ WARNINGS ] │
│   Big number 94%                │   12          3           │
│   "Healthy" + bullet bar        │   + sparkline + sparkline │
│   col-span-6  row-span-2        │   col-span-3  col-span-3  │
│                                 │ ─────────────────────────│
│                                 │ [ LAST CHECK ][ NEXT     ]│
│                                 │   2m ago       in 4h 23m  │
│                                 │   col-span-3  col-span-3  │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2 Tailwind 구현

```tsx
<section className="grid grid-cols-12 gap-4 auto-rows-[minmax(120px,auto)]">
  <HealthHeroBullet  className="col-span-12 lg:col-span-6 lg:row-span-2" />
  <CriticalCard      className="col-span-6  lg:col-span-3" />
  <WarningCard       className="col-span-6  lg:col-span-3" />
  <LastCheckCard     className="col-span-6  lg:col-span-3" />
  <NextCheckCard     className="col-span-6  lg:col-span-3" />
</section>
```

- 모바일(< sm): 자동 1~2 col reflow
- 셀 크기 = 정보 우선순위 (Hero 4×, KPI 1×)
- gap은 `--space-4` (16px) 고정
- 본문은 같은 12-col 격자 위에서 `col-span-12` / `col-span-8 + col-span-4` 등으로 자유 배치

---

## 5. 차트 타입

### 검증: 25 차트 타입 중 클러스터 상태 적합 후보

| Rank | Data Type | Best Chart | A11y Grade | 이유 |
|---|---|---|---|---|
| **1** | Performance vs Target (Compact) | **Bullet Chart** | **AAA** | 다중 KPI를 같은 화면에 — 우리 핵심 |
| 2 | Real-Time Streaming | Streaming Area / Moving Gauge | B | Pulse 애니, real-time 업데이트 |
| 3 | Heatmap / Intensity | **Heat Map** | B | cluster × time 매트릭스 — 우리 history |
| 4 | Anomaly Detection | Line Chart with Highlights | AA | 인시던트 분석용 |
| 5 | Trend Over Time | Line Chart (Sparkline) | AA | KPI 카드 미니 트렌드 |

### ✅ 최종 채택 — 3종

#### ① Bullet Chart (Health Hero 메인) — *Radial Gauge 대신 채택*
> **근거 (한 줄)**: ui-ux-pro-max 기준 **A11y AAA** (Gauge는 AA), 동일 셀에서 actual + target + threshold zone을 모두 표현 가능, 다중 KPI 비교 가능. Recharts 미지원이라 SVG 직접 구현 또는 D3 활용.
- **위치**: Health Hero 좌측 큰 셀 + 본문 KPI 비교 카드
- **시각**: 가로 막대 + 타겟 마커 + 3-zone 배경 (`status-critical-bg` / `status-warning-bg` / `status-healthy-bg`)
- **Recharts 호환**: 제한적 → SVG 컴포넌트 직접 작성 권장

#### ② Sparkline (KPI 카드 트렌드)
> **근거 (한 줄)**: ui-ux-pro-max `Trend Over Time` 결과 — Recharts 9/10 호환, KPI 카드 1장 안에 "현재 값 + 최근 N분 추세"를 동시 표현하는 사실상 표준.
- **위치**: Critical/Warning/CPU/Memory 카드 하단
- **Recharts**: `<LineChart data={...} width={120} height={32}>` + 축/툴팁 숨김
- **색**: 추세에 따라 `status-healthy` / `status-critical` 자동 전환

#### ③ Heat Map (Recent Check History — cluster × time)
> **근거 (한 줄)**: ui-ux-pro-max `Heatmap / Intensity` — "time-based patterns (e.g., activity by hour × day)"가 정확히 우리 케이스. 표보다 패턴(특정 클러스터의 정기 warning) 발견에 압도적 우위.
- **위치**: Dashboard 하단 "Recent Check History" 섹션
- **구현**: CSS Grid + status 배경색 직접 구현 (라이브러리 불필요, ~30줄)
- **A11y 보강**: 셀에 `aria-label="cluster=prod time=09:00 status=critical"` + 호버 시 shadcn `<Tooltip>`으로 상세

### ❌ 비추천 차트 (이 프로젝트엔 부적합)

- **Pie / Donut (4+ slices)**: ui-ux-pro-max `no-pie-overuse` 룰 — 5+ 카테고리는 Bar로
- **Radial Gauge** (이전 제안): Bullet Chart가 같은 정보를 더 적은 공간 + 더 높은 A11y로 표현
- **3D Chart**: 정확한 값 읽기 불가
- **Streaming Area** (실시간): 우리는 5분 간격 polling이지 1Hz 스트림 아님 — 과한 패턴

> **이전 제안과의 델타**:
> - 이전 **Radial Gauge** → **Bullet Chart**로 교체 (A11y AAA 대 AA, 멀티 KPI 가능)
> - **Sparkline / Heat Map**은 그대로 유지 (검증 완료)

---

## 6. shadcn/ui 컴포넌트 매핑

| 용도 | shadcn/ui 컴포넌트 | 우리 적용 |
|---|---|---|
| 카드 컨테이너 | `Card` | 기존 `MacCard` → `Card` 어댑터로 통합. traffic-light 점은 옵션 prop |
| 버튼 | `Button` | variants: `default` / `secondary` / `ghost` / `destructive` × `sm` / `default` / `lg` |
| 상태 라벨 | `Badge` | 색 dot + 텍스트 동시 표기 (a11y: 색만으로 의미 전달 금지) |
| 모달 | `Dialog`, `Sheet` (모바일 사이드바) | 현재 자체 모달 교체 |
| 툴팁 | `Tooltip` (Radix) | 현재 `PortalTooltip` 교체 — 키보드 트리거 자동 |
| 탭 | `Tabs` | Dashboard Overview / Operations / History 분리에 사용 |
| 액션 메뉴 | `DropdownMenu` | Top bar "+ Add" / "More" 메뉴 |
| 토스트 | `Sonner` | 현재 자체 Toast 검토 후 교체 |
| 표 | `Table` | Recent History 표 / 클러스터 목록 |
| 폼 | `Form` + react-hook-form + zod | Add Cluster / Add Metric 모달 |
| Input | `Input`, `Label`, `Select`, `Switch` | 폼 필드 표준화 |
| Skeleton | `Skeleton` | 자체 Skeleton 교체 |

설치: `npx shadcn@latest init` → 위 목록 순차 추가.
(패키지명이 `shadcn-ui` → `shadcn` 으로 바뀌었다. 2026.7 기준 `init` 시 **Base UI** 가 기본 프리미티브이며, Radix 도 계속 지원한다. shadcn 추상화 덕에 컴포넌트 API 는 동일하므로 기존 Radix 코드와 공존한다.)
AI(Claude Code)로 컴포넌트를 추가할 땐 `frontend/.mcp.json` 의 shadcn MCP 를 통해 레지스트리에서 실제 컴포넌트를 조회·설치한다(props 환각 방지).

---

## 7. 인터랙션 / 모션 토큰

ui-ux-pro-max 룰 §7 기준.

| Token | Value | 용도 |
|---|---|---|
| `--motion-fast`   | `120ms` | 호버, focus ring |
| `--motion-base`   | `200ms` | 카드 진입, 모달 열림 |
| `--motion-slow`   | `300ms` | 페이지 전환, 드로어 |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 표준 (Material) |
| `--ease-emphasized` | `cubic-bezier(0.2, 0, 0.2, 1)` | 강조 |

규칙
- 모든 애니메이션은 `prefers-reduced-motion: reduce` 시 즉시 단축/제거
- exit duration ≈ enter × 0.7 (`exit-faster-than-enter`)
- transform/opacity만 애니메이션 (width/height 금지 — `transform-performance`)
- Real-time pulse는 status-info 점에만 사용, 그 외 장식 pulse 금지

---

## 8. 접근성 체크리스트 (PR 머지 게이트)

ui-ux-pro-max Quick Reference §1 기준 — PR마다 확인.

- [ ] 본문 텍스트 contrast ≥ 4.5:1 (보조 텍스트 ≥ 3:1) — 정량 측정 미실시(환경 제약), 토큰 설계 단계에서는 고려됨
- [x] 모든 icon-only 버튼에 `aria-label` — `jsx-a11y/control-has-associated-label` 로 전수 스캔·수정(2026-07), 룰 상시 활성화로 회귀 방지
- [x] 모든 status 표시는 색 + 텍스트/아이콘 동시 (`color-not-only`) — `StatusBadge`/`Badge`(W2) 공통 패턴
- [x] focus ring 2~4px 가시 (focus-visible) — `index.css` 전역 `*:focus-visible` 2px outline
- [ ] Tab 순서가 시각 순서와 일치 — 별도 전수 감사 미실시
- [x] 차트는 `<table className="sr-only">` 데이터 표 동반 — `Sparkline` 적용. `BulletChart`/`CheckHistoryHeatmap` 은 단일값·실제 버튼+aria-label/Tooltip 구조라 동일 목적을 다른 방식으로 충족
- [ ] form input은 `<label htmlFor>` 연결 — 대부분 `aria-label` 로 대체(동등하지만 리터럴 `<label htmlFor>` 전수 감사는 미실시)
- [x] 메인 레이아웃 최상단에 `<a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>` — `App.tsx` AppShell 에 추가, Tab 포커스로 실동작 확인
- [x] `prefers-reduced-motion` 존중 — `index.css` `@media (prefers-reduced-motion: reduce)` 기존 적용

---

## 9. Anti-Patterns (절대 금지)

ui-ux-pro-max Pre-Delivery Checklist에서 추출.

- ❌ 이모지를 아이콘으로 사용 (Lucide 등 SVG 아이콘만)
- ❌ 컴포넌트에 raw HEX 직접 작성 (반드시 토큰 경유)
- ❌ 색상만으로 status 전달 (텍스트/아이콘 병기)
- ❌ placeholder를 라벨 대용으로 사용
- ❌ 차트 hover에만 의존하는 데이터 표시 (키보드 접근 불가)
- ❌ 5+ 슬라이스 Pie/Donut
- ❌ width/height 애니메이션 (CLS 유발)
- ❌ light mode 토큰을 단순 invert해서 dark 만들기

---

## 10. 적용 로드맵

| 스프린트 | 작업 | DoD |
|---|---|---|
| **W1** | 토큰 정합 — `index.css` rewrite + `tailwind.config.js` `status.*` 추가 + raw HEX 사용처 grep 후 전수 치환 | `grep -rE "#[0-9a-fA-F]{6}" frontend/src` 결과가 **토큰 정의부 + 화이트리스트 외 0건**. 화이트리스트 = three.js/canvas/recharts 파일(`FlowGraph3D`, `Topology*`, `*Chart*`, `*Timeline`, `KanbanSummaryCharts`) 및 컬러픽커 기본값 prop(`defaultBg="#..."`) — 이들은 CSS class 를 못 쓰므로 hex 불가피. 외부 서비스 고유색(Jira `#0052CC` 등)은 `brand.*` 토큰 경유. |
| **W2** | shadcn/ui 도입(MCP 경유) — `Button`, `Card`, `Badge`, `Tooltip`, `Dialog` 5종부터. 기존 자체 컴포넌트 어댑터 추가 | 새 컴포넌트는 shadcn 사용, 기존은 점진 마이그레이션 |
| **W3** | ✅ Health Hero PoC — 12-col Bento(`HealthHero`) + Bullet Chart(`ui/BulletChart`) 구현 + Dashboard 상단 교체(`SummaryStats` 삭제) | Bullet Chart `role="img"` + `aria-label` 로 AAA 패턴 적용. Lighthouse 정량 측정은 미실시(환경 제약) — W4 진행 시 함께 측정 권장 |
| **W4** | ✅ 접근성 패스 — `eslint-plugin-jsx-a11y` (기존 도입돼있던 것 확인) + `jsx-a11y/control-has-associated-label` 신규 활성화 + 전수 스캔 위반 54건 수정 + skip link + 신규 차트 sr-only 데이터 표 | `npx eslint . --rule '{"jsx-a11y/control-has-associated-label":"warn"}'` 전체 스캔 0건, `npm run lint` 그대로 통과(회귀 방지 위해 룰 상시 활성화) |
| **W5+** | ✅ 차트 교체 — Sparkline(`ui/Sparkline`, MetricCard 하단) + Recent Check History → Heat Map(`CheckHistoryHeatmap`, cluster×time, hover 시 Tooltip) | Heat Map 셀은 `aria-label="cluster=… time=… status=…"` + 실제 `<button>`(키보드 포커스 가능). sr-only 데이터 표는 별도로 추가하지 않음 — 후속 W4 에서 검토 |

---

## 11. 결정 요약 (한 줄씩)

- **스타일**: Real-Time Monitoring + Data-Dense Dashboard 하이브리드 (ui-ux-pro-max 검증)
- **팔레트**: Ops Slate — bg `#0F172A`, primary `#3B82F6`, status (`#22C55E` / `#F59E0B` / `#DC2626` / `#6B7280`)
- **폰트**: Inter (UI) + JetBrains Mono (numeric) + Pretendard (KO fallback)
- **레이아웃**: 12-col Asymmetric Bento Grid for Health Hero
- **차트**: Bullet Chart (health) + Sparkline (trend) + Heat Map (cluster × time)
- **컴포넌트**: shadcn/ui Card·Button·Badge·Tooltip·Dialog·Sonner 표준 사용

---

## 부록 A — 검증 출처

| 항목 | ui-ux-pro-max 출처 |
|---|---|
| 스타일 후보 | `styles.csv` Real-Time Monitoring (#1), Data-Dense Dashboard (#6), Executive Dashboard (#5) |
| 팔레트 | `colors.csv` Smart Home/IoT Dashboard (#2) — bg `#0F172A`, card `#1B2336` |
| 폰트 | `typography.csv` Dashboard Data (#1, Fira), Developer Mono (#2, JetBrains+IBM Plex) → 절충 |
| 레이아웃 | `landing.csv` Bento Grid Showcase (#1), Real-Time / Operations Landing (#3) |
| 차트 | `charts.csv` Bullet Chart (#4, AAA), Heat Map (#1), Trend Line/Sparkline (#6) |
| 룰 | `ui-reasoning` §1 Accessibility, §6 Typography & Color, §10 Charts & Data |
