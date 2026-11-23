// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Automatic guess: landmarks found by a detector, placed as guesses for the user to drag, keep or delete. The app looks
// for a detector in this order:
//   1. a detector file the user added ("Add detector file"), kept on this device: the guess is worked out on this device;
//   2. the built-in detector, published beside the app (detector/index.json names the file, or its pieces for a host
//      that limits a file's size): downloaded once in the background, kept on this device by its content stamp, read
//      from there on every later opening (no request for the file, and it works with no connection), downloaded again
//      only when index.json names a new stamp; worked out on this device;
//   3. a detector service the user runs on their own machine, which is sent the photo and answers with landmarks.
// Each answers with a record in the "spine-labels/1" format. The user can turn the automatic guess off (remembered): then
// nothing is downloaded, the kept copy of the built-in detector is removed, and no detector of any kind is asked.

import { readDetectorFile, readHeader, startDetector, webgpuOffered, type DeviceDetector, type GuessRecord, type RuntimeFiles } from './detector'
import cpuWorkerUrl from './detector/cpu-worker?worker&url'
import { download, isIndex, DownloadError, type DetectorIndex } from './detector/download'
import { drop, keep, keepAdded, keepFiles, loadAdded, loadFiles, loadKept, removeAdded } from './detector/store'

export { NotOffered, DetectorFileError } from './detector'
export { DownloadError } from './detector/download'
export type { GuessRecord } from './detector'

export type Detector = { kind: 'service'; base: string } | { kind: 'device'; from: 'added' | 'published'; device: DeviceDetector }

export interface Found {
  detector: Detector | null
  /** A detector is here, but this browser cannot run it (no WebGPU): nothing is downloaded. */
  notOffered: boolean
  /** The user has added a detector file, kept on this device. */
  added: boolean
  /** The user turned the automatic guess off. */
  off: boolean
  /** The built-in detector this time: read from this device, or being downloaded (its size), and whether it is kept. */
  published: null | { from: 'store' | 'download'; bytes: number; kept: Promise<boolean> }
  /** The built-in detector could not be reached and none is kept (no connection): it is tried again next time. */
  later: boolean
  /** This browser offers WebGPU (the fast way); without it the slower way, on the processor. */
  gpu: boolean
}

const KEY = 'spine-angles:detector'
const OFF = 'spine-angles:auto-guess'
const SERVICE = 'spine-guess'
/** Where the built-in detector is published, beside the app. */
const INDEX = 'detector/index.json'

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/** Whether the user turned the automatic guess off (remembered on this device). */
export function guessOff(): boolean {
  try {
    return localStorage.getItem(OFF) === 'off'
  } catch {
    return sessionOff
  }
}
let sessionOff = false

/** Turn the automatic guess off (the kept copy of the built-in detector is removed) or on again. */
export async function setGuessOff(off: boolean): Promise<void> {
  sessionOff = off
  try {
    if (off) localStorage.setItem(OFF, 'off')
    else localStorage.removeItem(OFF)
  } catch {
    // Not remembered: for this session only.
  }
  if (off) {
    await drop('published')
    await drop('runtime')
  }
}

async function healthy(base: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2500)
  try {
    const res = await fetch(`${base}health`, { cache: 'no-store', signal: ctl.signal })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string }
    return body.service === SERVICE
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Address of a detector service, or null. Looked for, in order: `?detector=URL` on the page address (remembered for next
 * time; an empty value forgets it), the remembered address, and the place the app itself was loaded from, which is where
 * the service serves it.
 */
export async function findService(): Promise<string | null> {
  const asked = new URLSearchParams(location.search).get('detector')
  let saved: string | null = null
  try {
    if (asked !== null) {
      if (asked) localStorage.setItem(KEY, asked)
      else localStorage.removeItem(KEY)
    }
    saved = localStorage.getItem(KEY)
  } catch {
    // Storage unavailable: only the page address and the app's own origin are tried.
  }
  const tries = [asked || saved, new URL('.', location.href).href].filter((u): u is string => !!u).map(withSlash)
  for (const base of [...new Set(tries)]) if (await healthy(base)) return base
  return null
}

