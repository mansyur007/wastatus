import type { MediaInfo, Segment, Settings } from '../types'
import {
  audioKbps,
  bitrateForTarget,
  effectiveVideoBitrate,
  encodeDuration,
  estimateSizeBytes,
  segmentPlan,
} from './bitrate'
import { WA_HARD_LIMIT_BYTES, outputFps } from './presets'

/**
 * What the planner needs to know about the source. Structural rather than
 * SourceMeta so the desktop main process - which has no File object - can run
 * the exact same decision.
 */
export interface PlanSource extends MediaInfo {
  size?: number
  duration?: number
  codec?: string
}

/**
 * Which of the two routes an export takes.
 *
 * 'copy'   - the source already satisfies every constraint, so it is cut with
 *            `-c copy`: no decode, no encode, done in well under a second.
 * 'encode' - the normal route: one ffmpeg run that decodes the source exactly
 *            once and writes every part through the segment muxer.
 */
export type PlanKind = 'copy' | 'encode'

export interface EncodePlan {
  kind: PlanKind
  segments: Segment[]
  seamSeconds: number
  /** Ceiling handed to -maxrate, in kbps. Unused by the copy route. */
  videoKbps: number
  /** True when the source's own bitrate, not the size budget, set the ceiling. */
  cappedBySource: boolean
  /** Plain-language explanation for the panel. */
  reason: string
}

/**
 * Bytes one part is expected to weigh. A copy keeps the source bytes, so its
 * size follows the source rate; an encode follows the ceiling it was given.
 */
export function estimatePartBytes(plan: EncodePlan, s: Settings, meta?: PlanSource): number {
  if (plan.kind === 'copy' && meta?.size && meta.duration) {
    return Math.round((meta.size / meta.duration) * encodeDuration(s))
  }
  return estimateSizeBytes(s, meta)
}

/** 9:16 within a tolerance wide enough for 1080x1920, 720x1280 and 540x960. */
const isPortrait916 = (w: number, h: number) => h > w && Math.abs(w / h - 9 / 16) < 0.02

/** Total source bitrate in kbps, straight from the container where possible. */
function sourceTotalKbps(meta?: PlanSource): number | undefined {
  if (!meta) return undefined
  if (meta.size && meta.duration) return (meta.size * 8) / 1000 / meta.duration
  if (meta.videoKbps) return meta.videoKbps + (meta.hasAudio === false ? 0 : 128)
  return undefined
}

/**
 * Whether the export can skip the codec entirely.
 *
 * Every condition here exists because breaking it would change pixels: a
 * non-H.264 codec WhatsApp may refuse, a landscape source that still needs its
 * 9:16 framing, a frame rate the user asked to halve. When none of those apply,
 * decoding 56 minutes of video to produce bit-identical output is pure waste.
 */
export function streamCopyCheck(s: Settings, meta?: PlanSource): { ok: boolean; reason: string } {
  if (!s.allowStreamCopy) return { ok: false, reason: 'Potong tanpa encode ulang dimatikan di panel.' }
  if (!meta) return { ok: false, reason: 'Metadata sumber belum terbaca.' }
  if (meta.codec && meta.codec !== 'h264') {
    return { ok: false, reason: `Sumber ${meta.codec.toUpperCase()}, WhatsApp butuh H.264 - harus encode ulang.` }
  }
  if (!meta.codec) return { ok: false, reason: 'Codec sumber tidak terbaca.' }
  if (meta.hasAudio !== false && meta.audioCodec && meta.audioCodec !== 'aac') {
    return { ok: false, reason: `Audio ${meta.audioCodec.toUpperCase()} perlu dikonversi ke AAC.` }
  }
  if (!isPortrait916(meta.width, meta.height)) {
    return { ok: false, reason: 'Sumber belum 9:16, masih perlu dibingkai ulang.' }
  }
  if (meta.width > 1080 || meta.height > 1920) {
    return { ok: false, reason: 'Sumber di atas 1080x1920, perlu diperkecil.' }
  }
  const targetFps = outputFps(s.fpsMode, meta.fps)
  if (meta.fps && targetFps < meta.fps - 0.01) {
    return { ok: false, reason: `FPS diturunkan ke ${targetFps}, perlu encode ulang.` }
  }
  const kbps = sourceTotalKbps(meta)
  if (!kbps) return { ok: false, reason: 'Bitrate sumber tidak terbaca.' }
  // Keyframe-aligned cuts can overshoot the nominal seam by up to one GOP, so
  // budget for a slightly longer part than segmentSeconds promises.
  const worstSeam = s.segmentSeconds * 1.1
  const bytes = (kbps * 1000 * worstSeam) / 8
  if (bytes > WA_HARD_LIMIT_BYTES) {
    return { ok: false, reason: 'Potongan apa adanya masih di atas 16 MB, perlu dikompres.' }
  }
  return { ok: true, reason: 'Sumber sudah memenuhi semua syarat - dipotong tanpa encode ulang.' }
}

export function buildPlan(s: Settings, meta?: PlanSource): EncodePlan {
  const segments = segmentPlan(s)
  const copy = streamCopyCheck(s, meta)
  const videoKbps = effectiveVideoBitrate(s, meta)

  if (copy.ok) {
    return {
      kind: 'copy',
      segments,
      seamSeconds: s.segmentSeconds,
      videoKbps,
      cappedBySource: false,
      reason: copy.reason,
    }
  }

  // Did the source bitrate bind, or the size budget? Only meaningful in size mode.
  const uncapped =
    s.encodingMode === 'size'
      ? bitrateForTarget(s.targetSizeMB, encodeDuration(s), audioKbps(s, meta))
      : videoKbps
  const cappedBySource = s.encodingMode === 'size' && videoKbps < uncapped

  return {
    kind: 'encode',
    segments,
    seamSeconds: s.segmentSeconds,
    videoKbps,
    cappedBySource,
    reason: cappedBySource
      ? `Dibatasi bitrate sumber (${Math.round(videoKbps)} kbps) - encode di atas itu cuma memperbesar file.`
      : copy.reason,
  }
}
