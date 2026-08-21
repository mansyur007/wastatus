/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /** Near-black neutrals with a faint green cast, so the WA accent sits
         *  in the same family as the surfaces instead of floating on blue-gray. */
        ink: {
          950: '#070A09',
          900: '#0B100E',
          850: '#101613',
          800: '#151D19',
          700: '#1D2723',
          600: '#2A3833',
          500: '#3B4C45',
        },
        mist: {
          100: '#EAF2EE',
          200: '#C9D6D0',
          300: '#9EAEA7',
          400: '#76867F',
          500: '#586661',
        },
        wa: { green: '#25D366', deep: '#12B155', dark: '#075E54', teal: '#128C7E' },
      },
      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable Text',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'monospace'],
      },
      borderRadius: { '4xl': '1.75rem', '5xl': '2.25rem' },
      boxShadow: {
        /** Inset top highlight + long soft drop: makes a panel read as a slab
         *  with a lit edge rather than a 1px outlined rectangle. */
        slab: 'inset 0 1px 0 0 rgba(255,255,255,0.05), 0 18px 40px -24px rgba(0,0,0,0.9)',
        lift: 'inset 0 1px 0 0 rgba(255,255,255,0.07), 0 30px 60px -28px rgba(0,0,0,0.95)',
        accent: '0 10px 30px -12px rgba(37,211,102,0.55)',
        dent: 'inset 0 1px 2px 0 rgba(0,0,0,0.5)',
      },
      transitionTimingFunction: {
        fluid: 'cubic-bezier(0.22, 1, 0.36, 1)',
        spring: 'cubic-bezier(0.34, 1.42, 0.5, 1)',
      },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(12px) scale(0.99)' },
          to: { opacity: '1', transform: 'none' },
        },
        fade: { from: { opacity: '0' }, to: { opacity: '1' } },
        sweep: {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        breathe: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
        drift: {
          '0%, 100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(0,-8px,0)' },
        },
      },
      animation: {
        rise: 'rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        fade: 'fade 0.4s ease-out both',
        sweep: 'sweep 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        breathe: 'breathe 2s ease-in-out infinite',
        drift: 'drift 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
