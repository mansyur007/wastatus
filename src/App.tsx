import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversionResult, Settings, SourceMeta, Stage } from './types'
import { Dropzone, isAccepted } from './components/Dropzone'
import { Preview } from './components/Preview'
import { Panel } from './components/Panel'
import { ProgressBar, ResultCard, SourceInfo } from './components/Result'
import { Toggle } from './components/ui'
import { defaultSettings } from './lib/presets'
import {
  convert,
  describeEngine,
  prepareEngine,
  probeExtra,
  probeWithVideoElement,
} from './lib/engine'
import type { EngineDescription } from './lib/engine'
import { formatBytes } from './lib/format'
import { clipDuration, estimateSizeBytes, partCount } from './lib/bitrate'

/** Keeps the trim window inside the source and under the duration cap. */
function normalize(s: Settings, meta: SourceMeta): Settings {
  const duration = Math.max(0.1, meta.duration)
  let trimStart = Math.min(Math.max(0, s.trimStart), duration - 0.1)
  let trimEnd = Math.min(Math.max(trimStart + 0.1, s.trimEnd), duration)
  // autoSplit lifts the cap: extra length becomes extra parts, not a truncation.
  if (!s.autoSplit && trimEnd - trimStart > s.maxDuration) trimEnd = trimStart + s.maxDuration
  return {
    ...s,
    trimStart,
    trimEnd,
    targetSizeMB: Math.min(16, Math.max(1, s.targetSizeMB || 1)),
    crf: Math.min(30, Math.max(18, s.crf)),
    videoBitrate: Math.max(0, Math.round(s.videoBitrate || 0)),
  }
}

export default function App() {
  const [meta, setMeta] = useState<SourceMeta | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [results, setResults] = useState<ConversionResult[]>([])
  const [safeZone, setSafeZone] = useState(true)
  const [uploadError, setUploadError] = useState<string>()
  const [engine, setEngine] = useState<EngineDescription | null>(null)
  const dirtyRef = useRef(false)

  useEffect(() => {
    describeEngine().then(setEngine)
  }, [])

  // Release object URLs when the source or results are swapped out.
  useEffect(() => () => {
    if (meta) URL.revokeObjectURL(meta.url)
  }, [meta])
  useEffect(() => () => {
    results.forEach((r) => URL.revokeObjectURL(r.url))
  }, [results])

  const onFile = useCallback(async (file: File) => {
    setUploadError(undefined)
    if (!isAccepted(file)) {
      setUploadError('Format tidak didukung. Gunakan mp4, mov, mkv, webm, avi, 3gp, atau m4v.')
      return
    }
    setResults([])
    dirtyRef.current = false
    try {
      setStage({ kind: 'probing' })
      const basic = await probeWithVideoElement(file)
      const base: SourceMeta = {
        file,
        url: basic.url,
        name: file.name,
        size: file.size,
        duration: basic.duration,
        width: basic.width,
        height: basic.height,
      }
      setMeta(base)
      setSettings(normalize(defaultSettings(base), base))

      // ffprobe needs the wasm core; fps/codec arrive a moment later.
      setStage({ kind: 'loading-engine' })
      await prepareEngine()
      setStage({ kind: 'probing' })
      const extra = await probeExtra(file)
      const merged: SourceMeta = { ...base, ...extra }
      setMeta(merged)
      if (!dirtyRef.current) setSettings(normalize(defaultSettings(merged), merged))
      setStage({ kind: 'idle' })
    } catch (e) {
      setStage({ kind: 'idle' })
      setUploadError(e instanceof Error ? e.message : 'Gagal membaca video.')
    }
  }, [])

  const patch = useCallback(
    (p: Partial<Settings>) => {
      dirtyRef.current = true
      setSettings((prev) => (prev && meta ? normalize({ ...prev, ...p }, meta) : prev))
    },
    [meta],
  )

  const reset = useCallback(() => {
    if (!meta) return
    dirtyRef.current = false
    setSettings(normalize(defaultSettings(meta), meta))
  }, [meta])

  const startOver = useCallback(() => {
    setMeta(null)
    setSettings(null)
    setResults([])
    setStage({ kind: 'idle' })
  }, [])

  const run = useCallback(async () => {
    if (!meta || !settings) return
    setResults([])
    try {
      setStage({ kind: 'loading-engine' })
      await prepareEngine()
      setStage({ kind: 'converting', progress: 0, label: 'Menyiapkan' })
      const out = await convert(meta, settings, {
        onProgress: (progress, label) => setStage({ kind: 'converting', progress, label }),
      })
      setResults(out)
      setStage({ kind: 'done' })
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : 'Konversi gagal.' })
    }
  }, [meta, settings])

  const busy = stage.kind === 'converting' || stage.kind === 'loading-engine' || stage.kind === 'probing'
  const parts = settings ? partCount(settings) : 1

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold text-white">WA Status Converter</h1>
            <p className="text-xs text-slate-400">
              Video apa pun jadi 9:16, di bawah 16 MB, tanpa upload ke server.
            </p>
            {engine ? (
              <p
                className={`mt-1 text-[11px] ${
                  engine.kind === 'native' ? 'text-wa-green' : 'text-slate-500'
                }`}
                title={engine.detail}
              >
                Mesin: {engine.label}
                {engine.kind === 'native' ? ' (cepat)' : ''}
              </p>
            ) : null}
          </div>
          {meta ? (
            <button
              type="button"
              onClick={startOver}
              disabled={busy}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
            >
              Video baru
            </button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {!meta || !settings ? (
          <Dropzone onFile={onFile} error={uploadError} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <Preview meta={meta} settings={settings} showSafeZone={safeZone} />
              <div className="mx-auto max-w-[320px]">
                <Toggle checked={safeZone} onChange={setSafeZone} label="Tampilkan panduan safe zone" />
              </div>
              <SourceInfo meta={meta} />

              <button
                type="button"
                onClick={run}
                disabled={busy}
                className="w-full rounded-xl bg-wa-green px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Memproses...' : `Convert ke WA Status${parts > 1 ? ` (${parts} bagian)` : ''}`}
              </button>
              <p className="text-center text-xs text-slate-500">
                {parts > 1
                  ? `${parts} bagian x ~${formatBytes(estimateSizeBytes(settings, meta))} per bagian · total ${clipDuration(settings).toFixed(1)} detik`
                  : `Perkiraan hasil ${formatBytes(estimateSizeBytes(settings, meta))} · ${clipDuration(settings).toFixed(1)} detik`}
              </p>

              <ProgressBar stage={stage} />
              {stage.kind === 'error' ? (
                <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                  {stage.message}
                </p>
              ) : null}
              {results.length ? <ResultCard results={results} onReset={startOver} /> : null}
            </div>

            <Panel
              meta={meta}
              settings={settings}
              onChange={patch}
              onReset={reset}
              disabled={stage.kind === 'converting'}
            />
          </div>
        )}
      </main>
    </div>
  )
}
