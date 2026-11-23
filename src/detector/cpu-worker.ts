// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The slower way's worker: the same network as the engine, run by ONNX Runtime Web on the processor (one thread), so that the
// page stays responsive during a guess that takes seconds. Built as its own file (fetched and kept on the device with the
// runtime, only where the engine cannot run). Everything it needs comes in its first message: the runtime's files, the
// network's graph (no weights) and, from the detector file, the 8-bit weights, their table and each look's statistics.
//   start { ort, glue, wasm, graph, q8, entry, offsets, scale, shift, selftest, looks, warm } -> both looks' sessions, each
//          self-tested on the made-up picture and warmed up at the size it sees: { deviation, warmMs, createMs, threads }
//   run   { look, d, w, h }  -> { maps (the look's own, Float32Array), maps count, first, w, h, ms }
//   end

import { unpack } from './unpack.mjs'
import { phantom, deviation } from './hand/engine.mjs'

type Looks = { where: [number, number]; read: [number, number] }
// The runtime's API as this worker uses it (ONNX Runtime Web is loaded at run time from the bytes it is sent).
interface OrtTensor { data: Float32Array; dims: number[]; dispose?: () => void }
interface OrtSession { run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>; release(): Promise<void> }
interface Ort {
  env: { logLevel: string; wasm: { numThreads: number; wasmPaths: unknown; wasmBinary?: ArrayBuffer | Uint8Array } }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
  InferenceSession: { create(model: Uint8Array, o: unknown): Promise<OrtSession> }
}

let ort: Ort | null = null
let sessions: Partial<Record<'where' | 'read', OrtSession>> = {}
let looks: Looks | null = null

const answer = (id: number, body: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id, ...body }, transfer)
const blobUrl = (b: ArrayBuffer, type: string) => URL.createObjectURL(new Blob([b], { type }))

function tensor(d: ArrayLike<number>, w: number, h: number) {
  const x = new Float32Array(d.length)
  for (let i = 0; i < x.length; i++) x[i] = d[i]
  return new ort!.Tensor('float32', x, [1, 1, h, w])
}

/** The where look's numbers in place of the read look's: each convolution's channel scales times the where look's scale,
 *  its biases the where look's shift (the detector file's statistics, as the engine applies them). */
function whereOver(entry: { tensors: number[][] }, q8: ArrayBuffer, offsets: number[], scale: Float32Array, shift: Float32Array) {
  const over = new Map<number, Float32Array>()
  offsets.forEach((o, j) => {
    const [, n, , ch, at] = entry.tensors[2 * j], [, nb, , , atb] = entry.tensors[2 * j + 1]
    const s = new Float32Array(q8, Math.ceil((at + n) / 4) * 4, ch), w = new Float32Array(ch)
    for (let c = 0; c < ch; c++) w[c] = s[c] * scale[o + c]
    over.set(at, w)
    over.set(atb, shift.slice(o, o + nb))
  })
  return over
}

async function run(look: 'where' | 'read', d: ArrayLike<number>, w: number, h: number) {
  const s = sessions[look]
  if (!s) throw new Error('the network is not started')
  const t0 = performance.now(), out = (await s.run({ image: tensor(d, w, h) })).maps
  const [m0, m1] = looks![look], n = w * h
  const maps = out.data.slice(m0 * n, m1 * n)
  out.dispose?.()
  return { maps, count: m1 - m0, first: m0, w, h, ms: performance.now() - t0 }
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data
  try {
    if (m.type === 'start') {
      const t0 = performance.now()
      ort = (await import(/* @vite-ignore */ blobUrl(m.ort, 'text/javascript'))) as Ort
      ort.env.logLevel = 'error'
      // One thread: the page is not cross-origin isolated, which threads need.
      ort.env.wasm.numThreads = m.threads || 1
      ort.env.wasm.wasmPaths = { mjs: blobUrl(m.glue, 'text/javascript') }
      ort.env.wasm.wasmBinary = new Uint8Array(m.wasm)
      looks = m.looks
      const graph = new Uint8Array(m.graph), dev: Record<string, number> = {}, warmMs: Record<string, number> = {}
      let createMs = 0
      // One look at a time, so that only one look's 50 MB of weights is ever held here besides the runtime's own copy.
      for (const look of ['read', 'where'] as const) {
        const over = look === 'where' ? whereOver(m.entry, m.q8, m.offsets, new Float32Array(m.scale), new Float32Array(m.shift)) : null
        const weights = unpack(m.entry, m.q8, over)
        const tc = performance.now()
        sessions[look] = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'], graphOptimizationLevel: 'all',
          externalData: [{ path: 'weights.bin', data: new Uint8Array(weights.buffer) }] })
        createMs += performance.now() - tc
        const want = m.selftest[look], [h, w] = want.size
        const r = await run(look, phantom(w, h), w, h)
        dev[look] = deviation(want, r.maps, w, h)
        const [ww, wh] = m.warm[look]
        warmMs[look] = (await run(look, new Uint8Array(ww * wh), ww, wh)).ms
      }
      answer(m.id, { ok: true, deviation: dev, warmMs, createMs, threads: ort.env.wasm.numThreads, ms: performance.now() - t0 })
    } else if (m.type === 'run') {
      const r = await run(m.look, m.d, m.w, m.h)
      answer(m.id, { ok: true, ...r }, [r.maps.buffer])
    } else if (m.type === 'end') {
      for (const s of Object.values(sessions)) { try { await s!.release() } catch { /* gone */ } }
      sessions = {}
      answer(m.id, { ok: true })
    }
  } catch (e) {
    answer(m.id, { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) })
  }
}
