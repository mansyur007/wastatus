import { useCallback, useRef, useState } from 'react'
import { IconAlert, IconBolt, IconFrame, IconLock, IconPhoneVideo } from './icons'

export const ACCEPTED = ['mp4', 'mov', 'mkv', 'webm', 'avi', '3gp', 'm4v']
const ACCEPT_ATTR = ACCEPTED.map((e) => `.${e}`).join(',') + ',video/*'

export function isAccepted(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ACCEPTED.includes(ext) || file.type.startsWith('video/')
}

const FACTS: { icon: typeof IconLock; label: string; value: string }[] = [
  { icon: IconLock, label: 'Privasi', value: 'Diproses di perangkat' },
  { icon: IconFrame, label: 'Rasio', value: '9:16 penuh layar' },
  { icon: IconBolt, label: 'Ukuran', value: 'Selalu di bawah 16 MB' },
]

export function Dropzone({ onFile, error }: { onFile: (f: File) => void; error?: string }) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const take = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file) onFile(file)
    },
    [onFile],
  )

  const open = () => inputRef.current?.click()

  return (
    <div className="mx-auto w-full max-w-3xl animate-rise">
      <div className="mb-9 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight text-white sm:text-[2.6rem] sm:leading-[1.1]">
          Video apa pun,
          <span className="bg-gradient-to-r from-wa-green to-[#7ff0b4] bg-clip-text text-transparent">
            {' '}
            siap jadi Status
          </span>
        </h2>
        <p className="mx-auto mt-3 max-w-md text-pretty text-sm leading-relaxed text-mist-300">
          Dipotong ke 9:16, ditekan di bawah batas WhatsApp, dan tidak pernah meninggalkan perangkat
          kamu.
        </p>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="Pilih atau tarik video ke sini"
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(e.dataTransfer.files)
        }}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            open()
          }
        }}
        className={`group relative cursor-pointer overflow-hidden rounded-4xl border bg-gradient-to-b from-ink-900/90 to-ink-950/60 px-6 py-14 text-center shadow-lift transition-all duration-300 ease-fluid sm:px-10 ${
          over
            ? 'border-wa-green/60 shadow-[0_0_0_6px_rgba(37,211,102,0.08),0_30px_60px_-28px_rgba(0,0,0,0.95)]'
            : 'border-white/[0.08] hover:border-white/[0.16]'
        }`}
      >
        {/* Light that follows the drag state, not a border colour swap. */}
        <div
          className={`pointer-events-none absolute -top-24 left-1/2 h-56 w-[36rem] -translate-x-1/2 rounded-[50%] bg-wa-green/20 blur-3xl transition-opacity duration-500 ease-fluid ${
            over ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
          }`}
        />

        <div className="relative mx-auto mb-7 h-24 w-[3.75rem] animate-drift">
          <div
            className={`absolute inset-0 rounded-[0.85rem] border bg-gradient-to-b from-ink-800 to-ink-950 shadow-[0_16px_30px_-14px_rgba(0,0,0,0.95)] transition-colors duration-300 ${
              over ? 'border-wa-green/70' : 'border-white/[0.14]'
            }`}
          >
            <span className="absolute left-1/2 top-1.5 h-1 w-5 -translate-x-1/2 rounded-full bg-white/15" />
            <IconPhoneVideo
              className={`absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 transition-colors duration-300 ${
                over ? 'text-wa-green' : 'text-mist-400 group-hover:text-mist-200'
              }`}
            />
            {/* Shimmer sweep across the screen glass. */}
            <span className="absolute inset-0 overflow-hidden rounded-[0.85rem]">
              <span className="absolute inset-y-0 -left-1/2 w-1/2 animate-sweep bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
            </span>
          </div>
          <span className="absolute -bottom-3 left-1/2 h-3 w-16 -translate-x-1/2 rounded-[50%] bg-black/60 blur-md" />
        </div>

        <p className="text-lg font-semibold tracking-tight text-white">
          {over ? 'Lepaskan di sini' : 'Tarik video ke sini'}
        </p>
        <p className="mt-1.5 text-sm text-mist-300">
          atau pilih dari perangkat
          <span className="mx-2 text-mist-500">·</span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-mist-400">
            {ACCEPTED.join(' ')}
          </span>
        </p>

        <span className="btn-primary mt-7 px-6 py-3">Pilih Video</span>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => take(e.target.files)}
        />
      </div>

      {error ? (
        <p className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 animate-rise">
          <IconAlert className="h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.05] sm:grid-cols-3">
        {FACTS.map(({ icon: Glyph, label, value }) => (
          <div key={label} className="flex items-center gap-3 bg-ink-950/80 px-4 py-3.5">
            <Glyph className="h-4 w-4 shrink-0 text-wa-green/80" />
            <span>
              <span className="block text-[10px] uppercase tracking-[0.14em] text-mist-500">
                {label}
              </span>
              <span className="block text-xs font-medium text-mist-200">{value}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
