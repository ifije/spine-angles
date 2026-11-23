// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Fetching the detector file that is published beside the app (detector/index.json names it). One file, or pieces of it
// for a host that limits a file's size; read as it arrives, so that the app can say how much has come and can prepare the
// engine from the file's first part (everything but the network's weights) while the rest is still on its way.

import { readHeader } from './file'

/** detector/index.json */
export interface DetectorIndex {
  /** The file, or the pieces that joined make it. */
  file?: string
  pieces?: { name: string; bytes: number }[]
  /** The whole file's length in bytes, and its content stamp (SHA-256, hex): the app keeps the file by this stamp. */
  bytes?: number
  stamp?: string
  detector?: string
  /** The network's graph for the slower way (ONNX Runtime on the processor), with no weights in it. */
  graph?: { file: string; bytes: number; sha256?: string }
}

export const isIndex = (x: unknown): x is DetectorIndex => {
  const i = x as DetectorIndex
  return !!i && typeof i === 'object' && (typeof i.file === 'string' || (Array.isArray(i.pieces) && i.pieces.length > 0 && i.pieces.every((p) => typeof p?.name === 'string' && p.bytes > 0)))
}

/** A download in progress: the file's first part (all but the weights) as soon as it is here, and the whole file. */
export interface Download {
  first: Promise<Uint8Array>
  whole: Promise<ArrayBuffer>
}

export class DownloadError extends Error {}

/**
 * Fetch the file `index` names, relative to `base` (the index's own address). `progress(got, total)` is called as bytes
 * arrive. Aborting `signal` stops it. Every part comes from that one address; nothing is sent.
 */
export function download(index: DetectorIndex, base: URL, o: { fetch?: typeof fetch; progress?: (got: number, total: number) => void; signal?: AbortSignal } = {}): Download {
  const get = o.fetch ?? fetch
  const parts = index.file ? [{ name: index.file, bytes: index.bytes ?? 0 }] : index.pieces!
  const sized = parts.every((p) => p.bytes > 0)
  const total = sized ? parts.reduce((s, p) => s + p.bytes, 0) : index.bytes ?? 0
  if (index.bytes !== undefined && sized && total !== index.bytes) {
    const e = Promise.reject(new DownloadError('the detector list does not add up'))
    e.catch(() => {})
    return { first: e as Promise<never>, whole: e as Promise<never> }
  }
  let firstOk: (b: Uint8Array) => void = () => {}
  let firstFail: (e: unknown) => void = () => {}
  const first = new Promise<Uint8Array>((ok, fail) => ((firstOk = ok), (firstFail = fail)))
  first.catch(() => {})
  let firstDone = false
  let weightsAt = -1

  const whole = (async () => {
    // Without the sizes up front, the file is read whole (no early part, progress by what the server says).
    if (!sized) {
      const res = await get(new URL(parts[0].name, base), { signal: o.signal })
      if (!res.ok) throw new DownloadError(`the detector file could not be fetched (${res.status})`)
      const b = await res.arrayBuffer()
      o.progress?.(b.byteLength, b.byteLength)
      return b
    }
    const all = new Uint8Array(total)
    const got = new Array<number>(parts.length).fill(0)
    const starts = parts.map((_, i) => parts.slice(0, i).reduce((s, p) => s + p.bytes, 0))
    /** Bytes here without a gap from the file's start. */
    const run = () => {
      let n = 0
      for (let i = 0; i < parts.length; i++) {
        n += got[i]
        if (got[i] < parts[i].bytes) break
      }
      return n
    }
    const arrived = () => {
      o.progress?.(got.reduce((s, n) => s + n, 0), total)
      if (firstDone) return
      const n = run()
      try {
        if (weightsAt < 0) {
          const h = readHeader(all.subarray(0, n))
          const w = h?.sections.find((s) => s.name === 'weights')
          if (w) weightsAt = w.offset
        }
      } catch {
        weightsAt = total                                   // not a detector file: the whole will say so
      }
      if (weightsAt >= 0 && n >= weightsAt) {
        firstDone = true
        firstOk(all.slice(0, weightsAt))
      }
    }
    await Promise.all(parts.map(async (p, i) => {
      const res = await get(new URL(p.name, base), { signal: o.signal })
      if (!res.ok) throw new DownloadError(`the detector file could not be fetched (${res.status})`)
      if (!res.body) {
        const b = new Uint8Array(await res.arrayBuffer())
        if (b.length !== p.bytes) throw new DownloadError('the detector file arrived incomplete')
        all.set(b, starts[i])
        got[i] = b.length
        arrived()
        return
      }
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (got[i] + value.length > p.bytes) throw new DownloadError('the detector file is larger than its list says')
        all.set(value, starts[i] + got[i])
        got[i] += value.length
        arrived()
      }
      if (got[i] !== p.bytes) throw new DownloadError('the detector file arrived incomplete')
    }))
    return all.buffer
  })()
  whole.then((b) => { if (!firstDone) firstOk(new Uint8Array(b)) }, (e) => firstFail(e))
  return { first, whole }
}
