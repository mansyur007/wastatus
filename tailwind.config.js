/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        wa: { green: '#25D366', dark: '#075E54', teal: '#128C7E' },
      },
    },
  },
  plugins: [],
}
