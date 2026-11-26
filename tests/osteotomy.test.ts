// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

import { describe, it, expect } from 'vitest'
import { Features, compute } from '../src/sagittal'
import { rot, Pt } from '../src/geometry'
import {
  makeWedge, isWedge, moveFeatures, movePoint, pieces, Wedge, makeCage, isCage, cageCut, psoCut, moveThrough,
  moveFeaturesThrough, Cut, fromBelow,
} from '../src/osteotomy'

const P = (x: number, y: number) => ({ x, y })

/** A lateral film facing right (anterior is +x): pelvis, S1, L4, L1 and the body centres. */
const F: Features = {
  fh1: [P(520, 1120), P(560, 1120)],
  s1: [P(560, 1000), P(440, 960)], l4: [P(560, 880), P(450, 880)], l1: [P(520, 700), P(420, 720)], l1c: [P(470, 680)],
  t4c: [P(430, 330)], t1c: [P(440, 230)],
}
/** A PSO at L3: the hinge at the front of the body, the back points on its back wall. */
const HINGE = P(545, 790)
const BACK_UP = P(455, 776)
const BACK_LOW = P(455, 804)

const mapAll = (f: Features, m: (p: Pt) => Pt): Features =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v!.map(m)])) as Features

function after(f: Features, w: Wedge, t = 1, tilt = 0) {
  const before = compute(f, { tilt })
  return { before, after: compute(moveFeatures(f, w, t), { tilt, facing: before.facing }) }
}
const val = (r: ReturnType<typeof compute>, key: string) => r.results.find((x) => x.key === key)!.value

function inside(poly: Pt[], p: Pt): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

