/**
 * A minimal, store-only ZIP writer.
 *
 * A split export can run to a hundred parts, and handing those to the browser
 * as a hundred anchor clicks does not work: Chrome blocks bulk automatic
 * downloads after the first few, and the 400 ms spacing that tried to dodge it
 * turned a download into a minute of waiting. One archive is one click.
 *
 * Store-only (no deflate) is deliberate - the payload is already-compressed
 * H.264, which deflate cannot shrink and would only cost time to chew through.
 * No dependency, and nothing here needs the whole archive in memory at once:
 * headers are small Uint8Arrays and the payloads stay as Blobs until the
 * browser assembles them.
 */

/** ZIP without ZIP64 tops out at 4 GiB; refuse rather than emit a broken file. */
const ZIP32_LIMIT = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Names are ASCII by construction (see outputFilename), so UTF-8 is a no-op. */
const encodeName = (name: string) => new TextEncoder().encode(name)

interface Writer {
  view: DataView
  offset: number
}

/** Sized buffer plus a little-endian writer over it. */
function alloc(size: number): { bytes: Uint8Array<ArrayBuffer>; writer: Writer } {
  const buffer = new ArrayBuffer(size)
  const bytes = new Uint8Array(buffer)
  return { bytes, writer: { view: new DataView(buffer), offset: 0 } }
}
const u16 = (t: Writer, v: number) => {
  t.view.setUint16(t.offset, v, true)
  t.offset += 2
}
const u32 = (t: Writer, v: number) => {
  t.view.setUint32(t.offset, v >>> 0, true)
  t.offset += 4
}

export interface ZipEntry {
  name: string
  blob: Blob
}

/**
 * Packs every entry into one archive. Entries are read one at a time to compute
 * their CRC, so peak memory is one part, not the whole export.
 */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encodeName(entry.name)
    const bytes = new Uint8Array(await entry.blob.arrayBuffer())
    const crc = crc32(bytes)
    const size = bytes.length

    const { bytes: local, writer: lt } = alloc(30 + name.length)
    u32(lt, 0x04034b50) // local file header
    u16(lt, 20) // version needed
    u16(lt, 0) // flags
    u16(lt, 0) // method: stored
    u16(lt, 0) // mod time
    u16(lt, 0x21) // mod date: 1980-01-01, so archives are reproducible
    u32(lt, crc)
    u32(lt, size)
    u32(lt, size)
    u16(lt, name.length)
    u16(lt, 0) // extra length
    local.set(name, 30)

    parts.push(local, bytes)

    const { bytes: dir, writer: dt } = alloc(46 + name.length)
    u32(dt, 0x02014b50) // central directory header
    u16(dt, 20) // version made by
    u16(dt, 20) // version needed
    u16(dt, 0)
    u16(dt, 0)
    u16(dt, 0)
    u16(dt, 0x21)
    u32(dt, crc)
    u32(dt, size)
    u32(dt, size)
    u16(dt, name.length)
    u16(dt, 0) // extra
    u16(dt, 0) // comment
    u16(dt, 0) // disk
    u16(dt, 0) // internal attrs
    u32(dt, 0) // external attrs
    u32(dt, offset)
    dir.set(name, 46)
    central.push(dir)

    offset += local.length + size
    if (offset > ZIP32_LIMIT) {
      throw new Error('Total hasil di atas 4 GB - unduh per bagian saja.')
    }
  }

  const centralSize = central.reduce((sum, d) => sum + d.length, 0)
  const { bytes: end, writer: et } = alloc(22)
  u32(et, 0x06054b50) // end of central directory
  u16(et, 0)
  u16(et, 0)
  u16(et, entries.length)
  u16(et, entries.length)
  u32(et, centralSize)
  u32(et, offset)
  u16(et, 0) // comment length

  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
