import { useEffect, useRef } from 'react'
import type { Settings, SourceMeta } from '../types'
import { SAFE_ZONE, targetDimensions } from '../lib/presets'

const TOP_PCT = (SAFE_ZONE.top / 1920) * 100
const BOTTOM_PCT = (SAFE_ZONE.bottom / 1920) * 100

/**
 * WYSIWYG 9:16 preview: CSS object-fit mirrors the ffmpeg framing filters, so
 * what the user frames here is what the crop/pad/blur filter produces. The
 * device shell around it is decoration, but it is what makes the 9:16 crop
 * read as "a phone screen" instead of "a tall box".
 */
export function Preview({
  meta,
  settings,
  showSafeZone,
}: {
  meta: SourceMeta
  settings: Settings
  showSafeZone: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const bgRef = useRef<HTMLVideoElement>(null)
  const { trimStart, trimEnd, aspectMode, cropX, cropY } = settings

  // Keep playback inside the trim window.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.currentTime < trimStart || el.currentTime > trimEnd) el.currentTime = trimStart
    const onTime = () => {
      if (el.currentTime > trimEnd) el.currentTime = trimStart
      const bg = bgRef.current
      if (bg && Math.abs(bg.currentTime - el.currentTime) > 0.25) bg.currentTime = el.currentTime
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [trimStart, trimEnd])

  // Mirror play/pause onto the blurred backdrop copy.
  useEffect(() => {
    const el = videoRef.current
    const bg = bgRef.current
    if (!el || !bg) return
    const play = () => void bg.play().catch(() => {})
    const pause = () => bg.pause()
    el.addEventListener('play', play)
    el.addEventListener('pause', pause)
    return () => {
      el.removeEventListener('play', play)
      el.removeEventListener('pause', pause)
    }
  }, [aspectMode])

  const fit = aspectMode === 'crop' ? 'cover' : 'contain'
  // SAFE_ZONE is expressed in 1080x1920 space; scale it to the chosen output.
  const outH = targetDimensions(settings.resolution, meta).height
  const zonePx = (v: number) => Math.round((v / 1920) * outH)

  return (
    <div className="relative mx-auto w-full max-w-[318px]">
      {/* Coloured spill behind the device, so it sits in the page instead of on it. */}
      <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[3rem] bg-wa-teal/10 blur-3xl" />

      <div className="rounded-[2.1rem] border border-white/[0.1] bg-gradient-to-b from-ink-700/80 to-ink-900 p-[5px] shadow-[0_40px_70px_-30px_rgba(0,0,0,0.95),inset_0_1px_0_0_rgba(255,255,255,0.09)]">
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[1.75rem] bg-black">
          {aspectMode === 'blur' ? (
            <video
              ref={bgRef}
              src={meta.url}
              muted
              playsInline
              className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl"
            />
          ) : null}

          <video
            ref={videoRef}
            src={meta.url}
            controls
            playsInline
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: fit, objectPosition: `${cropX * 100}% ${cropY * 100}%` }}
          />

          <div
            className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ease-fluid ${
              showSafeZone ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <div
              className="absolute inset-x-0 top-0 border-b border-dashed border-amber-300/60 bg-gradient-to-b from-black/45 to-transparent"
              style={{ height: `${TOP_PCT}%` }}
            >
              <span className="absolute bottom-1.5 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-amber-200 backdrop-blur-sm">
                nama pengirim · {zonePx(SAFE_ZONE.top)}px
              </span>
            </div>
            <div
              className="absolute inset-x-0 bottom-0 border-t border-dashed border-amber-300/60 bg-gradient-to-t from-black/45 to-transparent"
              style={{ height: `${BOTTOM_PCT}%` }}
            >
              <span className="absolute left-2 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-amber-200 backdrop-blur-sm">
                bar balasan · {zonePx(SAFE_ZONE.bottom)}px
              </span>
            </div>
            {/* Corner brackets read as a framing guide; a full outline reads as a bug. */}
            <div
              className="absolute inset-x-3"
              style={{ top: `${TOP_PCT}%`, bottom: `${BOTTOM_PCT}%` }}
            >
              <span className="absolute left-0 top-0 h-4 w-4 rounded-tl-sm border-l border-t border-wa-green/70" />
              <span className="absolute right-0 top-0 h-4 w-4 rounded-tr-sm border-r border-t border-wa-green/70" />
              <span className="absolute bottom-0 left-0 h-4 w-4 rounded-bl-sm border-b border-l border-wa-green/70" />
              <span className="absolute bottom-0 right-0 h-4 w-4 rounded-br-sm border-b border-r border-wa-green/70" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
