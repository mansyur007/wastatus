// Publishes the freshly built release APK to the website.
//
// Runs at the tail of `npm run android:build`. It copies the gradle output into
// public/downloads/ (the path the download button points at) and writes
// src/apk-release.json, which the Dropzone reads for the version, the size, and
// the build date.
//
// The metadata is a committed file rather than something fetched at runtime:
// the VPS deploy rebuilds dist/ on a CI runner from whatever is in the repo, so
// a build-time constant can never disagree with the APK sitting next to it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const published = join(root, 'public', 'downloads', 'wa-status.apk')
const manifest = join(root, 'src', 'apk-release.json')

if (!existsSync(built)) {
  console.error('[apk] ' + built + ' tidak ada. Jalankan `npm run android:build` dulu.')
  process.exit(1)
}

/** versionName / versionCode straight from the gradle file that produced it. */
const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8')
const version = /versionName\s+"([^"]+)"/.exec(gradle)?.[1]
const versionCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1])
if (!version || !Number.isFinite(versionCode)) {
  console.error('[apk] versionName/versionCode tidak terbaca dari android/app/build.gradle.')
  process.exit(1)
}

// The APK's own mtime, not "now": re-running this script must not make an old
// build look fresh on the website.
const stat = statSync(built)

mkdirSync(dirname(published), { recursive: true })
copyFileSync(built, published)

writeFileSync(
  manifest,
  JSON.stringify(
    {
      version,
      versionCode,
      sizeBytes: stat.size,
      builtAt: stat.mtime.toISOString(),
    },
    null,
    2,
  ) + '\n',
)

const mb = (stat.size / 1024 / 1024).toFixed(1)
console.log(`[apk] v${version} (${versionCode}) · ${mb} MB · ${stat.mtime.toISOString()}`)
console.log('[apk] -> public/downloads/wa-status.apk + src/apk-release.json')
