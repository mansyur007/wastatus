import type { MediaInfo, ResolutionKey, Settings, SourceMeta } from '../types'

/** WhatsApp Status hard ceiling for a single video (16 MiB). */
export const WA_HARD_LIMIT_BYTES = 16 * 1024 * 1024
/** Recommended target so the WA re-compression pass has headroom. */
export const WA_TARGET_MB = 15
/** Default seam for auto split. Older builds cap Status at 30 s; newer ones
 *  allow 60 s, so this is only the default - see Settings.segmentSeconds. */
export const WA_SEGMENT_SECONDS = 30

/**
 * WhatsApp never delivers video above 720p: the Standard path re-encodes to
 * 480p and even the HD path tops out at 720p. Encoding above that spends the
 * size budget on pixels WhatsApp throws away.
 */
export const WA_MAX_DELIVERED_HEIGHT = 1280

/** UI safe zone in 1080x1920 output pixels (sender name / reply bar). */
export const SAFE_ZONE = { top: 120, bottom: 200, contentWidth: 1080, contentHeight: 1600 }

export const RESOLUTIONS: { key: ResolutionKey; label: string; hint: string }[] = [
  { key: '720x1280', label: '720 x 1280', hint: 'Plafon WhatsApp - disarankan' },
  { key: '1080x1920', label: '1080 x 1920', hint: 'Di atas plafon, encode lebih lama' },
  { key: '540x960', label: '540 x 960', hint: 'Hemat kuota, encode paling cepat' },
  { key: 'source', label: 'Ikuti sumber', hint: 'Ikut ukuran video asli, maks 1080' },
]

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Output is always 9:16; 'source' just picks a smaller box for small sources. */
export function targetDimensions(res: ResolutionKey, meta?: MediaInfo) {
  switch (res) {
    case '1080x1920':
      return { width: 1080, height: 1920 }
    case '720x1280':
      return { width: 720, height: 1280 }
    case '540x960':
      return { width: 540, height: 960 }
    case 'source': {
      if (!meta) return { width: 1080, height: 1920 }
      const height = Math.min(1920, even(Math.max(meta.width, meta.height)))
      return { width: even(Math.min(1080, (height * 9) / 16)), height }
    }
  }
}

export function outputFps(fpsMode: Settings['fpsMode'], sourceFps?: number): number {
  const src = sourceFps && sourceFps > 0 ? sourceFps : 30
  if (fpsMode === 'source') return src
  const cap = fpsMode === '30' ? 30 : 24
  return Math.min(src, cap)
}

/**
 * The optimal WA Status preset, applied the moment a video is loaded.
 * FPS defaults to a 30 cap on 60 fps-class sources: halving the frame rate is
 * the cheapest size win before touching resolution or bitrate.
 *
 * The whole clip is selected by default: autoSplit turns anything past the
 * segment length into consecutive parts, so trimming to the first 30 s would
 * silently drop footage the user can now actually publish.
 *
 * Resolution defaults to 720x1280 because WhatsApp caps delivered video at
 * 720p. At the 15 MB budget those pixels also get ~2.3x more bits each than
 * 1080x1920 would, and encode ~2x faster.
 */
export function defaultSettings(meta: SourceMeta): Settings {
  const trimEnd = meta.duration
  return {
    resolution: '720x1280',
    aspectMode: 'crop',
    cropX: 0.5,
    cropY: 0.5,
    trimStart: 0,
    trimEnd,
    maxDuration: 30,
    autoSplit: true,
    segmentSeconds: WA_SEGMENT_SECONDS,
    encodingMode: 'size',
    targetSizeMB: WA_TARGET_MB,
    crf: 23,
    videoBitrate: 2500,
    audioBitrate: 128,
    audioChannels: 2,
    fpsMode: meta.fps && meta.fps > 31 ? '30' : 'source',
    x264Preset: 'faster',
    faststart: true,
  }
}
