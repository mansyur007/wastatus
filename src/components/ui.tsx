import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { IconAlert, IconCheck, IconChevron, IconInfo } from './icons'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium tracking-tight text-mist-100">{label}</span>
        {hint ? (
          <span className="tnum shrink-0 text-[11px] font-medium text-mist-400">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/**
 * A collapsible group. The panel used to be one long column of controls, which
 * is why it read as a dump rather than a tool: sections give the settings a
 * shape, and the summary carries the current state while collapsed.
 */
export function Section({
  icon,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section className="overflow-clip rounded-2xl border border-white/[0.06] bg-white/[0.015] transition-colors duration-300 ease-fluid hover:border-white/[0.1]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-200 hover:bg-white/[0.025]"
      >
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-all duration-300 ease-fluid ${
            open
              ? 'border-wa-green/40 bg-wa-green/10 text-wa-green'
              : 'border-white/[0.07] bg-white/[0.03] text-mist-400 group-hover:text-mist-200'
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold tracking-tight text-mist-100">{title}</span>
          {summary ? (
            <span className="mt-0.5 block truncate text-[11px] text-mist-400">{summary}</span>
          ) : null}
        </span>
        <IconChevron
          className={`h-4 w-4 shrink-0 text-mist-400 transition-transform duration-300 ease-fluid ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {/* 1fr <-> 0fr keeps the collapse smooth without measuring heights. */}
      <div
        id={id}
        className={`grid transition-[grid-template-rows,opacity,visibility] duration-300 ease-fluid ${
          open ? 'grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-clip">
          <div className="space-y-5 border-t border-white/[0.05] px-4 pb-5 pt-4">{children}</div>
        </div>
      </div>
    </section>
  )
}

/**
 * The app's only single-choice list. It replaced the native <select>: clicking
 * a <select> makes the browser scroll it into view before the popup opens,
 * which yanked the whole page up or down mid-tuning.
 */
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Names the group for screen readers; mirror the enclosing Field label. */
  label: string
  value: T
  options: { value: T; label: string; hint?: string; note?: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200 ease-fluid ${
              active
                ? 'border-wa-green/45 bg-wa-green/[0.09] shadow-[0_8px_24px_-16px_rgba(37,211,102,0.9)]'
                : 'border-white/[0.07] bg-ink-850/70 hover:border-white/[0.14] hover:bg-ink-800/70'
            }`}
          >
            <span
              className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors duration-200 ${
                active ? 'border-wa-green' : 'border-mist-500'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full bg-wa-green transition-transform duration-200 ease-spring ${
                  active ? 'scale-100' : 'scale-0'
                }`}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${active ? 'text-white' : 'text-mist-200'}`}>
                {o.label}
              </span>
              {o.hint ? <span className="block text-[11px] text-mist-400">{o.hint}</span> : null}
            </span>
            {o.note ? (
              <span className="tnum shrink-0 text-[11px] font-medium text-mist-400">{o.note}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Sliding pill indicator - the selection travels rather than blinking to a new box. */
export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const n = options.length
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  return (
    <div className="relative flex rounded-xl border border-white/[0.07] bg-ink-950/70 p-1 shadow-dent">
      <span
        aria-hidden
        className="absolute inset-y-1 rounded-lg bg-wa-green shadow-[0_4px_14px_-4px_rgba(37,211,102,0.8)] transition-[left] duration-300 ease-fluid"
        style={{
          width: `calc((100% - 0.5rem) / ${n})`,
          left: `calc(0.25rem + (100% - 0.5rem) / ${n} * ${idx})`,
        }}
      />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`relative z-10 flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors duration-200 ${
            o.value === value ? 'text-ink-950' : 'text-mist-300 hover:text-mist-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const pct = ((value - min) / Math.max(0.0001, max - min)) * 100
  return (
    <div className={`relative h-6 select-none ${disabled ? 'opacity-40' : ''}`}>
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ink-700 shadow-dent" />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-wa-teal to-wa-green"
        style={{ width: `${pct}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 h-6 w-full appearance-none bg-transparent"
      />
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200 ease-fluid ${
        checked
          ? 'border-wa-green/35 bg-wa-green/[0.07]'
          : 'border-white/[0.07] bg-ink-850/70 hover:border-white/[0.14]'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm text-mist-100">{label}</span>
        {hint ? <span className="block text-[11px] text-mist-400">{hint}</span> : null}
      </span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-300 ease-fluid ${
          checked ? 'bg-wa-green' : 'bg-ink-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.5)] transition-all duration-300 ease-spring ${
            checked ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/** Two thumbs on one track, for the trim range. */
export function DualRange({
  min,
  max,
  step,
  start,
  end,
  onChange,
}: {
  min: number
  max: number
  step: number
  start: number
  end: number
  onChange: (start: number, end: number) => void
}) {
  const span = Math.max(0.001, max - min)
  const left = ((start - min) / span) * 100
  const width = ((end - start) / span) * 100
  return (
    <div className="relative h-8 select-none">
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ink-700 shadow-dent" />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-wa-teal to-wa-green"
        style={{ left: `${left}%`, width: `${width}%` }}
      />
      <input
        type="range"
        aria-label="Awal trim"
        min={min}
        max={max}
        step={step}
        value={start}
        onChange={(e) => onChange(Math.min(Number(e.target.value), end - step), end)}
        className="pointer-events-none absolute inset-0 h-8 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
      />
      <input
        type="range"
        aria-label="Akhir trim"
        min={min}
        max={max}
        step={step}
        value={end}
        onChange={(e) => onChange(start, Math.max(Number(e.target.value), start + step))}
        className="pointer-events-none absolute inset-0 h-8 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
      />
    </div>
  )
}

export function Badge({ tone, children }: { tone: 'pass' | 'over' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'pass'
      ? 'border-wa-green/35 bg-wa-green/10 text-[#7bebab]'
      : tone === 'over'
        ? 'border-red-400/35 bg-red-500/10 text-red-300'
        : 'border-white/[0.1] bg-white/[0.04] text-mist-300'
  const Glyph = tone === 'pass' ? IconCheck : tone === 'over' ? IconAlert : IconInfo
  return (
    <span
      className={`tnum inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${cls}`}
    >
      <Glyph className="h-3.5 w-3.5 shrink-0" />
      {children}
    </span>
  )
}

/** Inline advisory. Replaces the loose coloured <p> tags scattered in the panel. */
export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'good'
  children: ReactNode
}) {
  const cls =
    tone === 'warn'
      ? 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/90'
      : tone === 'good'
        ? 'border-wa-green/25 bg-wa-green/[0.07] text-[#9fe9c2]'
        : 'border-white/[0.07] bg-white/[0.025] text-mist-300'
  const Glyph = tone === 'warn' ? IconAlert : tone === 'good' ? IconCheck : IconInfo
  return (
    <p className={`flex gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed ${cls}`}>
      <Glyph className="mt-px h-3.5 w-3.5 shrink-0 opacity-80" />
      <span>{children}</span>
    </p>
  )
}
