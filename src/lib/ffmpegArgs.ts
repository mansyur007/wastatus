import type { MediaInfo, Segment, Settings, X264Preset } from '../types'
import { outputFps, targetDimensions } from './presets'
import { audioKbps, clipDuration } from './bitrate'

/**
 * ffmpeg.wasm is single-threaded, so the x264 preset trades encode time for
 * compression efficiency. A slower preset packs more quality into the same
 * bitrate, which matters because the size budget is fixed at 15 MB per part.
 */
export const X264_PRESETS: { value: X264Preset; label: string; hint: string }[] = [
  { value: 'veryfast', label: 'Cepat', hint: 'encode tercepat, file paling boros' },
  { value: 'faster', label: 'Seimbang', hint: 'default - sedikit lebih lama, hasil lebih rapi' },
  { value: 'medium', label: 'Kualitas', hint: 'paling efisien, encode ~2x lebih lama' },
]

export interface ArgOptions {
  input: string
  output: string
  settings: Settings
  meta: MediaInfo
  /** kbps, target-size mode only. */
  videoBitrate: number
  /** 1 = analysis pass (no audio, no output file), 2 = final encode. */
  pass?: 1 | 2
  /** Slice to encode. Defaults to the whole trim window. */
  segment?: Segment
  /** x264 stats file, unique per part so pass 1 never leaks across parts. */
  passlog?: string
  /** Sink for the pass-1 encode. emscripten has /dev/null; Windows has NUL. */
  nullPath?: string
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

export function buildArgs(o: ArgOptions): string[] {
  const { settings: s, meta, input, output, videoBitrate, pass, segment } = o
  const duration = segment ? segment.duration : clipDuration(s)
  const start = segment ? segment.start : s.trimStart
  const filter = buildFilter(s, meta)
  const fps = outputFps(s.fpsMode, meta.fps)
  const args: string[] = []

  // Input-side seek: fast, and accurate enough for a Status clip.
  if (start > 0) args.push('-ss', start.toFixed(3))
  args.push('-i', input, '-t', duration.toFixed(3))

  if (filter.complex) {
    args.push('-filter_complex', filter.chain, '-map', '[v]')
  } else {
    args.push('-vf', filter.chain, '-map', '0:v:0')
  }

  const withAudio = pass !== 1 && meta.hasAudio !== false
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
    args.push(
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.round(videoBitrate * 1.45)}k`,
      '-bufsize', `${Math.round(videoBitrate * 2)}k`,
      '-pass', String(pass ?? 2),
      '-passlogfile', o.passlog ?? 'wapass',
    )
  } else {
    args.push('-crf', String(s.crf))
    if (s.videoBitrate > 0) {
      args.push('-maxrate', `${s.videoBitrate}k`, '-bufsize', `${Math.round(s.videoBitrate * 2)}k`)
    }
  }

  if (pass === 1) {
    args.push('-an', '-sn', '-dn', '-f', 'null', o.nullPath ?? '/dev/null')
    return args
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
  if (s.faststart) args.push('-movflags', '+faststart')
  args.push('-y', output)
  return args
}

/** Human-readable command for the "FFmpeg command" disclosure in the panel. */
export function previewCommand(o: ArgOptions): string {
  const quote = (a: string) => (/[\s[\];]/.test(a) ? `"${a}"` : a)
  return `ffmpeg ${buildArgs(o).map(quote).join(' ')}`
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
