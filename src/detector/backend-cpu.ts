// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The slower way: the same network as the engine, run on the processor by ONNX Runtime Web in a worker (cpu-worker.ts), behind
// the engine backend's interface, so that the landmark path (combo.mjs) and the record are the same. Used only where the
// engine cannot run (no WebGPU, no graphics adapter, or its self-test failed in 16-bit and in 32-bit).

import type { Grey } from './img.mjs'
import type { LookResult } from './combo.mjs'
import type { DetectorParts } from './file'

/** What the slower way needs besides the detector file: the runtime's three files, the worker, the network's graph. */
export interface RuntimeFiles {
  ort: ArrayBuffer
  glue: ArrayBuffer
  wasm: ArrayBuffer
  worker: ArrayBuffer
  graph: ArrayBuffer
}

export interface CpuStart {
  selfTest: { where: number; read: number }
  /** A look at the sizes a photo brings, after the warm-up: milliseconds. */
  warmMs: { where: number; read: number }
  createMs: number
  threads: number
  ms: number
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer

/** The where look's size for a 3:4 photo, the usual phone camera shape (as the engine's warm-up). */
const WHERE_WARM: [number, number] = [352, 448]

export function makeCpuBackend(parts: DetectorParts, rt: RuntimeFiles, o: { threads?: number } = {}) {
  let worker: Worker | null = null
  let seq = 0
  const waiting = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>()
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      if (!worker) return fail(new Error('the slower way has stopped'))
      const id = ++seq
      waiting.set(id, { ok, fail })
      worker.postMessage({ ...msg, id }, transfer)
    })
  const looks = parts.net.looks
  return {
    kind: 'cpu',
    async start(): Promise<CpuStart> {
      const url = URL.createObjectURL(new Blob([rt.worker], { type: 'text/javascript' }))
      worker = new Worker(url, { type: 'module' })
      URL.revokeObjectURL(url)
      worker.onmessage = (ev) => {
        const x = waiting.get(ev.data.id)
        if (!x) return
        waiting.delete(ev.data.id)
        if (ev.data.ok) x.ok(ev.data)
        else x.fail(new Error(ev.data.error))
      }
      worker.onerror = (ev) => {
        const e = new Error(`the slower way stopped: ${String(ev.message || 'its worker failed').slice(0, 200)}`)
        for (const x of waiting.values()) x.fail(e)
        waiting.clear()
        worker = null
      }
      const statistics = parts.steps.looks as { offsets: number[]; where: { scale: string; shift: string } }
      const q8 = parts.weights.slice().buffer
      const [rw, rh] = looks.read.size
      const r = await call({
        type: 'start', ort: rt.ort, glue: rt.glue, wasm: rt.wasm, graph: rt.graph, q8,
        entry: { bytes: parts.steps.bytes, tensors: parts.steps.tensors },
        offsets: statistics.offsets, scale: b64(statistics.where.scale), shift: b64(statistics.where.shift),
        selftest: parts.steps.selftest, looks: { where: looks.where.maps, read: looks.read.maps },
        warm: { read: [rw, rh], where: WHERE_WARM }, threads: o.threads ?? 1,
      }, [q8])
      return { selfTest: r.deviation as CpuStart['selfTest'], warmMs: r.warmMs as CpuStart['warmMs'], createMs: r.createMs as number, threads: r.threads as number, ms: r.ms as number }
    },
    async look(look: 'where' | 'read', pic: Grey): Promise<LookResult> {
      const d = pic.d.slice()
      const r = await call({ type: 'run', look, d, w: pic.w, h: pic.h }, [d.buffer])
      return { d: r.maps as Float32Array, maps: r.count as number, first: r.first as number, w: r.w as number, h: r.h as number, ms: r.ms as number }
    },
    async end() {
      try {
        if (worker) await Promise.race([call({ type: 'end' }), new Promise((r) => setTimeout(r, 2000))])
      } catch {
        // Ending anyway.
      }
      worker?.terminate()
      worker = null
      for (const x of waiting.values()) x.fail(new Error('stopped'))
      waiting.clear()
    },
  }
}

export type CpuBackend = ReturnType<typeof makeCpuBackend>
