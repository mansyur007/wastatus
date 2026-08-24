import type { MediaInfo, Segment, Settings, SourceMeta } from '../types'
import { outputFps, targetDimensions } from './presets'

/** Container/muxer overhead margin so the 2-pass result lands under target. */
const OVERHEAD = 0.97
const MIN_VIDEO_KBPS = 150
/** A trailing sliver shorter than this is dropped instead of becoming a Status. */
const MIN_TAIL_SECONDS = 0.25

/** Length of the whole trim window. autoSplit lifts the single-file cap. */
export function clipDuration(s: Settings): number {
  const selected = s.trimEnd - s.trimStart
  return Math.max(0.1, s.autoSplit ? selected : Math.min(selected, s.maxDuration))
}

/**
 * The trim window cut into Status-sized pieces. WhatsApp chops anything past
 * its Status cap at its own boundaries, so cutting here means the user controls
 * where the seams land - and each piece gets its own size budget.
 */
export function segmentPlan(s: Settings): Segment[] {
  const total = clipDuration(s)
  const seam = s.segmentSeconds
  if (!s.autoSplit || total <= seam) {
    return [{ index: 0, start: s.trimStart, duration: total }]
  }
  const segments: Segment[] = []
  for (let offset = 0; offset < total - MIN_TAIL_SECONDS; offset += seam) {
    segments.push({
      index: segments.length,
      start: s.trimStart + offset,
      duration: Math.min(seam, total - offset),
    })
  }
  return segments.length ? segments : [{ index: 0, start: s.trimStart, duration: total }]
}

export function partCount(s: Settings): number {
  return segmentPlan(s).length
}

/**
 * Length of the longest part. Every part is encoded at the one bitrate derived
 * from this, so quality stays even across parts and a short tail simply comes
 * out smaller rather than being handed an absurd bitrate to fill its target.
 */
export function encodeDuration(s: Settings): number {
  return segmentPlan(s).reduce((max, seg) => Math.max(max, seg.duration), 0.1)
}

/**
 * Target size (MiB) -> video bitrate in kbps, audio track already subtracted.
 *
 * `ceilingKbps` is the source's own video bitrate. Without it a 90 MB / 56 min
 * source (~225 kbps) gets handed the full 3940 kbps a 15 MB / 30 s budget
 * allows and the export inflates to ~1.6 GB - spending hours to make the file
 * eighteen times larger. Re-encoding above the source rate cannot recover
 * detail that was never there, so the budget is only ever an upper bound.
 */
export function bitrateForTarget(
  targetMB: number,
  durationSec: number,
  audioKbps: number,
  ceilingKbps?: number,
): number {
  const totalKbits = (targetMB * 1024 * 1024 * 8) / 1000
  const budget = Math.floor((totalKbits * OVERHEAD) / durationSec - audioKbps)
  const capped = ceilingKbps && ceilingKbps > 0 ? Math.min(budget, Math.round(ceilingKbps)) : budget
  return Math.max(MIN_VIDEO_KBPS, capped)
}

/**
 * The source video bitrate in kbps. ffprobe reports it per stream on most MP4s;
 * when it does not, the container average (size over duration, minus whatever
 * the audio track costs) is close enough for a ceiling.
 */
export function sourceVideoKbps(meta?: Partial<SourceMeta>): number | undefined {
  if (!meta) return undefined
  if (meta.videoKbps && meta.videoKbps > 0) return meta.videoKbps
  if (!meta.size || !meta.duration || meta.duration <= 0) return undefined
  const totalKbps = (meta.size * 8) / 1000 / meta.duration
  // Audio codec is unknown here; 128 kbps is the common case and erring high
  // only makes the ceiling slightly stricter.
  const video = totalKbps - (meta.hasAudio === false ? 0 : 128)
  return video > 0 ? Math.round(video) : undefined
}

/** Fills in videoKbps from the container average when ffprobe did not report it. */
export function withDerivedBitrate(meta: SourceMeta): SourceMeta {
  if (meta.videoKbps && meta.videoKbps > 0) return meta
  const derived = sourceVideoKbps(meta)
  return derived ? { ...meta, videoKbps: derived } : meta
}

/**
 * Rough size prediction for CRF mode. CRF is quality-targeted so the real size
 * is content dependent; this is a bits-per-pixel heuristic, shown as "~".
 */
export function estimateCrfBitrate(s: Settings, meta?: MediaInfo): number {
  const { width, height } = targetDimensions(s.resolution, meta)
  const fps = outputFps(s.fpsMode, meta?.fps)
  const bpp = 0.00008 * Math.pow(2, (23 - s.crf) / 6)
  return Math.max(MIN_VIDEO_KBPS, Math.round((width * height * fps * bpp) / 1000))
}

/** Effective video bitrate for the current panel state, in kbps. */
export function effectiveVideoBitrate(s: Settings, meta?: MediaInfo): number {
  if (s.encodingMode === 'size') {
    // Per part, not per clip: each part is its own upload with its own budget.
    return bitrateForTarget(s.targetSizeMB, encodeDuration(s), audioKbps(s, meta), meta?.videoKbps)
  }
  // In CRF mode the bitrate field acts as a max-rate cap, so it bounds the estimate.
  const heuristic = estimateCrfBitrate(s, meta)
  const capped = meta?.videoKbps ? Math.min(heuristic, meta.videoKbps) : heuristic
  return s.videoBitrate > 0 ? Math.min(capped, s.videoBitrate) : capped
}

export function audioKbps(s: Settings, meta?: MediaInfo): number {
  if (meta && meta.hasAudio === false) return 0
  return s.audioChannels === 1 ? Math.round(s.audioBitrate / 2) : s.audioBitrate
}

/** Live estimate in bytes for a single part: (video + audio) x part duration. */
export function estimateSizeBytes(s: Settings, meta?: MediaInfo): number {
  const kbps = effectiveVideoBitrate(s, meta) + audioKbps(s, meta)
  return Math.round((kbps * 1000 * encodeDuration(s)) / 8)
}
