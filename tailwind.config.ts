import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Trading-terminal palette: near-black base, slate panels, amber "live" accent,
        // disciplined semantic colors for direction/status.
        base: {
          950: "#0a0d10",
          900: "#0f1317",
          800: "#151a20",
          700: "#1c232b",
          600: "#2a323c",
          500: "#3d4753",
        },
        ink: {
          100: "#e8edf2",
          300: "#aab4c0",
          500: "#7b8794",
        },
        buy: {
          DEFAULT: "#2fbf71",
          dim: "#1c7a48",
          bg: "#0e1f16",
        },
        sell: {
          DEFAULT: "#e5484d",
          dim: "#8f2e31",
          bg: "#25100f",
        },
        setup: {
          DEFAULT: "#e8a23d",
          dim: "#8f6423",
          bg: "#241a0b",
        },
        watch: {
          DEFAULT: "#4d9de5",
          dim: "#2e5f8f",
          bg: "#0d1a24",
        },
        live: "#e8a23d",
      },
      fontFamily: {
        mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["'Inter'", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
    },
  },
  plugins: [],
};

export default config;
