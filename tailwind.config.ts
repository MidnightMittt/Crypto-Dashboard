import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        void: "#0A0D12",
        panel: "#12171F",
        "panel-hi": "#171D27",
        hairline: "rgba(255,255,255,0.08)",
        cyan: {
          DEFAULT: "#2DD4E8",
          dim: "#1B8A9A",
        },
        amber: {
          DEFAULT: "#F5A623",
          dim: "#8A5D14",
        },
        danger: {
          DEFAULT: "#EF4444",
          dim: "#7A2222",
        },
        success: {
          DEFAULT: "#22C55E",
          dim: "#175A32",
        },
        ink: {
          DEFAULT: "#E8EDF2",
          muted: "#8890A0",
          faint: "#535B68",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.45)",
        "glow-cyan": "0 0 24px rgba(45,212,232,0.25)",
        "glow-amber": "0 0 24px rgba(245,166,35,0.25)",
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "needle-in": {
          "0%": { transform: "rotate(-90deg)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.8s ease-in-out infinite",
        shimmer: "shimmer 2.2s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
