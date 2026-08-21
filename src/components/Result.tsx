import type { ConversionResult, SourceMeta, Stage } from '../types'
import { Badge } from './ui'
import { IconDownload, IconInfo, IconLayers, IconRefresh } from './icons'
import { saveAllNatively, saveNatively } from '../lib/engine'
import { WA_HARD_LIMIT_BYTES } from '../lib/presets'
import { formatBytes, formatDuration, formatFps } from '../lib/format'

export function SourceInfo({ meta }: { meta: SourceMeta }) {
  const rows: [string, string][] = [
    ['File', meta.name],
    ['Durasi', formatDuration(meta.duration)],
    ['Resolusi', `${meta.width}x${meta.height}`],
    ['FPS', formatFps(meta.fps)],
    ['Codec', meta.codec ?? '—'],
    ['Ukuran', formatBytes(meta.size)],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-400">{k}</dt>
          <dd className="truncate font-medium text-slate-100" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ProgressBar({ stage }: { stage: Stage }) {
  if (stage.kind === 'loading-engine' || stage.kind === 'probing') {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
        <span className="inline-block animate-pulse">
          {stage.kind === 'loading-engine' ? 'Memuat mesin FFmpeg (~32 MB, sekali saja)...' : 'Membaca metadata video...'}
        </span>
      </div>
    )
  }
  if (stage.kind !== 'converting') return null
  const pct = Math.round(stage.progress * 100)
  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-200">{stage.label}</span>
        <span className="font-mono text-slate-400">{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-wa-green transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
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
  const range = `${formatDuration(result.start)} - ${formatDuration(result.start + result.duration)}`

  return (
    <div className={solo ? 'space-y-3' : 'space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3'}>
      {solo ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-white">
            Bagian {result.part}
            <span className="ml-1.5 font-normal text-slate-400">{range}</span>
          </span>
          <Badge tone={pass ? 'pass' : 'over'}>{formatBytes(result.size)}</Badge>
        </div>
      )}

      <video
        src={result.url}
        controls
        playsInline
        className={`mx-auto aspect-[9/16] w-full rounded-xl bg-black ${solo ? 'max-w-[280px]' : 'max-w-[200px]'}`}
      />

      <p className="text-xs text-slate-500">
        {result.videoBitrate} kbps video · {result.duration.toFixed(1)} s
        {result.attempts > 1 ? ` · ${result.attempts - 1}x re-encode otomatis` : ''}
        {pass ? '' : ' · masih di atas 16 MB, turunkan target ukuran atau durasi'}
      </p>

      <button
        type="button"
        onClick={() => void triggerDownload(result)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
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
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-white">
          Hasil{split ? ` · ${results.length} bagian` : ''}
        </h2>
        <Badge tone={allPass ? 'pass' : 'over'}>
          {allPass ? 'PASS' : 'OVER'} · {formatBytes(split ? totalSize : results[0].size)}
          {split ? ' total' : ''}
        </Badge>
      </div>

      {split ? (
        <p className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          <IconLayers className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Video dipecah jadi {results.length} bagian. Upload berurutan dari bagian 1 supaya Status
            tampil sesuai urutan.
          </span>
        </p>
      ) : null}

      <div className={split ? 'grid gap-3 sm:grid-cols-2' : ''}>
        {results.map((r) => (
          <PartCard key={r.filename} result={r} solo={!split} />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {split ? (
          <button
            type="button"
            onClick={() => void downloadAll()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            <IconDownload className="h-4 w-4" />
            Download semua ({results.length} file)
          </button>
        ) : null}
        <button
          type="button"
          onClick={onReset}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:border-slate-500 hover:text-white"
        >
          <IconRefresh className="h-4 w-4" />
          Konversi lagi
        </button>
      </div>

      <div className="flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
        <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <p>
          <strong className="text-slate-200">Wajib untuk kualitas maksimal:</strong> tombol HD tidak
          tersedia untuk Status, jadi Status yang diposting langsung selalu lewat jalur kompresi standar.
          Kirim file ini dulu ke chat pribadi dengan tombol <strong>HD</strong>, baru teruskan (forward)
          ke &ldquo;Status Saya&rdquo; - forward memakai ulang file yang sudah diunggah, tanpa encode ulang.
        </p>
      </div>
    </div>
  )
}
