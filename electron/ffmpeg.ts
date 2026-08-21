import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArgs, outputFilename } from '../src/lib/ffmpegArgs'
import { audioKbps, bitrateForTarget, encodeDuration, segmentPlan } from '../src/lib/bitrate'
import { WA_HARD_LIMIT_BYTES } from '../src/lib/presets'
import type { MediaInfo, Settings } from '../src/types'

/**
 * The desktop encoding engine. Deliberately free of any electron import so it
 * can be exercised directly in Node against the real binary - the wasm path has
 * no equivalent, since it needs a browser.
 */

/** Serialisable stand-in for SourceMeta: no File survives the IPC boundary. */
export interface NativeMeta extends MediaInfo {
  name: string
  duration: number
}

export interface ConvertRequest {
  inputPath: string
  settings: Settings
  meta: NativeMeta
}

export interface Binaries {
  ffmpeg: string
  ffprobe: string
}

export interface NativePart {
  bytes: Buffer
  size: number
  filename: string
  attempts: number
  videoBitrate: number
  part: number
  totalParts: number
  start: number
  duration: number
}

/** Windows has no /dev/null; the pass-1 encode is thrown away into NUL. */
export const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null'

interface RunResult {
  code: number
  stderr: string
  /** ffmpeg writes -version here, while encode logs go to stderr. */
  stdout: string
}

/**
 * Runs a binary. `onProgress` receives seconds of output written so far, parsed
 * from ffmpeg's own -progress stream rather than scraped out of stderr.
 */
export function run(
  bin: string,
  args: string[],
  onProgress?: (seconds: number) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    let stdout = ''
    let pending = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 40000) stderr = stderr.slice(-20000)
    })
    child.stdout.on('data', (d) => {
      const chunk = d.toString()
      stdout += chunk
      if (stdout.length > 40000) stdout = stdout.slice(-20000)
      if (!onProgress) return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim())
        if (m) onProgress(Number(m[1]) / 1000000)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderr, stdout }))
  })
}

/** ffprobe straight to stdout, so no temp file is needed just to read metadata. */
export function probe(bins: Binaries, inputPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bins.ffprobe,
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,r_frame_rate,width,height',
        '-show_entries', 'format=duration',
        '-of', 'json',
        inputPath,
      ],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        const streams: Record<string, unknown>[] = parsed.streams ?? []
        const video = streams.find((s) => s.codec_type === 'video')
        const audio = streams.find((s) => s.codec_type === 'audio')
        const result: Record<string, unknown> = { hasAudio: Boolean(audio) }
        const duration = Number(parsed.format?.duration)
        if (Number.isFinite(duration)) result.duration = duration
        if (video) {
          result.codec = video.codec_name
          if (video.width) result.width = video.width
          if (video.height) result.height = video.height
          const [num, den] = String(video.r_frame_rate ?? '').split('/').map(Number)
          if (num && den) result.fps = Math.round((num / den) * 100) / 100
        }
        resolve(result)
      } catch {
        reject(new Error(err.trim().split('\n').pop() || 'Tidak bisa membaca metadata video.'))
      }
    })
  })
}

/** ffmpeg puts the useful line last; the rest is banner and stream dumps. */
function ffmpegError(stderr: string, phase: string): string {
  const line = stderr.trim().split('\n').filter(Boolean).pop()
  return 'FFmpeg ' + phase + ' gagal' + (line ? ': ' + line.trim() : '.')
}

/**
 * Same orchestration as the wasm client - segment, 2-pass, shrink-and-retry -
 * but driven by the native binary, which is far faster and is not boxed in by
 * the wasm heap.
 */
export async function convert(
  bins: Binaries,
  req: ConvertRequest,
  report: (fraction: number, label: string) => void,
): Promise<NativePart[]> {
  const { inputPath, settings, meta } = req
  const segments = segmentPlan(settings)
  const twoPass = settings.encodingMode === 'size'
  const startBitrate = twoPass
    ? bitrateForTarget(settings.targetSizeMB, encodeDuration(settings), audioKbps(settings, meta))
    : settings.videoBitrate

  const dir = await mkdtemp(join(tmpdir(), 'wa-status-'))
  const results: NativePart[] = []

  try {
    for (const segment of segments) {
      const total = segments.length
      const prefix = total > 1 ? 'Bagian ' + (segment.index + 1) + '/' + total + ' - ' : ''
      const from = segment.index / total
      const to = (segment.index + 1) / total
      const at = (a: number, b: number) => [from + (to - from) * a, from + (to - from) * b] as const

      const output = join(dir, 'part-' + segment.index + '.mp4')
      const passlog = join(dir, 'wapass' + segment.index)
      let bitrate = startBitrate
      let bytes: Buffer | null = null
      let attempt = 0
      const maxAttempts = twoPass ? 3 : 1

      while (attempt < maxAttempts) {
        attempt++
        const base = {
          input: inputPath,
          output,
          settings,
          meta,
          videoBitrate: bitrate,
          segment,
          passlog,
          nullPath: NULL_SINK,
        }
        const retryLabel = attempt > 1 ? ' (re-encode ' + (attempt - 1) + ')' : ''
        const track = (span: readonly [number, number], label: string) => (seconds: number) => {
          const p = Math.min(1, Math.max(0, seconds / segment.duration))
          report(span[0] + (span[1] - span[0]) * p, label)
        }
        const globals = ['-hide_banner', '-nostats', '-progress', 'pipe:1']

        if (twoPass) {
          const l1 = prefix + 'Analisis pass 1' + retryLabel
          const r1 = await run(bins.ffmpeg, globals.concat(buildArgs({ ...base, pass: 1 })), track(at(0, 0.45), l1))
          if (r1.code !== 0) throw new Error(ffmpegError(r1.stderr, 'pass 1'))
          const l2 = prefix + 'Encoding pass 2' + retryLabel
          const r2 = await run(bins.ffmpeg, globals.concat(buildArgs({ ...base, pass: 2 })), track(at(0.45, 1), l2))
          if (r2.code !== 0) throw new Error(ffmpegError(r2.stderr, 'pass 2'))
        } else {
          const l = prefix + 'Encoding CRF ' + settings.crf
          const r = await run(bins.ffmpeg, globals.concat(buildArgs(base)), track(at(0, 1), l))
          if (r.code !== 0) throw new Error(ffmpegError(r.stderr, 'encode'))
        }

        bytes = await readFile(output)
        if (bytes.byteLength <= WA_HARD_LIMIT_BYTES || attempt >= maxAttempts) break
        bitrate = Math.max(150, Math.round(bitrate * 0.9))
      }

      if (!bytes) throw new Error('Konversi bagian ' + (segment.index + 1) + ' tidak menghasilkan file.')
      results.push({
        bytes,
        size: bytes.byteLength,
        filename: outputFilename(meta.name, settings, meta, { index: segment.index, total }),
        attempts: attempt,
        videoBitrate: bitrate,
        part: segment.index + 1,
        totalParts: total,
        start: segment.start,
        duration: segment.duration,
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  report(1, 'Selesai')
  return results
}
