# PEP (Platform Engineering Portal) — Design System

> **Stack**: React 18 + TypeScript + Tailwind CSS + Recharts + shadcn/ui (Radix)
> **Mode**: 바탕 테마 4종 + `system` — 기본값은 `light`(Databricks-leaning flat, radius 8px), 대안으로
> `dark`, `comfort`(화이트+딥그린, radius 16px), `high-contrast`(관제실용 고대비). 색 취향은 **강조색**
> 6종(blue·teal·green·amber·coral·violet, `<html data-accent>`)으로 고르며 라이트·다크에만 적용된다.
> 이 문서의 "Ops Slate" 다크 규격은 `html.dark` 테마에 해당한다. (테마 전환: `stores/themeStore.ts`, fallback `'light'`)
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

**면(fill) / 글자(text) 분리와 사용 규칙** (P0·P1, 2026-09):

- `bg-status-*` · `border-status-*` · `fill-status-*` 는 위 면 토큰(`--status-*`)을, `text-status-*` 는
  테마별로 4.5:1 을 보장하는 글자 토큰(`--status-*-text`)을 탄다 (`tailwind.config.js` `extend.textColor`).
- 배지 표준 조합: `bg-status-X/10 text-status-X border-status-X/30` (X = healthy·warning·critical·info·unknown).
  옅은 카드 tint 는 `bg-status-X/5`. `dark:` 변형을 따로 달지 않는다 — 토큰이 테마를 따라간다.
- **상태 의미의 고정 팔레트(`emerald`·`green`·`red`·`rose`·`amber`·`yellow`·`sky`)는 ESLint
  `no-restricted-syntax` 가 error 로 막는다** (`frontend/.eslintrc.cjs` `STATUS_PALETTE_RE`).
  장식용 계열(`blue`·`violet`·`purple`·`orange`·`cyan` 등)은 대상이 아니다.

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
| 카드 컨테이너 | `Card` | 기존 `MacCard` → `Card` 어댑터로 통합. traffic-light 점 장식은 P3 에서 삭제 |
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

## 12. 구현 표준 (Implementation Standards)

> 이 장이 **컴포넌트/레이아웃 구현 규칙의 원천**이다. `CLAUDE.md` 에는 위반 시 리뷰 반려되는
> 불변 규칙만 요약돼 있고, props·예시 코드·레이아웃 세부는 여기를 본다.

### 12.1 테마 시스템 (`stores/themeStore.ts` — `k8s:theme` + `k8s:accent`, fallback `'light'` + `'blue'`)

P2(2026-09)에서 테마 11종을 **바탕 4종 + 시스템**과 **강조색 6종**으로 줄였다. 테마마다 토큰 40여 개를
다시 정의하던 구조라 대비 검증이 끝나지 않은 조합이 계속 생겼기 때문이다.

