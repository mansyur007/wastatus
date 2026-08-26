import type { Settings, SourceMeta } from '../../types'
import type { PipelineMeta, PipelinePart } from './pipeline'

/** Messages between the UI thread and the WebCodecs worker. */

export type WorkerRequest =
  | { id: number; kind: 'support' }
  | { id: number; kind: 'probe'; file: File }
  | { id: number; kind: 'convert'; file: File; settings: Settings; meta: PipelineMeta }

export type WorkerResponse =
  | { id: number; kind: 'support'; ok: boolean; reason: string }
  | { id: number; kind: 'probed'; meta: Partial<SourceMeta> }
  | { id: number; kind: 'progress'; fraction: number; label: string }
  | { id: number; kind: 'done'; parts: PipelinePart[] }
  /** `unsupported` means "this source, not this browser" - the caller falls back. */
  | { id: number; kind: 'error'; message: string; unsupported: boolean }
