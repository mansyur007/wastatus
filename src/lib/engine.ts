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
  fps?: number
  codec?: string
  hasAudio?: boolean
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

let described: EngineDescription | null = null

export async function describeEngine(): Promise<EngineDescription> {
  if (described) return described
  if (native) {
    const info = await native.info().catch(() => null)
    described = info?.ready
      ? { kind: 'native', label: 'FFmpeg native', detail: info.version || 'binary bawaan aplikasi' }
      : {
          kind: 'wasm',
          label: 'ffmpeg.wasm',
          detail: 'FFmpeg bawaan tidak ditemukan, kembali ke mesin wasm',
        }
  } else {
    described = { kind: 'wasm', label: 'ffmpeg.wasm', detail: 'berjalan di dalam browser' }
  }
  return described
}

/** True only when the native binary is present and usable. */
async function nativeReady(): Promise<boolean> {
  return (await describeEngine()).kind === 'native'
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
  fps: meta.fps,
  codec: meta.codec,
  hasAudio: meta.hasAudio,
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

  const off = native!.onProgress(({ fraction, label }) => handlers.onProgress(fraction, label))
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
