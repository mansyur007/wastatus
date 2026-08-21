// Bundles the Electron main and preload scripts. They import the same pure
// modules the renderer uses (ffmpegArgs / bitrate / presets), so the desktop
// build produces byte-identical FFmpeg commands to the browser build.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Electron and node builtins are supplied by the runtime, never bundled.
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

const targets = [
  { entryPoints: [join(root, 'electron', 'main.ts')], outfile: join(root, 'electron-dist', 'main.cjs') },
  { entryPoints: [join(root, 'electron', 'preload.ts')], outfile: join(root, 'electron-dist', 'preload.cjs') },
]

for (const t of targets) {
  if (watch) {
    const ctx = await (await import('esbuild')).context({ ...common, ...t })
    await ctx.watch()
  } else {
    await build({ ...common, ...t })
  }
}

console.log('[electron] main + preload bundled to electron-dist/')
