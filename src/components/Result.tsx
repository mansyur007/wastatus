import { useState } from 'react'
import type { ConversionResult, SourceMeta, Stage } from '../types'
import { Badge, Note } from './ui'
import { IconAlert, IconDownload, IconInfo, IconLayers, IconRefresh } from './icons'
import { saveAllNatively, saveNatively } from '../lib/engine'
import { WA_HARD_LIMIT_BYTES } from '../lib/presets'
import { createZip } from '../lib/zip'
import { formatBytes, formatDuration, formatEta, formatFps } from '../lib/format'

export function SourceInfo({ meta }: { meta: SourceMeta }) {
  const stats: [string, string][] = [
    ['Durasi', formatDuration(meta.duration)],
    ['Resolusi', `${meta.width}×${meta.height}`],
    ['FPS', formatFps(meta.fps)],
    ['Codec', meta.codec ?? '—'],
    ['Ukuran', formatBytes(meta.size)],
    ['Bitrate', meta.videoKbps ? `${meta.videoKbps} kbps` : '—'],
  ]
  return (
    <div className="slab overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-white/[0.05] px-4 py-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wa-green" />
        <span className="truncate text-xs font-medium text-mist-100" title={meta.name}>
          {meta.name}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-white/[0.05] sm:grid-cols-3">
        {stats.map(([k, v]) => (
          <div key={k} className="bg-ink-900/90 px-4 py-2.5">
            <dt className="text-[10px] uppercase tracking-[0.13em] text-mist-500">{k}</dt>
            <dd className="tnum truncate text-[13px] font-medium text-mist-100" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function ProgressBar({ stage }: { stage: Stage }) {
  if (stage.kind === 'loading-engine' || stage.kind === 'probing') {
    return (
      <div className="flex items-center gap-2.5 text-xs text-mist-300 animate-fade">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-wa-green/70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-wa-green" />
        </span>
        {stage.kind === 'loading-engine'
          ? 'Memuat mesin FFmpeg (~32 MB, sekali saja)…'
          : 'Membaca metadata video…'}
      </div>
    )
  }
  if (stage.kind !== 'converting') return null
  const pct = Math.round(stage.progress * 100)
  const eta = formatEta(stage.etaSeconds)
  return (
    <div className="space-y-2 animate-fade">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-mist-200">{stage.label}</span>
        <span className="tnum shrink-0 font-mono text-mist-400">{pct}%</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-800 shadow-dent">
        <div
          className="h-full rounded-full bg-gradient-to-r from-wa-teal to-wa-green transition-[width] duration-300 ease-fluid"
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-y-0 -left-1/4 w-1/4 animate-sweep bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      </div>
      {/* An honest ETA from measured throughput beats a bar that just crawls. */}
      {eta ? <p className="tnum text-[11px] text-mist-500">{eta}</p> : null}
    </div>
  )
}

/** Desktop opens a Save dialog; the browser falls back to an anchor download. */
async function triggerDownload(result: ConversionResult) {
  if (await saveNatively(result)) return
  downloadBlob(result.url, result.filename)
}

function downloadBlob(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * One part.
 *
 * The `<video>` is mounted on demand rather than up front: a hundred-part
 * export used to put a hundred media elements on the page at once, each holding
 * its own blob URL, which is enough to stall the tab on its own.
 */
function PartCard({ result, solo }: { result: ConversionResult; solo: boolean }) {
  const [playing, setPlaying] = useState(solo)
  const pass = result.size <= WA_HARD_LIMIT_BYTES
  const range = `${formatDuration(result.start)} – ${formatDuration(result.start + result.duration)}`

  return (
    <div
      className={
        solo
          ? 'space-y-3'
          : 'space-y-3 rounded-2xl border border-white/[0.06] bg-ink-950/50 p-3.5 transition-colors duration-200 hover:border-white/[0.12]'
      }
    >
      {solo ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white">
            Bagian {result.part}
            <span className="tnum ml-1.5 font-normal text-mist-400">{range}</span>
          </span>
          <Badge tone={pass ? 'pass' : 'over'}>{formatBytes(result.size)}</Badge>
        </div>
      )}

      {playing ? (
        <video
          src={result.url}
          controls
          autoPlay={!solo}
          playsInline
          preload="metadata"
          className={`mx-auto aspect-[9/16] w-full rounded-xl bg-black ring-1 ring-white/[0.08] ${
            solo ? 'max-w-[260px]' : 'max-w-[200px]'
          }`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="mx-auto flex aspect-[9/16] w-full max-w-[200px] items-center justify-center rounded-xl bg-black/60 ring-1 ring-white/[0.08] transition-colors duration-200 hover:bg-black/40 hover:ring-white/20"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full bg-white/10 backdrop-blur">
            <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-white/90">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          <span className="sr-only">Putar bagian {result.part}</span>
        </button>
      )}

      <p className="tnum text-center text-[11px] text-mist-500">
        {result.copied
          ? 'salinan langsung · tanpa encode ulang'
          : `${result.videoBitrate} kbps · ${result.duration.toFixed(1)} s`}
        {result.attempts > 1 ? ` · ${result.attempts - 1}× re-encode otomatis` : ''}
      </p>
      {pass ? null : (
        <Note tone="warn">Masih di atas 16 MB — turunkan target ukuran atau durasi.</Note>
      )}

      <button
        type="button"
        onClick={() => void triggerDownload(result)}
        className="btn-primary w-full px-4 py-2.5"
      >
        <IconDownload className="h-4 w-4" />
        Download{solo ? '' : ` bagian ${result.part}`}
      </button>
    </div>
  )
}

export function ResultCard({
  results,
  onReset,
}: {
  results: ConversionResult[]
  onReset: () => void
}) {
  const [zipping, setZipping] = useState(false)
  const [zipError, setZipError] = useState<string>()
  if (results.length === 0) return null
  const split = results.length > 1
  const totalSize = results.reduce((sum, r) => sum + r.size, 0)
  const allPass = results.every((r) => r.size <= WA_HARD_LIMIT_BYTES)

  const downloadAll = async () => {
    setZipError(undefined)
    // Desktop writes every part into one chosen folder in a single prompt.
    if (await saveAllNatively(results)) return
    setZipping(true)
    try {
      const zip = await createZip(results.map((r) => ({ name: r.filename, blob: r.blob })))
      const url = URL.createObjectURL(zip)
      downloadBlob(url, `wa-status_${results.length}-bagian.zip`)
      // Give the download a beat to start before the URL is reclaimed.
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      setZipError(e instanceof Error ? e.message : 'Gagal membuat ZIP.')
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="slab space-y-4 p-4 animate-rise sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-white">
          Hasil{split ? ` · ${results.length} bagian` : ''}
        </h2>
        <Badge tone={allPass ? 'pass' : 'over'}>
          {allPass ? 'Lolos' : 'Kelebihan'} · {formatBytes(split ? totalSize : results[0].size)}
          {split ? ' total' : ''}
        </Badge>
      </div>

      {split ? (
        <p className="flex gap-2 rounded-xl border border-wa-green/25 bg-wa-green/[0.07] px-3 py-2.5 text-[11px] leading-relaxed text-[#9fe9c2]">
          <IconLayers className="mt-px h-3.5 w-3.5 shrink-0 opacity-80" />
          <span>
            Video dipecah jadi {results.length} bagian. Upload berurutan dari bagian 1 supaya Status
            tampil sesuai urutan.
          </span>
        </p>
      ) : null}

      <div className={split ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3' : ''}>
        {results.map((r) => (
          <PartCard key={r.filename} result={r} solo={!split} />
        ))}
      </div>

      {zipError ? (
        <p className="flex gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-red-300">
          <IconAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{zipError}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {split ? (
          <button
            type="button"
            onClick={() => void downloadAll()}
            disabled={zipping}
            className="btn-primary flex-1 px-4 py-2.5"
          >
            <IconDownload className="h-4 w-4" />
            {zipping
              ? 'Mengemas ZIP…'
              : `Download semua (${results.length} file, satu ZIP)`}
          </button>
        ) : null}
        <button type="button" onClick={onReset} className="btn-ghost px-4 py-2.5">
          <IconRefresh className="h-4 w-4" />
          Konversi lagi
        </button>
      </div>

      <div className="well flex gap-2.5 p-3.5 text-[11px] leading-relaxed text-mist-400">
        <IconInfo className="mt-px h-4 w-4 shrink-0 text-mist-500" />
        <p>
          <strong className="text-mist-100">Wajib untuk kualitas maksimal:</strong> tombol HD tidak
          tersedia untuk Status, jadi Status yang diposting langsung selalu lewat jalur kompresi
          standar. Kirim file ini dulu ke chat pribadi dengan tombol <strong>HD</strong>, baru
          teruskan (forward) ke &ldquo;Status Saya&rdquo; — forward memakai ulang file yang sudah
          diunggah, tanpa encode ulang.
        </p>
      </div>
    </div>
  )
}
