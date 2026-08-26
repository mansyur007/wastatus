import type { ConversionResult, Settings, SourceMeta } from '../types'
import * as wasm from './ffmpegClient'
import * as webcodecs from './webcodecs'

/**
 * One conversion API over three engines, picked best-first.
 *
 * 1. native     - the Electron build, where a preload script exposes
 *                 `window.waNative` and the work goes to a bundled FFmpeg
 *                 binary. Fastest, and the only engine with real CRF.
 * 2. webcodecs  - every current browser, the PWA and the APK. Decode and
 *                 encode go to the device's own media hardware through
 *                 WebCodecs, roughly 20-40x the wasm engine.
 * 3. wasm       - ffmpeg.wasm. Software H.264 on one thread; kept as the
 *                 fallback for browsers without WebCodecs and for sources
 *                 whose codec the hardware decoder will not take.
 *
 * All three run the same planner, so which one served a job changes how long
 * it took, not how the files come out.
 */

interface NativeInfo {
  ready: boolean
  version: string
  ffmpegPath: string
}

interface NativePart {
  bytes: Uint8Array
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

interface NativeApi {
  info(): Promise<NativeInfo>
  pathForFile(file: File): string | null
  probe(inputPath: string): Promise<Partial<SourceMeta>>
  convert(req: { inputPath: string; settings: Settings; meta: SerialisableMeta }): Promise<NativePart[]>
  save(filename: string, bytes: Uint8Array): Promise<string | null>
  saveAll(files: { filename: string; bytes: Uint8Array }[]): Promise<string | null>
  reveal(filePath: string): Promise<void>
  setExitGuard?(on: boolean): void
  onProgress(cb: (p: { fraction: number; label: string }) => void): () => void
}

/** SourceMeta minus the things that cannot cross an IPC boundary. */
interface SerialisableMeta {
  name: string
  duration: number
  width: number
  height: number
  size: number
  fps?: number
  codec?: string
  audioCodec?: string
  hasAudio?: boolean
  videoKbps?: number
}

declare global {
  interface Window {
    waNative?: NativeApi
  }
}

const native = typeof window !== 'undefined' ? window.waNative : undefined

export const isNative = Boolean(native)

/**
 * Arms the desktop close confirm. No-op in the browser, where the same job is
 * done by a beforeunload listener.
 */
export function setNativeExitGuard(on: boolean): void {
  native?.setExitGuard?.(on)
}

export type EngineKind = 'native' | 'webcodecs' | 'wasm'

export interface EngineDescription {
  kind: EngineKind
  label: string
  detail: string
}

let nativeInfo: NativeInfo | null | undefined

/** Which engine will actually do the work, for the badge in the header. */
export async function describeEngine(): Promise<EngineDescription> {
  if (native) {
    if (nativeInfo === undefined) nativeInfo = await native.info().catch(() => null)
    if (nativeInfo?.ready) {
      return {
        kind: 'native',
        label: 'FFmpeg native',
        detail: nativeInfo.version || 'binary bawaan aplikasi',
      }
    }
  }
  const wc = await webcodecs.support()
  if (wc.ok) return { kind: 'webcodecs', label: 'WebCodecs', detail: wc.reason }
  if (native) {
    return {
      kind: 'wasm',
      label: 'ffmpeg.wasm',
      detail: 'FFmpeg bawaan tidak ditemukan, kembali ke mesin wasm',
    }
  }
  return { kind: 'wasm', label: 'ffmpeg.wasm', detail: wc.reason }
}

/** True only when the native binary is present and usable. */
async function nativeReady(): Promise<boolean> {
  if (!native) return false
  if (nativeInfo === undefined) nativeInfo = await native.info().catch(() => null)
  return Boolean(nativeInfo?.ready)
}

/** True when the browser engine can take the job, so wasm stays unloaded. */
async function webcodecsReady(): Promise<boolean> {
  if (await nativeReady()) return false
  return (await webcodecs.support()).ok
}

export const probeWithVideoElement = wasm.probeWithVideoElement

/**
 * Warms up whichever engine will do the work.
 *
 * On the WebCodecs path this only spins up a worker, so the 32 MB wasm core is
 * never fetched - the wait between dropping a file and seeing the panel goes
 * from seconds to nothing.
 */
export async function prepareEngine(): Promise<void> {
  if (await nativeReady()) return
  if (await webcodecsReady()) {
    await webcodecs.prepare()
    return
  }
  await wasm.getEngine()
}

/** fps / codec / audio presence. Best effort: never throws. */
export async function probeExtra(file: File): Promise<Partial<SourceMeta>> {
  if (await nativeReady()) {
    try {
      const path = native!.pathForFile(file)
      if (path) return await native!.probe(path)
    } catch {
      return {}
    }
    return {}
  }
  if (await webcodecsReady()) {
    // A container mediabunny cannot parse is not a lost cause: ffprobe still
    // reads it, and the conversion will fall back to wasm anyway.
    const meta = await webcodecs.probe(file).catch(() => null)
    if (meta) return meta
  }
  return wasm.probeWithFfprobe(file)
}

const serialise = (meta: SourceMeta): SerialisableMeta => ({
  name: meta.name,
  duration: meta.duration,
  width: meta.width,
  height: meta.height,
  size: meta.size,
  fps: meta.fps,
  codec: meta.codec,
  audioCodec: meta.audioCodec,
  hasAudio: meta.hasAudio,
  videoKbps: meta.videoKbps,
})

/**
 * Wraps a position-only progress stream with the elapsed-time extrapolation
 * that produces an ETA. Identical for every engine, so it lives here.
 */
function withEta(handlers: wasm.ConvertHandlers) {
  const startedAt = Date.now()
  return (fraction: number, label: string) => {
    const p = Math.min(1, Math.max(0, fraction))
    const elapsed = (Date.now() - startedAt) / 1000
    // Below a couple of percent the extrapolation is noise, not an estimate.
    const eta = p > 0.02 && elapsed > 2 ? Math.round((elapsed * (1 - p)) / p) : undefined
    handlers.onProgress(p, label, eta)
  }
}

export async function convert(
  meta: SourceMeta,
  settings: Settings,
  handlers: wasm.ConvertHandlers,
): Promise<ConversionResult[]> {
  if (!(await nativeReady())) {
    if (await webcodecsReady()) {
      const report = withEta(handlers)
      let started = false
      try {
        return await webcodecs.convert(meta, settings, (fraction, label) => {
          if (fraction > 0) started = true
          report(fraction, label)
        })
      } catch (e) {
        // Falling back is right for a source the hardware pipeline refuses, and
        // for anything that goes wrong before the first frame - both are "this
        // browser cannot do it", and wasm can. A failure part-way through a run
        // is different: restarting on an engine seventeen times slower, without
        // saying so, is worse than surfacing the error.
        const unsupported = e instanceof webcodecs.UnsupportedSourceError
        if (started && !unsupported) throw e
        handlers.onProgress(
          0,
          unsupported ? 'Codec tidak didukung hardware · pakai ffmpeg.wasm' : 'Beralih ke ffmpeg.wasm',
        )
        await wasm.getEngine()
      }
    }
    return wasm.convert(meta, settings, handlers)
  }

  const inputPath = native!.pathForFile(meta.file)
  // A File with no path (rare: synthetic drops) still has bytes, so fall back.
  if (!inputPath) return wasm.convert(meta, settings, handlers)

  // The native side reports position only; the ETA comes from withEta.
  const report = withEta(handlers)
  const off = native!.onProgress(({ fraction, label }) => report(fraction, label))
  try {
    const parts = await native!.convert({ inputPath, settings, meta: serialise(meta) })
    return parts.map((p) => {
      const blob = new Blob([new Uint8Array(p.bytes)], { type: 'video/mp4' })
      return {
        blob,
        url: URL.createObjectURL(blob),
        size: p.size,
        filename: p.filename,
        attempts: p.attempts,
        videoBitrate: p.videoBitrate,
        part: p.part,
        totalParts: p.totalParts,
        start: p.start,
        duration: p.duration,
        copied: p.copied,
      }
    })
  } finally {
    off()
  }
}

/**
 * Desktop gets real save dialogs; the browser keeps the anchor download.
 * Both return true when the save was handled natively (including a cancel,
 * which must not fall through to a second, surprise browser download).
 */
export async function saveNatively(result: ConversionResult): Promise<boolean> {
  if (!native) return false
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  await native.save(result.filename, bytes)
  return true
}

/** One folder prompt for every part of a split export. */
export async function saveAllNatively(results: ConversionResult[]): Promise<boolean> {
  if (!native) return false
  const files = await Promise.all(
    results.map(async (r) => ({
      filename: r.filename,
      bytes: new Uint8Array(await r.blob.arrayBuffer()),
    })),
  )
  await native.saveAll(files)
  return true
}
