export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function formatFps(fps?: number): string {
  return fps ? `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps` : '— fps'
}

/** Coarse on purpose: a countdown that ticks every second reads as precision the extrapolation does not have. */
export function formatEta(seconds?: number): string | null {
  if (seconds === undefined || !isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return `~${Math.max(5, Math.round(seconds / 5) * 5)} detik lagi`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes} menit lagi`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `~${hours} jam ${rest} menit lagi` : `~${hours} jam lagi`
}
