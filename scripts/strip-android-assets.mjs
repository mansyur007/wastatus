// Removes web-only payloads from the synced Android assets.
//
// `cap sync` copies the whole of dist/ into android/app/src/main/assets/public,
// and dist/ contains downloads/wa-status.apk because the website offers the APK
// for download. Left alone, every APK ships the previous APK inside itself: the
// first such build went from 13.7 MB to 27.1 MB, and the next one would have
// embedded that, and so on.
//
// The file has to stay in dist/ (the VPS deploy rsyncs dist/ and the download
// link points at it), so the fix is to drop it from the Android copy after the
// sync rather than to keep it out of the build.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'android', 'app', 'src', 'main', 'assets', 'public')

/** Paths under the synced assets that must never reach the APK. */
const STRIP = ['downloads']

function bytes(path) {
  const st = statSync(path)
  if (st.isFile()) return st.size
  let total = 0
  for (const entry of readdirSync(path)) total += bytes(join(path, entry))
  return total
}

if (!existsSync(assets)) {
  console.warn('[android] assets not synced yet, nothing to strip.')
  process.exit(0)
}

let freed = 0
for (const rel of STRIP) {
  const target = join(assets, rel)
  if (!existsSync(target)) continue
  freed += bytes(target)
  rmSync(target, { recursive: true, force: true })
  console.log(`[android] stripped assets/public/${rel}`)
}
console.log(`[android] ${(freed / 1024 / 1024).toFixed(1)} MB kept out of the APK`)
