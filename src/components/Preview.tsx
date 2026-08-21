import { useEffect, useRef } from 'react'
import type { Settings, SourceMeta } from '../types'
import { SAFE_ZONE, targetDimensions } from '../lib/presets'

const TOP_PCT = (SAFE_ZONE.top / 1920) * 100
const BOTTOM_PCT = (SAFE_ZONE.bottom / 1920) * 100

/**
 * WYSIWYG 9:16 preview: CSS object-fit mirrors the ffmpeg framing filters, so
 * what the user frames here is what the crop/pad/blur filter produces.
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
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-slate-700">
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

      {showSafeZone ? (
        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute inset-x-0 top-0 border-b border-dashed border-amber-400/70 bg-amber-400/10"
            style={{ height: `${TOP_PCT}%` }}
          >
            <span className="absolute bottom-1 left-2 text-[10px] font-medium text-amber-200">
              nama pengirim · {zonePx(SAFE_ZONE.top)}px
            </span>
          </div>
          <div
            className="absolute inset-x-0 bottom-0 border-t border-dashed border-amber-400/70 bg-amber-400/10"
            style={{ height: `${BOTTOM_PCT}%` }}
          >
            <span className="absolute left-2 top-1 text-[10px] font-medium text-amber-200">
              bar balasan · {zonePx(SAFE_ZONE.bottom)}px
            </span>
          </div>
          <div
            className="absolute inset-x-0 border border-emerald-400/40"
            style={{ top: `${TOP_PCT}%`, bottom: `${BOTTOM_PCT}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
