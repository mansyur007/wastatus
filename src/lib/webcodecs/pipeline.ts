import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack, VideoSample } from 'mediabunny'
import type { MediaInfo, Segment, Settings, SourceMeta } from '../../types'
import { audioKbps } from '../bitrate'
import { outputFps, targetDimensions, WA_HARD_LIMIT_BYTES } from '../presets'
import { buildPlan } from '../plan'
import { outputFilename } from '../ffmpegArgs'

/**
 * The WebCodecs conversion engine.
 *
 * ffmpeg.wasm decodes and encodes H.264 in software, on one thread, inside a
 * wasm sandbox - which is why a long source used to take longer than the source
 * itself. WebCodecs hands both halves to the same hardware media engine the
 * browser already uses to play video, so decode and encode leave the CPU almost
 * entirely.
 *
 * What is deliberately NOT here: the x264 preset and the CRF knob. A hardware
 * encoder takes a target bitrate, not a rate factor, so size mode maps onto it
 * directly and those two panel controls only steer the wasm fallback. Every
 * other decision - framing, seams, per-part budget, retry on overshoot - is the
 * shared planner, so both engines produce the same set of files.
 */

/** Raised when this engine cannot handle the job; the caller falls back to wasm. */
export class UnsupportedSourceError extends Error {}

export interface PipelinePart {
  buffer: ArrayBuffer
  size: number
  filename: string
  attempts: number
  videoBitrate: number
  part: number
  totalParts: number
  start: number
  duration: number
  copied?: boolean
}

export type Report = (fraction: number, label: string) => void

/** Everything about the source the pipeline needs, minus the File. */
export type PipelineMeta = MediaInfo & Pick<SourceMeta, 'name' | 'duration' | 'size' | 'codec'>

/** Keyframe every 2 seconds, matching the `-g fps*2` the ffmpeg path uses. */
const KEY_FRAME_INTERVAL = 2

/**
 * Can this browser encode what the app is going to ask of it? Checked once,
 * against the resolution the app actually defaults to, before the engine badge
 * is drawn. Decode support is per-source and is checked at conversion time.
 */
export async function checkSupport(): Promise<{ ok: boolean; reason: string }> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    return { ok: false, reason: 'Browser ini belum punya WebCodecs.' }
  }
  const video = await canEncodeVideo('avc', {
    width: 720,
    height: 1280,
    quality: new Quality({ bitrate: 4_000_000 }),
  }).catch(() => false)
  if (!video) return { ok: false, reason: 'Browser ini tidak bisa meng-encode H.264.' }
  const audio = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 44100 }).catch(
    () => false,
  )
  return {
    ok: true,
    reason: audio ? 'encode lewat hardware perangkat' : 'encode lewat hardware, tanpa audio',
  }
}

/**
 * WebCodecs codec ids, in the names the rest of the app already speaks.
 *
 * mediabunny follows the WebCodecs registry ('avc'), ffprobe follows FFmpeg
 * ('h264'), and the planner - shared by all three engines - was written against
 * ffprobe. Without this the stream-copy check silently never matches and every
 * ready-to-go source gets re-encoded for nothing.
 */
const FFMPEG_NAME: Record<string, string> = { avc: 'h264', 'pcm-s16': 'pcm_s16le' }
const ffmpegName = (codec: string | null) => (codec ? (FFMPEG_NAME[codec] ?? codec) : undefined)

/** Metadata read straight from the container - no 32 MB wasm core involved. */
export async function probe(file: File): Promise<Partial<SourceMeta>> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    const out: Partial<SourceMeta> = { hasAudio: Boolean(audio) }
    if (audio) out.audioCodec = ffmpegName(await audio.getCodec())
    if (video) {
      out.codec = ffmpegName(await video.getCodec())
      out.width = await video.getDisplayWidth()
      out.height = await video.getDisplayHeight()
      // Deduced from the real frame timestamps, so a container that lies about
      // its frame rate (or carries none) still lands on the right number.
      const rate = await video.computeFrameRateMetrics().catch(() => null)
      if (rate) out.fps = Math.round(rate.bestGuessFrameRate * 100) / 100
      // Sampled rather than exhaustive: plenty for a bitrate ceiling, and cheap
      // on a long file.
      const stats = await video.computePacketStats(200).catch(() => null)
      if (stats && stats.averageBitrate > 0) out.videoKbps = Math.round(stats.averageBitrate / 1000)
    }
    return out
  } finally {
    input.dispose()
  }
}

