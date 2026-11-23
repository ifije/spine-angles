// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// The combined network (experiment 15, A3) run by the hand-written engine, behind the interface the page's runtime backend has too:
//
//   const b = await makeBackend({ net, files, base, arithmetic })
//     net: the manifest entry export.py writes (out/phone/engine15/a3/net.json): { kind: 'engine15', key, steps: file name, pieces:
//          [file names], q8Bytes, sha256, maps, looks: { where: { maps: [25, 28] }, read: { size: [w, h], maps: [0, 25] } }, files }
//     files: { get(name) } or the page's { take(name) } -> Promise<ArrayBuffer>, for a file named in the entry
//     base: the page's folder address (not needed by this backend; taken for the common interface)
//     arithmetic: 'f16', 'f32' or 'auto' (16-bit where the chip offers it). 16-bit means 16-bit numbers with 32-bit sums, as the
//     reference computes (PyTorch's 16-bit on the card); o.accumulate 'same' gives sums in 16-bit too: faster, but its landmarks
//     stray from the reference's as the runtime's 16-bit do (RESULT_15_engine.md, "A3 on the engine")
//   await b.start()  -> { arithmetic, selfTest: { where, read }, heldBytes, startMs }
//     the weights joined from their pieces and unpacked, the engine started (one fixed set of buffers for both looks), then each look
//     run once on a made-up picture against the trained network's stored 32-bit answers (the self-test; it also warms each look up).
//     16-bit is given up for 32-bit, and why recorded (`refused16`), if its shaders do not compile or its self-test is above 0.05.
//   await b.look(look, pic) -> { d: Float32Array, maps, first, w, h, ms }
//     look 'where' or 'read' (any size, multiples of 32: the read look is 384 x 576, but the page's search with no where candidate
//     asks it for others); pic { d: grey bytes (Uint8Array), w, h } as the page's img.mjs makes them, the scaling to the network's
//     numbers ((x / 255 - 0.45) / 0.225) done by the engine; d: the look's own raw maps (`maps` of them, the first being map `first`
//     of the network's 28; where 25 to 27, read 0 to 24), map after map, each h rows of w. As phone/web/js/backend-ort.mjs.
//   Optional, as the page's backends: o.mark(state) called before the start and before every look (so that the page can tell what
//   the phone was doing if it closed the page), o.stepped(from, to, why) when 16-bit is given up for 32-bit.
//   await b.end()
//
// Works on a page's main thread and in a worker alike (it uses nothing but WebGPU). Looks are queued, never overlapped.
import { requestDevice, start as startEngine } from './engine.mjs'

const BAR = 0.05

export async function makeBackend(o = {}) {
  const { net, files, base, arithmetic = 'auto', stats = 'shader', accumulate = 'f32', powerPreference } = o
  if (!net || net.kind !== 'engine15') throw new Error('not a network for the hand-written engine')
  const READ = net.looks.read.size
  let eng = null, device = null, steps = null
  const now = () => performance.now()
  const fetchFile = (name) => (files.get ? files.get(name) : files.take(name))
  const ranges = { where: net.looks.where.maps || [0, net.maps], read: net.looks.read.maps || [0, net.maps] }
  return {
    kind: 'hand',
    base,
    async start() {
      const t0 = now()
      o.mark?.({ net: net.key, step: 'start' })
      const [stepsBuf, ...parts] = await Promise.all([fetchFile(net.steps), ...net.pieces.map((p) => fetchFile(p))])
      steps = JSON.parse(new TextDecoder().decode(stepsBuf))
      const q8 = new Uint8Array(net.q8Bytes)
      let at = 0
      for (const p of parts) { q8.set(new Uint8Array(p), at); at += p.byteLength }
      if (at !== net.q8Bytes || steps.q8Bytes !== net.q8Bytes) throw new Error(`the weights are ${at} bytes, the network says ${net.q8Bytes}`)
      const tFiles = now()
      const [wh, ww] = steps.selftest.where.size, [rh, rw] = steps.selftest.read.size
      const sizes = [[READ[0], READ[1], 'read'], [ww, wh, 'where']]
      if (rw !== READ[0] || rh !== READ[1]) sizes.push([rw, rh, 'read'])
      const tries = arithmetic === 'f32' ? ['f32'] : arithmetic === 'f16' ? ['f16', 'f32'] : ['auto', 'f32']
      const out = { refused16: null }
      for (const ar of tries) {
        try {
          const t1 = now()
          device = await requestDevice({ no16: ar === 'f32', powerPreference })
          const t2 = now()
          eng = await startEngine(device, { steps, q8: q8.buffer }, sizes, { arithmetic: ar, input: 'u8', stats, accumulate, capacity: READ[0] * READ[1], lookMaps: ranges })
          const t3 = now()
          const selfTest = { where: await eng.check(steps.selftest.where, { look: 'where' }), read: await eng.check(steps.selftest.read, { look: 'read' }) }
          Object.assign(out, { deviceMs: Math.round(t2 - t1), selfTestMs: Math.round(now() - t3) })
          if (eng.arithmetic === 'f16' && !(selfTest.where <= BAR && selfTest.read <= BAR)) throw new Error(`16-bit self-test off: where ${selfTest.where}, read ${selfTest.read}`)
          out.selfTest = selfTest
          break
        } catch (e) {
          try { eng?.end() } catch {}
          try { device?.destroy() } catch {}
          eng = device = null
          if (ar === 'f32') throw e
          out.refused16 = String(e && e.message ? e.message : e).slice(0, 300)
          o.stepped?.('gpu16', 'gpu32', out.refused16)
        }
      }
      const r6 = (v) => Math.round(v * 1e6) / 1e6
      return { arithmetic: eng.arithmetic, selfTest: { where: r6(out.selfTest.where), read: r6(out.selfTest.read) }, heldBytes: eng.bytes.total, startMs: Math.round(now() - t0),
        filesMs: Math.round(tFiles - t0), deviceMs: out.deviceMs, engineMs: eng.startMs, selfTestMs: out.selfTestMs, describe: eng.describe, ...(out.refused16 ? { refused16: out.refused16 } : {}) }
    },
    async look(look, pic) {
      if (!eng) throw new Error('the backend is not started')
      if (look !== 'where' && look !== 'read') throw new Error('a look is "where" or "read"')
      o.mark?.({ net: net.key, how: eng.arithmetic === 'f16' ? 'gpu16' : 'gpu32', step: 'run', look, megapixels: Math.round(pic.w * pic.h / 1e4) / 100 })
      const t0 = now()
      const d = await eng.look(pic.d, [pic.w, pic.h], null, { look })
      const [m0, m1] = ranges[look]
      return { d, maps: m1 - m0, first: m0, w: pic.w, h: pic.h, ms: Math.round((now() - t0) * 10) / 10 }
    },
    /** What it holds on the chip now (bytes; it grows only if a where look larger than the read look is asked for). */
    get heldBytes() { return eng ? eng.bytes.total : 0 },
    async end() {
      try { eng?.end() } catch {}
      try { device?.destroy() } catch {}
      eng = device = null
    },
  }
}
