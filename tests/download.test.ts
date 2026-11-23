// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Fetching the built-in detector as it arrives: one file or pieces, the progress, the file's first part (all but the
// weights) as soon as it is here, and the refusals. With the tiny made-up detector file and a stand-in for fetch.

import { describe, it, expect } from 'vitest'
import { download, isIndex, DownloadError, type DetectorIndex } from '../src/detector/download'
import { readHeader, readEarly } from '../src/detector/file'
import { makeFile } from './madeup'

const BASE = new URL('https://example.invalid/app/detector/index.json')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A stand-in for fetch: each name answers with its bytes in chunks of `chunk`, after `delay` ms; anything else 404. */
function host(files: Record<string, Uint8Array>, o: { chunk?: number; delay?: Record<string, number> } = {}) {
  const asked: string[] = []
  const get = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const name = String(input).split('/').pop()!
    asked.push(String(input))
    await wait(o.delay?.[name] ?? 0)
    if (init?.signal?.aborted) throw new DOMException('stopped', 'AbortError')
    const b = files[name]
    if (!b) return new Response('no', { status: 404 })
    const size = o.chunk ?? 64
    return new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        for (let i = 0; i < b.length; i += size) {
          c.enqueue(b.slice(i, i + size))
          await wait(0)
        }
        c.close()
      },
    }))
  }) as typeof fetch
  return { get, asked }
}

const weightsAt = (f: Uint8Array) => readHeader(f)!.sections.find((s) => s.name === 'weights')!.offset

describe('downloading the built-in detector', () => {
  it('reads one file as it arrives, says how much has come, and gives its first part early', async () => {
    const f = await makeFile()
    const { get, asked } = host({ 'd.bin': f }, { chunk: 50 })
    const seen: [number, number][] = []
    const d = download({ file: 'd.bin', bytes: f.length }, BASE, { fetch: get, progress: (g, t) => seen.push([g, t]) })
    const first = await d.first
    expect(Array.from(first)).toEqual(Array.from(f.subarray(0, weightsAt(f))))
    expect(readEarly(first)!.net.key).toBe('toy')
    expect(Array.from(new Uint8Array(await d.whole))).toEqual(Array.from(f))
    expect(seen.at(-1)).toEqual([f.length, f.length])
    expect(seen.every(([g], i) => i === 0 || g >= seen[i - 1][0])).toBe(true)
    expect(asked).toEqual(['https://example.invalid/app/detector/d.bin'])
  })

  it('joins pieces that arrive out of order, the first part only once the start is here', async () => {
    const f = await makeFile()
    const w = weightsAt(f), mid = w + 10
    const files = { 'p.0.wasm': f.slice(0, w), 'p.1.wasm': f.slice(w, mid), 'p.2.wasm': f.slice(mid) }
    const index: DetectorIndex = { pieces: Object.entries(files).map(([name, b]) => ({ name, bytes: b.length })), bytes: f.length }
    const { get } = host(files, { delay: { 'p.0.wasm': 30 } })
    const d = download(index, BASE, { fetch: get })
    const [first, whole] = await Promise.all([d.first, d.whole])
    expect(first.length).toBe(w)
    expect(Array.from(new Uint8Array(whole))).toEqual(Array.from(f))
  })

  it('refuses a file that is cut short or longer than its list, and one that is not there', async () => {
    const f = await makeFile()
    await expect(download({ file: 'd.bin', bytes: f.length + 5 }, BASE, { fetch: host({ 'd.bin': f }).get }).whole).rejects.toBeInstanceOf(DownloadError)
    await expect(download({ file: 'd.bin', bytes: f.length - 5 }, BASE, { fetch: host({ 'd.bin': f }).get }).whole).rejects.toThrow(/larger/)
    const gone = download({ file: 'gone.bin', bytes: 10 }, BASE, { fetch: host({}).get })
    await expect(gone.whole).rejects.toThrow(/could not be fetched \(404\)/)
    await expect(gone.first).rejects.toThrow(/404/)
    await expect(download({ pieces: [{ name: 'a', bytes: 3 }], bytes: 4 }, BASE, { fetch: host({}).get }).whole).rejects.toThrow(/does not add up/)
  })

  it('stops when told to', async () => {
    const f = await makeFile()
    const ctl = new AbortController()
    const d = download({ file: 'd.bin', bytes: f.length }, BASE, { fetch: host({ 'd.bin': f }, { delay: { 'd.bin': 50 } }).get, signal: ctl.signal })
    ctl.abort()
    await expect(d.whole).rejects.toThrow(/stopped/)
    await expect(d.first).rejects.toThrow(/stopped/)
  })

  it('knows an index when it sees one', () => {
    expect(isIndex({ file: 'x.bin', bytes: 3, stamp: 'ab' })).toBe(true)
    expect(isIndex({ pieces: [{ name: 'a.wasm', bytes: 3 }] })).toBe(true)
    expect(isIndex({ pieces: [] })).toBe(false)
    expect(isIndex({ pieces: [{ name: 'a.wasm', bytes: 0 }] })).toBe(false)
    expect(isIndex(null)).toBe(false)
    expect(isIndex('detector')).toBe(false)
  })
})