/** The 9:16 framing, drawn per frame. Mirrors buildFilter() in ffmpegArgs.ts. */
function makeRenderer(settings: Settings, meta: MediaInfo) {
  const { width: W, height: H } = targetDimensions(settings.resolution, meta)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new UnsupportedSourceError('Canvas 2D tidak tersedia.')
  ctx.imageSmoothingQuality = 'high'
  // A gaussian blur bites harder per pixel than the box blur the ffmpeg path
  // uses, so the radius is scaled down to land on the same look.
  const blurPx = Math.max(4, Math.round(W / 32))

  /** Source rect that fills the WxH box, positioned by the crop sliders. */
  const cover = (sw: number, sh: number, ax: number, ay: number) => {
    const scale = Math.max(W / sw, H / sh)
    const w = Math.min(sw, W / scale)
    const h = Math.min(sh, H / scale)
    return { sx: (sw - w) * ax, sy: (sh - h) * ay, sw: w, sh: h }
  }

  const draw = (sample: VideoSample) => {
    const dw = sample.displayWidth
    const dh = sample.displayHeight

    if (settings.aspectMode === 'crop') {
      const r = cover(dw, dh, clamp01(settings.cropX), clamp01(settings.cropY))
      ctx.filter = 'none'
      sample.draw(ctx, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H)
      return
    }

    // Both remaining modes letterbox the untouched frame; only the backdrop
    // differs - flat black, or a blurred blow-up of the frame itself.
    const scale = Math.min(W / dw, H / dh)
    const w = Math.round(dw * scale)
    const h = Math.round(dh * scale)
    const dx = Math.round((W - w) / 2)
    const dy = Math.round((H - h) / 2)

    if (settings.aspectMode === 'blur') {
      const r = cover(dw, dh, 0.5, 0.5)
      ctx.filter = 'blur(' + blurPx + 'px)'
      // Bleed past every edge so the blur kernel never samples the transparent
      // outside and darkens the border.
      const bleed = blurPx * 2
      sample.draw(ctx, r.sx, r.sy, r.sw, r.sh, -bleed, -bleed, W + bleed * 2, H + bleed * 2)
    } else {
      ctx.filter = 'none'
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
    }

    ctx.filter = 'none'
    sample.draw(ctx, dx, dy, w, h)
  }

  return { canvas, draw, width: W, height: H }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

interface PartTracks {
  video: InputVideoTrack
  audio: InputAudioTrack | null
}

/**
 * Encodes one part into a standalone MP4.
 *
 * Each part is its own Output, so its first frame is always a keyframe and the
 * file plays on its own - the same guarantee `-force_key_frames` plus the
 * segment muxer buys on the ffmpeg path, without having to ask for it.
 */
async function encodePart(
  tracks: PartTracks,
  seg: Segment,
  settings: Settings,
  meta: PipelineMeta,
  videoKbps: number,
  renderer: ReturnType<typeof makeRenderer>,
  onFrame: (relSeconds: number) => void,
): Promise<ArrayBuffer> {
  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: settings.faststart ? 'in-memory' : false }),
    target,
  })

  const capped = settings.fpsMode !== 'source'
  const fps = outputFps(settings.fpsMode, meta.fps)
  const videoSource = new CanvasSource(renderer.canvas, {
    codec: 'avc',
    // A bitrate, not a rate factor: hardware encoders have no CRF. The planner
    // already derived this from the size budget and capped it at the source's
    // own rate, so it carries the same meaning -maxrate does for x264.
    quality: new Quality({ bitrate: Math.round(videoKbps * 1000), bitrateMode: 'variable' }),
    keyFrameInterval: KEY_FRAME_INTERVAL,
  })
  output.addVideoTrack(videoSource, capped ? { frameRate: fps } : {})

  const wantsAudio = tracks.audio !== null && meta.hasAudio !== false
  const audioSource = wantsAudio
    ? new AudioSampleSource({
        codec: 'aac',
        quality: new Quality({ bitrate: Math.round(audioKbps(settings, meta) * 1000) }),
        transform: { numberOfChannels: settings.audioChannels, sampleRate: 44100 },
      })
    : null
  if (audioSource) output.addAudioTrack(audioSource)

  await output.start()

  const end = seg.start + seg.duration
  const step = 1 / fps
  let tick = 0

  const videoSink = new VideoSampleSink(tracks.video)
  for await (const sample of videoSink.samples(seg.start, end)) {
    const relStart = sample.timestamp - seg.start
    const relEnd = relStart + (sample.duration || step)
    try {
      if (capped) {
        // Constant frame rate: one output frame per tick, filled by whichever
        // decoded frame is on screen at that instant. Drops frames on a 60->30
        // halving and repeats them when the source runs slower than the target,
        // which is what the fps filter does.
        if (tick * step >= relEnd) continue
        renderer.draw(sample)
        while (tick * step < relEnd && tick * step < seg.duration) {
          await videoSource.add(tick * step, step)
          tick++
        }
      } else {
        if (relEnd <= 0) continue
        renderer.draw(sample)
        await videoSource.add(Math.max(0, relStart), sample.duration || step)
      }
      onFrame(Math.min(seg.duration, Math.max(0, relStart)))
    } finally {
      sample.close()
    }
  }

  if (audioSource && tracks.audio) {
    const audioSink = new AudioSampleSink(tracks.audio)
    for await (const sample of audioSink.samples(seg.start, end)) {
      try {
        sample.setTimestamp(Math.max(0, sample.timestamp - seg.start))
        await audioSource.add(sample)
      } finally {
        sample.close()
      }
    }
  }

  await output.finalize()
  if (!target.buffer) throw new Error('Encoder tidak menghasilkan file.')
  return target.buffer
}

