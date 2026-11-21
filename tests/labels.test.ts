// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

import { describe, it, expect } from 'vitest'
import { buildLabels, hasLabels, featureLabel, readLabels, rimPoint, LABEL_SCHEMA, LabelInput } from '../src/labels'
import { compute, Features } from '../src/sagittal'
import type { Doc } from '../src/model'

const P = (x: number, y: number) => ({ x, y })

function build(features: Features, extra: Partial<LabelInput> = {}, tilt = 0, facingOverride = 0) {
  const doc: Doc = { measures: [], features, tilt }
  const sag = compute(features, { tilt, facing: facingOverride })
  return buildLabels({
    doc, width: 3000, height: 4000, facing: sag.facing, facingAuto: !facingOverride,
    skipped: [], results: sag.results, imageFile: 'x.jpg', imageId: 'x',
    saved: '2026-11-18T00:00:00.000Z', appVersion: 'test', ...extra,
  })
}
const byName = (r: ReturnType<typeof build>) => Object.fromEntries(r.landmarks.map((l) => [l.name, l]))

// Patient facing image right: anterior corners have the larger x.
const pelvisRight: Features = {
  fh1: [P(1500, 3000), P(1560, 3000)],
  s1: [P(1400, 2600), P(1250, 2500)],
  l1: [P(1500, 1800), P(1350, 1790)],
}

