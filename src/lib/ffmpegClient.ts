import { FFmpeg } from '@ffmpeg/ffmpeg'
import type { ConversionResult, Settings, SourceMeta } from '../types'
import { buildArgs, outputFilename } from './ffmpegArgs'
import { audioKbps, bitrateForTarget, encodeDuration, segmentPlan } from './bitrate'
import { WA_HARD_LIMIT_BYTES } from './presets'

// Self-hosted core + worker (see scripts/copy-ffmpeg-core.mjs). The worker is a
// module worker, so it dynamic-imports the ESM core and needs absolute URLs.
// Resolved against document.baseURI rather than the origin, so this also works
// from file:// where the origin is null.
const abs = (p: string) => new URL(p, document.baseURI).href
const CLASS_WORKER_URL = abs('ffmpeg/lib/worker.js')
const CORE_URL = abs('ffmpeg/ffmpeg-core.js')
const WASM_URL = abs('ffmpeg/ffmpeg-core.wasm')

const IN = 'input'
const OUT = 'output.mp4'

let instance: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null
const logLines: string[] = []

export function recentLog(): string[] {
  return logLines.slice(-40)
}

export function getEngine(): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance)
  if (loading) return loading
  loading = (async () => {
    const ffmpeg = new FFmpeg()
    ffmpeg.on('log', ({ message }) => {
      logLines.push(message)
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
    })
    await ffmpeg.load({ classWorkerURL: CLASS_WORKER_URL, coreURL: CORE_URL, wasmURL: WASM_URL })
    instance = ffmpeg
    return ffmpeg
  })()
  return loading
}

const extOf = (name: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : 'mp4'
}

/** Reads duration/resolution straight from the browser, without ffmpeg. */
export function probeWithVideoElement(file: File): Promise<Pick<SourceMeta, 'duration' | 'width' | 'height'> & { url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      resolve({ url, duration: el.duration || 0, width: el.videoWidth, height: el.videoHeight })
    }
    el.onerror = () => reject(new Error('Browser tidak bisa membaca metadata video ini.'))
    el.src = url
  })
}

/** fps / codec / audio presence via ffprobe. Best effort: never throws. */
export async function probeWithFfprobe(file: File): Promise<Partial<SourceMeta>> {
  try {
    const ffmpeg = await getEngine()
    const name = `probe.${extOf(file.name)}`
    await ffmpeg.writeFile(name, new Uint8Array(await file.arrayBuffer()))
    await ffmpeg.ffprobe([
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,r_frame_rate,width,height',
      '-of', 'json',
      name,
      '-o', 'probe.json',
    ])
    const raw = (await ffmpeg.readFile('probe.json', 'utf8')) as string
    await ffmpeg.deleteFile(name).catch(() => {})
    await ffmpeg.deleteFile('probe.json').catch(() => {})

    const streams: any[] = JSON.parse(raw).streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.find((s) => s.codec_type === 'audio')
    const out: Partial<SourceMeta> = { hasAudio: Boolean(audio) }
    if (video) {
      out.codec = video.codec_name
      const [num, den] = String(video.r_frame_rate ?? '').split('/').map(Number)
      if (num && den) out.fps = Math.round((num / den) * 100) / 100
      if (video.width) out.width = video.width
      if (video.height) out.height = video.height
    }
    return out
  } catch {
    return {}
  }
}

export interface ConvertHandlers {
  onProgress: (fraction: number, label: string) => void
}

/**
 * Encodes the trim window with the panel settings, one file per part (autoSplit
 * cuts anything over 30 s). Target-size mode runs x264 2-pass per part and, if a
 * part still lands over the WhatsApp limit, retries it with 10% less bitrate
 * (max 2 retries, per spec 5.4.4).
 */
