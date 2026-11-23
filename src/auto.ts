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

import { readDetectorFile, readHeader, startDetector, webgpuOffered, type DeviceDetector, type GuessRecord } from './detector'
import { download, isIndex, type DetectorIndex } from './detector/download'
import { drop, keep, keepAdded, loadAdded, loadKept, removeAdded } from './detector/store'

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
  if (off) await drop('published')
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

const onDevice = (from: 'added' | 'published', src: { first?: Promise<Uint8Array>; whole: Promise<ArrayBuffer> }): Detector => {
  // (a download that fails is reported through `ready`; the bytes' own promise is then never waited for)
  src.whole.catch(() => {})
  const device = startDetector({ from, ...src })
  device.ready.catch(() => {})
  return { kind: 'device', from, device }
}

const NONE: Found = { detector: null, notOffered: false, added: false, off: false, published: null, later: false }

async function orService(found: Partial<Found>): Promise<Found> {
  const base = await findService()
  return { ...NONE, ...found, detector: base ? { kind: 'service', base } : null }
}

export interface FindOptions {
  /** Called as the built-in detector downloads: bytes so far, bytes in all. */
  progress?: (got: number, total: number) => void
  /** Stops the download. */
  signal?: AbortSignal
}

/**
 * The detector to use, in the order above. A detector file is started at once (its engine prepared, self-tested and
 * warmed up in the background; `device.ready` says when, after the download if there is one). Where a detector is here
 * but this browser offers no WebGPU, `notOffered` is set, nothing is downloaded and a service is still looked for.
 */
export async function findDetector(o: FindOptions = {}): Promise<Found> {
  if (guessOff()) return { ...NONE, off: true }
  const added = await loadAdded()
  if (added) {
    if (await webgpuOffered()) return { ...NONE, detector: onDevice('added', { whole: Promise.resolve(added) }), added: true }
    return orService({ notOffered: true, added: true })
  }
  const [at, stored] = await Promise.all([publishedIndex(), loadKept('published')])
  const index = at && at !== 'unreachable' ? at : null
  if (!index && !stored) return orService({ later: at === 'unreachable' })
  if (!(await webgpuOffered())) return orService({ notOffered: true })
  if (stored && (!index || index.index.stamp === stored.stamp)) {
    // Kept on this device: no request for the file (and none needed with no connection).
    return { ...NONE, detector: onDevice('published', { whole: Promise.resolve(stored.bytes) }), published: { from: 'store', bytes: stored.bytes.byteLength, kept: Promise.resolve(true) } }
  }
  // Not kept yet, or a new one is published: downloaded in the background, then kept by its stamp in place of the old one.
  const dl = download(index!.index, index!.url, o)
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
  return { ...NONE, detector: onDevice('published', { first: dl.first, whole }), published: { from: 'download', bytes, kept: keptP } }
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
  if (!(await webgpuOffered())) return { detector: null, kept, notOffered: true }
  return { detector: onDevice('added', { whole: Promise.resolve(bytes) }), kept, notOffered: false }
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
