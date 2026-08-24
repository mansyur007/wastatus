import type { MediaInfo, Segment, Settings, X264Preset } from '../types'
import { outputFps, targetDimensions } from './presets'
import { audioKbps, clipDuration } from './bitrate'

/**
 * The x264 preset trades encode time for compression efficiency. It matters far
 * less than it looks: benchmarking a 1080p source showed decode alone accounts
 * for essentially all of the wall clock, so 'veryfast' and 'medium' land within
 * noise of each other. The knob stays because it does still move the file size,
 * which is the thing actually under a 15 MB budget.
 */
export const X264_PRESETS: { value: X264Preset; label: string; hint: string }[] = [
  { value: 'veryfast', label: 'Cepat', hint: 'file paling boros' },
  { value: 'faster', label: 'Seimbang', hint: 'default - hasil lebih rapi' },
  { value: 'medium', label: 'Kualitas', hint: 'paling efisien, sedikit lebih lama' },
]

export interface ArgOptions {
  input: string
  /** A filename, or a printf pattern like 'part%03d.mp4' when seamSeconds is set. */
  output: string
  settings: Settings
  meta: MediaInfo
  /** kbps. Fed to -maxrate as the ceiling the part must not exceed. */
  videoBitrate: number
  /** Slice to encode. Defaults to the whole trim window. */
  segment?: Segment
  /**
   * Cut the run into parts of this many seconds using the segment muxer. One
   * ffmpeg invocation then produces every part from a single decode pass,
   * instead of one invocation - and one decode - per part.
   */
  seamSeconds?: number
  /**
   * Where the segment muxer writes its manifest. Relative to the ffmpeg process
   * cwd, so the desktop build has to point it at its own temp directory.
   */
  segmentList?: string
}

interface Filter {
  complex: boolean
  chain: string
}

