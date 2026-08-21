import { useCallback, useRef, useState } from 'react'
import { IconPhoneVideo } from './icons'

export const ACCEPTED = ['mp4', 'mov', 'mkv', 'webm', 'avi', '3gp', 'm4v']
const ACCEPT_ATTR = ACCEPTED.map((e) => `.${e}`).join(',') + ',video/*'

export function isAccepted(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ACCEPTED.includes(ext) || file.type.startsWith('video/')
}

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

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div
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
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-16 text-center transition ${
          over ? 'border-wa-green bg-wa-green/5' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500'
        }`}
      >
        <IconPhoneVideo className="mx-auto h-10 w-10 text-slate-500" />
        <p className="mt-4 text-lg font-semibold text-white">Tarik video ke sini</p>
        <p className="mt-1 text-sm text-slate-400">
          atau klik untuk memilih file — {ACCEPTED.join(', ')}
        </p>
        <button
          type="button"
          className="mt-6 rounded-lg bg-wa-green px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
        >
          Pilih Video
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => take(e.target.files)}
        />
      </div>
      {error ? <p className="mt-3 text-center text-sm text-red-400">{error}</p> : null}
      <p className="mt-6 text-center text-xs text-slate-500">
        Semua proses berjalan di browser kamu — video tidak pernah diunggah ke server.
      </p>
    </div>
  )
}