/** The built-in detector's index: the index, null if none is published here, or 'unreachable' (no connection). */
async function publishedIndex(): Promise<{ url: URL; index: DetectorIndex } | null | 'unreachable'> {
  // (resolved as the page's own relative addresses are, which also holds where a host gives the page a base address)
  const url = new URL(INDEX, document.baseURI)
  let res: Response
  try {
    res = await fetch(url, { cache: 'no-cache' })
  } catch {
    return 'unreachable'
  }
  try {
    if (!res.ok) return null
    const index = await res.json()
    return isIndex(index) ? { url, index } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the slower way's files

/** ort/index.json: the processor runtime's files, beside the app (scripts/copy_runtime.mjs). */
interface RuntimeIndex {
  version: string
  files: { name: string; bytes: number; gz?: { name: string; bytes: number } }[]
}

const RUNTIME_INDEX = 'ort/index.json'
const ROLES = { ort: 'ort.wasm.min.mjs', glue: 'ort-wasm-simd-threaded.mjs', wasm: 'ort-wasm-simd-threaded.wasm' } as const

async function fetchJson<T>(url: URL): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/** One file's bytes, counted as they arrive (`gunzip`: it is sent compressed and unpacked here). */
async function fetchBytes(url: URL, counted: (n: number) => void, signal?: AbortSignal, gunzip = false): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new DownloadError(`a file the slower way needs could not be fetched (${res.status})`)
  const counter = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { counted(chunk.length); c.enqueue(chunk) } })
  let body: ReadableStream<Uint8Array> = res.body.pipeThrough(counter)
  if (gunzip) body = body.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
  return new Response(body).arrayBuffer()
}

/**
 * The slower way's files: the runtime (ONNX Runtime Web, processor only), its worker and the network's graph. Read from this
 * device if they are kept there (no request, works with no connection); otherwise fetched once, each only if what is published
 * now is not the one kept, and kept. Called only where the engine cannot run.
 */
async function loadRuntime(graphFrom: Promise<{ url: URL; index: DetectorIndex } | null>, o: FindOptions): Promise<RuntimeFiles> {
  const [kept, idx, at] = await Promise.all([loadFiles('runtime'), fetchJson<RuntimeIndex>(new URL(RUNTIME_INDEX, document.baseURI)), graphFrom])
  const workerUrl = new URL(cpuWorkerUrl, document.baseURI)
  const graph = at?.index.graph
  // what each part is now: its identity (version, file name, stamp), or null with no connection (then whatever is kept)
  const want: Record<keyof RuntimeFiles, string | null> = {
    ort: idx ? `ort@${idx.version}` : null, glue: idx ? `glue@${idx.version}` : null, wasm: idx ? `wasm@${idx.version}` : null,
    worker: `worker@${workerUrl.pathname.split('/').pop()}`, graph: graph ? `graph@${graph.sha256 ?? graph.file}` : null,
  }
  const have = kept?.files ?? {}
  const pick = (role: keyof RuntimeFiles) => {
    const id = want[role]
    const key = id ? (have[id] ? id : null) : Object.keys(have).find((k) => k.startsWith(role + '@')) ?? null
    return key ? { key, bytes: have[key] } : null
  }
  const out: Partial<Record<keyof RuntimeFiles, { key: string; bytes: ArrayBuffer }>> = {}
  const missing: (keyof RuntimeFiles)[] = []
  for (const role of Object.keys(want) as (keyof RuntimeFiles)[]) {
    const k = pick(role)
    if (k) out[role] = k
    else missing.push(role)
  }
  if (missing.length) {
    if (!idx || (missing.includes('graph') && !graph)) throw new DownloadError('the files the slower way needs could not be fetched')
    const gunzip = typeof DecompressionStream !== 'undefined'
    const entry = (role: 'ort' | 'glue' | 'wasm') => idx.files.find((f) => f.name === ROLES[role])
    const size = (role: keyof RuntimeFiles) => role === 'graph' ? graph!.bytes : role === 'worker' ? 0
      : gunzip && entry(role as 'wasm')?.gz ? entry(role as 'wasm')!.gz!.bytes : entry(role as 'wasm')?.bytes ?? 0
    const total = missing.reduce((n, r) => n + size(r), 0)
    let got = 0
    const counted = (n: number) => {
      got += n
      o.progress?.(Math.min(got, total), total, 'runtime')
    }
    o.progress?.(0, total, 'runtime')
    for (const role of missing) {
      let url: URL, packed = false
      if (role === 'graph') url = new URL(graph!.file, at!.url)
      else if (role === 'worker') url = workerUrl
      else {
        const e = entry(role)
        if (!e) throw new DownloadError('the runtime is not complete here')
        packed = gunzip && !!e.gz
        url = new URL(packed ? e.gz!.name : e.name, new URL(RUNTIME_INDEX, document.baseURI))
      }
      out[role] = { key: want[role]!, bytes: await fetchBytes(url, counted, o.signal, packed) }
    }
    const files = Object.fromEntries(Object.values(out).map((x) => [x!.key, x!.bytes]))
    if (!(await keepFiles('runtime', files, idx.version))) await drop('runtime')
  }
  return { ort: out.ort!.bytes, glue: out.glue!.bytes, wasm: out.wasm!.bytes, worker: out.worker!.bytes, graph: out.graph!.bytes }
}

