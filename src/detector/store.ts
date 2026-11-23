// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Detector files kept on this device (IndexedDB): the built-in detector, downloaded once and kept by its content stamp,
// a detector file the user added, and (only where the slower way is needed) the processor runtime's files. Nothing else is kept here: never a photo. Every call is wrapped: where storage is
// refused or missing (a private window, a full device) the app works without it. The store is not opened at all until
// something has been kept in it on this device.

const DB = 'spine-angles'
const STORE = 'detector'
const WAIT = 4000

/** 'file': a detector file the user added; 'published': the built-in detector, as downloaded from beside the app;
 *  'runtime': the slower way's files (the processor runtime, its worker, the network's graph). */
export type Slot = 'file' | 'published' | 'runtime'

/** Remembered beside the store, so that the store is only opened (or made) once something was kept in it. */
const FLAG: Record<Slot, string> = { file: 'spine-angles:detector-file', published: 'spine-angles:detector-kept', runtime: 'spine-angles:runtime-kept' }

export interface Kept {
  bytes: ArrayBuffer
  name: string
  /** The detector file's content stamp (SHA-256, hex), where known. */
  stamp?: string
  added: string
}

function flag(slot: Slot, on?: boolean): boolean | null {
  try {
    if (on === true) localStorage.setItem(FLAG[slot], '1')
    else if (on === false) localStorage.removeItem(FLAG[slot])
    return localStorage.getItem(FLAG[slot]) === '1'
  } catch {
    return null
  }
}

/** The database, or null (no IndexedDB, refused, or no answer in time). */
function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (db: IDBDatabase | null) => {
      if (done) {
        db?.close()
        return
      }
      done = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => finish(null), WAIT)
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => finish(req.result)
      req.onerror = () => finish(null)
      req.onblocked = () => finish(null)
    } catch {
      finish(null)
    }
  })
}

function run<T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const tx = db.transaction(STORE, mode)
          const req = act(tx.objectStore(STORE))
          let value: T | null = null
          req.onsuccess = () => (value = (req.result as T) ?? null)
          tx.oncomplete = () => {
            db.close()
            resolve(mode === 'readonly' ? value : (true as T))
          }
          tx.onerror = tx.onabort = () => {
            db.close()
            resolve(null)
          }
        } catch {
          db.close()
          resolve(null)
        }
      }),
    () => null,
  )
}

/** Whether something may have been kept in this slot (without opening the store when it is known that nothing was). */
async function mayHave(slot: Slot): Promise<boolean> {
  const f = flag(slot)
  if (f !== null) return f
  try {
    const list = await indexedDB.databases?.()
    if (list) return list.some((d) => d.name === DB)
  } catch {
    // Not answerable: look.
  }
  return true
}

/** What is kept in a slot, or null. */
export async function loadKept(slot: Slot): Promise<Kept | null> {
  if (typeof indexedDB === 'undefined' || !(await mayHave(slot))) return null
  const kept = await run<Kept>('readonly', (s) => s.get(slot))
  return kept && kept.bytes instanceof ArrayBuffer ? kept : null
}

/** Keep a detector file in a slot (replacing what was there). False if this browser would not keep it. */
export async function keep(slot: Slot, bytes: ArrayBuffer, name: string, stamp?: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  const ok = await run<boolean>('readwrite', (s) => s.put({ bytes, name, stamp, added: new Date().toISOString() } satisfies Kept, slot))
  if (!ok) return false
  flag(slot, true)
  try {
    // Ask the browser not to clear it when space runs short; a refusal changes nothing.
    void navigator.storage?.persist?.().catch(() => {})
  } catch {
    // Not offered.
  }
  return true
}

/** Several files kept together under one stamp (the slower way's). */
export interface KeptFiles {
  files: Record<string, ArrayBuffer>
  stamp: string
  added: string
}

/** The files kept in a slot, or null. */
export async function loadFiles(slot: Slot): Promise<KeptFiles | null> {
  if (typeof indexedDB === 'undefined' || !(await mayHave(slot))) return null
  const kept = await run<KeptFiles>('readonly', (s) => s.get(slot))
  return kept && kept.files && Object.values(kept.files).every((b) => b instanceof ArrayBuffer) ? kept : null
}

/** Keep several files in a slot under one stamp (replacing what was there). False if this browser would not keep them. */
export async function keepFiles(slot: Slot, files: Record<string, ArrayBuffer>, stamp: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  const ok = await run<boolean>('readwrite', (s) => s.put({ files, stamp, added: new Date().toISOString() } satisfies KeptFiles, slot))
  if (ok) flag(slot, true)
  return !!ok
}

/** Remove what is kept in a slot. */
export async function drop(slot: Slot): Promise<boolean> {
  const had = flag(slot)
  flag(slot, false)
  if (typeof indexedDB === 'undefined' || had === false) return true
  return (await run<boolean>('readwrite', (s) => s.delete(slot))) === true
}

/** The added detector file's bytes, or null. */
export const loadAdded = async (): Promise<ArrayBuffer | null> => (await loadKept('file'))?.bytes ?? null
/** Keep the added detector file on this device. False if this browser would not keep it. */
export const keepAdded = (bytes: ArrayBuffer, name: string): Promise<boolean> => keep('file', bytes, name)
/** Remove the added detector file from this device. */
export const removeAdded = (): Promise<boolean> => drop('file')
