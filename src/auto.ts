// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Automatic guess: an optional detector service, run by the user on their own machine, that
// is sent the photo and answers with landmarks in the "spine-labels/1" format. Without one
// the app behaves exactly as before and nothing leaves the device.

import type { LabelRecord } from './labels'

const KEY = 'spine-angles:detector'
const SERVICE = 'spine-guess'

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
 * Address of a detector, or null. Looked for, in order: `?detector=URL` on the page address
 * (remembered for next time; an empty value forgets it), the remembered address, and the
 * place the app itself was loaded from, which is where the detector serves it.
 */
export async function findDetector(): Promise<string | null> {
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

/** Send the working copy of the photo; coordinates in the answer are in its pixels. */
export async function requestGuess(base: string, photo: HTMLCanvasElement): Promise<LabelRecord> {
  const blob = await new Promise<Blob | null>((resolve) => photo.toBlob(resolve, 'image/jpeg', 0.92))
  if (!blob) throw new Error('the photo could not be prepared')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60000)
  try {
    const res = await fetch(`${base}guess`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' }, signal: ctl.signal })
    if (!res.ok) throw new Error(`the detector answered ${res.status}`)
    const rec = (await res.json()) as LabelRecord
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
