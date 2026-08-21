import type { ConversionResult, SourceMeta, Stage } from '../types'
import { Badge, Note } from './ui'
import { IconDownload, IconInfo, IconLayers, IconRefresh } from './icons'
import { saveAllNatively, saveNatively } from '../lib/engine'
import { WA_HARD_LIMIT_BYTES } from '../lib/presets'
import { formatBytes, formatDuration, formatFps } from '../lib/format'

export function SourceInfo({ meta }: { meta: SourceMeta }) {
  const stats: [string, string][] = [
    ['Durasi', formatDuration(meta.duration)],
    ['Resolusi', `${meta.width}×${meta.height}`],
    ['FPS', formatFps(meta.fps)],
    ['Codec', meta.codec ?? '—'],
    ['Ukuran', formatBytes(meta.size)],
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
  return (
    <div className="space-y-2 animate-fade">
      <div className="flex items-center justify-between text-xs">
        <span className="text-mist-200">{stage.label}</span>
        <span className="tnum font-mono text-mist-400">{pct}%</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-800 shadow-dent">
        <div
          className="h-full rounded-full bg-gradient-to-r from-wa-teal to-wa-green transition-[width] duration-300 ease-fluid"
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-y-0 -left-1/4 w-1/4 animate-sweep bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      </div>
    </div>
  )
}

/** Desktop opens a Save dialog; the browser falls back to an anchor download. */
async function triggerDownload(result: ConversionResult) {
  if (await saveNatively(result)) return
  const a = document.createElement('a')
  a.href = result.url
  a.download = result.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function PartCard({ result, solo }: { result: ConversionResult; solo: boolean }) {
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

      <video
        src={result.url}
        controls
        playsInline
        className={`mx-auto aspect-[9/16] w-full rounded-xl bg-black ring-1 ring-white/[0.08] ${
          solo ? 'max-w-[260px]' : 'max-w-[200px]'
        }`}
      />

      <p className="tnum text-center text-[11px] text-mist-500">
        {result.videoBitrate} kbps · {result.duration.toFixed(1)} s
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
  if (results.length === 0) return null
  const split = results.length > 1
  const totalSize = results.reduce((sum, r) => sum + r.size, 0)
  const allPass = results.every((r) => r.size <= WA_HARD_LIMIT_BYTES)

  const downloadAll = async () => {
    // Desktop writes every part into one chosen folder in a single prompt.
    if (await saveAllNatively(results)) return
    // Browsers throttle burst downloads; space them out so no part is dropped.
    for (const r of results) {
      await triggerDownload(r)
      await new Promise((resolve) => setTimeout(resolve, 400))
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

      <div className="flex flex-wrap gap-2">
        {split ? (
          <button
            type="button"
            onClick={() => void downloadAll()}
            className="btn-primary flex-1 px-4 py-2.5"
          >
            <IconDownload className="h-4 w-4" />
            Download semua ({results.length} file)
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
