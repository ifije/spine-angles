// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Automatic guess: landmarks found by a detector, placed as guesses for the user to drag, keep or delete. The app looks
// for a detector in this order:
//   1. a detector file the user added ("Add detector file"), kept on this device: the guess is worked out on this device;
//   2. a detector file beside the app (detector/index.json naming the file or its pieces), only in a build made to look
//      for one (SPINE_ANGLES_TEST_BUILD=1): likewise worked out on this device;
//   3. a detector service the user runs on their own machine, which is sent the photo and answers with landmarks.
// Each answers with a record in the "spine-labels/1" format. Without any of them the app behaves exactly as before and
// nothing leaves the device.

import { readDetectorFile, startDetector, webgpuOffered, type DeviceDetector, type GuessRecord } from './detector'
import { keepAdded, loadAdded, removeAdded } from './detector/store'

export { NotOffered, DetectorFileError } from './detector'
export type { GuessRecord } from './detector'

export type Detector = { kind: 'service'; base: string } | { kind: 'device'; from: 'added' | 'beside'; device: DeviceDetector }

export interface Found {
  detector: Detector | null
  /** A detector file is here, but this browser cannot run it (no WebGPU). */
  notOffered: boolean
  /** The user has added a detector file, kept on this device. */
  added: boolean
}

const KEY = 'spine-angles:detector'
const SERVICE = 'spine-guess'
/** Where a build made for it looks for a detector file served beside the app. */
const BESIDE = 'detector/index.json'

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

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

interface BesideIndex {
  /** One file, or the pieces that joined make it (for a host with a limit on a file's size). */
  file?: string
  pieces?: { name: string; bytes: number }[]
  bytes?: number
}

/** The detector file beside the app: its index, or null if there is none. */
async function besideIndex(): Promise<{ url: URL; index: BesideIndex } | null> {
  // (resolved as the page's own relative addresses are, which also holds where a host gives the page a base address)
  const url = new URL(BESIDE, document.baseURI)
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) return null
    const index = (await res.json()) as BesideIndex
    return index && (typeof index.file === 'string' || (Array.isArray(index.pieces) && index.pieces.length)) ? { url, index } : null
  } catch {
    return null
  }
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('the detector file beside the app could not be fetched')
  return res.arrayBuffer()
}

/** The file beside the app, fetched: its first piece early (the engine is prepared from it), then the whole. */
function fetchBeside(at: { url: URL; index: BesideIndex }): { first?: Promise<Uint8Array>; whole: Promise<ArrayBuffer> } {
  const { url, index } = at
  if (index.file) return { whole: fetchBytes(new URL(index.file, url)) }
  const parts = index.pieces!.map((p) => fetchBytes(new URL(p.name, url)))
  const whole = Promise.all(parts).then((got) => {
    const n = got.reduce((s, b) => s + b.byteLength, 0)
    if (index.bytes !== undefined && n !== index.bytes) throw new Error('the detector file beside the app arrived incomplete')
    const all = new Uint8Array(n)
    let at = 0
    for (const b of got) {
      all.set(new Uint8Array(b), at)
      at += b.byteLength
    }
    return all.buffer
  })
  return { first: parts[0].then((b) => new Uint8Array(b)), whole }
}

const onDevice = (from: 'added' | 'beside', src: { first?: Promise<Uint8Array>; whole: Promise<ArrayBuffer> }): Detector => {
  const device = startDetector({ from, ...src })
  device.ready.catch(() => {})
  return { kind: 'device', from, device }
}

/**
 * The detector to use, in the order above. A detector file is started at once (its engine prepared, self-tested and
 * warmed up in the background; `device.ready` says when). Where a file is here but this browser offers no WebGPU,
 * `notOffered` is set and a service is still looked for.
 */
export async function findDetector(): Promise<Found> {
  const added = await loadAdded()
  let notOffered = false
  if (added) {
    if (await webgpuOffered()) return { detector: onDevice('added', { whole: Promise.resolve(added) }), notOffered, added: true }
    notOffered = true
  } else if (__DETECTOR_BESIDE__) {
    const beside = await besideIndex()
    if (beside) {
      if (await webgpuOffered()) return { detector: onDevice('beside', fetchBeside(beside)), notOffered, added: false }
      notOffered = true
    }
  }
  const base = await findService()
  return { detector: base ? { kind: 'service', base } : null, notOffered, added: !!added }
}

/**
 * Check a detector file the user chose and keep it on this device. Throws with a plain reason if it is not one this app
 * can use. `kept` is false if this browser would not keep it (then it is used for this session only).
 */
export async function addDetectorFile(file: Blob): Promise<{ detector: Detector | null; kept: boolean; notOffered: boolean }> {
  const bytes = await file.arrayBuffer()
  await readDetectorFile(bytes)
  const kept = await keepAdded(bytes, file instanceof File ? file.name : 'detector')
  if (!(await webgpuOffered())) return { detector: null, kept, notOffered: true }
  return { detector: onDevice('added', { whole: Promise.resolve(bytes) }), kept, notOffered: false }
}

/** Remove the added detector file from this device. */
export const removeDetectorFile = (): Promise<boolean> => removeAdded()

/** Stop a detector (the engine gives back what it holds on the graphics chip). */
export function endDetector(d: Detector | null): void {
  if (d?.kind === 'device') d.device.end()
}

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
