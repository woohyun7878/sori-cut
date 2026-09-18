/**
 * Colours are declared as `rgb(var(--token) / <alpha-value>)` so every utility
 * keeps working with an opacity modifier (`bg-canvas/40`, `text-danger/80`).
 * Pointing a colour straight at `var(--token)` looks fine until someone writes
 * `/40`, at which point Tailwind 3 cannot compute the value and drops the rule
 * without an error. The tokens themselves live in src/index.css.
 */
const channel = (token) => `rgb(var(${token}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: channel('--color-canvas'),
        surface: channel('--color-surface'),
        'surface-raised': channel('--color-surface-raised'),
        hover: channel('--color-hover'),
        'editor-border': channel('--color-border'),
        'editor-border-strong': channel('--color-border-strong'),
        primary: channel('--color-text-primary'),
        secondary: channel('--color-text-secondary'),
        muted: channel('--color-text-muted'),
        success: channel('--color-success'),
        warning: channel('--color-warning'),
        danger: channel('--color-danger'),
        brand: {
          50: '#fff8ea',
          100: '#ffefcd',
          200: '#ffdf9c',
          300: channel('--color-brand-soft'),
          400: '#f7bb52',
          500: channel('--color-brand'),
          600: channel('--color-brand-strong'),
          700: '#9d6614',
          800: '#754c10',
          900: '#4d320b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI Variable', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['Inter', 'Segoe UI Variable', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Code', 'Consolas', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        control: 'var(--radius-control)',
        editor: 'var(--radius-panel)',
        pill: 'var(--radius-pill)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
