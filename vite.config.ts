import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// COOP/COEP are harmless for the single-thread core and required if you ever
// swap in @ffmpeg/core-mt (SharedArrayBuffer).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Relative asset URLs so the same build works from a web server, from the
  // Capacitor WebView, and from file:// inside Electron - absolute '/assets'
  // paths resolve to the drive root under file:// and load nothing.
  base: './',
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
})