describe('PSO wedge', () => {
  const w = makeWedge(HINGE, BACK_UP, BACK_LOW)
  if (!isWedge(w)) throw new Error('no wedge')

  it('measures the angle at the hinge', () => {
    expect(w.deg).toBeCloseTo((2 * Math.atan(14 / 90) * 180) / Math.PI, 9)
  })

  it('adds exactly the wedge to lordosis and leaves the pelvis alone', () => {
    const { before, after: a } = after(F, w)
    expect(val(a, 'LL') - val(before, 'LL')).toBeCloseTo(w.deg, 9)
    expect(val(a, 'PI-LL') - val(before, 'PI-LL')).toBeCloseTo(-w.deg, 9)
    expect(val(a, 'L4S1')).toBeCloseTo(val(before, 'L4S1'), 9)
    for (const k of ['PI', 'PT', 'SS']) expect(val(a, k)).toBeCloseTo(val(before, k), 9)
    // The trunk comes back: the pelvic angles of L1, T4 and T1 fall.
    for (const k of ['L1PA', 'T4PA', 'TPA']) expect(val(a, k)).toBeLessThan(val(before, k))
  })

  it('closes part way in proportion', () => {
    const { before, after: a } = after(F, w, 0.5)
    expect(val(a, 'LL') - val(before, 'LL')).toBeCloseTo(w.deg / 2, 9)
  })

  it('does not care in which order the back points are tapped', () => {
    const w2 = makeWedge(HINGE, BACK_LOW, BACK_UP)
    if (!isWedge(w2)) throw new Error('no wedge')
    expect(w2.pU).toEqual(w.pU)
    expect(val(after(F, w2).after, 'LL')).toBeCloseTo(val(after(F, w).after, 'LL'), 9)
  })

  it('works the same on a film facing left', () => {
    const m = (p: Pt) => P(1000 - p.x, p.y)
    const wm = makeWedge(m(HINGE), m(BACK_UP), m(BACK_LOW))
    if (!isWedge(wm)) throw new Error('no wedge')
    const r = after(mapAll(F, m), wm)
    expect(r.before.facing).toBe(-1)
    expect(val(r.after, 'LL') - val(r.before, 'LL')).toBeCloseTo(w.deg, 9)
  })

  it('takes the levelling into account when deciding which piece moves', () => {
    // The photo turned 20 degrees and levelled back: the same plan.
    const m = (p: Pt) => rot(p, 20)
    const wt = makeWedge(m(HINGE), m(BACK_UP), m(BACK_LOW), -20)
    if (!isWedge(wt)) throw new Error('no wedge')
    const r = after(mapAll(F, m), wt, 1, -20)
    expect(val(r.after, 'LL') - val(r.before, 'LL')).toBeCloseTo(w.deg, 9)
    expect(val(r.after, 'PT')).toBeCloseTo(val(r.before, 'PT'), 9)
  })

  it('says why three points make no wedge', () => {
    expect(makeWedge(P(500, 800), P(450, 800), P(400, 800))).toBe('thin')
    expect(makeWedge(P(500, 800), P(480, 700), P(520, 700))).toBe('vertical')
    expect(makeWedge(P(500, 800), P(480, 900), P(520, 900))).toBe('vertical')
    // A wider wedge opening straight down is refused too; a steep PSO, as at L5 under a high sacral slope (middle line
    // 55 degrees below the horizontal), is not.
    expect(makeWedge(P(500, 800), P(530, 900), P(470, 900))).toBe('vertical')
    expect(isWedge(makeWedge(P(500, 800), P(423, 864), P(466, 894)))).toBe(true)
  })

  it('keeps the hinge still and lays the upper cut on the lower one', () => {
    expect(movePoint(w, HINGE, 1)).toEqual(HINGE)
    const moved = movePoint(w, BACK_UP, 1)
    // Both back points are 90 x 14 from the hinge, so the upper one lands on the lower one.
    expect(moved.x).toBeCloseTo(BACK_LOW.x, 9)
    expect(moved.y).toBeCloseTo(BACK_LOW.y, 9)
    expect(movePoint(w, F.s1![0], 1)).toEqual(F.s1![0])
  })

  it('cuts the picture into a piece that moves and a piece that stays', () => {
    const { moving, still } = pieces(w, 10000)
    expect(inside(moving, F.l1c![0])).toBe(true)
    expect(inside(still, F.l1c![0])).toBe(false)
    expect(inside(still, F.s1![1])).toBe(true)
    expect(inside(moving, F.s1![1])).toBe(false)
    // The bone between the cuts belongs to neither.
    const inWedge = P(470, 790)
    expect(inside(moving, inWedge) || inside(still, inWedge)).toBe(false)
  })
})

/** The L4-5 disc of the same film: the upper endplate (L4's lower one) and the lower (L5's upper one), front first. */
const DISC = [P(562, 925), P(452, 920), P(564, 945), P(454, 932)]

