// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The on-device detector: a landmark network run on this device's graphics chip by a small WebGPU engine (hand-written
// shaders, no machine-learning runtime), and the landmark path that reads its answers. The code is copied from the
// detector's own repository (scripts/sync_detector.py); the network and every number of the path come in a detector file
// (file.ts), which this app does not include. The photo never leaves the page: it is read from the app's canvas, turned
// grey and handed to the engine.
//
//   const d = startDetector({ from: 'added', whole: bytes })   // or a file still arriving: { first, whole }
//   await d.ready                                              // engine started once, self-tested, both looks warmed up
//   const record = await d.guess(canvas)                       // a "spine-labels/1" record, in the canvas's pixels
//   d.end()

import { guessA3 } from './combo.mjs'
import { grey } from './img.mjs'
import { prepare, release, makeBackend, type EngineNet, type EngineStart } from './backend-engine.mjs'
import { makeCpuBackend, type CpuStart, type RuntimeFiles } from './backend-cpu'
import type { Grey } from './img.mjs'
import type { LookResult } from './combo.mjs'
import { readDetectorFile, readEarly, type DetectorParts } from './file'
import { toGuessRecord, type GuessRecord } from './record'

export { readDetectorFile, readHeader, DetectorFileError } from './file'
export type { GuessRecord } from './record'
export type { RuntimeFiles } from './backend-cpu'

/** The self-test's bar: the largest difference from the expected answers, as a share of their range (as the engine's backend). */
const BAR = 0.05
/** The where look's size for a 3:4 photo, the usual phone camera shape: warmed up at the start with the read look's size. */
const WHERE_WARM: [number, number] = [352, 448]

type GPUish = { requestAdapter(o?: object): Promise<object | null> }

