import type { ConversionResult, Settings, SourceMeta } from '../../types'
import type { PipelineMeta } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * UI-thread half of the WebCodecs engine: owns the worker, correlates replies,
 * and hands finished parts back as Blobs.
 *
 * Nothing here imports mediabunny or the pipeline at runtime - only types - so
 * a browser without WebCodecs never downloads or parses any of it.
 */

/** The source, not the browser: the caller should fall back to ffmpeg.wasm. */
export class UnsupportedSourceError extends Error {}

/** Cheap synchronous gate. The real answer comes from support(). */
export function present(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined'
  )
}

let worker: Worker | null = null
let nextId = 1

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return worker
}

interface CallHandlers {
  onProgress?: (fraction: number, label: string) => void
}

/** A plain Omit collapses a union to its shared keys; this keeps each variant. */
type Unaddressed<T> = T extends unknown ? Omit<T, 'id'> : never

/** One request, resolved by the matching reply. Progress is streamed meanwhile. */
function call<T extends WorkerResponse>(
  request: Unaddressed<WorkerRequest>,
  { onProgress }: CallHandlers = {},
): Promise<T> {
  const w = getWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      if (msg.id !== id) return
      if (msg.kind === 'progress') {
        onProgress?.(msg.fraction, msg.label)
        return
      }
      done()
      if (msg.kind === 'error') {
        reject(msg.unsupported ? new UnsupportedSourceError(msg.message) : new Error(msg.message))
        return
      }
      resolve(msg as T)
    }
    // A worker that fails to even boot (blocked module worker, older WebView)
    // is a browser problem, so it reads as unsupported and falls back.
    const onError = (event: ErrorEvent) => {
      done()
      reject(new UnsupportedSourceError(event.message || 'Worker WebCodecs gagal dimuat.'))
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    w.postMessage({ ...request, id } as WorkerRequest)
  })
}

let supported: Promise<{ ok: boolean; reason: string }> | null = null

/** Memoised: whether this browser can encode H.264 through WebCodecs at all. */
export function support(): Promise<{ ok: boolean; reason: string }> {
  if (!present()) {
    return Promise.resolve({ ok: false, reason: 'Browser ini belum punya WebCodecs.' })
  }
  supported ??= call<Extract<WorkerResponse, { kind: 'support' }>>({ kind: 'support' })
    .then(({ ok, reason }) => ({ ok, reason }))
    .catch(() => ({ ok: false, reason: 'Worker WebCodecs tidak bisa dijalankan.' }))
  return supported
}

/** Boots the worker early so the first conversion does not pay for it. */
export async function prepare(): Promise<void> {
  await support()
}

export async function probe(file: File): Promise<Partial<SourceMeta>> {
  const res = await call<Extract<WorkerResponse, { kind: 'probed' }>>({ kind: 'probe', file })
  return res.meta
}

const serialise = (meta: SourceMeta): PipelineMeta => ({
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
  onProgress: (fraction: number, label: string) => void,
): Promise<ConversionResult[]> {
  const res = await call<Extract<WorkerResponse, { kind: 'done' }>>(
    { kind: 'convert', file: meta.file, settings, meta: serialise(meta) },
    { onProgress },
  )
  return res.parts.map((p) => {
    const blob = new Blob([p.buffer], { type: 'video/mp4' })
    return {
      blob,
      url: URL.createObjectURL(blob),
      size: blob.size,
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
}