const onDevice = (from: 'added' | 'published', gpu: boolean, src: { first?: Promise<Uint8Array>; whole: Promise<ArrayBuffer> }, runtime: () => Promise<RuntimeFiles>): Detector => {
  // (a download that fails is reported through `ready`; the bytes' own promise is then never waited for)
  src.whole.catch(() => {})
  const device = startDetector({ from, gpu, runtime, ...src })
  device.ready.catch(() => {})
  return { kind: 'device', from, device }
}

const NONE: Found = { detector: null, notOffered: false, added: false, off: false, published: null, later: false, gpu: true }

async function orService(found: Partial<Found>): Promise<Found> {
  const base = await findService()
  return { ...NONE, ...found, detector: base ? { kind: 'service', base } : null }
}

export interface FindOptions {
  /** Called as files download: bytes so far, bytes in all, and which (the detector, or the slower way's runtime). */
  progress?: (got: number, total: number, what: 'detector' | 'runtime') => void
  /** Stops the download. */
  signal?: AbortSignal
}

/**
 * The detector to use, in the order above. A detector file is started at once (on the graphics chip where this browser
 * offers WebGPU, else the slower way on the processor; prepared, self-tested and warmed up in the background; `device.ready`
 * says when, after the downloads if there are any). The slower way's files are fetched only where the engine cannot run.
 */
export async function findDetector(o: FindOptions = {}): Promise<Found> {
  if (guessOff()) return { ...NONE, off: true }
  const gpuP = webgpuOffered()
  const indexP = publishedIndex()
  const graphFrom = indexP.then((at) => (at && at !== 'unreachable' ? at : null))
  const runtime = () => loadRuntime(graphFrom, o)
  const added = await loadAdded()
  if (added) {
    const gpu = await gpuP
    return { ...NONE, gpu, detector: onDevice('added', gpu, { whole: Promise.resolve(added) }, runtime), added: true }
  }
  const [at, stored, gpu] = await Promise.all([indexP, loadKept('published'), gpuP])
  const index = at && at !== 'unreachable' ? at : null
  if (!index && !stored) return orService({ later: at === 'unreachable', gpu })
  if (stored && (!index || index.index.stamp === stored.stamp)) {
    // Kept on this device: no request for the file (and none needed with no connection).
    return { ...NONE, gpu, detector: onDevice('published', gpu, { whole: Promise.resolve(stored.bytes) }, runtime), published: { from: 'store', bytes: stored.bytes.byteLength, kept: Promise.resolve(true) } }
  }
  // Not kept yet, or a new one is published: downloaded in the background, then kept by its stamp in place of the old one.
  const dl = download(index!.index, index!.url, { ...o, progress: (g, t) => o.progress?.(g, t, 'detector') })
  let kept: (k: boolean) => void = () => {}
  const keptP = new Promise<boolean>((r) => (kept = r))
  const whole = dl.whole.then(
    async (b) => {
      let stamp = index!.index.stamp
      try {
        stamp = readHeader(b)?.stamp ?? stamp
      } catch {
        // Not a detector file: the engine's start says so.
      }
      const ok = await keep('published', b, index!.index.file ?? 'detector', stamp)
      if (!ok) await drop('published')
      kept(ok)
      return b
    },
    async (e) => {
      kept(false)
      // An older copy is better than none until the new one can be fetched (next time).
      if (stored && !o.signal?.aborted) return stored.bytes
      throw e
    },
  )
  const bytes = index!.index.bytes ?? index!.index.pieces?.reduce((s, p) => s + p.bytes, 0) ?? 0
  return { ...NONE, gpu, detector: onDevice('published', gpu, { first: dl.first, whole }, runtime), published: { from: 'download', bytes, kept: keptP } }
}

