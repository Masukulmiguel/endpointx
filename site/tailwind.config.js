/** @type {import('tailwindcss').Config} */
export default {
  content: ['./*.html', './docs/**/*.html', './en/**/*.html', './src/**/*.{js,css}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: 'var(--bg)',
          900: 'var(--bg-soft)',
          800: 'var(--bg-elev)',
          line: 'var(--line)',
          text: 'var(--text)',
          muted: 'var(--muted)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
        },
      },
      fontFamily: {
        display: ['Sora', 'system-ui', 'sans-serif'],
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
