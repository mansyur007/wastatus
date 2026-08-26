// Runs the Gradle release build, then publishes the APK to the website.
//
// Why a script and not `cd android && gradlew assembleRelease` in package.json:
// npm runs scripts through cmd.exe on Windows, and a bare `gradlew` only
// resolves there if cmd is allowed to search the current directory - which it
// is not on every machine. Naming the wrapper explicitly per platform is the
// difference between "works here" and "works".
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const android = join(root, 'android')
const windows = process.platform === 'win32'
const wrapper = join(android, windows ? 'gradlew.bat' : 'gradlew')

// Node refuses to spawn a .bat directly (EINVAL since the 2024 argument-
// injection fix), so on Windows the batch file goes through cmd.exe. It is
// referenced as `.\gradlew.bat` relative to cwd rather than by absolute path:
// cmd would split the absolute one on the spaces in the repo path, and a bare
// name does not resolve on machines where cmd's current-directory search is
// switched off.
const [command, args] = windows
  ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', '.\\gradlew.bat', 'assembleRelease']]
  : [wrapper, ['assembleRelease']]

const gradle = spawnSync(command, args, { cwd: android, stdio: 'inherit' })
if (gradle.error) {
  console.error('[apk] gagal menjalankan ' + wrapper + ': ' + gradle.error.message)
  process.exit(1)
}
if (gradle.status !== 0) process.exit(gradle.status ?? 1)

const publish = spawnSync(process.execPath, [join(root, 'scripts', 'publish-apk.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(publish.status ?? 1)
