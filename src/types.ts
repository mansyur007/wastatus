export type ResolutionKey = '1080x1920' | '720x1280' | '540x960' | 'source'
export type AspectMode = 'crop' | 'pad' | 'blur'
export type EncodingMode = 'size' | 'crf'
export type FpsMode = 'source' | '30' | '24'
export type AudioBitrate = 64 | 96 | 128 | 192
export type MaxDuration = 30 | 60 | 90
/** Length of one auto-split part. WhatsApp raised the Status cap to 60 s on
 *  newer builds, so the seam is configurable rather than pinned to 30. */
export type SegmentSeconds = 30 | 60
/** x264 speed/compression trade. Slower = smaller file at the same quality. */
export type X264Preset = 'veryfast' | 'faster' | 'medium'

export interface Settings {
  resolution: ResolutionKey
  aspectMode: AspectMode
  /** 0 = left/top, 0.5 = center, 1 = right/bottom. Crop mode only. */
  cropX: number
  cropY: number
  trimStart: number
  trimEnd: number
  /** Caps the clip in single-file mode. Ignored while autoSplit is on. */
  maxDuration: MaxDuration
  /** Cut anything over segmentSeconds into consecutive Status-sized parts. */
  autoSplit: boolean
  segmentSeconds: SegmentSeconds
  encodingMode: EncodingMode
  targetSizeMB: number
  crf: number
  /** kbps. Derived in target-size mode, editable in CRF/manual mode. */
  videoBitrate: number
  audioBitrate: AudioBitrate
  audioChannels: 1 | 2
  fpsMode: FpsMode
  x264Preset: X264Preset
  faststart: boolean
}

/**
 * The parts of a source that the pure argument/bitrate math actually reads.
 * Splitting this out lets the exact same code run in the browser and in the
 * Electron main process, where there is no File object to carry around.
 */
export interface MediaInfo {
  width: number
  height: number
  fps?: number
  hasAudio?: boolean
}

export interface SourceMeta extends MediaInfo {
  file: File
  url: string
  name: string
  size: number
  duration: number
  codec?: string
}

/** One slice of the trim window, in absolute source seconds. */
export interface Segment {
  /** 0-based. */
  index: number
  start: number
  duration: number
}

/** One rendered file. A split export returns several of these, in order. */
export interface ConversionResult {
  blob: Blob
  url: string
  size: number
  filename: string
  attempts: number
  videoBitrate: number
  /** 1-based position, and how many parts the export produced. */
  part: number
  totalParts: number
  /** Where this part sits in the source, for the "0:30 - 1:00" label. */
  start: number
  duration: number
}

export type Stage =
  | { kind: 'idle' }
  | { kind: 'loading-engine' }
  | { kind: 'probing' }
  | { kind: 'converting'; progress: number; label: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
