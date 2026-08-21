import { useMemo, useState } from 'react'
import type {
  AudioBitrate,
  MaxDuration,
  SegmentSeconds,
  Settings,
  SourceMeta,
  X264Preset,
} from '../types'
import { Badge, DualRange, Field, RadioGroup, SegmentedControl, Select, Slider, Toggle } from './ui'
import {
  RESOLUTIONS,
  WA_HARD_LIMIT_BYTES,
  WA_MAX_DELIVERED_HEIGHT,
  WA_SEGMENT_SECONDS,
  targetDimensions,
} from '../lib/presets'
import {
  audioKbps,
  clipDuration,
  effectiveVideoBitrate,
  encodeDuration,
  estimateSizeBytes,
  partCount,
  segmentPlan,
} from '../lib/bitrate'
import { X264_PRESETS, previewCommand } from '../lib/ffmpegArgs'
import { formatBytes, formatDuration } from '../lib/format'

export function Panel({
  meta,
  settings,
  onChange,
  onReset,
  disabled,
}: {
  meta: SourceMeta
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  disabled?: boolean
}) {
  const [showCommand, setShowCommand] = useState(false)
  const s = settings
  const duration = clipDuration(s)
  const parts = partCount(s)
  // Everything downstream of the split is per part: budget, bitrate, estimate.
  const partDuration = encodeDuration(s)
  const estimate = estimateSizeBytes(s, meta)
  const videoKbps = effectiveVideoBitrate(s, meta)
  const dims = targetDimensions(s.resolution, meta)
  const overLimit = estimate > WA_HARD_LIMIT_BYTES

  const command = useMemo(
    () =>
      previewCommand({
        input: 'input.mp4',
        output: 'output.mp4',
        settings: s,
        meta,
        videoBitrate: videoKbps,
        pass: s.encodingMode === 'size' ? 2 : undefined,
        segment: segmentPlan(s)[0],
        passlog: 'wapass0',
      }),
    [s, meta, videoKbps],
  )

  return (
    <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Panel Penyesuaian</h2>
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-wa-green hover:text-white disabled:opacity-40"
        >
          Reset ke preset WA optimal
        </button>
      </div>

      <fieldset disabled={disabled} className="space-y-5 disabled:opacity-60">
        <Field label="Resolusi" hint={`${dims.width}x${dims.height}`}>
          <Select
            value={s.resolution}
            options={RESOLUTIONS.map((r) => ({ value: r.key, label: r.label }))}
            onChange={(resolution) => onChange({ resolution })}
          />
          {dims.height > WA_MAX_DELIVERED_HEIGHT ? (
            <p className="text-xs text-amber-300">
              WhatsApp mengirim video maksimal 720p - jalur Status bahkan lebih rendah. Piksel di atas itu
              tidak sampai ke penonton, cuma memecah budget bitrate dan memperlama encode.
            </p>
          ) : null}
        </Field>

        <Field label="Mode aspek (9:16)">
          <RadioGroup
            value={s.aspectMode}
            onChange={(aspectMode) => onChange({ aspectMode })}
            options={[
              { value: 'crop', label: 'Crop to fill', hint: 'Penuhi frame, sisi terpotong' },
              { value: 'pad', label: 'Black bars', hint: 'Muat utuh, sisa jadi bar hitam' },
              { value: 'blur', label: 'Blurred background', hint: 'Muat utuh, latar blur dari video' },
            ]}
          />
        </Field>

        {s.aspectMode === 'crop' ? (
          <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 sm:grid-cols-2">
            <Field label="Posisi crop X" hint={`${Math.round(s.cropX * 100)}%`}>
              <Slider min={0} max={1} step={0.01} value={s.cropX} onChange={(cropX) => onChange({ cropX })} />
            </Field>
            <Field label="Posisi crop Y" hint={`${Math.round(s.cropY * 100)}%`}>
              <Slider min={0} max={1} step={0.01} value={s.cropY} onChange={(cropY) => onChange({ cropY })} />
            </Field>
          </div>
        ) : null}

        <Field
          label="Trim"
          hint={`${formatDuration(s.trimStart)} - ${formatDuration(s.trimEnd)} | ${duration.toFixed(1)} s`}
        >
          <DualRange
            min={0}
            max={Math.max(0.1, meta.duration)}
            step={0.1}
            start={s.trimStart}
            end={s.trimEnd}
            onChange={(trimStart, trimEnd) => onChange({ trimStart, trimEnd })}
          />
        </Field>

        <Field label="Auto split" hint={parts > 1 ? parts + ' bagian' : 'tidak perlu'}>
          <Toggle
            checked={s.autoSplit}
            onChange={(autoSplit) => onChange({ autoSplit })}
            label={'Pecah otomatis tiap ' + s.segmentSeconds + ' detik'}
          />
          {s.autoSplit ? (
            <>
              <SegmentedControl<SegmentSeconds>
                value={s.segmentSeconds}
                options={[
                  { value: 30, label: '30 s / bagian' },
                  { value: 60, label: '60 s / bagian' },
                ]}
                onChange={(segmentSeconds) => onChange({ segmentSeconds })}
              />
              {s.segmentSeconds === 60 ? (
                <p className="text-xs text-amber-300">
                  Batas 60 detik hanya ada di WhatsApp versi baru. Kalau Status-mu masih terpotong di 30
                  detik, kembalikan ke 30 s.
                </p>
              ) : null}
              {parts > 1 ? (
                <p className="text-xs text-emerald-300">
                  {duration.toFixed(1)} s jadi {parts} file terpisah, masing-masing maks {s.segmentSeconds}{' '}
                  s dengan target {s.targetSizeMB} MB. Upload berurutan dari bagian 1.
                </p>
              ) : (
                <p className="text-xs text-slate-400">
                  Klip di bawah {s.segmentSeconds} s, jadi tetap satu file.
                </p>
              )}
            </>
          ) : null}
        </Field>

        {!s.autoSplit ? (
          <Field
            label="Batas durasi"
            hint={s.maxDuration > WA_SEGMENT_SECONDS ? 'akan dipecah WA' : 'satu segmen'}
          >
            <SegmentedControl<MaxDuration>
              value={s.maxDuration}
              options={[
                { value: 30, label: '30 s' },
                { value: 60, label: '60 s' },
                { value: 90, label: '90 s' },
              ]}
              onChange={(maxDuration) => onChange({ maxDuration })}
            />
            {s.maxDuration > WA_SEGMENT_SECONDS ? (
              <p className="text-xs text-amber-300">
                WhatsApp memecah Status jadi potongan {WA_SEGMENT_SECONDS} detik - video di atas 30 s akan
                tampil sebagai beberapa Status berurutan.
              </p>
            ) : null}
          </Field>
        ) : null}

        <Field label="Mode encoding">
          <RadioGroup
            value={s.encodingMode}
            onChange={(encodingMode) => onChange({ encodingMode })}
            options={[
              { value: 'size', label: 'Target ukuran (2-pass)', hint: 'Bitrate dihitung otomatis' },
              { value: 'crf', label: 'Kualitas (CRF)', hint: 'Ukuran mengikuti isi video' },
            ]}
          />
        </Field>

        {s.encodingMode === 'size' ? (
          <Field label="Target ukuran (MB)" hint={`limit WA ${WA_HARD_LIMIT_BYTES / 1024 / 1024} MB`}>
            <input
              type="number"
              min={1}
              max={16}
              step={0.5}
              value={s.targetSizeMB}
              onChange={(e) => onChange({ targetSizeMB: Number(e.target.value) })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-wa-green"
            />
          </Field>
        ) : (
          <Field label="CRF" hint={`${s.crf} - makin kecil makin bagus`}>
            <Slider min={18} max={30} step={1} value={s.crf} onChange={(crf) => onChange({ crf })} />
          </Field>
        )}

        <Field
          label="Bitrate video (kbps)"
          hint={s.encodingMode === 'size' ? 'otomatis' : 'batas maksimum'}
        >
          <input
            type="number"
            min={150}
            step={50}
            readOnly={s.encodingMode === 'size'}
            value={s.encodingMode === 'size' ? videoKbps : s.videoBitrate}
            onChange={(e) => onChange({ videoBitrate: Number(e.target.value) })}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none read-only:text-slate-400 focus:border-wa-green"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Audio" hint={`${audioKbps(s, meta)} kbps efektif`}>
            <SegmentedControl<number>
              value={s.audioChannels}
              options={[
                { value: 2, label: 'Stereo' },
                { value: 1, label: 'Mono' },
              ]}
              onChange={(v) => onChange({ audioChannels: v === 1 ? 1 : 2 })}
            />
          </Field>
          <Field label="Bitrate audio">
            <Select<AudioBitrate>
              value={s.audioBitrate}
              options={[64, 96, 128, 192].map((v) => ({ value: v as AudioBitrate, label: `${v} kbps` }))}
              onChange={(audioBitrate) => onChange({ audioBitrate })}
            />
          </Field>
        </div>

        <Field label="FPS" hint={meta.fps ? `sumber ${meta.fps} fps` : 'sumber tidak diketahui'}>
          <SegmentedControl
            value={s.fpsMode}
            options={[
              { value: 'source', label: 'Ikuti sumber' },
              { value: '30', label: 'Cap 30' },
              { value: '24', label: 'Cap 24' },
            ]}
            onChange={(fpsMode) => onChange({ fpsMode })}
          />
          {meta.fps && meta.fps > 31 && s.fpsMode === 'source' ? (
            <p className="text-xs text-amber-300">
              Sumber {Math.round(meta.fps)} fps - cap 30 memangkas ukuran hampir setengah tanpa terlihat di
              Status.
            </p>
          ) : null}
        </Field>

        <Field
          label="Kecepatan encode"
          hint={X264_PRESETS.find((x) => x.value === s.x264Preset)?.hint}
        >
          <SegmentedControl<X264Preset>
            value={s.x264Preset}
            options={X264_PRESETS.map((x) => ({ value: x.value, label: x.label }))}
            onChange={(x264Preset) => onChange({ x264Preset })}
          />
        </Field>

        <Toggle
          checked={s.faststart}
          onChange={(faststart) => onChange({ faststart })}
          label="Faststart (moov di depan)"
        />
      </fieldset>

      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">
            Estimasi ukuran output{parts > 1 ? ' (per bagian)' : ''}
          </span>
          <Badge tone={overLimit ? 'over' : 'pass'}>{formatBytes(estimate)}</Badge>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {videoKbps} kbps video + {audioKbps(s, meta)} kbps audio x {partDuration.toFixed(1)} s
          {s.encodingMode === 'crf' ? ' (perkiraan kasar, CRF mengikuti isi video)' : ''}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setShowCommand((v) => !v)}
        className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
      >
        {showCommand ? 'Sembunyikan' : 'Lihat'} perintah FFmpeg{parts > 1 ? ' (bagian 1)' : ''}
      </button>
      {showCommand ? (
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-400">
          {command}
        </pre>
      ) : null}
    </div>
  )
}
