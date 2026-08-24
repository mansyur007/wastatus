import type { ConversionResult, Settings, SourceMeta } from '../types'
import * as wasm from './ffmpegClient'

/**
 * One conversion API over two engines.
 *
 * In the browser (and inside the Capacitor APK) everything runs through
 * ffmpeg.wasm. In the Electron build a preload script exposes `window.waNative`
 * and the work goes to a bundled native FFmpeg instead - same arguments, same
 * segment plan, roughly 20-50x the speed.
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

export type EngineKind = 'native' | 'wasm'

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
    return {
      kind: 'wasm',
      label: 'ffmpeg.wasm',
      detail: 'FFmpeg bawaan tidak ditemukan, kembali ke mesin wasm',
    }
  }
  return { kind: 'wasm', label: 'ffmpeg.wasm', detail: 'berjalan di dalam browser' }
}

/** True only when the native binary is present and usable. */
async function nativeReady(): Promise<boolean> {
  if (!native) return false
  if (nativeInfo === undefined) nativeInfo = await native.info().catch(() => null)
  return Boolean(nativeInfo?.ready)
}

export const probeWithVideoElement = wasm.probeWithVideoElement

/** Warms up whichever engine will do the work. */
export async function prepareEngine(): Promise<void> {
  if (await nativeReady()) return
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

export async function convert(
  meta: SourceMeta,
  settings: Settings,
  handlers: wasm.ConvertHandlers,
): Promise<ConversionResult[]> {
  if (!(await nativeReady())) return wasm.convert(meta, settings, handlers)

  const inputPath = native!.pathForFile(meta.file)
  // A File with no path (rare: synthetic drops) still has bytes, so fall back.
  if (!inputPath) return wasm.convert(meta, settings, handlers)

  // The native side reports position only; the elapsed-time extrapolation that
  // produces an ETA is identical for both engines, so it lives here.
  const startedAt = Date.now()
  const off = native!.onProgress(({ fraction, label }) => {
    const p = Math.min(1, Math.max(0, fraction))
    const elapsed = (Date.now() - startedAt) / 1000
    const eta = p > 0.02 && elapsed > 2 ? Math.round((elapsed * (1 - p)) / p) : undefined
    handlers.onProgress(p, label, eta)
  })
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
