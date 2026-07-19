/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // ── Sidebar tokens (Databricks dark-navy sidebar in light theme) ──
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          primary: "hsl(var(--sidebar-primary))",
        },
        // ── Surface tokens (DESIGN_SYSTEM §2.1) ──
        surface: {
          DEFAULT: "hsl(var(--card))",
          elevated: "hsl(var(--popover))",
          // 5단계 — 그림자 대신 톤 차이로 깊이감(card-shadow: none 철학과 일치).
          // lowest(바탕에 가까움) → highest(가장 도드라짐). bg-surface-container-* 로 사용.
          container: {
            lowest:  "hsl(var(--surface-container-lowest)  / <alpha-value>)",
            low:     "hsl(var(--surface-container-low)     / <alpha-value>)",
            DEFAULT: "hsl(var(--surface-container)          / <alpha-value>)",
            high:    "hsl(var(--surface-container-high)    / <alpha-value>)",
            highest: "hsl(var(--surface-container-highest) / <alpha-value>)",
          },
        },
        // ── Semantic status tokens (DESIGN_SYSTEM §2.4) ──
        // raw HEX 사용 금지. 모든 status 색은 이 토큰 경유.
        status: {
          healthy:  "hsl(var(--status-healthy)  / <alpha-value>)",
          warning:  "hsl(var(--status-warning)  / <alpha-value>)",
          critical: "hsl(var(--status-critical) / <alpha-value>)",
          unknown:  "hsl(var(--status-pending)  / <alpha-value>)",
          info:     "hsl(var(--status-info)     / <alpha-value>)",
        },
        // ── Brand tokens (외부 서비스 고유색. raw HEX 대신 이 토큰 경유) ──
        brand: {
          jira: "hsl(var(--brand-jira) / <alpha-value>)",
        },
        // ── Categorical chart tokens (D-005) — Recharts/SVG 시리즈 구분색 ──
        // 의미 있는 색(성공/실패)은 status.* 를 쓰고, 시리즈 구분용만 chart-N 사용.
        chart: {
          1: "hsl(var(--chart-1) / <alpha-value>)",
          2: "hsl(var(--chart-2) / <alpha-value>)",
          3: "hsl(var(--chart-3) / <alpha-value>)",
          4: "hsl(var(--chart-4) / <alpha-value>)",
          5: "hsl(var(--chart-5) / <alpha-value>)",
          6: "hsl(var(--chart-6) / <alpha-value>)",
          7: "hsl(var(--chart-7) / <alpha-value>)",
          8: "hsl(var(--chart-8) / <alpha-value>)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
}
