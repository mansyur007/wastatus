import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversionResult, Settings, SourceMeta, Stage } from './types'
import { Dropzone, isAccepted } from './components/Dropzone'
import { Preview } from './components/Preview'
import { Panel } from './components/Panel'
import { ProgressBar, ResultCard, SourceInfo } from './components/Result'
import { Toggle } from './components/ui'
import { IconAlert, IconBolt, IconLock, IconPhoneVideo, IconSparkle } from './components/icons'
import { defaultSettings } from './lib/presets'
import {
  convert,
  describeEngine,
  isNative,
  prepareEngine,
  probeExtra,
  probeWithVideoElement,
  setNativeExitGuard,
} from './lib/engine'
import type { EngineDescription } from './lib/engine'
import { formatBytes, formatDuration } from './lib/format'
import {
  clipDuration,
  encodeDuration,
  partCount,
  withDerivedBitrate,
} from './lib/bitrate'
import { buildPlan, estimatePartBytes } from './lib/plan'

/** Above this many parts the run is long enough to warn about up front. */
const MANY_PARTS = 20

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
  useEffect(
    () => () => {
      if (meta) URL.revokeObjectURL(meta.url)
    },
    [meta],
  )
  useEffect(
    () => () => {
      results.forEach((r) => URL.revokeObjectURL(r.url))
    },
    [results],
  )

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
      const withBitrate = withDerivedBitrate(base)
      setMeta(withBitrate)
      setSettings(normalize(defaultSettings(withBitrate), withBitrate))

      // ffprobe needs the wasm core; fps/codec arrive a moment later.
      setStage({ kind: 'loading-engine' })
      await prepareEngine()
      setStage({ kind: 'probing' })
      const extra = await probeExtra(file)
      const merged = withDerivedBitrate({ ...base, ...extra } as SourceMeta)
      setMeta(merged)
      if (!dirtyRef.current) setSettings(normalize(defaultSettings(merged), merged))
      // The wasm engine only learns whether it got threads once the core is up.
      describeEngine().then(setEngine)
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
        onProgress: (progress, label, etaSeconds) =>
          setStage({ kind: 'converting', progress, label, etaSeconds }),
      })
      setResults(out)
      setStage({ kind: 'done' })
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : 'Konversi gagal.' })
    }
  }, [meta, settings])

  const busy =
    stage.kind === 'converting' || stage.kind === 'loading-engine' || stage.kind === 'probing'

  /**
   * Everything lives in memory: a refresh or a closed tab throws away the
   * decoded source, the settings, and any finished part that has not been
   * downloaded yet. Guard the exit from the moment a video is loaded.
   */
  const guardExit = meta !== null || busy
  useEffect(() => {
    if (!guardExit) return
    // Electron never shows Chromium's beforeunload dialog - it would just
    // cancel the close - so the desktop build confirms in the main process.
    if (isNative) {
      setNativeExitGuard(true)
      return () => setNativeExitGuard(false)
    }
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Legacy channel: older engines need returnValue set to show the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [guardExit])
  const parts = settings ? partCount(settings) : 1
  const plan = settings && meta ? buildPlan(settings, meta) : null
  // A stream copy keeps the source bytes, so its size follows the source, not
  // the bitrate the encoder would have picked.
  const perPart = settings && plan ? estimatePartBytes(plan, settings, meta ?? undefined) : 0
  const native = engine?.kind === 'native'

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-wa-green to-wa-teal text-ink-950 shadow-accent">
            <IconPhoneVideo className="h-[18px] w-[18px]" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-white">
              WA Status Converter
            </h1>
            <p className="hidden truncate text-[11px] text-mist-400 sm:block">
              9:16 · di bawah 16 MB · tanpa upload ke server
            </p>
          </div>

          {engine ? (
            <span
              title={engine.detail}
              className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex ${
                native
                  ? 'border-wa-green/30 bg-wa-green/10 text-[#7bebab]'
                  : 'border-white/[0.08] bg-white/[0.03] text-mist-400'
              }`}
            >
              {native ? (
                <IconBolt className="h-3 w-3" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-mist-500" />
              )}
              {engine.label}
            </span>
          ) : null}

          {meta ? (
            <button
              type="button"
              onClick={startOver}
              disabled={busy}
              className="btn-ghost px-3 py-1.5 text-[11px]"
            >
              Video baru
            </button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {!meta || !settings ? (
          <Dropzone onFile={onFile} error={uploadError} />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_384px]">
            <div className="space-y-4 animate-rise lg:sticky lg:top-[4.75rem]">
              <Preview meta={meta} settings={settings} showSafeZone={safeZone} />

              <div className="mx-auto max-w-[318px]">
                <Toggle
                  checked={safeZone}
                  onChange={setSafeZone}
                  label="Panduan safe zone"
                  hint="Area yang tertutup UI WhatsApp"
                />
              </div>

              <SourceInfo meta={meta} />

              {/* Action dock: the estimate and the trigger live together, so the
                  number the user is tuning is next to the button that spends it. */}
              <div className="slab space-y-3 p-4">
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="text-mist-400">
                    {parts > 1 ? `${parts} bagian · per bagian` : 'Perkiraan hasil'}
                  </span>
                  <span className="tnum font-medium text-mist-200">
                    {formatBytes(perPart)}
                    <span className="mx-1.5 text-mist-500">·</span>
                    {formatDuration(parts > 1 ? encodeDuration(settings) : clipDuration(settings))}
                  </span>
                </div>

                {parts > 1 ? (
                  <div className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="text-mist-400">Total semua bagian</span>
                    <span className="tnum font-medium text-mist-200">
                      {formatBytes(perPart * parts)}
                    </span>
                  </div>
                ) : null}

                {/* A long source turns into a lot of parts and a long run. Saying
                    so before the click beats a progress bar that never moves. */}
                {parts > MANY_PARTS && plan?.kind !== 'copy' ? (
                  <p className="flex gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
                    <IconAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      {formatDuration(clipDuration(settings))} jadi {parts} bagian, dan semuanya
                      di-encode di perangkat ini. Ini bisa makan waktu lama — biarkan tab tetap
                      terbuka sampai selesai.
                    </span>
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={run}
                  disabled={busy}
                  className="btn-primary w-full px-4 py-3.5 text-[15px]"
                >
                  {busy ? (
                    'Memproses…'
                  ) : (
                    <>
                      <IconSparkle className="h-4 w-4" />
                      Convert ke WA Status{parts > 1 ? ` · ${parts} bagian` : ''}
                    </>
                  )}
                </button>

                <ProgressBar stage={stage} />

                {stage.kind === 'error' ? (
                  <p className="flex gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-red-300">
                    <IconAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>{stage.message}</span>
                  </p>
                ) : null}

                <p className="flex items-center justify-center gap-1.5 text-[10px] text-mist-500">
                  <IconLock className="h-3 w-3" />
                  Diproses di perangkat kamu
                </p>
              </div>
            </div>

            <Panel
              meta={meta}
              settings={settings}
              onChange={patch}
              onReset={reset}
              disabled={stage.kind === 'converting'}
            />

            {results.length ? (
              <div className="lg:col-span-2">
                <ResultCard results={results} onReset={startOver} />
              </div>
            ) : null}
          </div>
        )}
      </main>
    </div>
  )
}
