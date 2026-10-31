/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { 50: "#eef2f9", 100: "#d5deef", 200: "#a9bbdc", 400: "#4d6aa3", 600: "#1f3a6d", 700: "#172d57", 800: "#112244", 900: "#0b1730" },
        paper: { DEFAULT: "#faf7f1", 100: "#f4efe4", 200: "#e9e1d0" },
        gold: { 100: "#f6ecd2", 300: "#dcc27e", 500: "#b8892b", 700: "#7d5b14" },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "-apple-system", "Roboto", "sans-serif"],
        serif: ["Georgia", "Cambria", "Times New Roman", "serif"],
        mono: ["ui-monospace", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
