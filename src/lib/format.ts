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
