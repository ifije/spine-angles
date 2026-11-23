// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// Experiment 15 (RESULT_15_page.md; the phone's judgement of 2026-11-23): the hand-written engine (agent E's phone/engine15/js/engine.mjs and
// backend-hand.mjs, copied unchanged into js/hand/ by build.py) as the page's default backend for the combined network, with two things
// the page adds around it:
//   prepare(stepsBytes, o) -> { compileMs, ms, arithmetic }   the engine's shaders compiled as soon as its small steps file is here, while its
//        weights still download (the shaders need no weights: an engine is started on weights of zeros at a tiny size), on the device the
//        engine's own start then gets (handed over), its pipelines kept alive until release() after that start. On the phone the first
//        compile of a session took 1.25 s and the next 13 ms; the record gives the start's own compile time, which says whether it worked.
//   makeBackend(o)   backend-hand.mjs's, unchanged (16-bit numbers with 32-bit sums by default, as the reference computes; 32-bit if
//        16-bit does not compile or fails its self-test), with the page's files and hooks.
// For trying the fallbacks on a machine that compiles everything (o.test, from ?test-engine=): 'nocompile' makes every shader of the
// engine fail to compile (a syntax error added to its code on this thread: the runtime's worker is not touched), so that the page must
// fall back to the runtime; 'break16' only the 16-bit ones, so that the engine must step down to 32-bit.
import { makeBackend as handBackend } from './hand/backend-hand.mjs'
import { requestDevice, start as startEngine } from './hand/engine.mjs'

let broken = null
/** Act out shaders that do not compile (for tests only). */
export function actOut(test) {
  if (!test || broken === test || typeof GPUDevice === 'undefined') return
  const orig = broken ? GPUDevice.prototype.__createShaderModule : GPUDevice.prototype.createShaderModule
  GPUDevice.prototype.__createShaderModule = orig
  GPUDevice.prototype.createShaderModule = function (d) {
    const bad = test === 'nocompile' || (test === 'break16' && /enable f16/.test(d.code))
    return orig.call(this, bad ? { ...d, code: d.code + '\nfn broken( {}' } : d)
  }
  broken = test
}

/** The engine's shaders compiled ahead, from the steps file alone, on the device the engine will then be started on: the device is kept
 *  and handed to the engine's own start (the next device this page's thread asks an adapter for, if it has the same 16-bit feature), and
 *  the pipelines compiled here are kept alive until that start is done (release()), so that the start finds them, whatever the browser
 *  keeps between devices. Weights of zeros at 32 x 32: nothing else is made but the weights' buffers, given back in release(). */
let handOver = null
export async function prepare(stepsBytes, o = {}) {
  actOut(o.test)
  const t0 = performance.now(), steps = JSON.parse(new TextDecoder().decode(stepsBytes)), net = o.net
  const device = await requestDevice({ no16: o.arithmetic === 'f32' })
  let eng = null
  try {
    const ranges = { where: net.looks.where.maps, read: net.looks.read.maps }
    eng = await startEngine(device, { steps, q8: new ArrayBuffer(steps.q8Bytes) }, [[32, 32, 'read'], [32, 32, 'where']],
      { arithmetic: o.arithmetic === 'f32' ? 'f32' : o.arithmetic === 'f16' ? 'f16' : 'auto', input: 'u8', stats: 'shader', accumulate: 'f32', capacity: 32 * 32, lookMaps: ranges })
  } catch (e) { try { eng?.end() } catch {} try { device.destroy() } catch {} throw e }
  const h = handOver = { device, eng, used: false }
  const orig = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = function (desc) {
    const want16 = !!(desc && desc.requiredFeatures && [...desc.requiredFeatures].includes('shader-f16'))
    if (handOver === h && !h.used && want16 === h.device.features.has('shader-f16')) { h.used = true; GPUAdapter.prototype.requestDevice = orig; return Promise.resolve(h.device) }
    return orig.call(this, desc)
  }
  h.restore = () => { if (GPUAdapter.prototype.requestDevice !== orig) GPUAdapter.prototype.requestDevice = orig }
  return { compileMs: eng.startMs.compile, unpackMs: eng.startMs.unpack, ms: Math.round(performance.now() - t0), arithmetic: eng.arithmetic, pipelines: eng.pipelines }
}
/** After the engine's own start: the compile-ahead engine's buffers given back; its device, if the start did not take it, destroyed. */
export function release() {
  const h = handOver
  handOver = null
  if (!h) return null
  try { h.eng.end() } catch {}
  h.restore()
  if (!h.used) { try { h.device.destroy() } catch {} }
  return { handedOver: h.used }
}

export function makeBackend(o) {
  actOut(o.test)
  return handBackend(o)
}
