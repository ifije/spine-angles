// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The on-device detector's two pure parts: the detector file's format (with a tiny made-up file: no trained number
// is in this repository) and the conversion of the landmark path's answer into a "spine-labels/1" guess, including which
// landmarks the path gives at each level of confidence.

import { describe, it, expect } from 'vitest'
import { readDetectorFile, readEarly, readHeader, DetectorFileError, DETECTOR_FORMAT } from '../src/detector/file'
import { toGuessRecord, type PathResult } from '../src/detector/record'
import { named } from '../src/detector/combo.mjs'
import { readLabels, LABEL_SCHEMA } from '../src/labels'

// ---------------------------------------------------------------- a made-up detector file

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
const MADE_UP_WEIGHTS = Uint8Array.from({ length: 37 }, (_, i) => (i * 7 + 3) & 255)

function sections(over: Record<string, unknown> = {}): Record<string, Uint8Array> {
  return {
    path: enc({ spec: { variant: 'made up', accept: { shown: 0.15 } }, prior: { mean: [[0, 0, 0, 0]], icov: [[[1, 0, 0, 0]]] },
      net: { kind: 'engine15', key: 'toy', q8Bytes: MADE_UP_WEIGHTS.length, maps: 3, looks: { where: { maps: [2, 3] }, read: { size: [32, 32], maps: [0, 2] } } }, ...((over.path as object) ?? {}) }),
    steps: enc({ format: 'engine15-steps-1', q8Bytes: MADE_UP_WEIGHTS.length, steps: [{ op: 'conv' }], ...((over.steps as object) ?? {}) }),
    statistics: enc({ names: ['where', 'read'], where: { scale: 'AA==', shift: 'AA==' }, read: { scale: 'AA==', shift: 'AA==' } }),
    selftest: enc({ where: { size: [32, 32], peaks: [] }, read: { size: [32, 32], peaks: [] } }),
    weights: (over.weights as Uint8Array) ?? MADE_UP_WEIGHTS,
  }
}

/** The layout make_detector.py writes: magic, header length, header, then each section at a multiple of 8. */
async function makeFile(parts = sections(), o: { format?: string; magic?: string; drop?: string; overlap?: boolean } = {}): Promise<Uint8Array> {
  const order = ['path', 'steps', 'statistics', 'selftest', 'weights'].filter((n) => n !== o.drop)
  let headerLen = 400
  for (;;) {
    let at = 12 + headerLen
    at += (8 - (at % 8)) % 8
    const body = at
    const secs = order.map((name) => {
      const s = { name, kind: name === 'weights' ? 'bytes' : 'json', offset: at, length: parts[name].length }
      at += parts[name].length
      at += (8 - (at % 8)) % 8
      return s
    })
    const last = secs[secs.length - 1]
    const total = last.offset + last.length
    if (o.overlap) secs[1].offset = secs[0].offset + 8
    const out = new Uint8Array(total)
    for (const s of secs) out.set(parts[s.name].subarray(0, Math.min(parts[s.name].length, total - s.offset)), s.offset)
    const stamp = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(body))), (x) => x.toString(16).padStart(2, '0')).join('')
    const header = enc({ format: o.format ?? DETECTOR_FORMAT, detector: 'toy', title: 'made up', made: '2026-11-23', bytes: total, body, stamp, sections: secs })
    if (header.length > headerLen) {
      headerLen = header.length
      continue
    }
    out.set(new TextEncoder().encode((o.magic ?? 'SPINEDET').padEnd(8).slice(0, 8)), 0)
    new DataView(out.buffer).setUint32(8, header.length, true)
    out.set(header, 12)
    return out
  }
}

const fails = async (b: Uint8Array, text: RegExp) => {
  await expect(readDetectorFile(b)).rejects.toBeInstanceOf(DetectorFileError)
  await expect(readDetectorFile(b)).rejects.toThrow(text)
}

