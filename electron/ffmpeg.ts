import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEGMENT_LIST, buildArgs, buildCopyArgs, outputFilename } from '../src/lib/ffmpegArgs'
import { buildPlan } from '../src/lib/plan'
import { clipDuration } from '../src/lib/bitrate'
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
  /** Bytes on disk, so the planner can derive a bitrate ceiling. */
  size?: number
  codec?: string
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
  copied?: boolean
}

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
        '-show_entries', 'stream=codec_type,codec_name,r_frame_rate,width,height,bit_rate',
        '-show_entries', 'format=duration,bit_rate',
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
        if (audio) result.audioCodec = audio.codec_name
        if (video) {
          result.codec = video.codec_name
          if (video.width) result.width = video.width
          if (video.height) result.height = video.height
          const [num, den] = String(video.r_frame_rate ?? '').split('/').map(Number)
          if (num && den) result.fps = Math.round((num / den) * 100) / 100
          // The bitrate ceiling: never re-encode above what the source carries.
          const bps = Number(video.bit_rate)
          if (Number.isFinite(bps) && bps > 0) result.videoKbps = Math.round(bps / 1000)
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

/** "part000.mp4,0.000000,30.000000" -> the real boundaries of each part. */
function parseSegmentList(csv: string): { name: string; start: number; duration: number }[] {
  const rows: { name: string; start: number; duration: number }[] = []
  for (const line of csv.split('\n')) {
    const [name, start, end] = line.trim().split(',')
    if (!name || start === undefined || end === undefined) continue
    const a = Number(start)
    const b = Number(end)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    rows.push({ name, start: a, duration: Math.max(0, b - a) })
  }
  return rows
}

/**
 * Same orchestration as the wasm client: one ffmpeg run whose segment muxer
 * writes every part from a single decode pass, then a targeted re-encode for
 * any part that still overshoots. Driven by the native binary, which is far
 * faster and is not boxed in by the wasm heap.
 */
export async function convert(
  bins: Binaries,
  req: ConvertRequest,
  report: (fraction: number, label: string) => void,
): Promise<NativePart[]> {
  const { inputPath, settings, meta } = req

  // The planner needs the file size to derive a bitrate ceiling when ffprobe
  // did not report a per-stream one.
  const size = meta.size ?? (await stat(inputPath).then((s) => s.size).catch(() => undefined))
  const plan = buildPlan(settings, { ...meta, size })

  const dir = await mkdtemp(join(tmpdir(), 'wa-status-'))
  const split = plan.segments.length > 1
  const seam = split ? plan.seamSeconds : undefined
  const listPath = join(dir, SEGMENT_LIST)
  const partPath = (name: string) => join(dir, name)

  const globals = ['-hide_banner', '-nostats', '-progress', 'pipe:1']
  const window = clipDuration(settings)

  /**
   * Decode on the GPU where one is available.
   *
   * `-ss/-i` are input options, and `-hwaccel` has to precede them, which is
   * why it rides along with the globals. `auto` is genuinely automatic: ffmpeg
   * tries the platform decoders in turn and silently falls back to software
   * when none of them will take the stream, so this cannot fail the run. It
   * only applies to the encode route - a stream copy never decodes anything.
   *
   * Measured on a 1080p60 HEVC source: 19.8 s -> 14.5 s, with libx264 still
   * doing the encoding, so not a pixel of the output changes.
   */
  const decode = plan.kind === 'copy' ? [] : ['-hwaccel', 'auto']

  try {
    const base = {
      input: inputPath,
      output: split ? join(dir, 'part%03d.mp4') : join(dir, 'part000.mp4'),
      settings,
      meta,
      videoBitrate: plan.videoKbps,
      seamSeconds: seam,
      segmentList: listPath,
    }
    const label = plan.kind === 'copy' ? 'Memotong tanpa encode ulang' : 'Encoding'
    const track = (seconds: number) => {
      report(Math.min(0.95, Math.max(0, seconds / window) * 0.95), label)
    }

    const args = plan.kind === 'copy' ? buildCopyArgs(base) : buildArgs(base)
    const first = await run(bins.ffmpeg, globals.concat(decode, args), track)
    if (first.code !== 0) throw new Error(ffmpegError(first.stderr, plan.kind === 'copy' ? 'potong' : 'encode'))

    let rows = split
      ? parseSegmentList(await readFile(listPath, 'utf8').catch(() => ''))
      : []
    if (!rows.length) {
      rows = plan.segments.map((seg, i) => ({
        name: 'part' + String(i).padStart(3, '0') + '.mp4',
        start: 0,
        duration: seg.duration,
      }))
    }

    const total = rows.length
    const results: NativePart[] = []

    for (let i = 0; i < total; i++) {
      const row = rows[i]
      const start = settings.trimStart + row.start
      let bytes = await readFile(partPath(row.name))
      let bitrate = plan.videoKbps
      let attempt = 1
      const maxAttempts = plan.kind === 'encode' ? 3 : 1

      while (bytes.byteLength > WA_HARD_LIMIT_BYTES && attempt < maxAttempts) {
        attempt++
        bitrate = Math.max(150, Math.round(bitrate * 0.9))
        report(0.95, 'Bagian ' + (i + 1) + ' terlalu besar - re-encode ' + (attempt - 1))
        const retry = await run(
          bins.ffmpeg,
          globals.concat(
            decode,
            buildArgs({
              input: inputPath,
              output: partPath(row.name),
              settings,
              meta,
              videoBitrate: bitrate,
              // The nominal plan, not the CSV: an encode plan cuts exactly on
              // the seams it forced, while the CSV drifts by a frame or two.
              segment: plan.segments[i] ?? { index: i, start, duration: row.duration },
            }),
          ),
        )
        if (retry.code !== 0) break
        bytes = await readFile(partPath(row.name))
      }

      results.push({
        bytes,
        size: bytes.byteLength,
        filename: outputFilename(meta.name, settings, meta, { index: i, total }),
        attempts: attempt,
        videoBitrate: bitrate,
        part: i + 1,
        totalParts: total,
        start,
        duration: row.duration,
        copied: plan.kind === 'copy',
      })
      report(0.95 + 0.05 * ((i + 1) / total), 'Menyiapkan hasil')
    }

    report(1, 'Selesai')
    return results
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
