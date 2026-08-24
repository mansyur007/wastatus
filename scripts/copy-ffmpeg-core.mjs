// Copies ffmpeg.wasm (core + the ESM worker classes) into public/ffmpeg so the
// app is fully self-hosted: no CDN at runtime, and no bundler worker/wasm quirks.
//
// Single-thread core only. @ffmpeg/core-mt@0.12.10 was tried and reverted: with
// COOP/COEP served and crossOriginIsolated true, it loads and spawns its
// pthread pool, then deadlocks after "Stream mapping:" without emitting a
// single frame - with or without an explicit -threads. The identical arguments
// run fine on the single-thread core. Because it hangs rather than throwing, a
// try/catch fallback never fires, so there is no safe way to ship it.
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coreSrc = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
const libSrc = join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm')
const dest = join(root, 'public', 'ffmpeg')

if (!existsSync(coreSrc) || !existsSync(libSrc)) {
  console.warn('[ffmpeg] packages not installed yet, skipping copy.')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
mkdirSync(join(dest, 'lib'), { recursive: true })

// The worker is loaded as a module worker, so it dynamic-imports the ESM core.
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(coreSrc, f), join(dest, f))
}
for (const f of readdirSync(libSrc).filter((f) => f.endsWith('.js'))) {
  copyFileSync(join(libSrc, f), join(dest, 'lib', f))
}

console.log('[ffmpeg] core + worker copied to public/ffmpeg')