describe('detector file', () => {
  it('reads every part of a well-formed file, its content stamp checked', async () => {
    const f = await makeFile()
    const p = await readDetectorFile(f)
    expect(p.stamped).toBe(true)
    expect(p.header.format).toBe(DETECTOR_FORMAT)
    expect(Array.from(p.weights)).toEqual(Array.from(MADE_UP_WEIGHTS))
    expect(p.steps.format).toBe('engine15-steps-1')
    // The engine takes its steps whole: the two looks' statistics and the self-test are put back in.
    expect(Object.keys(p.steps)).toEqual(expect.arrayContaining(['steps', 'looks', 'selftest']))
    expect((p.steps.looks as { names: string[] }).names).toEqual(['where', 'read'])
    expect(p.spec.variant).toBe('made up')
    expect(p.prior.mean).toHaveLength(1)
    expect(p.net.looks.read.size).toEqual([32, 32])
    expect(p.net.q8Bytes).toBe(MADE_UP_WEIGHTS.length)
  })

  it('refuses a file that is not a detector file', async () => {
    await fails(await makeFile(undefined, { magic: 'NOTADET!' }), /not a detector file/)
    await fails(new TextEncoder().encode('{"format": "spine-detector/1"}'), /not a detector file|damaged/)
    await fails(await makeFile(undefined, { drop: 'selftest' }), /not a detector file/)
    await fails(await makeFile(undefined, { overlap: true }), /not a detector file/)
  })

  it('says when a file is of a newer kind', async () => {
    await fails(await makeFile(undefined, { format: 'spine-detector/2' }), /cannot read/)
  })

  it('finds a changed byte or a missing end', async () => {
    const f = await makeFile()
    const changed = f.slice()
    changed[changed.length - 3] ^= 1
    await fails(changed, /damaged or incomplete/)
    await fails(f.slice(0, f.length - 5), /damaged or incomplete/)
  })

  it('refuses weights of another length than the steps say', async () => {
    await fails(await makeFile(sections({ weights: MADE_UP_WEIGHTS.subarray(0, 30) })), /damaged/)
  })

  it('reads the header and the parts before the weights from a first piece alone', async () => {
    const f = await makeFile()
    expect(readHeader(f.subarray(0, 11))).toBeNull()
    expect(readHeader(f.subarray(0, 20))).toBeNull()
    const h = readHeader(f)!
    const w = h.sections.find((s) => s.name === 'weights')!
    expect(readEarly(f.subarray(0, w.offset - 9))).toBeNull()
    const early = readEarly(f.subarray(0, w.offset))!
    expect(early.steps.format).toBe('engine15-steps-1')
    expect(early.net.key).toBe('toy')
  })
})

// ---------------------------------------------------------------- the guess as a record

const P = (x: number, y: number): [number, number] => [x, y]
/** A lumbar chain of 22 corners, L1 at the top, each endplate 100 px long, facing image left (front ends at smaller x). */
const chainPts = Array.from({ length: 22 }, (_, k) => P(1000 + (k % 2) * 100, 1000 + Math.floor(k / 2) * 80))
const pel = (verify: number) => ({ A: P(990, 1900), B: P(1095, 1870), H: P(900, 2200), heads: [P(880, 2190), P(930, 2210)],
  conf: { hip: verify, s1_ant: 0.7, s1_post: 0.8 }, verify })
const chain = (flagged: boolean) => ({ pts: chainPts, flagged, support: 0.45 })
const SPEC = { accept: { shown: 0.15 } }

function result(look: { pel: ReturnType<typeof pel> | null; chain: ReturnType<typeof chain> }, tier = 'all'): PathResult {
  const { landmarks, pelvisMode, chainGiven } = named(SPEC, look)
  const at = Object.fromEntries(landmarks.map((l) => [l.name, l]))
  return {
    width: 3000, height: 4000, landmarks,
    facing: at.S1_sup_ant && at.S1_sup_post ? (at.S1_sup_ant.x > at.S1_sup_post.x ? 'right' : 'left') : null,
    guess: { tier, pipeline_result: 'All four angles', pelvis_confidence: look.pel ? look.pel.verify : null, lumbar_support: 0.45,
      lumbar_chain_given: chainGiven, s1_from: pelvisMode ? 'close-up maps' : chainGiven ? 'lumbar chain' : null, s1_tilt_difference_between_networks: null },
  }
}
const made = { detector: 'toy', stamp: '0123456789abcdef', arithmetic: 'f16', seconds: 0.4321 }
const names = (r: PathResult) => r.landmarks.map((l) => l.name)

