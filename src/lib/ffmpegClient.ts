import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import type { ConversionResult, Segment, Settings, SourceMeta } from '../types'
import { SEGMENT_LIST, buildArgs, buildCopyArgs, outputFilename } from './ffmpegArgs'
import { buildPlan } from './plan'
import { WA_HARD_LIMIT_BYTES } from './presets'

// Self-hosted core + worker (see scripts/copy-ffmpeg-core.mjs). The worker is a
// module worker, so it dynamic-imports the ESM core and needs absolute URLs.
// Resolved against document.baseURI rather than the origin, so this also works
// from file:// where the origin is null.
const abs = (p: string) => new URL(p, document.baseURI).href
const CLASS_WORKER_URL = abs('ffmpeg/lib/worker.js')
const CORE_URL = abs('ffmpeg/ffmpeg-core.js')
const WASM_URL = abs('ffmpeg/ffmpeg-core.wasm')

/** Read-only mount point for the source file. */
const MOUNT = '/mnt'
const PART_PATTERN = 'part%03d.mp4'
const partFile = (i: number) => `part${String(i).padStart(3, '0')}.mp4`

let instance: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null
const logLines: string[] = []

export function recentLog(): string[] {
  return logLines.slice(-40)
}

/**
 * Single-thread core, deliberately.
 *
 * @ffmpeg/core-mt@0.12.10 was tried here: the page is cross-origin isolated
 * (Caddyfile and vite.config.ts both serve COOP/COEP) and the core loads and
 * spawns its pthread pool, but every encode then deadlocks right after
 * "Stream mapping:" without producing a frame - with or without an explicit
 * -threads. The same arguments encode fine on this core. It hangs rather than
 * throwing, so a try/catch fallback would never fire and the tab would simply
 * sit at 0% forever. Not shippable until upstream fixes it.
 */
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

/**
 * Exposes the source to ffmpeg without copying it.
 *
 * The old path did `writeFile(new Uint8Array(await file.arrayBuffer()))`, which
 * materialises the whole file twice - once as a JS ArrayBuffer, once inside the
 * wasm heap - and did it again for the probe. For a 90 MB source that is 360 MB
 * of churn before a single frame is decoded, and it puts a hard ceiling on the
 * file size the app can open at all. WORKERFS reads straight from the Blob.
 */
async function mountSource(ffmpeg: FFmpeg, file: File): Promise<string> {
  const name = `source.${extOf(file.name)}`
  await ffmpeg.createDir(MOUNT).catch(() => {})
  await ffmpeg.unmount(MOUNT).catch(() => {})
  await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name, data: file }] }, MOUNT)
  return `${MOUNT}/${name}`
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

/** fps / codec / bitrate / audio presence via ffprobe. Best effort: never throws. */
export async function probeWithFfprobe(file: File): Promise<Partial<SourceMeta>> {
  const ffmpeg = await getEngine().catch(() => null)
  if (!ffmpeg) return {}
  try {
    const input = await mountSource(ffmpeg, file)
    await ffmpeg.ffprobe([
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,r_frame_rate,width,height,bit_rate',
      '-show_entries', 'format=bit_rate',
      '-of', 'json',
      input,
      '-o', 'probe.json',
    ])
    const raw = (await ffmpeg.readFile('probe.json', 'utf8')) as string
    await ffmpeg.deleteFile('probe.json').catch(() => {})

    const parsed = JSON.parse(raw)
    const streams: any[] = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.find((s) => s.codec_type === 'audio')
    const out: Partial<SourceMeta> = { hasAudio: Boolean(audio) }
    if (audio) out.audioCodec = audio.codec_name
    if (video) {
      out.codec = video.codec_name
      const [num, den] = String(video.r_frame_rate ?? '').split('/').map(Number)
      if (num && den) out.fps = Math.round((num / den) * 100) / 100
      if (video.width) out.width = video.width
      if (video.height) out.height = video.height
      // Per-stream bitrate is the honest number; many MP4s omit it, in which
      // case bitrate.ts derives one from size over duration instead.
      const bps = Number(video.bit_rate)
      if (Number.isFinite(bps) && bps > 0) out.videoKbps = Math.round(bps / 1000)
    }
    return out
  } catch {
    return {}
  } finally {
    await ffmpeg.unmount(MOUNT).catch(() => {})
  }
}