export async function convert(
  meta: SourceMeta,
  settings: Settings,
  { onProgress }: ConvertHandlers,
): Promise<ConversionResult[]> {
  const ffmpeg = await getEngine()
  const input = `${IN}.${extOf(meta.name)}`
  await ffmpeg.writeFile(input, new Uint8Array(await meta.file.arrayBuffer()))

  const segments = segmentPlan(settings)
  const twoPass = settings.encodingMode === 'size'
  // One bitrate for every part, sized for the longest one, so quality stays
  // even and a short tail just comes out smaller than its budget.
  const startBitrate = twoPass
    ? bitrateForTarget(settings.targetSizeMB, encodeDuration(settings), audioKbps(settings, meta))
    : settings.videoBitrate

  const results: ConversionResult[] = []

  // Progress events report per-pass position; weight passes and parts into one bar.
  let span: [number, number] = [0, 1]
  let label = 'Encoding'
  const handler = ({ progress }: { progress: number }) => {
    const p = Math.min(1, Math.max(0, progress))
    onProgress(span[0] + (span[1] - span[0]) * p, label)
  }
  ffmpeg.on('progress', handler)

  try {
    for (const segment of segments) {
      const total = segments.length
      const prefix = total > 1 ? `Bagian ${segment.index + 1}/${total} · ` : ''
      // Each part owns its own slice of the overall bar.
      const from = segment.index / total
      const to = (segment.index + 1) / total
      const at = (a: number, b: number): [number, number] => [
        from + (to - from) * a,
        from + (to - from) * b,
      ]
      // Unique stats file: pass 1 of one part must never feed pass 2 of another.
      const passlog = `wapass${segment.index}`

      let bitrate = startBitrate
      let data: Uint8Array | null = null
      let attempt = 0
      const maxAttempts = twoPass ? 3 : 1

      while (attempt < maxAttempts) {
        attempt++
        const base = { input, output: OUT, settings, meta, videoBitrate: bitrate, segment, passlog }
        const retryLabel = attempt > 1 ? ` (re-encode ${attempt - 1})` : ''

        if (twoPass) {
          span = at(0, 0.45)
          label = `${prefix}Analisis pass 1${retryLabel}`
          const code1 = await ffmpeg.exec(buildArgs({ ...base, pass: 1 }))
          if (code1 !== 0) throw new Error(`FFmpeg pass 1 gagal (kode ${code1}).`)
          span = at(0.45, 1)
          label = `${prefix}Encoding pass 2${retryLabel}`
          const code2 = await ffmpeg.exec(buildArgs({ ...base, pass: 2 }))
          if (code2 !== 0) throw new Error(`FFmpeg pass 2 gagal (kode ${code2}).`)
        } else {
          span = at(0, 1)
          label = `${prefix}Encoding CRF ${settings.crf}`
          const code = await ffmpeg.exec(buildArgs(base))
          if (code !== 0) throw new Error(`FFmpeg gagal (kode ${code}).`)
        }

        data = (await ffmpeg.readFile(OUT)) as Uint8Array
        if (data.byteLength <= WA_HARD_LIMIT_BYTES || attempt >= maxAttempts) break
        bitrate = Math.max(150, Math.round(bitrate * 0.9))
      }

      if (!data) throw new Error(`Konversi bagian ${segment.index + 1} tidak menghasilkan file.`)
      const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: 'video/mp4' })
      results.push({
        blob,
        url: URL.createObjectURL(blob),
        size: blob.size,
        filename: outputFilename(meta.name, settings, meta, { index: segment.index, total }),
        attempts: attempt,
        videoBitrate: bitrate,
        part: segment.index + 1,
        totalParts: total,
        start: segment.start,
        duration: segment.duration,
      })

      // Free the wasm FS as we go: a long split would otherwise hold every part twice.
      await ffmpeg.deleteFile(OUT).catch(() => {})
      await ffmpeg.deleteFile(`${passlog}-0.log`).catch(() => {})
      await ffmpeg.deleteFile(`${passlog}-0.log.mbtree`).catch(() => {})
    }
  } finally {
    ffmpeg.off('progress', handler)
    await ffmpeg.deleteFile(input).catch(() => {})
    await ffmpeg.deleteFile(OUT).catch(() => {})
  }

  onProgress(1, 'Selesai')
  return results
}