| `<html>` 클래스 | 성격 | 비고 |
|---|---|---|
| `:root` / `html.light` | **기본값** — flat 표면, slate 팔레트, **다크 네이비 사이드바**, `--radius` 8px, `--card-shadow: none` | 강조색 적용 대상 |
| `html.dark` | Databricks-leaning 다크 | 위 §2 "Ops Slate" 계열. 강조색 적용 대상 |
| `html.comfort` | 화이트 계열 배경(`60 15% 98%`) + 딥그린(#22593D) primary + 민트 서페이스, `--radius` 16px, 소프트 카드 섀도(hover lift) | 자체 색 고정(강조색 무시) |
| `html.high-contrast` | 흰 바탕·검정 글자·회색 45% 경계, 본문 21:1 · 보조 10.4:1 · 경계 4.8:1, 포커스 링 3px, `text-primary` 앵커 밑줄 | 관제실 대형 화면·빔프로젝터용. 자체 색 고정 |
| `html.umber` | 입체미래주의풍 유화에서 추출 — 움버 바탕(`8 14% 11%`) · 오커 primary(`45 96% 52%`, 움버 글자) · 더스티 핑크 차트. 경고는 오커와 겹치지 않게 주황(hue 24) | 자체 색 고정. 핑크는 차트·장식 전용 |
| `html.plaster` | 흰 벽 입체주의 풍경화에서 추출 — 크림 석고 바탕(`42 32% 94%`) · 슬레이트 블루 primary(`216 32% 40%`) · 파스텔 차트 · 시에나 입력 테두리 · 액자 브라운 사이드바 | 자체 색 고정. 파스텔은 차트·옅은 배경 전용 |
| `html.journal` | 입체주의 정물화(〈아침 식사〉)에서 추출 — 검정 바탕(`230 14% 8%`) · 코발트 primary(`219 77% 64%`, 어두운 글자) · 비취 초록(정상) · 오커(경고) · 라일락(정보) · 크림슨 사이드바 | 다크. 자체 색 고정 |
| `html.relief` | 석재 부조에서 추출 — 스톤 베이지 바탕(`36 16% 91%`) · 슬레이트 primary·사이드바(`228 16% 40%`) · 녹청 초록(정상·활성 표시) | 라이트. 자체 색 고정 |
| `html.harlequin` | 입체주의 인물화(서명 "Picasso, Rome 1917")에서 추출 — 은회색 바탕(`30 2% 88%`) · 콘플라워 블루 primary(`211 45% 62%`, 검정 글자) · 검정 사이드바 | 라이트. 자체 색 고정 |
| `html.umber-light` | 같은 팔레트의 라이트 — 크림 바탕 · 움버 사이드바 · 오커 primary(글자는 짙은 오커 `36 90% 28%`) | 자체 색 고정 |
| (`system`) | OS 설정 따라 light/dark 자동 | 클래스는 light/dark 중 하나로 해석됨 → 강조색 적용 |

**강조색** — `html.light[data-accent="…"]` / `html.dark[data-accent="…"]` 블록이 `--primary`,
`--primary-foreground`, `--primary-text`, `--accent`, `--sidebar-primary`(+다크는 `--ring`)만 덮는다.
`blue` 는 기본값이라 블록이 없다. 6종 모두 버튼 글자·링크가 라이트·다크에서 4.5:1 이상이다.
미리보기 색은 `lib/themeSwatches.ts` 의 `ACCENT_SWATCH` 가 같은 값을 들고 있다.

**이전 테마 마이그레이션**(첫 로드 1회, `LEGACY_THEME_MAP`): `default`(코랄)·`burnt-sienna`·`tuscan-sunset`·
`summer-breeze` → light+coral, `wildflower-meadow` → light+amber, `tropical-punch` → light+teal,
`electropop` → dark+violet, 레거시 `claude` → light.

핵심 원칙: **모든 색·라운딩은 테마별로 값이 달라지므로 고정값 대신 토큰을 쓴다.**
Semantic status(`--status-healthy/warning/critical/...`), Surface Container 5단계
(`bg-surface-container-lowest~highest`), brand(`--brand-jira`), motion(`--motion-*`) 토큰이
`index.css` 에 10테마 모두 정의돼 있다.

### 12.2 라운딩 (radius 토큰)

`tailwind.config.js` 매핑 — **전 단계 테마 인지(theme-aware)** (P3, 2026-09):

| 클래스 | 값 | `--radius` 8px(라이트·다크·고대비) | 12px(컴포트) |
|---|---|---|---|
| `rounded` / `rounded-sm` | radius−4px | 4 | 8 |
| `rounded-md` | radius−2px | 6 | 10 |
| `rounded-lg` | radius | 8 | 12 |
| `rounded-xl` | radius+4px | 12 | 16 |
| `rounded-2xl` | radius+8px | 16 | 20 |

예전엔 `rounded`·`rounded-xl`·`rounded-2xl` 이 4/12/16px 고정이라 `--radius` 가 큰 테마에서 타일이 버튼보다
둥글어지는 등 관계가 뒤집혔다. 8px 테마에서는 예전 고정값과 같아 화면 변화가 없다.

- **카드**: `MacCard`(flat 기본, `rounded-md` 토큰) 사용 — 페이지에서 카드 div 를 직접 만들지 않는다.
- **버튼/입력**: `rounded-xl` (`ui/button.tsx` 기준). sharp corner 금지.
- 직접 `rounded-2xl` 카드는 레거시(다이얼로그 제외) — 신규 코드에서 사용하지 않는다.

### 12.3 MacCard (`frontend/src/components/ui/MacCard.tsx`)

모든 주요 섹션은 `MacCard` 로 감싼다. shadcn `Card` 프리미티브의 어댑터로, 평평한 표면 + 1px 보더,
좌측 정렬 소형 대문자 라벨 헤더(`bg-surface-container-high`), 라운딩 `rounded-md` 토큰이다.
(P3 에서 신호등 3점 장식의 `variant="mac"` 과 `--mac-red/yellow/green` 토큰을 삭제했다 — 사용처 0건,
누를 수 없는 장식이 상태색과 같은 hue 라 "장애"로 읽혔다.)

```tsx
import { MacCard } from '@/components/ui/MacCard';

<MacCard title="Cluster Status">{/* content */}</MacCard>
```

Props: `title?`, `children`, `className?`(body), `rootClassName?`, `bodyPadding?`(기본 `p-4`).

### 12.4 컴포넌트 컨벤션

- **카드**: `MacCard` 사용, 직접 `bg-card border` div 조합 금지 (DESIGN.md D-004).
- **Shadows**: light/dark/high-contrast 는 `--card-shadow: none`(보더가 그림자 대체), comfort 만 은은한
  depth(멀티레이어 섀도+hover lift) — Tailwind `shadow-card` / `hover:shadow-card-hover`(토큰
  `--card-shadow(-hover)`)만 쓴다. `Card` 기본 컴포넌트가 이미 달고 있으니 개별 shadow 클래스를 만들지 않는다.
  CSS 에서 `[class*="…"]` 처럼 클래스 이름 부분 문자열로 요소를 고르는 선택자는 쓰지 않는다(P3 에서 제거).
- **Section titles inside MacCard**: 카드 제목을 본문 `<h2>` 로 중복하지 않는다.
- **타이포 (P2)**: 본문 기본 굵기 400(`body`), 라벨 500, 제목 600. 최소 글자 `text-[11px]` — 8~10px 금지.
  보조 글자는 `text-muted-foreground` 를 투명도 없이 쓴다(`/50~90` 은 라이트에서 2~3:1). 장식용
  아이콘·구분선만 `/20~40` 허용, 입력 안내는 `placeholder:` 변형. 둘 다 ESLint(`TYPO_RE`)가 error 로 막는다.
  비활성 표현(`disabled:opacity-50`)은 예외 — 비활성은 흐린 게 맞다.
- **Colors**: JSX 내 raw hex 금지 — Tailwind 토큰(`text-primary` 등) 또는 `hsl(var(--*))`.
  고정 팔레트(`text-white`, `bg-gray-*` 등)도 금지 — 테마 토큰(`text-foreground`,
  `text-muted-foreground`, `bg-card`, `bg-secondary`)을 쓴다. 차트/캔버스는 `--chart-*` 토큰 우선.
- **접근성**: 아이콘 전용 버튼은 `title` 과 함께 **`aria-label` 병행**을 표준으로 한다.

### 12.5 Cluster Sidebar 표준 (`ClusterSidebar`) — 모든 per-cluster 페이지 필수

**Component:** `frontend/src/components/common/ClusterSidebar.tsx`

페이지에 클러스터 선택 사이드바를 표시할 때는 **항상 `iconOnly` 모드**를 사용한다. 이는 메인 사이드바와 시각 일관성을 유지하기 위한 표준이며, 폭 56px 의 아이콘 레일로 렌더되고 호버 시 클러스터 이름·region·운영등급이 툴팁으로 표시된다. 시퀀스 번호(`seq`)는 어떤 모드에서도 노출하지 않는다.

**시각적 형태 (iconOnly 모드):**
```
┌────┐
│ ▦  │  ← 전체 (allowAll 시) — LayoutGrid 아이콘
├────┤
│ ✓●│  ← 클러스터 1 (status 아이콘 + 우상단 status dot)
│ ⚠●│  ← 클러스터 2 (warning)
│ ✕●│  ← 클러스터 3 (critical)
└────┘
   ↑ 호버하면 우측에 "이름 · region · 등급" 툴팁이 portal 로 표시됨
```

**사용 패턴 (3가지):**

| 시나리오 | 필수 props | 예시 페이지 |
|---|---|---|
| 단일 선택 (전체 옵션 X) | `iconOnly` + `selectedId` + `onSelect` | CiliumTracePage |
| 단일 선택 + 전체 옵션 | `iconOnly` + `allowAll` + `allLabel` + `selectedId` + `onSelect` | Dashboard |
| 다중 선택 (빈 배열 = 전체) | `iconOnly` + `multiSelect` + `selectedIds` + `onMultiSelectChange` (+ optional `allowAll` `allLabel`) | PlaybooksPage, BulkExecPage |

**예시 — 단일 선택:**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={clusterId || null}
  onSelect={(id) => setClusterId(id ?? '')}
  iconOnly
/>
```

**예시 — 단일 선택 + 전체:**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={selectedClusterId}
  onSelect={setSelectedClusterId}
  allowAll
  allLabel="전체 현황"
  iconOnly
/>
```

**예시 — 다중 선택 (PlaybooksPage 패턴):**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={null}
  onSelect={() => { /* multiSelect 모드라 미사용 */ }}
  allowAll
  allLabel="전체 클러스터"
  iconOnly
  multiSelect
  selectedIds={selectedClusterIds}
  onMultiSelectChange={setSelectedClusterIds}
/>
```

**레이아웃 규칙:**
- **간격 표준 (모든 per-cluster 페이지 동일)**: 보조 사이드바(클러스터/서비스)는 **메인 사이드바에 flush(좌측 공백 0)** 로 붙인다. 컨테이너 행은 좌측 패딩 없이 `py-3 pr-3 flex gap-3` (또는 `min-h-screen bg-background flex`) 로 잡는다.
  - 메인 사이드바 ↔ 보조 사이드바 = **0px(공백 없음)**, 보조 사이드바 ↔ 본문 = `gap-3`(12px) 또는 본문의 좌측 패딩으로 띄운다.
  - ❌ 행에 `mx-auto`/`max-w-[...]` 로 가운데 정렬하면 보조 사이드바가 우측으로 밀려 공백이 생긴다 — **행은 좌측 정렬**(센터링 금지). 가독성 max-width 가 필요하면 보조 사이드바가 아니라 **본문(`flex-1`)에만** 적용한다.
  - ❌ 좌측 `px-3`/`px-6`/`p-3` 처럼 행 전체에 좌측 패딩을 줘서 메인 사이드바와 보조 사이드바 사이에 틈을 만들지 않는다.
- 사이드바 옆 본문은 `<div className="flex-1 min-w-0">` 으로 감싼다.
- 사이드바는 `sticky top-4` 로 고정되어 스크롤해도 따라온다.
- `MacCard` 등 본문 wrapper 와 같은 row 에 둔다.

**금지:**
- ❌ 와이드 폼 (`iconOnly` 없이 사용) — 신규 페이지에서 절대 사용 금지. 기존 페이지도 모두 iconOnly 로 마이그레이션됨.
- ❌ `seq` 번호를 별도로 표시하는 어떤 UI 도 금지 (레거시 동작).
- ❌ 페이지 내 dropdown 형태 클러스터 선택기 (`<select>`) — 대신 좌측 사이드바를 쓴다.
- ❌ `onReorder` prop — iconOnly 에서는 정렬 토글이 노출되지 않으므로 사용 금지. 클러스터 정렬은 `/cluster-manage` 페이지에서만 한다.

### 12.6 콘솔 화면 표준 패턴 (PEP Console Pattern) — SSH/exec 실행형 화면 공통

원격 명령을 실행하고 로그(stdout/stderr)를 보여주는 화면은 모두 **같은 패턴**을 따른다.
"콘솔 패턴 반영해줘" 류 요청이 오면 아래 목록의 화면 전부에 일괄 적용한다.

**적용 화면**: 노드 일괄 실행 `/bulk-exec` · mc 클라이언트 `/mc-client` · etcdctl `/etcdctl` ·
Cilium BPF Trace `/cilium-trace` · 커널 파라미터 `/kernel-params` · NFS 모니터링(Isilon) `/isilon-nfs`
(+ 신규 SSH/exec 콘솔은 전부 이 패턴으로 시작)

> `/isilon-nfs` 는 명령 1건이 stdout/stderr 두 스트림이 아니라 단일 출력(+선택적 error)만 갖는
> 조회 전용 isi 명령이라 2번(`ExecOutputTabs`)은 적용하지 않고 `LogViewer` 로 바로 렌더링한다.
> 또한 좌측에 "타겟"이 아니라 서버 레일이 오고(§12.5 예외와 동일하게 서버 스코프), 중앙 컬럼이
> mc 클라이언트의 인자 입력 대신 **등록된 명령 체크박스 다중 선택**(프리셋 전용, 자유 입력 없음)
> 이다 — isi 명령은 항상 DB 등록·검증(읽기전용 allowlist)된 것만 실행 가능해 위험 명령 확인
> (`ConfirmDialog` danger)도 필요 없다.

1. **레이아웃 — 좌(컨트롤) / 우(결과) 한 로우 고정**: 10~12컬럼 grid(`grid grid-cols-1 lg:grid-cols-10 gap-4 items-start` 등)로
   컨트롤 카드(들)를 좌측(4~5), 결과/로그 카드를 우측(5~6)에 배치한다. 결과 카드는 **실행 전에도 같은 자리에
   플레이스홀더**로 존재해 레이아웃이 흔들리지 않고, 스크롤은 결과 패널 내부에서만(가로 스크롤로 페이지가 늘어나면 안 됨).
2. **stdout/stderr 는 `ExecOutputTabs`** (`components/common/ExecOutputTabs.tsx`): 두 스트림을 위아래로 쌓지 않고
   탭으로 전환한다. 탭 라벨에 결과 유무 dot(초록=stdout/빨강=stderr)과 라인 수가 표기되고, 내용이 있는 쪽이 기본 활성
   탭이다(stdout 우선). stdout/stderr 를 각각 `LogViewer` 로 직접 쌓는 코드는 신규 작성 금지.
3. **로그 출력은 항상 `LogViewer`** (`components/common/LogViewer.tsx`): plain `<pre>` 금지. 포맷 자동감지(JSON/journal/table),
   필터/복사/줄바꿈 툴바, 터미널 Appearance(색/글꼴) 가 일괄 적용된다.
4. **터미널 Appearance 자동 적용 — `useTerminalEnvSync`** (`hooks/useTerminalEnvSync.ts`): 페이지 최상단에서
   `useTerminalEnvSync(clusters, selectedId | selectedIds)` 를 호출한다. 선택 클러스터의 운영등급(`operationLevel`)이
   prod/dr 계열이면 운영(ops), 아니면 개발(dev) 프로파일이 LogViewer 에 자동 적용된다(다중 선택은 하나라도 운영이면 ops,
   페이지 이탈 시 null 초기화). **기본값: 개발=Monokai, 운영=기본(테마 색상)** — 사용자가 Settings → 터미널 Appearance 에서
   프로파일별 템플릿/색/글꼴을 저장하면(개인화) 그 값이 우선한다(백엔드 `terminal_appearance` user_setting).
5. **실행 상태 배지**: ok/error/timeout/auth_error/connect_error 는 `STATUS_META` 패턴(색 + 아이콘 pill)으로 표기,
   위험 명령은 `ConfirmDialog` `danger` 확인을 거친다.

**예외 — PTY 웹 터미널 화면** (k9s 콘솔 `/k9s` · 노드 SSH 터미널 `/node-ssh`): 결과가 stdout/stderr 로 끊겨
돌아오는 게 아니라 대화형 tty 라 위 1~3 항목(좌/우 로우, `ExecOutputTabs`, `LogViewer`)이 적용되지 않는다.
대신 **공용 `SshTerminalWindow`**(`components/k8s/SshTerminalWindow.tsx`)를 쓴다 — xterm.js ↔ WebSocket 브리지,
드래그 이동 플로팅 창 + 우하단 리사이즈, 헤더의 재연결/새 창으로 빼기/전체화면/종료, `lib/terminalPopout.ts`
기반 별도 창 handoff, **Ctrl+C 복사 / Ctrl+V 붙여넣기**(`lib/terminalClipboard.ts`)가 여기 다 들어있다. 화면은 접속 폼(`ClusterSidebar iconOnly` + `MacCard`)과 init 프레임만
만든다. 4·5 항목은 그대로 지킨다 — `useTerminalEnvSync` 호출(터미널 색/글꼴이 `useXtermTheme` 로 xterm 에도
적용된다), 연결 테스트 결과는 `STATUS_META` 배지. 새 SSH 터미널 화면을 xterm 부터 직접 붙이는 코드는 금지.

### 12.7 전역 상단바 (`components/layout/AppTopBar.tsx`) — 높이 규약

모든 화면은 `PageStyleProvider` 안에서 `AppTopBar`(업무 도메인 그룹 + 인사말/날짜 + 알람 종) 를
`sticky top-0` 로 이고 있다. 페이지 루트가 뷰포트 전체 높이를 자기 것으로 가정하면(`min-h-screen`/
`h-screen`) 상단바 높이만큼 화면 아래로 넘친다.

- **높이 상수**: `index.css` `:root { --topbar-h: 3rem; }` — 테마 무관 레이아웃 값이라 테마 블록마다
  재정의하지 않는다.
- **소비는 반드시 이름 있는 유틸리티로**: `min-h-screen` → **`app-min-h-screen`**,
  `h-screen` → **`app-h-screen`**, `max-h-screen` → **`app-max-h-screen`**
  (`calc(100vh - var(--topbar-h))` 를 감싼 `index.css` 커스텀 클래스). Tailwind arbitrary value
  (`h-[calc(100vh-var(--topbar-h))]`)를 페이지마다 반복해 쓰지 않는다 — 상단바 높이가 바뀌어도
  `--topbar-h` 하나만 고치면 전 화면에 반영된다.
- **Your Island 임베드 예외**: `.island-embed :is(.min-h-screen, .h-screen, .app-min-h-screen,
  .app-h-screen)` 가 이 네 클래스를 전부 무력화한다(`index.css`) — 패널 안에서는 전체화면 셸 가정이
  의미 없기 때문. 새 페이지가 이 네 클래스 중 하나라도 새로 쓰면 자동으로 이 예외의 적용을 받는다.
- **제외 대상**: `AppShell` 밖 라우트(`/login`, `/me/change-password`)와 팝업 escape 라우트
  (`/k9s/popup`, `/node-ssh/popup`)는 상단바가 없으므로 구 `min-h-screen`/`h-screen` 을 그대로 쓴다.
- **화면 검색 버튼**(D-073): 우측 그룹 맨 앞의 "화면 검색 ⌘K" 버튼이 커맨드 팔레트를 연다
  (`useCommandPaletteStore.setOpen(true)`). `md` 미만에서는 아이콘만.

### 12.8 셸 flyout 메뉴 규약 (`components/layout/NavFlyout.tsx`) — 키보드 접근성 필수

사이드바 레일·상단바·즐겨찾기·사용자 메뉴·도움말이 전부 `FlyoutShell` 하나를 공유한다. 포털이
`document.body` 끝에 붙어 `Tab` 순서로는 도달할 수 없으므로 **포커스를 프로그램적으로 넣고 빼는
것**이 키보드 사용자의 유일한 진입로다(D-080). 새 flyout/트리거를 만들 때 지킬 것:

- **트리거**: `aria-haspopup="menu"` + `aria-expanded`. 클릭/Enter 로 열 때는 트리거 element 를
  같이 넘긴다(`RailIconButton onClick(rect, el)`, 상단바는 `e.currentTarget`).
- **열기 의도 구분**: hover 로 열면 `autoFocus=false`(포커스 불간섭), 클릭·키보드로 열면
  `autoFocus=true` + `returnFocusTo={trigger}`. 두 값을 `flyoutFocus` state 하나로 들고 모든
  `FlyoutShell` 에 `{...focusProps}` 로 넘긴다(Sidebar/AppTopBar 동일 패턴).
- **항목**: 라우팅은 `FlyoutLink`(`role="menuitem"`, `aria-current="page"`), 동작(테마·패널 열기·
  로그아웃)은 `FlyoutAction`(`role="menuitem"`, `checked` 를 주면 `menuitemradio`, `tone="danger"`).
  plain `<button>`/`<Link>` 를 flyout 안에 직접 두면 ↑↓ 내비에서 빠진다.
- **키보드**: ↑↓/Home/End 는 `menuitem*` 사이 이동, Tab 은 flyout 안에서 순환, Esc 는 닫기+트리거
  복귀. `useModalA11y` 는 dialog(트랩+복원) 전용이라 flyout 에는 쓰지 않는다.

### 12.9 권한 UX — 쓰기 액션 버튼은 숨기지 않고 비활성 + 사유 (`hooks/useCanOperate.ts`)

백엔드 `require_operator` 가 실제 차단을 담당하고, 프론트는 "눌러보고서야 403" 을 없앤다(D-082).
실행·추가·수정·삭제·저장·설정처럼 서버가 operator 이상을 요구하는 버튼은:

```tsx
const { canOperate, withHint } = useCanOperate();
<button disabled={!canOperate || pending} title={withHint('지금 실행')} aria-label={withHint('지금 실행')}
        className="… disabled:opacity-50 disabled:cursor-not-allowed">
```

- `withHint(title)` 은 권한이 있으면 원래 title, 없으면 "operator 이상 권한이 필요합니다 (현재:
  viewer)" 를 돌려준다. 숨기지 않는 이유는 기능이 있다는 것을 알아야 권한을 요청할 수 있어서다.
- 예외: 빈 상태(EmptyState)의 주 액션처럼 "비활성 버튼 하나만 덩그러니" 남는 자리는 viewer 에게
  액션을 생략해도 된다. 기존 `hasRole(user,'admin','operator')` 로 버튼을 **숨기던** 화면
  (`ClusterManagePage` 등)은 그대로 두되, 신규 화면은 이 패턴을 따른다.

### 12.10 지원 뷰포트 (D-076)

PEP 는 운영자용 내부 콘솔이라 모바일 전용 레이아웃을 만들지 않는다 — 대신 창 폭 기준으로
3단계를 **선언**하고, 좁을수록 기능을 숨기지 않되(조회는 항상 가능) 진입점만 접는다.

| 폭 | 등급 | 동작 |
|---|---|---|
| **≥1280px** (Tailwind `xl`) | 정식 | 모든 레이아웃이 설계 의도대로 — 홈 2열 그리드, 상단바 그룹 버튼 개별 노출 |
| **1024~1279px** (`lg`) | 축약 | 상단바 업무 그룹 버튼이 `Menu` 트리거 하나로 접힌다(`AppTopBar.tsx` — `hidden lg:flex` 본 nav + `lg:hidden` 트리거, 두 그룹을 섹션 구분된 한 flyout 목록으로). 홈 등 `xl:` 전용 그리드는 이 구간에서 단일 열로 스택(기존 동작, 변경 없음) |
| **<1024px** | 미지원 | `ViewportSupportBanner`(`components/layout/ViewportSupportBanner.tsx`, `PageStyleProvider` 최상단에 전역 마운트)가 "권장 지원 범위 밖" 경고를 띄운다 — **막지는 않는다**, 세션당 1회 닫기 가능(`sessionStorage`). 사이드바(고정 56px)·데이터 테이블(자체 `overflow-x-auto`)은 이 구간에서도 그대로 동작한다 |

- 새 breakpoint 로직은 `matchMedia` + `useEffect`(리사이즈 시 재평가) 패턴을 쓴다 — `BatchJobsPage.tsx`
  의 `OVERLAY_BREAKPOINT = '(max-width: 1279px)'` 가 레퍼런스.
- 상단바처럼 "접는" 대상을 늘릴 땐 새 `<nav>`/버튼 그룹을 만들지 말고 §12.8 의 `FlyoutShell`/
  `FlyoutLink` 를 그대로 재사용한다(`AppTopBar.tsx` 의 `moreOpen` 트리거가 예시).
- 이 표는 검증 매트릭스의 원천이다 — 새 화면을 QA 할 때 1280/1024/768px 세 폭에서 최소 한 번씩
  훑는다(특히 `xl:` 전용 그리드·`overflow-x-auto` nav 를 새로 추가하는 화면).

### 12.11 leaf 단위 opt-in 앱 카탈로그 — 사이드바 + 상단바 (Main UI 간소화, 2026-09-17 + 후속 개편)

좌측 사이드바 레일(플랫폼/시스템 도메인)과 상단바(이름 옆, 업무 도메인) 둘 다 **아무것도
항상 보여주지 않는다** — 사용자가 "설치"한 것만, 설치한 순서대로 보인다. 설치 단위는 그룹
전체가 아니라 **그 그룹에 속한 leaf(최하위) 페이지 하나하나**다 — "가장 하위 메뉴 기준으로
추가"라는 사용자 요청에 따라, 예전의 그룹 단위(레일 아이콘 하나가 flyout 으로 여러 하위
화면을 감춤) 설치에서 leaf 단위(설치한 것 하나 = 레일/상단바 아이콘 하나, 직행 링크, flyout
없음) 설치로 바뀌었다.

- **카탈로그**: `frontend/src/components/layout/installableApps.ts` — `GROUPS`(`navConfig.ts`)
  의 `paths` 를 펼쳐 leaf 페이지 단위 `InstallableApp` 목록을 만들고(`groupId`/`groupLabel` 은
  카탈로그 다이얼로그의 섹션 헤더로만 쓰인다), `back`/`favorites`/`island` 세 개는 leaf 페이지가
  아닌 "개인" 섹션 특수 항목으로 하드코딩돼 있다. `sidebarAppSections(isAdmin)` 은
  `platform`/`system` 도메인 + `back` 을, `topbarAppSections()` 는 `work` 도메인 + `favorites`/
  `island` 를 그룹별 섹션으로 묶어 반환한다. 그룹의 `description` 은 섹션 설명으로, `tone: 'danger'`
  (현재 '클러스터 · 운영 조작' — 명령을 보내는 화면)는 경고 톤 테두리로 `AddAppDialog` 에 표시된다.
  2026-09 P1 재편으로 옛 '클러스터'(23개)는 관측(`observe`)/점검(`inspect`)/운영 조작(`operate`)/
  구성(`configure`) 4그룹, 서버/인프라·스토리지·서비스/앱은 `infra` 하나로 바뀌었다. 새 그룹/leaf 를 추가하면 `GROUPS`/`NAV_MAP` 에만
  등록하면 자동으로 카탈로그에 반영된다(그룹 단위이던 예전과 달리 카탈로그 쪽에 별도 목록을
  중복 유지하지 않는다).
- **저장**: `HomePrefs.installed_apps`(`backend/app/schemas/home_prefs.py`, 기존
  `GET/PUT /api/v1/me/home-prefs` 재사용 — 새 라우터를 만들지 않는다) — leaf 경로 문자열(또는
  `back`/`favorites`/`island`) 배열 하나를 사이드바와 상단바가 **공유**한다. 각 화면은
  `installableAppById(id).domain` 으로 자기 몫만 걸러 그린다(`Sidebar.tsx` 는 platform/system,
  `AppTopBar.tsx` 는 work). 기본값은 `["/tasks-mgmt"]`(사이드바는 여기 걸러지는 게 없어 빈
  레일, 상단바는 "업무 관리" 하나만 미리 설치된 상태로 시작 — 사용자 요청: "업무 관리만
  기본으로 나오게, 나머지는 개인별 add-on"). 서버 저장이라 기기·브라우저를 넘어 따라온다
  (로그인=UI-First 개인화 원칙).
- **UI**: 양쪽 다 "+" 버튼 → 공용 `AddAppDialog.tsx`(shadcn `Dialog`, 그룹 섹션 헤더 + 카드형
  그리드, 카드당 아이콘·라벨·짧은 설명 + 설치/설치됨 토글)를 각자의 섹션 목록으로 연다.
  `system` 도메인 leaf(`/settings`)는 admin 에게만 보인다 — 렌더링 쪽(`Sidebar.tsx`)도
  `installableAppById(id).adminOnly` 가 참인데 `!isAdmin` 이면 건너뛰는 방어 체크를 이중으로
  둔다(역할 강등 등 엣지케이스 대비).
- **예외 — 홈은 opt-in 대상이 아니다**: 로고(홈 버튼)는 사용자가 레일을 전부 비워도 `/` 로 돌아올
  방법이 하나는 있어야 하므로 항상 클릭 가능하다. "뒤로가기"는 반대로 카탈로그 항목이라 기본
  미설치이고, 홈(`/`)에서는 설치돼 있어도 숨는다(의미 없는 버튼이므로).
- **즐겨찾기 / Your Island 도 opt-in**: 후속 요청으로 상단바의 즐겨찾기(구 ★ 버튼, 상시노출)와
  Your Island(구 사이드바 푸터 아이콘, 상시노출) 도 leaf 페이지와 동일한 "개인" 섹션 카탈로그
  항목이 됐다 — 설치해야만 보인다. 둘 다 leaf 페이지가 아니라 자체 flyout(즐겨찾기 목록 / 내
  아일랜드 선택)을 열므로, `Sidebar.tsx`/`AppTopBar.tsx` 렌더 쪽에서 `appId === 'favorites' |
  'island'` 특수 분기로 처리한다(직행 링크가 아님).
- **기존 계정 이관 — 3단계**: 이 기능이 생기기 전부터 있던 계정이 갑자기 빈 화면을 보면 안
  되므로, `backend/app/main.py` 에 순서가 고정된 세 마이그레이션이 있다(`_seed_initial_admin`
  보다 반드시 먼저 실행 — 안 그러면 막 생긴 부트스트랩 admin 이 "기존 사용자"로 오인된다).
  1. `_backfill_installed_sidebar_apps()`(1단계, sentinel `installed_sidebar_apps_backfilled_v1`)
     — 그룹 단위 개편 당시 전체 그룹 id(`cluster`/`server`/.../`system`/`back`)로 이관.
  2. `_migrate_installed_apps_to_leaf_paths()`(2단계, sentinel `installed_apps_leaf_migration_v2`)
     — 1단계가 넣어준 그룹 id(더 이상 `INSTALLABLE_APPS` 에 없어 방치하면 조용히 사라짐)를 그
     그룹의 leaf 목록으로 치환하고, 상단바 업무 도메인(업무 관리·문서 관리 leaf + 즐겨찾기 +
     Your Island, 전부 예전엔 상시노출)을 이 마이그레이션 시점 존재하던 모든 계정에
     grandfather 로 추가한다.
  3. `_prune_topbar_apps_to_default()`(3단계, sentinel `installed_apps_topbar_default_v3`) —
     사용자 요청("업무 관리만 기본으로 나오게, 나머지는 개인별 add-on")에 따라 2단계가 채운
     상단바 grandfather 결과에서 `/tasks-mgmt`("업무 관리") 하나만 남기고 나머지(업무 관리
     그룹의 다른 leaf·문서 관리 그룹 전체·즐겨찾기·Your Island)를 다시 제거한다. 사이드바
     설치 항목은 건드리지 않는다. v1/v2 와 달리 **뺄셈** 마이그레이션이라, 이 마이그레이션이
     실행되는 시점에 사용자가 이미 직접 추가해 둔 항목까지 구분 없이 함께 제거된다(1회성
     트레이드오프로 감수 — `+` 로 언제든 재설치 가능).

  세 마이그레이션이 전부 실행된 뒤 새로 생성되는 계정만 `HomePrefs` 기본값(`["/tasks-mgmt"]`)이
  적용돼 사이드바는 빈 레일, 상단바는 "업무 관리" 하나로 시작한다. 그룹/leaf 매핑표는 프론트
  `navConfig.ts` 의 `GROUPS.paths` 와 반드시 일치해야 한다(`_migrate_installed_apps_to_leaf_paths()`
  의 `LEGACY_GROUP_LEAF_PATHS`, `_prune_topbar_apps_to_default()` 의 `TOPBAR_ITEMS_TO_PRUNE`
  주석 참고) — 그룹이 바뀌면 백엔드 상수도 같이 갱신할 것.
- **재사용 시 주의**: 카탈로그 항목 순서 재배열(드래그 앤 드롭)은 아직 지원하지 않는다 — 순서는
  설치한 순서 그대로다. 재정렬이 필요해지면 `pinnedPaths`(즐겨찾기)가 이미 쓰는 순서 보존 배열
  패턴을 참고할 것.

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