/**
 * The no-re-encode route: the source's own packets, re-timed into a fresh
 * container. Cuts land on the source's keyframes, exactly like `-c copy`.
 */
async function copyPart(
  tracks: PartTracks,
  seg: Segment,
  settings: Settings,
): Promise<{ buffer: ArrayBuffer; start: number; duration: number }> {
  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: settings.faststart ? 'in-memory' : false }),
    target,
  })

  const videoCodec = await tracks.video.getCodec()
  if (!videoCodec) throw new UnsupportedSourceError('Codec video sumber tidak dikenali.')
  const videoSource = new EncodedVideoPacketSource(videoCodec)
  output.addVideoTrack(videoSource, { rotation: await tracks.video.getRotation() })

  const audioCodec = tracks.audio ? await tracks.audio.getCodec() : null
  const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null
  if (audioSource) output.addAudioTrack(audioSource)

  await output.start()

  const videoPackets = new EncodedPacketSink(tracks.video)
  // The last keyframe at or before the seam: the first packet of a part has to
  // decode without the packets ahead of it.
  const first = await videoPackets.getKeyPacket(seg.start)
  if (!first) throw new UnsupportedSourceError('Tidak ada keyframe di titik potong.')
  const origin = first.timestamp
  const last = await videoPackets.getPacket(seg.start + seg.duration)

  let written = 0
  let videoMeta: EncodedVideoChunkMetadata | undefined = {
    decoderConfig: (await tracks.video.getDecoderConfig()) ?? undefined,
  }
  for await (const packet of videoPackets.packets(first, last ?? undefined)) {
    await videoSource.add(shift(packet, origin), videoMeta)
    videoMeta = undefined
    written = Math.max(written, packet.timestamp + packet.duration - origin)
  }

  if (audioSource && tracks.audio) {
    const audioPackets = new EncodedPacketSink(tracks.audio)
    const audioFirst = await audioPackets.getPacket(origin)
    const audioLast = await audioPackets.getPacket(origin + written)
    let audioMeta: EncodedAudioChunkMetadata | undefined = {
      decoderConfig: (await tracks.audio.getDecoderConfig()) ?? undefined,
    }
    if (audioFirst) {
      for await (const packet of audioPackets.packets(audioFirst, audioLast ?? undefined)) {
        await audioSource.add(shift(packet, origin), audioMeta)
        audioMeta = undefined
      }
    }
  }

  await output.finalize()
  if (!target.buffer) throw new Error('Remux tidak menghasilkan file.')
  return { buffer: target.buffer, start: origin, duration: written || seg.duration }
}

