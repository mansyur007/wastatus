import { useMemo, useState } from 'react'
import type {
  AudioBitrate,
  MaxDuration,
  SegmentSeconds,
  Settings,
  SourceMeta,
  X264Preset,
} from '../types'
import {
  Badge,
  DualRange,
  Field,
  Note,
  RadioGroup,
  Section,
  SegmentedControl,
  Slider,
  Toggle,
} from './ui'
import { IconClock, IconFrame, IconGauge, IconRefresh, IconTerminal, IconWave } from './icons'
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
  partCount,
  segmentPlan,
} from '../lib/bitrate'
import { X264_PRESETS, previewCommand } from '../lib/ffmpegArgs'
import { buildPlan, estimatePartBytes } from '../lib/plan'
import { formatBytes, formatDuration } from '../lib/format'

const ASPECT_LABEL: Record<Settings['aspectMode'], string> = {
  crop: 'Crop to fill',
  pad: 'Black bars',
  blur: 'Blurred background',
}

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
  const plan = useMemo(() => buildPlan(s, meta), [s, meta])
  const estimate = estimatePartBytes(plan, s, meta)
  const videoKbps = effectiveVideoBitrate(s, meta)
  const dims = targetDimensions(s.resolution, meta)
  const overLimit = estimate > WA_HARD_LIMIT_BYTES

  const command = useMemo(
    () =>
      previewCommand(
        {
          input: 'input.mp4',
          output: parts > 1 ? 'part%03d.mp4' : 'output.mp4',
          settings: s,
          meta,
          videoBitrate: plan.videoKbps,
          seamSeconds: parts > 1 ? s.segmentSeconds : undefined,
          segment: parts > 1 ? undefined : segmentPlan(s)[0],
        },
        plan.kind,
      ),
    [s, meta, plan, parts],
  )

  return (
    <div className="slab p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-white">Penyesuaian</h2>
          <p className="text-[11px] text-mist-400">Preset WA optimal sudah diterapkan</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="btn-ghost px-3 py-1.5 text-[11px] font-medium"
        >
          <IconRefresh className="h-3.5 w-3.5" />
          Reset
        </button>
      </div>

      {/* Always-visible readout: the sections below can all be collapsed. */}
      <div className="well mb-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-mist-300">
            Estimasi output{parts > 1 ? ' per bagian' : ''}
          </span>
          <Badge tone={overLimit ? 'over' : 'pass'}>{formatBytes(estimate)}</Badge>
        </div>
        <p className="tnum mt-2 text-[11px] leading-relaxed text-mist-500">
          {plan.kind === 'copy'
            ? 'Tanpa encode ulang — ukuran mengikuti sumber apa adanya'
            : `maks ${plan.videoKbps} kbps video + ${audioKbps(s, meta)} kbps audio × ${partDuration.toFixed(1)} s`}
        </p>
        {plan.kind === 'copy' ? (
          <Note tone="good">
            {plan.reason} Potongan mengikuti keyframe, jadi durasi tiap bagian bisa meleset
            beberapa detik dari {s.segmentSeconds} s.
          </Note>
        ) : plan.cappedBySource ? (
          <Note>{plan.reason}</Note>
        ) : null}
      </div>

      <fieldset disabled={disabled} className="space-y-2.5 disabled:opacity-60">
        <Section
          icon={<IconFrame className="h-4 w-4" />}
          title="Framing"
          summary={`${dims.width}×${dims.height} · ${ASPECT_LABEL[s.aspectMode]}`}
          defaultOpen
        >
          <Field label="Resolusi">
            <RadioGroup
              label="Resolusi"
              value={s.resolution}
              onChange={(resolution) => onChange({ resolution })}
              options={RESOLUTIONS.map((r) => {
                const d = targetDimensions(r.key, meta)
                return {
                  value: r.key,
                  label: r.label,
                  hint: r.hint,
                  note: `${d.width}×${d.height}`,
                }
              })}
            />
            {dims.height > WA_MAX_DELIVERED_HEIGHT ? (
              <Note tone="warn">
                WhatsApp mengirim video maksimal 720p — jalur Status bahkan lebih rendah. Piksel di
                atas itu tidak sampai ke penonton, cuma memecah budget bitrate dan memperlama encode.
              </Note>
            ) : null}
          </Field>

          <Field label="Mode aspek (9:16)">
            <RadioGroup
              label="Mode aspek"
              value={s.aspectMode}
              onChange={(aspectMode) => onChange({ aspectMode })}
              options={[
                { value: 'crop', label: ASPECT_LABEL.crop, hint: 'Penuhi frame, sisi terpotong' },
                { value: 'pad', label: ASPECT_LABEL.pad, hint: 'Muat utuh, sisa jadi bar hitam' },
                { value: 'blur', label: ASPECT_LABEL.blur, hint: 'Muat utuh, latar blur dari video' },
              ]}
            />
          </Field>

          {s.aspectMode === 'crop' ? (
            <div className="well grid gap-4 p-3.5 sm:grid-cols-2">
              <Field label="Posisi crop X" hint={`${Math.round(s.cropX * 100)}%`}>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={s.cropX}
                  onChange={(cropX) => onChange({ cropX })}
                />
              </Field>
              <Field label="Posisi crop Y" hint={`${Math.round(s.cropY * 100)}%`}>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={s.cropY}
                  onChange={(cropY) => onChange({ cropY })}
                />
              </Field>
            </div>
          ) : null}
        </Section>

        <Section
          icon={<IconClock className="h-4 w-4" />}
          title="Durasi & potongan"
          summary={`${duration.toFixed(1)} s · ${parts > 1 ? `${parts} bagian` : 'satu file'}`}
          defaultOpen
        >
          <Field
            label="Trim"
            hint={`${formatDuration(s.trimStart)} – ${formatDuration(s.trimEnd)}`}
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

          <Field label="Auto split" hint={parts > 1 ? `${parts} bagian` : 'tidak perlu'}>
            <Toggle
              checked={s.autoSplit}
              onChange={(autoSplit) => onChange({ autoSplit })}
              label={`Pecah otomatis tiap ${s.segmentSeconds} detik`}
              hint="Klip panjang jadi beberapa Status berurutan"
            />
            {s.autoSplit ? (
              <div className="space-y-2 pt-1">
                <SegmentedControl<SegmentSeconds>
                  value={s.segmentSeconds}
                  options={[
                    { value: 30, label: '30 s / bagian' },
                    { value: 60, label: '60 s / bagian' },
                  ]}
                  onChange={(segmentSeconds) => onChange({ segmentSeconds })}
                />
                {s.segmentSeconds === 60 ? (
                  <Note tone="warn">
                    Batas 60 detik hanya ada di WhatsApp versi baru. Kalau Status-mu masih terpotong
                    di 30 detik, kembalikan ke 30 s.
                  </Note>
                ) : null}
                {parts > 1 ? (
                  <Note tone="good">
                    {duration.toFixed(1)} s jadi {parts} file terpisah, masing-masing maks{' '}
                    {s.segmentSeconds} s dengan target {s.targetSizeMB} MB. Upload berurutan dari
                    bagian 1.
                  </Note>
                ) : (
                  <Note>Klip di bawah {s.segmentSeconds} s, jadi tetap satu file.</Note>
                )}
              </div>
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
                <Note tone="warn">
                  WhatsApp memecah Status jadi potongan {WA_SEGMENT_SECONDS} detik — video di atas 30
                  s akan tampil sebagai beberapa Status berurutan.
                </Note>
              ) : null}
            </Field>
          ) : null}
        </Section>

        <Section
          icon={<IconGauge className="h-4 w-4" />}
          title="Kualitas & bitrate"
          summary={
            s.encodingMode === 'size'
              ? `Target ${s.targetSizeMB} MB · ${videoKbps} kbps`
              : `CRF ${s.crf} · maks ${s.videoBitrate} kbps`
          }
        >
          <Field label="Mode encoding">
            <RadioGroup
              label="Mode encoding"
              value={s.encodingMode}
              onChange={(encodingMode) => onChange({ encodingMode })}
              options={[
                { value: 'size', label: 'Target ukuran', hint: 'Bitrate jadi batas atas, sekali pass' },
                { value: 'crf', label: 'Kualitas (CRF)', hint: 'Ukuran mengikuti isi video' },
              ]}
            />
          </Field>

          {s.encodingMode === 'size' ? (
            <Field
              label="Target ukuran (MB)"
              hint={`limit WA ${WA_HARD_LIMIT_BYTES / 1024 / 1024} MB`}
            >
              <input
                type="number"
                min={1}
                max={16}
                step={0.5}
                value={s.targetSizeMB}
                onChange={(e) => onChange({ targetSizeMB: Number(e.target.value) })}
                className="input tnum"
              />
            </Field>
          ) : (
            <Field label="CRF" hint={`${s.crf} — makin kecil makin bagus`}>
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
              className="input tnum read-only:cursor-not-allowed read-only:text-mist-400"
            />
          </Field>

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
              <Note tone="warn">
                Sumber {Math.round(meta.fps)} fps — cap 30 memangkas ukuran hampir setengah tanpa
                terlihat di Status.
              </Note>
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
        </Section>

        <Section
          icon={<IconWave className="h-4 w-4" />}
          title="Audio"
          summary={`${s.audioChannels === 1 ? 'Mono' : 'Stereo'} · ${audioKbps(s, meta)} kbps`}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kanal" hint={`${audioKbps(s, meta)} kbps efektif`}>
              <SegmentedControl<number>
                value={s.audioChannels}
                options={[
                  { value: 2, label: 'Stereo' },
                  { value: 1, label: 'Mono' },
                ]}
                onChange={(v) => onChange({ audioChannels: v === 1 ? 1 : 2 })}
              />
            </Field>
            <Field label="Bitrate audio" hint="kbps">
              <SegmentedControl<AudioBitrate>
                value={s.audioBitrate}
                options={([64, 96, 128, 192] as AudioBitrate[]).map((v) => ({
                  value: v,
                  label: String(v),
                }))}
                onChange={(audioBitrate) => onChange({ audioBitrate })}
              />
            </Field>
          </div>
        </Section>

        <Section
          icon={<IconTerminal className="h-4 w-4" />}
          title="Lanjutan"
          summary={plan.kind === 'copy' ? 'Tanpa encode ulang' : s.faststart ? 'Faststart aktif' : 'Faststart mati'}
        >
          <Toggle
            checked={s.faststart}
            onChange={(faststart) => onChange({ faststart })}
            label="Faststart"
            hint="moov atom di depan, mulai putar lebih cepat"
          />

          <Toggle
            checked={s.allowStreamCopy}
            onChange={(allowStreamCopy) => onChange({ allowStreamCopy })}
            label="Potong tanpa encode ulang bila memungkinkan"
            hint="Dipakai kalau sumber sudah 9:16 H.264 dan tiap bagian sudah muat"
          />
          {s.allowStreamCopy && plan.kind === 'encode' ? (
            <p className="text-[10.5px] leading-relaxed text-mist-500">
              Tidak dipakai: {plan.reason}
            </p>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => setShowCommand((v) => !v)}
              className="text-[11px] font-medium text-mist-400 underline-offset-4 transition-colors hover:text-mist-100 hover:underline"
            >
              {showCommand ? 'Sembunyikan' : 'Lihat'} perintah FFmpeg
              {parts > 1 ? ' (bagian 1)' : ''}
            </button>
            {showCommand ? (
              <pre className="well mt-2.5 overflow-x-auto p-3 font-mono text-[10.5px] leading-relaxed text-mist-400 animate-fade">
                {command}
              </pre>
            ) : null}
          </div>
        </Section>
      </fieldset>
    </div>
  )
}
