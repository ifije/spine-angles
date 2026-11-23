// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The detector file the user added, kept on this device (IndexedDB). Nothing else is kept here: never a photo. Every call
// is wrapped: where storage is refused or missing (a private window, a full device) the app works without it, and a file
// added then is used for that session only. The store is not even opened unless a file was added on this device.

const DB = 'spine-angles'
const STORE = 'detector'
const KEY = 'file'
/** Remembered beside the store, so that someone who never added a file never has a store opened (or made). */
const FLAG = 'spine-angles:detector-file'
const WAIT = 4000

interface Kept {
  bytes: ArrayBuffer
  name: string
  added: string
}

function flag(on?: boolean): boolean | null {
  try {
    if (on === true) localStorage.setItem(FLAG, '1')
    else if (on === false) localStorage.removeItem(FLAG)
    return localStorage.getItem(FLAG) === '1'
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

/** Whether a file may have been added here (without opening the store when it is known that none was). */
async function mayHave(): Promise<boolean> {
  const f = flag()
  if (f !== null) return f
  try {
    const list = await indexedDB.databases?.()
    if (list) return list.some((d) => d.name === DB)
  } catch {
    // Not answerable: look.
  }
  return true
}

/** The added detector file's bytes, or null. */
export async function loadAdded(): Promise<ArrayBuffer | null> {
  if (typeof indexedDB === 'undefined' || !(await mayHave())) return null
  const kept = await run<Kept>('readonly', (s) => s.get(KEY))
  return kept && kept.bytes instanceof ArrayBuffer ? kept.bytes : null
}

/** Keep a detector file on this device. False if this browser would not keep it. */
export async function keepAdded(bytes: ArrayBuffer, name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  const ok = await run<boolean>('readwrite', (s) => s.put({ bytes, name, added: new Date().toISOString() } satisfies Kept, KEY))
  if (!ok) return false
  flag(true)
  try {
    // Ask the browser not to clear it when space runs short; a refusal changes nothing.
    void navigator.storage?.persist?.().catch(() => {})
  } catch {
    // Not offered.
  }
  return true
}

/** Remove the added detector file from this device. */
export async function removeAdded(): Promise<boolean> {
  flag(false)
  if (typeof indexedDB === 'undefined') return true
  return (await run<boolean>('readwrite', (s) => s.delete(KEY))) === true
}