describe('interbody cage', () => {
  const withCuts = (f: Features, cuts: Cut[], tilt = 0) => {
    const before = compute(f, { tilt })
    return { before, after: compute(moveFeaturesThrough(f, cuts), { tilt, facing: before.facing }) }
  }
  const c = makeCage(DISC, 1)
  if (!isCage(c)) throw new Error('no cage')

  it('reads the disc angle between its endplates, front taller positive', () => {
    // upper endplate rises 5 over 110 towards the back, lower 13 over 110
    const expected = ((Math.atan2(13, 110) - Math.atan2(5, 110)) * 180) / Math.PI
    expect(c.deg).toBeCloseTo(expected, 9)
    expect(c.deg).toBeGreaterThan(0)
  })

  it('adds the change in disc angle to LL and L4-S1, and leaves the pelvis alone', () => {
    const { before, after } = withCuts(F, [cageCut(c, c.deg + 10)])
    expect(val(after, 'LL') - val(before, 'LL')).toBeCloseTo(10, 9)
    expect(val(after, 'L4S1') - val(before, 'L4S1')).toBeCloseTo(10, 9)
    for (const k of ['PI', 'PT', 'SS']) expect(val(after, k)).toBeCloseTo(val(before, k), 9)
    for (const k of ['L1PA', 'T4PA', 'TPA']) expect(val(after, k)).toBeLessThan(val(before, k))
  })

  it('sets the disc to the angle asked for, turning about the back of the disc', () => {
    const cut = cageCut(c, 18)
    const moved = DISC.map((p) => moveThrough([cut], p))
    const c2 = makeCage(moved, 1)
    if (!isCage(c2)) throw new Error('no cage after')
    expect(c2.deg).toBeCloseTo(18, 9)
    // The lower endplate stays; the middle of the back corners is the hinge.
    expect(moved[2]).toEqual(DISC[2])
    expect(moved[3]).toEqual(DISC[3])
    expect(moveThrough([cut], c.h)).toEqual(c.h)
  })

  it('does not care in which order the corners come, within or between the endplates', () => {
    const c2 = makeCage([DISC[3], DISC[2], DISC[1], DISC[0]], 1)
    if (!isCage(c2)) throw new Error('no cage')
    expect(c2.deg).toBeCloseTo(c.deg, 9)
    expect(c2.h).toEqual(c.h)
  })

  it('works the same on a film facing left, and on a levelled photo', () => {
    const m = (p: Pt) => P(1000 - p.x, p.y)
    const cm = makeCage(DISC.map(m), -1)
    if (!isCage(cm)) throw new Error('no cage')
    expect(cm.deg).toBeCloseTo(c.deg, 9)
    const r = withCuts(mapAll(F, m), [cageCut(cm, cm.deg + 10)])
    expect(val(r.after, 'LL') - val(r.before, 'LL')).toBeCloseTo(10, 9)

    const t = (p: Pt) => rot(p, 20)
    const ct = makeCage(DISC.map(t), 1, -20)
    if (!isCage(ct)) throw new Error('no cage')
    expect(ct.deg).toBeCloseTo(c.deg, 9)
    const rt = withCuts(mapAll(F, t), [cageCut(ct, ct.deg + 10, -20)], -20)
    expect(val(rt.after, 'LL') - val(rt.before, 'LL')).toBeCloseTo(10, 9)
    expect(val(rt.after, 'PT')).toBeCloseTo(val(rt.before, 'PT'), 9)
  })

  it('adds up with a PSO above it', () => {
    const w = makeWedge(HINGE, BACK_UP, BACK_LOW)
    if (!isWedge(w)) throw new Error('no wedge')
    const { before, after } = withCuts(F, [psoCut(w, 1), cageCut(c, c.deg + 10)])
    expect(val(after, 'LL') - val(before, 'LL')).toBeCloseTo(w.deg + 10, 9)
    expect(val(after, 'L4S1') - val(before, 'L4S1')).toBeCloseTo(10, 9)
    // Either order of the cuts gives the same.
    const again = withCuts(F, [cageCut(c, c.deg + 10), psoCut(w, 1)])
    expect(val(again.after, 'TPA')).toBeCloseTo(val(after, 'TPA'), 9)
  })

  it('puts a PSO at L5 above a steep L5-S1 cage, though the hinge of the cage sits higher', () => {
    // L5 tilted 35 degrees, its PSO hinge at the front wall; the L5-S1 disc below it, its back corners higher up.
    const pso = makeWedge(P(518.4, 912.9), P(488.7, 877.0), P(474.5, 897.2))
    const disc = makeCage([P(510.4, 924.4), P(473.5, 898.6), P(503.4, 934.2), P(469.0, 905.2)], 1)
    if (!isWedge(pso) || !isCage(disc)) throw new Error('no plan')
    const a = psoCut(pso, 1)
    const b = cageCut(disc, disc.deg + 8)
    expect(b.level).toBeGreaterThan(a.level)
    expect(fromBelow([a, b]).map((c) => c.kind)).toEqual(['cage', 'pso'])
    expect(fromBelow([b, a]).map((c) => c.kind)).toEqual(['cage', 'pso'])
  })

  it('refuses a disc that runs up and down the picture', () => {
    expect(makeCage([P(500, 800), P(500, 900), P(520, 800), P(520, 900)], 1)).toBe('vertical')
  })
})