export interface ConvertHandlers {
  onProgress: (fraction: number, label: string, etaSeconds?: number) => void
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
 * Encodes the trim window with the panel settings, one file per part.
 *
 * The whole export is a single ffmpeg run: the segment muxer writes every part
 * from one decode pass. The previous shape - one 2-pass invocation per part -
 * decoded the source twice over and re-opened it once per part, which on a
 * 56-minute source meant 224 invocations and hours of wall clock.
 *
 * Parts that still land over the WhatsApp limit are re-encoded individually
 * with 10% less headroom (max 2 retries), so a single stubborn part no longer
 * costs a rerun of the entire video.
 */
export async function convert(
  meta: SourceMeta,
  settings: Settings,
  { onProgress }: ConvertHandlers,
): Promise<ConversionResult[]> {
  const ffmpeg = await getEngine()
  const plan = buildPlan(settings, meta)
  const input = await mountSource(ffmpeg, meta.file)

  const planned = plan.segments.length
  const split = planned > 1
  const seam = split ? plan.seamSeconds : undefined
  const base = {
    input,
    output: split ? PART_PATTERN : partFile(0),
    settings,
    meta,
    videoBitrate: plan.videoKbps,
    seamSeconds: seam,
  }

  let label = plan.kind === 'copy' ? 'Memotong tanpa encode ulang' : 'Encoding'
  let span: [number, number] = [0, 0.95]
  const startedAt = Date.now()
  const handler = ({ progress }: { progress: number }) => {
    const p = Math.min(1, Math.max(0, progress))
    const elapsed = (Date.now() - startedAt) / 1000
    // Below a couple of percent the extrapolation is noise, not an estimate.
    const eta = p > 0.02 && elapsed > 2 ? Math.round((elapsed * (1 - p)) / p) : undefined
    onProgress(span[0] + (span[1] - span[0]) * p, label, eta)
  }
  ffmpeg.on('progress', handler)

  const produced: string[] = []
  try {
    const code = await ffmpeg.exec(plan.kind === 'copy' ? buildCopyArgs(base) : buildArgs(base))
    if (code !== 0) throw new Error(`FFmpeg gagal (kode ${code}).`)

    // Real boundaries, straight from the muxer's own manifest.
    let rows: { name: string; start: number; duration: number }[] = []
    if (split) {
      const csv = (await ffmpeg.readFile(SEGMENT_LIST, 'utf8').catch(() => '')) as string
      await ffmpeg.deleteFile(SEGMENT_LIST).catch(() => {})
      rows = parseSegmentList(csv)
    }
    if (!rows.length) {
      rows = plan.segments.map((seg: Segment, i: number) => ({
        name: partFile(i),
        start: 0,
        duration: seg.duration,
      }))
    }

    const total = rows.length
    const results: ConversionResult[] = []

    for (let i = 0; i < total; i++) {
      const row = rows[i]
      produced.push(row.name)
      // Segment starts are relative to the trim window; report source position.
      const start = settings.trimStart + row.start
      let data = (await ffmpeg.readFile(row.name)) as Uint8Array
      let bitrate = plan.videoKbps
      let attempt = 1

      // Only an encode can be made smaller; a copy is already the source bytes.
      const maxAttempts = plan.kind === 'encode' ? 3 : 1
      while (data.byteLength > WA_HARD_LIMIT_BYTES && attempt < maxAttempts) {
        attempt++
        bitrate = Math.max(150, Math.round(bitrate * 0.9))
        span = [0.95, 0.99]
        label = `Bagian ${i + 1} terlalu besar · re-encode ${attempt - 1}`
        onProgress(0.95, label)
        // The nominal plan, not the CSV: an encode plan cuts exactly on the
        // seams it forced, while the CSV timestamps drift by a frame or two.
        const slice = plan.segments[i] ?? { index: i, start, duration: row.duration }
        const retry = await ffmpeg.exec(
          buildArgs({ input, output: row.name, settings, meta, videoBitrate: bitrate, segment: slice }),
        )
        if (retry !== 0) break
        data = (await ffmpeg.readFile(row.name)) as Uint8Array
      }

      const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: 'video/mp4' })
      results.push({
        blob,
        url: URL.createObjectURL(blob),
        size: blob.size,
        filename: outputFilename(meta.name, settings, meta, { index: i, total }),
        attempts: attempt,
        videoBitrate: bitrate,
        part: i + 1,
        totalParts: total,
        start,
        duration: row.duration,
        copied: plan.kind === 'copy',
      })

      // Hand the bytes to the Blob and drop them from the wasm FS immediately;
      // holding every part twice is what turns a long split into an OOM.
      await ffmpeg.deleteFile(row.name).catch(() => {})
      onProgress(0.95 + 0.05 * ((i + 1) / total), 'Menyiapkan hasil')
    }

    onProgress(1, 'Selesai')
    return results
  } finally {
    ffmpeg.off('progress', handler)
    for (const name of produced) await ffmpeg.deleteFile(name).catch(() => {})
    await ffmpeg.deleteFile(SEGMENT_LIST).catch(() => {})
    await ffmpeg.unmount(MOUNT).catch(() => {})
  }
}