describe('label export', () => {
  it('names endplate ends by level, plate and anterior/posterior', () => {
    const r = build(pelvisRight)
    const lm = byName(r)
    expect(r.schema).toBe(LABEL_SCHEMA)
    expect(r.view).toBe('lateral')
    expect(r.facing).toBe('right')
    expect(lm.S1_sup_ant).toMatchObject({ x: 1400, y: 2600 })
    expect(lm.S1_sup_post).toMatchObject({ x: 1250, y: 2500 })
    expect(lm.L1_sup_ant.x).toBe(1500)
    expect(lm.femoral_head_a_center).toMatchObject({ x: 1500, y: 3000 })
    expect(r.circles).toEqual([{ name: 'femoral_head_a', cx: 1500, cy: 3000, r: 60, annotator: null }])
  })

  it('gives the same names when the patient faces left', () => {
    const mirror = (f: Features): Features =>
      Object.fromEntries(Object.entries(f).map(([k, pts]) => [k, pts!.map((p) => P(3000 - p.x, p.y))])) as Features
    const r = build(mirror(pelvisRight))
    const lm = byName(r)
    expect(r.facing).toBe('left')
    expect(lm.S1_sup_ant.x).toBe(1600)
    expect(lm.S1_sup_post.x).toBe(1750)
  })

  it('uses the facing direction, not tap order, to decide which end is anterior', () => {
    // S1 tapped posterior first; L1 and L4 tapped correctly, so the vote is still "right".
    const f: Features = { ...pelvisRight, s1: [P(1250, 2500), P(1400, 2600)], l4: [P(1450, 2300), P(1300, 2280)] }
    const lm = byName(build(f))
    expect(lm.S1_sup_ant.x).toBe(1400)
    expect(lm.S1_sup_post.x).toBe(1250)
  })

  it('follows a manual facing choice', () => {
    const r = build(pelvisRight, {}, 0, -1)
    expect(r.facing).toBe('left')
    expect(r.app.facing_auto).toBe(false)
    expect(byName(r).S1_sup_ant.x).toBe(1250)
  })

  it('keeps coordinates in image pixels when the photo is levelled', () => {
    const r = build(pelvisRight, {}, 7.5)
    expect(byName(r).S1_sup_ant).toMatchObject({ x: 1400, y: 2600 })
    expect(r.app.level_deg).toBe(7.5)
  })

  it('does not claim a facing direction from femoral heads alone', () => {
    const r = build({ fh1: [P(1500, 3000), P(1560, 3000)] })
    expect(r.view).toBe('lateral')
    expect(r.facing).toBeNull()
    expect(r.region).toBe('pelvis')
  })

  it('names coronal line ends by image side', () => {
    const r = build({ mtU: [P(1700, 900), P(1300, 1000)], mtL: [P(1250, 2000), P(1650, 2100)], po: [P(2000, 3300), P(900, 3350)] })
    const lm = byName(r)
    expect(r.view).toBe('frontal')
    expect(r.facing).toBeNull()
    expect(r.region).toBe('whole_spine')
    expect(lm.cobb_mt_upper_l.x).toBe(1300)
    expect(lm.cobb_mt_upper_r.x).toBe(1700)
    expect(lm['other:pelvis_ref_l'].x).toBe(900)
    expect(r.measurements['Main T Cobb']).toBeGreaterThan(0)
  })

  it('leaves out half-placed lines and lists landmarks marked not visible', () => {
    const r = build({ ...pelvisRight, l4: [P(1450, 2300)] }, { skipped: ['fh2', 'l4'] })
    expect(byName(r).L4_sup_ant).toBeUndefined()
    // l4 has a point placed, so it is unfinished, not "not visible".
    expect(r.labels.not_visible).toEqual(['femoral_head_b'])
  })

  it('copies the computed parameters and nothing about the patient', () => {
    const r = build(pelvisRight)
    const sag = compute(pelvisRight)
    for (const res of sag.results) expect(r.measurements[res.key]).toBeCloseTo(res.value, 1)
    expect(Object.keys(r.measurements)).toContain('PI')
    expect(r.patient).toEqual({})
    expect(r.tier).toBe('private')
  })

  it('classifies the region from the levels that were labelled', () => {
    expect(build({ c2: [P(10, 10), P(5, 12)], c7: [P(12, 60), P(6, 62)] }).region).toBe('cervical')
    expect(build({ s1: pelvisRight.s1, l1: pelvisRight.l1 }).region).toBe('lumbar')
    expect(build({ ...pelvisRight, t1c: [P(1500, 600)] }).region).toBe('whole_spine')
    expect(build({ t4: [P(10, 10), P(5, 12)], t12: [P(12, 60), P(6, 62)] }).region).toBe('thoracic')
    expect(build({ t1: [P(10, 10), P(5, 12)] }).region).toBe('cervical')
    expect(build({ ...pelvisRight, t4: [P(1300, 900), P(1180, 860)] }).region).toBe('whole_spine')
  })

  it('reports whether there is anything to save', () => {
    expect(hasLabels(build({}))).toBe(false)
    expect(hasLabels(build(pelvisRight))).toBe(true)
    expect(featureLabel('t12')).toBe('T12_inf')
  })

  it('uses only names from the shared scheme', () => {
    const all: Features = {
      fh1: [P(1500, 3000), P(1560, 3000)], fh2: [P(1520, 3010), P(1580, 3010)], s1: pelvisRight.s1, l4: [P(1450, 2300), P(1300, 2280)],
      l1: pelvisRight.l1, l1c: [P(1420, 1850)], t12: [P(1490, 1700), P(1340, 1690)], t4: [P(1300, 900), P(1180, 860)],
      t1: [P(1250, 650), P(1150, 600)], t1c: [P(1200, 660)], c7: [P(1260, 560), P(1160, 520)], c7c: [P(1210, 520)], c2: [P(1280, 300), P(1200, 280)],
    }
    const scheme = [
      /^(C[1-7]|T([1-9]|1[0-2])|L[1-6]|S[12])_(sup|inf)_(ant|post|l|r)$/, /^(C[1-7]|T([1-9]|1[0-2])|L[1-6]|S[12])_center$/,
      /^femoral_head_(a|b|left|right)_center$/, /^cobb_(pt|mt|tl)_(upper|lower)_(l|r)$/, /^other:.+$/,
    ]
    const r = build(all)
    expect(r.landmarks).toHaveLength(8 * 2 + 3 + 2)
    for (const l of r.landmarks) expect(scheme.some((re) => re.test(l.name)), l.name).toBe(true)
    expect(new Set(r.landmarks.map((l) => l.name)).size).toBe(r.landmarks.length)
  })
})