/** A packet re-timed so the part starts at zero. Negatives are clamped away. */
function shift(packet: EncodedPacket, origin: number): EncodedPacket {
  const ts = Math.max(0, packet.timestamp - origin)
  if (ts === packet.timestamp) return packet
  return new EncodedPacket(
    packet.data,
    packet.type,
    ts,
    packet.duration,
    packet.sequenceNumber,
    packet.byteLength,
    packet.sideData,
  )
}

export async function convert(
  file: File,
  settings: Settings,
  meta: PipelineMeta,
  report: Report,
): Promise<PipelinePart[]> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new UnsupportedSourceError('Tidak ada track video di file ini.')
    if (!(await video.canDecode())) {
      throw new UnsupportedSourceError('Browser ini tidak bisa men-decode codec sumber.')
    }
    const audioTrack = await input.getPrimaryAudioTrack()
    const audio = audioTrack && (await audioTrack.canDecode().catch(() => false)) ? audioTrack : null
    const tracks: PartTracks = { video, audio }

    const plan = buildPlan(settings, meta)
    const total = plan.segments.length
    const window = plan.segments.reduce((sum, s) => sum + s.duration, 0) || 1
    const label = plan.kind === 'copy' ? 'Memotong tanpa encode ulang' : 'Encoding'

    if (plan.kind === 'copy') {
      const parts: PipelinePart[] = []
      for (let i = 0; i < total; i++) {
        const out = await copyPart(tracks, plan.segments[i], settings)
        parts.push({
          buffer: out.buffer,
          size: out.buffer.byteLength,
          filename: outputFilename(meta.name, settings, meta, { index: i, total }),
          attempts: 1,
          videoBitrate: plan.videoKbps,
          part: i + 1,
          totalParts: total,
          start: out.start,
          duration: out.duration,
          copied: true,
        })
        report((i + 1) / total, label)
      }
      report(1, 'Selesai')
      return parts
    }

    const renderer = makeRenderer(settings, meta)
    const parts: PipelinePart[] = []
    let done = 0

    for (let i = 0; i < total; i++) {
      const seg = plan.segments[i]
      let bitrate = plan.videoKbps
      let attempt = 1
      let buffer = await encodePart(tracks, seg, settings, meta, bitrate, renderer, (rel) =>
        report(Math.min(0.99, (done + rel) / window), label),
      )

      // A part that still overshoots costs one more pass over that part only -
      // never a rerun of the whole video.
      while (buffer.byteLength > WA_HARD_LIMIT_BYTES && attempt < 3) {
        attempt++
        bitrate = Math.max(150, Math.round(bitrate * 0.9))
        const retryLabel = 'Bagian ' + (i + 1) + ' terlalu besar · re-encode ' + (attempt - 1)
        buffer = await encodePart(tracks, seg, settings, meta, bitrate, renderer, (rel) =>
          report(Math.min(0.99, (done + rel) / window), retryLabel),
        )
      }

      done += seg.duration
      parts.push({
        buffer,
        size: buffer.byteLength,
        filename: outputFilename(meta.name, settings, meta, { index: i, total }),
        attempts: attempt,
        videoBitrate: bitrate,
        part: i + 1,
        totalParts: total,
        start: seg.start,
        duration: seg.duration,
      })
      report(Math.min(0.99, done / window), label)
    }

    report(1, 'Selesai')
    return parts
  } finally {
    input.dispose()
  }
}