/** Whether this browser offers WebGPU with a graphics adapter (what the engine needs). */
export async function webgpuOffered(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GPUish }).gpu
  if (!gpu) return false
  try {
    return !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

/** This browser cannot run the detector at all: neither the engine (WebGPU) nor the slower way on the processor. */
export class NotOffered extends Error {}

export interface DetectorSource {
  /** 'added': a file the user added (kept on this device); 'published': the built-in detector, published beside the app. */
  from: 'added' | 'published'
  /** The whole file. */
  whole: Promise<ArrayBuffer>
  /** Its first part (all but the weights), while the rest is still arriving: the engine is prepared from it meanwhile. */
  first?: Promise<Uint8Array>
  /** Whether to try the engine at all (this browser offers WebGPU with an adapter). */
  gpu: boolean
  /** The slower way's files (the runtime, its worker, the network's graph): fetched or read only when the engine cannot run. */
  runtime?: () => Promise<RuntimeFiles>
}

export interface ReadyInfo {
  /** 'chip': the engine on the graphics chip; 'processor': the slower way. */
  how: 'chip' | 'processor'
  /** Why the slower way: this browser has no WebGPU, or the engine did not pass its check here. */
  why: 'no-webgpu' | 'engine-failed' | null
  arithmetic: string
  selfTest: { where: number; read: number }
  /** Milliseconds from the start to ready. */
  ms: number
  engine: EngineStart | null
  cpu: CpuStart | null
  /** The slower way: about how long one photo's guess takes here, in seconds (from the warm-up looks). */
  perPhotoS: number | null
  /** Whether the shaders were compiled ahead, while the weights were still arriving. */
  compiledAhead: boolean
  stamped: boolean
}

export interface DeviceDetector {
  from: 'added' | 'published'
  /** Resolves once the network is started, self-tested and warmed up; rejects with NotOffered if it cannot run here. */
  ready: Promise<ReadyInfo>
  /** What is happening now: getting the files, or starting the network (the slower way may need its own files first). */
  readonly stage: 'file' | 'engine' | 'runtime' | 'processor' | 'ready' | 'failed'
  /** Where the start was when it failed: getting the file, starting the engine, getting the slower way's files, starting it. */
  readonly failedAt: 'file' | 'engine' | 'runtime' | 'processor' | null
  /** Why the slower way, as soon as that is known (while its files download, say); null while the engine is tried or runs. */
  readonly why: ReadyInfo['why']
  /** The guess for the photo on `photo` (its pixels are the record's). */
  guess(photo: HTMLCanvasElement): Promise<GuessRecord>
  end(): void
}

const engineNet = (p: Pick<DetectorParts, 'net'>): EngineNet => ({
  kind: 'engine15', key: p.net.key, steps: 'steps', pieces: ['weights'], q8Bytes: p.net.q8Bytes, maps: p.net.maps, looks: p.net.looks,
})
const stepsBytes = (p: Pick<DetectorParts, 'steps'>) => new TextEncoder().encode(JSON.stringify(p.steps))

interface Looker {
  look(kind: 'where' | 'read', pic: Grey): Promise<LookResult>
  end(): Promise<void>
}

/** Start the network on a detector file: the engine where it can run, else the slower way; once, held until end(). */
export function startDetector(src: DetectorSource): DeviceDetector {
  let ended = false
  let backend: Looker | null = null
  let parts: DetectorParts | null = null
  let stage: DeviceDetector['stage'] = 'file'
  let failedAt: DeviceDetector['failedAt'] = null
  let why: ReadyInfo['why'] = null

  async function engine(p: DetectorParts, ahead: Promise<unknown> | null) {
    const b = await makeBackend({
      net: engineNet(p),
      // copies made when the engine's start asks for them, and let go of after it (the engine keeps its own on the chip)
      files: { get: async (name) => (name === 'steps' ? stepsBytes(p).buffer : p.weights.slice().buffer) },
      arithmetic: 'auto',
    })
    let st: EngineStart
    try {
      if (ahead) await ahead
      st = await b.start()
    } catch (e) {
      throw new NotOffered(e instanceof Error ? e.message : String(e))
    } finally {
      if (ahead) release()
    }
    if (!(st.selfTest.where <= BAR && st.selfTest.read <= BAR)) {
      await b.end()
      throw new NotOffered(`the engine's self-test failed (where ${st.selfTest.where}, read ${st.selfTest.read})`)
    }
    // Warm both looks up at the sizes a photo brings, so that the first photo's guess is as quick as the next.
    const [rw, rh] = p.net.looks.read.size
    await b.look('read', { d: new Uint8Array(rw * rh), w: rw, h: rh })
    await b.look('where', { d: new Uint8Array(WHERE_WARM[0] * WHERE_WARM[1]), w: WHERE_WARM[0], h: WHERE_WARM[1] })
    return { b, st }
  }

  async function processor(p: DetectorParts) {
    if (!src.runtime) throw new NotOffered('no slower way is offered here')
    stage = 'runtime'
    const rt = await src.runtime()
    stage = 'processor'
    const b = makeCpuBackend(p, rt)
    let st: CpuStart
    try {
      st = await b.start()
    } catch (e) {
      await b.end()
      throw new NotOffered(`the slower way could not start: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!(st.selfTest.where <= BAR && st.selfTest.read <= BAR)) {
      await b.end()
      throw new NotOffered(`the slower way's self-test failed (where ${st.selfTest.where}, read ${st.selfTest.read})`)
    }
    return { b, st }
  }

  async function start(): Promise<ReadyInfo> {
    const t0 = performance.now()
    let ahead: Promise<unknown> | null = null
    stage = 'file'
    if (src.gpu && src.first && !parts) {
      // The shaders need only the steps: compiled while the weights are still on their way.
      const early = readEarly(await src.first)
      if (early) ahead = prepare(stepsBytes(early), { net: engineNet(early), arithmetic: 'auto' }).catch(() => null)
    }
    try {
      parts ||= await readDetectorFile(await src.whole)
      const p = parts
      why = src.gpu ? null : 'no-webgpu'
      let chip: Awaited<ReturnType<typeof engine>> | null = null
      if (src.gpu) {
        stage = 'engine'
        try {
          chip = await engine(p, ahead)
        } catch (e) {
          if (!(e instanceof NotOffered)) throw e
          why = 'engine-failed'
        }
      }
      const cpu = chip ? null : await processor(p)
      if (ended) {
        await (chip?.b ?? cpu!.b).end()
        throw new Error('the detector was ended')
      }
      backend = chip?.b ?? cpu!.b
      stage = 'ready'
      const perPhotoS = cpu ? Math.max(1, Math.round((cpu.st.warmMs.where + 1.1 * cpu.st.warmMs.read + 400) / 1000)) : null
      return {
        how: chip ? 'chip' : 'processor', why, arithmetic: chip ? chip.st.arithmetic : 'f32', selfTest: chip ? chip.st.selfTest : cpu!.st.selfTest,
        ms: Math.round(performance.now() - t0), engine: chip?.st ?? null, cpu: cpu?.st ?? null, perPhotoS, compiledAhead: !!ahead, stamped: p.stamped,
      }
    } catch (e) {
      if (ahead) release()
      const at = stage as DeviceDetector['stage']
      failedAt = at === 'ready' || at === 'failed' ? null : at
      stage = 'failed'
      throw e
    }
  }

  let ready = start()
  ready.catch(() => {})

  return {
    from: src.from,
    get ready() {
      return ready
    },
    get stage() {
      return stage
    },
    get why() {
      return why
    },
    get failedAt() {
      return failedAt
    },
    async guess(photo) {
      if (ended) throw new Error('the detector was ended')
      const i = await ready
      const b = backend, p = parts
      if (!b || !p) throw new Error('the detector was ended')
      const t0 = performance.now()
      const ctx = photo.getContext('2d')
      if (!ctx) throw new Error('the photo could not be read')
      const pic = grey(ctx.getImageData(0, 0, photo.width, photo.height).data, photo.width, photo.height)
      try {
        const r = await guessA3((kind, q) => b.look(kind, q), p.spec, p.prior, pic)
        return toGuessRecord(r, { detector: p.header.detector, stamp: p.header.stamp.slice(0, 16), arithmetic: i.how === 'processor' ? 'processor' : i.arithmetic, seconds: (performance.now() - t0) / 1000 })
      } catch (e) {
        // The graphics device can be lost (the system takes it back); start again for the next photo.
        if (!ended) {
          backend = null
          void b.end().catch(() => {})
          ready = start()
          ready.catch(() => {})
        }
        throw e
      }
    },
    end() {
      ended = true
      const b = backend
      backend = null
      void b?.end().catch(() => {})
    },
  }
}