describe('reading labels back (an automatic guess)', () => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

  it('gives back the landmarks a saved record was built from', () => {
    const features: Features = {
      fh1: [P(1500, 3000), P(1560, 3000)], fh2: [P(1520, 3010), P(1580, 3010)], s1: pelvisRight.s1, l4: [P(1450, 2300), P(1300, 2280)],
      l1: pelvisRight.l1, l1c: [P(1420, 1850)], t12: [P(1490, 1700), P(1340, 1690)], c2: [P(1280, 300), P(1200, 280)],
    }
    const back = readLabels(build(features), 50).features
    expect(Object.keys(back).sort()).toEqual(Object.keys(features).sort())
    for (const id of ['s1', 'l4', 'l1', 'l1c', 't12', 'c2'] as const) expect(back[id]).toEqual(features[id])
    // A head comes back as its centre and a rim point at the same radius.
    expect(back.fh1![0]).toEqual(P(1500, 3000))
    expect(dist(back.fh1![0], back.fh1![1])).toBeCloseTo(60, 1)
    expect(compute(back).results.find((r) => r.key === 'PI')!.value).toBeCloseTo(compute(features).results.find((r) => r.key === 'PI')!.value, 1)
  })

  it('reads a guess: extra levels ignored, half a line ignored, confidence kept', () => {
    const lm = (name: string, x: number, y: number, confidence: number) => ({ name, x, y, visible: true, annotator: 'auto', confidence })
    const got = readLabels({
      landmarks: [
        lm('S1_sup_ant', 400, 900, 0.6), lm('S1_sup_post', 500, 850, 0.8), lm('L1_sup_ant', 380, 300, 0.4), lm('L1_sup_post', 480, 310, 0.4),
        lm('L3_inf_ant', 370, 600, 0.4), lm('L3_inf_post', 470, 610, 0.4), lm('L4_sup_ant', 372, 640, 0.4),
        lm('L1_center', 430, 340, 0.4), lm('femoral_head_a_center', 300, 1100, 0.9), lm('femoral_head_b_center', 320, 1110, 0.9),
      ],
      circles: [{ name: 'femoral_head_a', cx: 300, cy: 1100, r: 44, annotator: 'auto' }],
    }, 30)
    expect(Object.keys(got.features).sort()).toEqual(['fh1', 'fh2', 'l1', 'l1c', 's1'])
    expect(got.features.s1).toEqual([P(400, 900), P(500, 850)])
    expect(got.confidence.s1).toBe(0.6)
    expect(got.confidence.fh1).toBe(0.9)
    expect(got.features.fh1![1]).toEqual(rimPoint(P(300, 1100), 44))
    // No circle for the second head: its radius is taken from the S1 length.
    expect(dist(got.features.fh2![0], got.features.fh2![1])).toBeCloseTo(0.7 * Math.hypot(100, 50), 5)
    expect(readLabels({ landmarks: [lm('femoral_head_a_center', 10, 10, 0.5)], circles: [] }, 30).features.fh1![1]).toEqual(rimPoint(P(10, 10), 30))
  })

  it('marks untouched guesses as such when they are saved, and only those', () => {
    const doc: Doc = { measures: [], features: { ...pelvisRight }, tilt: 0, auto: { s1: 0.6, fh1: 0.9 } }
    const sag = compute(doc.features)
    const r = buildLabels({
      doc, width: 3000, height: 4000, facing: sag.facing, facingAuto: true, skipped: [], results: sag.results,
      imageFile: 'x.jpg', imageId: 'x', saved: '2026-11-20T00:00:00.000Z', appVersion: 'test',
    })
    const who = Object.fromEntries(r.landmarks.map((l) => [l.name, l.annotator]))
    expect(who).toMatchObject({ S1_sup_ant: 'auto', S1_sup_post: 'auto', femoral_head_a_center: 'auto', L1_sup_ant: null, L1_sup_post: null })
    expect(r.circles[0].annotator).toBe('auto')
    expect(r.notes).toContain('automatic guess')
    expect(build(pelvisRight).notes).toContain('Labelled by hand')
  })
})
