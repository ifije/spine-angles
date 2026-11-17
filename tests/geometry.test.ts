import { describe, it, expect } from 'vitest'
import { Pt, DEG, acuteAngle, cobbAngle, angle3, slopeInfo, rot, norm180 } from '../src/geometry'
import { compute, Features, detectFacing, stepsFor, MEASURE_GROUPS } from '../src/sagittal'

/** Segment of the given half-length centred at c, at `deg` clockwise from +x (y is down). */
function seg(c: Pt, deg: number, half = 20): [Pt, Pt] {
  const dx = Math.cos(deg / DEG) * half
  const dy = Math.sin(deg / DEG) * half
  return [{ x: c.x + dx, y: c.y + dy }, { x: c.x - dx, y: c.y - dy }]
}

describe('free measurements', () => {
  it('acute angle between lines', () => {
    const [a1, a2] = seg({ x: 0, y: 0 }, 10)
    const [b1, b2] = seg({ x: 0, y: 100 }, -20)
    expect(acuteAngle(a1, a2, b1, b2)).toBeCloseTo(30)
    expect(acuteAngle(a2, a1, b1, b2)).toBeCloseTo(30)
  })

  it('cobb angle is independent of tap order', () => {
    const [a1, a2] = seg({ x: 0, y: 0 }, 25)
    const [b1, b2] = seg({ x: 10, y: 200 }, -20)
    for (const [p, q, r, s] of [[a1, a2, b1, b2], [a2, a1, b1, b2], [a1, a2, b2, b1], [b1, b2, a2, a1]]) {
      expect(cobbAngle(p, q, r, s)).toBeCloseTo(45)
    }
  })

  it('cobb angle can exceed 90 degrees for stacked endplates', () => {
    const [a1, a2] = seg({ x: 0, y: 0 }, 50)
    const [b1, b2] = seg({ x: 0, y: 100 }, -50)
    expect(cobbAngle(a1, a2, b1, b2)).toBeCloseTo(100)
    expect(cobbAngle(a2, a1, b2, b1)).toBeCloseTo(100)
  })

  it('cobb angle falls back to acute for lines running along the chord', () => {
    // Two near-vertical posterior wall tangents, one above the other.
    const [a1, a2] = seg({ x: 0, y: 0 }, 85)
    const [b1, b2] = seg({ x: 5, y: 200 }, 97)
    expect(cobbAngle(a1, a2, b1, b2)).toBeCloseTo(12)
  })

  it('three point angle', () => {
    expect(angle3({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90)
    expect(angle3({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: -10, y: 10 })).toBeCloseTo(135)
  })

  it('slope picks the nearer axis', () => {
    const h = slopeInfo({ x: 0, y: 0 }, { x: 100, y: -10 })
    expect(h.ref).toBe('horizontal')
    expect(h.angle).toBeCloseTo(5.71, 1)
    const v = slopeInfo({ x: 0, y: 0 }, { x: 10, y: 100 })
    expect(v.ref).toBe('vertical')
    expect(v.angle).toBeCloseTo(5.71, 1)
  })

  it('norm180 wraps', () => {
    expect(norm180(190)).toBe(-170)
    expect(norm180(-190)).toBe(170)
  })
})

/**
 * Build a synthetic lateral spine facing image-right with known parameters.
 * Endplates are returned anterior corner first.
 */
function model(): { f: Features; expected: Record<string, number> } {
  const SS = 40, PT = 15
  const s1mid = { x: 500, y: 1000 }
  // Slope positive = anterior (right) end lower = clockwise rotation on screen.
  const endplate = (c: Pt, slope: number): Pt[] => seg(c, slope)
  // Hip axis: 100 px from the sacral midpoint, PT degrees anterior of straight down.
  const hip = { x: s1mid.x + 100 * Math.sin(PT / DEG), y: s1mid.y + 100 * Math.cos(PT / DEG) }
  // A point r px from `from`, `a` degrees anterior of vertical (upwards).
  const up = (from: Pt, a: number, r: number): Pt => ({ x: from.x + r * Math.sin(a / DEG), y: from.y - r * Math.cos(a / DEG) })
  const f: Features = {
    fh1: [{ x: hip.x - 6, y: hip.y + 2 }, { x: hip.x + 20, y: hip.y }],
    fh2: [{ x: hip.x + 6, y: hip.y - 2 }, { x: hip.x + 30, y: hip.y }],
    s1: endplate(s1mid, SS),
    l4: endplate({ x: 520, y: 880 }, 5),
    l1: endplate({ x: 480, y: 700 }, -18),
    t12: endplate({ x: 478, y: 690 }, -15),
    t4: endplate({ x: 440, y: 350 }, 28),
    t1: endplate({ x: 470, y: 250 }, 30),
    c7: endplate({ x: 475, y: 240 }, 26),
    c2: endplate({ x: 520, y: 120 }, 8),
    l1c: [up(hip, 4 - PT, 320)],
    t1c: [up(hip, 12 - PT, 760)],
    c7c: [up(s1mid, 9 - PT, 780)],
  }
  const expected = {
    PI: SS + PT, PT, SS, LL: 58, L4S1: 35, LDI: (35 / 58) * 100, 'PI-LL': -3, TK: 43,
    L1PA: 4, TPA: 12, GT: 9, T1S: 30, CL: 18, 'T1S-CL': 12,
  }
  return { f, expected }
}

const byKey = (f: Features, opts = {}) =>
  Object.fromEntries(compute(f, opts).results.map((r) => [r.key, r.value]))

const mapPts = (f: Features, fn: (p: Pt) => Pt): Features =>
  Object.fromEntries(Object.entries(f).map(([k, pts]) => [k, pts!.map(fn)]))

describe('sagittal parameters', () => {
  it('matches the synthetic model', () => {
    const { f, expected } = model()
    const got = byKey(f)
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBeCloseTo(v, 6)
    expect(compute(f).facing).toBe(1)
  })

  it('PI equals PT + SS', () => {
    const got = byKey(model().f)
    expect(got.PI).toBeCloseTo(got.PT + got.SS, 9)
  })

  it('is unchanged by a horizontal flip', () => {
    const { f, expected } = model()
    const flipped = mapPts(f, (p) => ({ x: 2000 - p.x, y: p.y }))
    expect(detectFacing(flipped)).toBe(-1)
    const got = byKey(flipped)
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBeCloseTo(v, 6)
  })

  it('does not depend on endplate tap order once facing is known', () => {
    const { f, expected } = model()
    const swapped = mapPts(f, (p) => p)
    for (const k of ['s1', 'l1', 't4', 'c2'] as const) swapped[k] = [...swapped[k]!].reverse()
    const got = byKey(swapped, { facing: 1 })
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBeCloseTo(v, 6)
  })

  it('levelling undoes a tilted photo', () => {
    const { f, expected } = model()
    const tilted = mapPts(f, (p) => rot(p, 7))
    const wrong = byKey(tilted)
    expect(Math.abs(wrong.SS - expected.SS)).toBeGreaterThan(5)
    // Angles between two endplates are unaffected by tilt.
    expect(wrong.LL).toBeCloseTo(expected.LL, 6)
    const got = byKey(tilted, { tilt: -7 })
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBeCloseTo(v, 6)
  })

  it('works with one femoral head and partial landmarks', () => {
    const { f } = model()
    const got = byKey({ fh1: f.fh1, s1: f.s1 })
    expect(Object.keys(got).sort()).toEqual(['PI', 'PT', 'SS'])
    expect(byKey({ s1: f.s1, l1: [f.l1![0]] })).toEqual({ SS: expect.closeTo(40, 6) })
  })

  it('adds notes for Schwab modifiers and age targets', () => {
    const r = compute(model().f, { age: 70 }).results
    expect(r.find((x) => x.key === 'PT')!.note).toBe('Schwab 0 · age target ≈ 25°')
    expect(r.find((x) => x.key === 'PI-LL')!.note).toContain('Schwab 0')
  })

  it('orders guided steps caudal to cranial without duplicates', () => {
    expect(stepsFor(['t1c', 's1', 'fh2', 'fh1', 's1'])).toEqual(['fh1', 'fh2', 's1', 't1c'])
    // Every guided measurement only asks for landmarks that exist, and its key is a real result.
    const keys = new Set(compute(model().f).results.map((r) => r.key))
    for (const g of MEASURE_GROUPS) for (const m of g.items) {
      expect(stepsFor(m.needs).length, m.key).toBe(new Set(m.needs).size)
      if (!m.key.startsWith('SET-')) expect(keys.has(m.key), m.key).toBe(true)
    }
  })
})
