// Renders public/og.png — the 1200x630 card WhatsApp, X, and search results
// show when someone shares the site.
//
// Composed with the FFmpeg binary already used for the desktop build
// (resources/ffmpeg/, gitignored), so the repo gains no dependency for an asset
// that changes maybe once a year. Run it by hand after a rebrand:
//
//   node scripts/make-og-image.mjs
//
// The text lives in temp files rather than inline in the filtergraph: ffmpeg's
// drawtext needs ':' and '\' escaped twice over, and one missed backslash turns
// into a filter parse error rather than a wrong-looking image.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ffmpeg = join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const icon = join(root, 'public', 'icon-512.png')
const out = join(root, 'public', 'og.png')

if (!existsSync(ffmpeg)) {
  console.error('[og] ' + ffmpeg + ' tidak ada. Lihat README bagian aplikasi Windows.')
  process.exit(1)
}

/** Segoe UI ships with Windows; fall back to whatever the platform has. */
const FONTS = {
  bold: ['C:/Windows/Fonts/segoeuib.ttf', '/System/Library/Fonts/SFNS.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  regular: ['C:/Windows/Fonts/segoeui.ttf', '/System/Library/Fonts/SFNS.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
}
const pick = (list) => list.find((p) => existsSync(p))
const bold = pick(FONTS.bold)
const regular = pick(FONTS.regular)
if (!bold || !regular) {
  console.error('[og] tidak menemukan font sistem untuk drawtext.')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'wa-og-'))
const textFile = (name, value) => {
  const path = join(dir, name)
  writeFileSync(path, value, 'utf8')
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}

const LINES = [
  { file: textFile('title.txt', 'WA Status Converter'), font: bold, size: 60, color: '0xF2F7F4', x: 324, y: 226 },
  { file: textFile('sub.txt', 'Video apa pun jadi WhatsApp Status 9:16'), font: regular, size: 34, color: '0x9EAEA7', x: 324, y: 310 },
  { file: textFile('accent.txt', 'Di bawah 16 MB  -  tanpa upload  -  gratis'), font: bold, size: 29, color: '0x25D366', x: 324, y: 368 },
  { file: textFile('host.txt', 'wastatus.emha.space'), font: regular, size: 25, color: '0x586661', x: 96, y: 508 },
]

const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')
const draw = LINES.map(
  (l) =>
    `drawtext=fontfile='${esc(l.font)}':textfile='${l.file}':` +
    `fontcolor=${l.color}:fontsize=${l.size}:x=${l.x}:y=${l.y}`,
).join(',')

// Deliberately no mock-up of the app on the right. A card of this size is
// usually shown at a third of it - a WhatsApp link preview is about 300 px wide
// - and every 2 px outline tried there turned to mush at that scale. The mark,
// the name, and the promise survive being shrunk; nothing else did.
const filter = [
  // Radial glow behind the mark. gradfun debands it: at these near-black levels
  // an 8-bit ramp shows concentric rings otherwise.
  `[0:v]gradfun=strength=8:radius=16,format=rgba[bg]`,
  // The lit top edge the app's own surfaces use, at 2px.
  `[bg]drawbox=x=0:y=0:w=1200:h=2:color=0x25D366@0.5:t=fill[plate]`,
  `[1:v]scale=196:196[icon]`,
  `[plate][icon]overlay=x=96:y=214[withicon]`,
  `[withicon]${draw}[out]`,
].join(';')

const args = [
  '-hide_banner',
  '-loglevel', 'error',
  '-f', 'lavfi',
  '-i', 'gradients=s=1200x630:c0=0x1D4436:c1=0x070A09:type=radial:x0=210:y0=300:d=1:r=1',
  '-i', icon,
  '-filter_complex', filter,
  '-map', '[out]',
  '-frames:v', '1',
  '-y', out,
]

const res = spawnSync(ffmpeg, args, { stdio: 'inherit' })
rmSync(dir, { recursive: true, force: true })
if (res.status !== 0) process.exit(res.status ?? 1)
console.log('[og] public/og.png (1200x630)')