/** 9:16 framing: crop-to-fill, black bars, or blurred self-background. */
export function buildFilter(s: Settings, meta?: MediaInfo): Filter {
  const { width: W, height: H } = targetDimensions(s.resolution, meta)
  const fps = s.fpsMode === 'source' ? null : outputFps(s.fpsMode, meta?.fps)
  const pre = fps ? `fps=${fps},` : ''

  if (s.aspectMode === 'crop') {
    const x = clamp01(s.cropX).toFixed(3)
    const y = clamp01(s.cropY).toFixed(3)
    return {
      complex: false,
      chain:
        `${pre}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:(iw-ow)*${x}:(ih-oh)*${y},format=yuv420p`,
    }
  }

  if (s.aspectMode === 'pad') {
    return {
      complex: false,
      chain:
        `${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`,
    }
  }

  // Blurred background: one copy scaled to cover and blurred, the untouched
  // copy centred on top.
  const radius = Math.max(4, Math.round(W / 25))
  return {
    complex: true,
    chain:
      `[0:v]${pre}split=2[bg][fg];` +
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `boxblur=luma_radius=${radius}:luma_power=1:chroma_radius=${Math.round(radius / 2)}:chroma_power=1[bgb];` +
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,format=yuv420p[v]`,
  }
}

/** -ss/-i/-t. Input-side seek: fast, and accurate enough for a Status clip. */
function inputArgs(o: ArgOptions): string[] {
  const duration = o.segment ? o.segment.duration : clipDuration(o.settings)
  const start = o.segment ? o.segment.start : o.settings.trimStart
  const args: string[] = []
  if (start > 0) args.push('-ss', start.toFixed(3))
  args.push('-i', o.input, '-t', duration.toFixed(3))
  return args
}

/** Where the segment muxer writes its "filename,start,end" manifest. */
export const SEGMENT_LIST = 'segments.csv'

/**
 * Muxer flags that turn one output into a numbered series of parts.
 *
 * The CSV manifest matters: with `-c copy` the cuts land on the source's own
 * keyframes, so the real part boundaries drift from the nominal seam. Reading
 * them back beats guessing, and costs nothing.
 */
function segmentMuxerArgs(seam: number, list: string): string[] {
  return [
    '-f', 'segment',
    '-segment_time', String(seam),
    // Without a tolerance the muxer misses the keyframe it was handed: the
    // frame forced at exactly t=seam rounds a hair below seam in the muxer
    // timebase, fails the >= test, and the cut slips a whole GOP late (a
    // 30 s part came out 32 s). 0.1 s is far under the 2 s GOP, so it can
    // only ever match the keyframe that was forced for this seam.
    '-segment_time_delta', '0.1',
    '-reset_timestamps', '1',
    '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+faststart',
    '-segment_list', list,
    '-segment_list_type', 'csv',
  ]
}

export function buildArgs(o: ArgOptions): string[] {
  const { settings: s, meta, output, videoBitrate, seamSeconds } = o
  const filter = buildFilter(s, meta)
  const fps = outputFps(s.fpsMode, meta.fps)
  const args: string[] = inputArgs(o)

  if (filter.complex) {
    args.push('-filter_complex', filter.chain, '-map', '[v]')
  } else {
    args.push('-vf', filter.chain, '-map', '0:v:0')
  }

  const withAudio = meta.hasAudio !== false
  if (withAudio) args.push('-map', '0:a:0?')

  args.push(
    '-c:v', 'libx264',
    '-preset', s.x264Preset,
    '-profile:v', 'high',
    '-level', '4.0',
    '-pix_fmt', 'yuv420p',
    '-g', String(Math.max(2, Math.round(fps * 2))),
  )

  if (s.encodingMode === 'size') {
    // Capped CRF, not two-pass ABR. Two-pass bought an exact landing on the
    // budget by decoding the whole source a second time, and benchmarking
    // showed decode to be essentially all of the wall clock. Capped CRF keeps
    // the guarantee that actually matters - never exceed the budget - in a
    // single pass, and simply comes in under it when the content is cheap.
    args.push(
      '-crf', String(s.crf),
      '-maxrate', `${videoBitrate}k`,
      '-bufsize', `${Math.round(videoBitrate * 2)}k`,
    )
  } else {
    args.push('-crf', String(s.crf))
    if (s.videoBitrate > 0) {
      args.push('-maxrate', `${s.videoBitrate}k`, '-bufsize', `${Math.round(s.videoBitrate * 2)}k`)
    }
  }

  if (seamSeconds) {
    // Every part must open on an IDR frame: the segment muxer can only cut on
    // a keyframe, and a part starting mid-GOP would not decode on its own.
    args.push('-force_key_frames', `expr:gte(t,n_forced*${seamSeconds})`)
  }

  if (withAudio) {
    args.push(
      '-c:a', 'aac',
      '-b:a', `${audioKbps(s, meta)}k`,
      '-ac', String(s.audioChannels),
      '-ar', '44100',
    )
  } else {
    args.push('-an')
  }

  args.push('-sn', '-dn', '-map_metadata', '-1')
  if (seamSeconds) {
    args.push(...segmentMuxerArgs(seamSeconds, o.segmentList ?? SEGMENT_LIST))
  } else if (s.faststart) {
    args.push('-movflags', '+faststart')
  }
  args.push('-y', output)
  return args
}

/**
 * The no-re-encode route: remux the selected window straight through. Cuts land
 * on the source's own keyframes, so a seam can sit up to one GOP past the
 * nominal mark - the trade for finishing in milliseconds instead of hours.
 */
export function buildCopyArgs(o: ArgOptions): string[] {
  const args: string[] = inputArgs(o)
  args.push('-map', '0:v:0')
  if (o.meta.hasAudio !== false) args.push('-map', '0:a:0?')
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-sn', '-dn', '-map_metadata', '-1')
  if (o.seamSeconds) {
    args.push(...segmentMuxerArgs(o.seamSeconds, o.segmentList ?? SEGMENT_LIST))
  } else if (o.settings.faststart) {
    args.push('-movflags', '+faststart')
  }
  args.push('-y', o.output)
  return args
}

/** Human-readable command for the "FFmpeg command" disclosure in the panel. */
export function previewCommand(o: ArgOptions, kind: 'copy' | 'encode' = 'encode'): string {
  const quote = (a: string) => (/[\s[\];]/.test(a) ? `"${a}"` : a)
  const args = kind === 'copy' ? buildCopyArgs(o) : buildArgs(o)
  return `ffmpeg ${args.map(quote).join(' ')}`
}

export function outputFilename(
  name: string,
  s: Settings,
  meta?: MediaInfo,
  part?: { index: number; total: number },
): string {
  const { width, height } = targetDimensions(s.resolution, meta)
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').slice(0, 40)
  // Zero-padded so the parts sort in order in any file manager.
  const suffix =
    part && part.total > 1
      ? `_bagian${String(part.index + 1).padStart(String(part.total).length, '0')}-dari-${part.total}`
      : ''
  return `wa-status_${base}_${width}x${height}${suffix}.mp4`
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
