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
        surface: "hsl(var(--card))",
        "surface-elevated": "hsl(var(--popover))",
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