describe('the on-device guess as a record', () => {
  it('gives the femoral heads, S1 from the pelvis, the lumbar endplates and the L1 body when a pelvis is shown', () => {
    const r = result({ pel: pel(0.6), chain: chain(false) })
    expect(names(r)).toEqual([
      'femoral_head_a_center', 'femoral_head_b_center', 'S1_sup_ant', 'S1_sup_post',
      ...['L1', 'L2', 'L3', 'L4', 'L5'].flatMap((lv) => ['sup', 'inf'].flatMap((pl) => [`${lv}_${pl}_ant`, `${lv}_${pl}_post`])), 'L1_center',
    ])
    const rec = toGuessRecord(r, made)
    expect(rec.schema).toBe(LABEL_SCHEMA)
    expect(rec.view).toBe('lateral')
    expect(rec.region).toBe('lumbar')
    expect(rec.image).toMatchObject({ width: 3000, height: 4000 })
    const byName = Object.fromEntries(rec.landmarks.map((l) => [l.name, l]))
    expect(byName.S1_sup_ant).toMatchObject({ x: 990, y: 1900, visible: true, annotator: 'auto', confidence: 0.7 })
    expect(byName.femoral_head_a_center.confidence).toBe(0.6)
    expect(byName.L1_center).toMatchObject({ x: 1050, y: 1040, confidence: 0.45 })
    expect(rec.guess).toMatchObject({ pipeline_result: 'All four angles', on_device: true, seconds: 0.43, lumbar_chain_given: true })
    expect(rec.patient).toEqual({})
  })

  it('takes S1 from the lumbar chain when no pelvis is shown, and gives no femoral head', () => {
    const r = result({ pel: pel(0.1), chain: chain(false) }, 'lumbar')
    const n = names(r)
    expect(n).not.toContain('femoral_head_a_center')
    expect(n.slice(0, 2)).toEqual(['S1_sup_ant', 'S1_sup_post'])
    const s1 = r.landmarks.find((l) => l.name === 'S1_sup_ant')!
    expect([s1.x, s1.y]).toEqual(chainPts[20])
    expect(s1.confidence).toBe(0.45)
    expect(result({ pel: null, chain: chain(false) }, 'lumbar').landmarks).toHaveLength(r.landmarks.length)
  })

  it('leaves a tangled chain out', () => {
    const r = result({ pel: pel(0.6), chain: chain(true) }, 'pelvis')
    expect(names(r)).toEqual(['femoral_head_a_center', 'femoral_head_b_center', 'S1_sup_ant', 'S1_sup_post'])
    const rec = toGuessRecord(r, made)
    expect(rec.region).toBe('pelvis')
    expect(toGuessRecord(result({ pel: pel(0.1), chain: chain(true) }, 'none'), made)).toMatchObject({ landmarks: [], view: 'unknown', region: 'other', facing: null })
  })

  it('is placed by the app as its landmarks, each with the lowest confidence of its points', () => {
    const rec = toGuessRecord(result({ pel: pel(0.6), chain: chain(false) }), made)
    const got = readLabels(rec, 50)
    expect(Object.keys(got.features).sort()).toEqual(['fh1', 'fh2', 'l1', 'l1c', 'l4', 's1'])
    expect(got.features.s1).toEqual([{ x: 990, y: 1900 }, { x: 1095, y: 1870 }])
    expect(got.features.l4).toEqual([chainPts[12], chainPts[13]].map(([x, y]) => ({ x, y })))
    expect(got.confidence).toMatchObject({ s1: 0.7, fh1: 0.6, l1: 0.45, l1c: 0.45 })
  })
})