/**
 * Check a detector file the user chose and keep it on this device. Throws with a plain reason if it is not one this app
 * can use. `kept` is false if this browser would not keep it (then it is used for this session only). Adding a file
 * turns the automatic guess on.
 */
export async function addDetectorFile(file: Blob): Promise<{ detector: Detector | null; kept: boolean; notOffered: boolean }> {
  const bytes = await file.arrayBuffer()
  await readDetectorFile(bytes)
  const kept = await keepAdded(bytes, file instanceof File ? file.name : 'detector')
  await setGuessOff(false)
  const gpu = await webgpuOffered()
  const graphFrom = publishedIndex().then((at) => (at && at !== 'unreachable' ? at : null))
  return { detector: onDevice('added', gpu, { whole: Promise.resolve(bytes) }, () => loadRuntime(graphFrom, {})), kept, notOffered: false }
}

/** Remove the added detector file from this device. */
export const removeDetectorFile = (): Promise<boolean> => removeAdded()

/** Stop a detector (the engine gives back what it holds on the graphics chip). */
export function endDetector(d: Detector | null): void {
  if (d?.kind === 'device') d.device.end()
}

/** Remove the kept copy of the built-in detector (a damaged one: it is downloaded again). */
export const dropPublished = (): Promise<boolean> => drop('published')

async function askService(base: string, photo: HTMLCanvasElement): Promise<GuessRecord> {
  const blob = await new Promise<Blob | null>((resolve) => photo.toBlob(resolve, 'image/jpeg', 0.92))
  if (!blob) throw new Error('the photo could not be prepared')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60000)
  try {
    const res = await fetch(`${base}guess`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' }, signal: ctl.signal })
    if (!res.ok) throw new Error(`the detector answered ${res.status}`)
    const rec = (await res.json()) as GuessRecord
    if (!rec || !Array.isArray(rec.landmarks)) throw new Error('the detector sent something unexpected')
    if (rec.image && (rec.image.width !== photo.width || rec.image.height !== photo.height)) throw new Error('the detector measured a different picture size')
    return rec
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('the detector took too long')
    if (err instanceof TypeError) throw new Error('the detector could not be reached')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The detector's guess for the working copy of the photo; coordinates in the answer are in its pixels. A service is sent
 * the photo; the on-device detector reads it from the canvas and sends it nowhere. Each guess is also announced in the
 * page as a "spine-angles:guess" event (the record and its time), for test harnesses; nothing leaves the page that way.
 */
export async function requestGuess(d: Detector, photo: HTMLCanvasElement): Promise<GuessRecord> {
  const t0 = performance.now()
  const rec = d.kind === 'service' ? await askService(d.base, photo) : await d.device.guess(photo)
  try {
    // with the on-device detector, also how its engine started (arithmetic, self-test, times; nothing about a photo)
    const start = d.kind === 'device' ? await d.device.ready : null
    dispatchEvent(new CustomEvent('spine-angles:guess', { detail: { record: rec, kind: d.kind, ms: Math.round(performance.now() - t0), start } }))
  } catch {
    // Announcing is only for tests.
  }
  return rec
}
