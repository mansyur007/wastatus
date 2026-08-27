import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Fills the APK placeholders in the structured data of index.html.
 *
 * Vite only substitutes `%VITE_*%` from the environment, and the numbers we
 * want live in src/apk-release.json - written by scripts/publish-apk.mjs from
 * the APK it just built. Reading them here keeps schema.org agreeing with both
 * the download button and the binary itself; a hand-typed version in three
 * places would agree with none of them for long.
 */
function apkMetadata(): Plugin {
  return {
    name: 'wa-status-apk-metadata',
    transformIndexHtml(html) {
      const apk = JSON.parse(readFileSync(new URL('./src/apk-release.json', import.meta.url), 'utf8'))
      return html
        .replace('%APK_VERSION%', apk.version)
        .replace('%APK_SIZE%', `${(apk.sizeBytes / 1024 / 1024).toFixed(1)} MB`)
    },
  }
}

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
  plugins: [react(), apkMetadata()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
})
