// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

import { describe, it, expect } from 'vitest'
import {
  FEATURES, MEASURE_BY_KEY, MEASURE_GROUPS, FeatureId, Features, compute, measureState, needsText,
} from '../src/sagittal'

const P = (x: number, y: number) => ({ x, y })

/** Every landmark placed somewhere plausible (the values do not matter here, only which landmarks are there). */
const ALL: Features = {
  fh1: [P(520, 1120), P(560, 1120)], fh2: [P(540, 1110), P(580, 1110)],
  s1: [P(560, 1000), P(440, 960)], l4: [P(560, 880), P(450, 880)], l1: [P(520, 700), P(420, 720)], l1c: [P(470, 680)],
  t12: [P(515, 690), P(420, 700)], t4: [P(470, 350), P(390, 330)], t4c: [P(430, 330)], t1: [P(480, 250), P(400, 220)],
  t1c: [P(440, 230)], c7: [P(480, 240), P(400, 225)], c7c: [P(440, 215)], c2: [P(530, 120), P(450, 115)],
  po: [P(300, 1500), P(700, 1480)], ct1: [P(470, 200), P(530, 205)], ptU: [P(470, 210), P(530, 200)], ptL: [P(480, 400), P(540, 410)],
  mtU: [P(480, 410), P(540, 420)], mtL: [P(450, 800), P(510, 780)], tlU: [P(450, 810), P(510, 790)], tlL: [P(470, 1200), P(530, 1210)],
  frU: [P(470, 1250), P(530, 1260)], frL: [P(470, 1400), P(530, 1398)],
}
const pick = (...ids: FeatureId[]): Features => Object.fromEntries(ids.map((id) => [id, ALL[id]]))
/** What the automatic guess places: both femoral heads, S1, L4, L1 and the L1 body. */
const GUESS: FeatureId[] = ['fh1', 'fh2', 's1', 'l4', 'l1', 'l1c']
const guessed = Object.fromEntries(GUESS.map((id) => [id, 0.9]))
const statuses = (s: ReturnType<typeof measureState>) => Object.fromEntries(s.needs.map((n) => [n.id, n.status]))

describe('what a guided measurement needs', () => {
  it('on an empty photo, PI needs both femoral heads and S1, in prompting order', () => {
    const s = measureState(MEASURE_BY_KEY.PI, {}, undefined)
    expect(s.needs).toEqual([
      { id: 'fh1', status: 'missing', optional: false },
      { id: 'fh2', status: 'missing', optional: true },
      { id: 's1', status: 'missing', optional: false },
    ])
    expect(s.toPlace).toEqual(['fh1', 'fh2', 's1'])
    expect(s.missing).toEqual(['fh1', 's1'])
    expect(s.measured).toBe(false)
    expect(needsText(s)).toBe('needs 3 landmarks')
  })

  it('after the automatic guess, T4PA has its pelvis as guesses and needs only the T4 body', () => {
    const s = measureState(MEASURE_BY_KEY.T4PA, pick(...GUESS), guessed)
    expect(statuses(s)).toEqual({ fh1: 'guessed', fh2: 'guessed', s1: 'guessed', t4c: 'missing' })
    expect(s.toPlace).toEqual(['t4c'])
    expect(s.measured).toBe(false)
    expect(needsText(s)).toBe('needs T4 body')
    for (const key of ['PI', 'PT', 'SS', 'LL', 'L4S1', 'PI-LL', 'L1PA']) {
      const m = measureState(MEASURE_BY_KEY[key], pick(...GUESS), guessed)
      expect(m.measured, key).toBe(true)
      expect(needsText(m), key).toBe('')
      expect(m.needs.every((n) => n.status === 'guessed'), key).toBe(true)
    }
  })

  it('a kept or moved guess is placed; a landmark placed by hand is placed', () => {
    const { s1, ...rest } = guessed
    void s1
    const s = measureState(MEASURE_BY_KEY.PI, pick(...GUESS), rest)
    expect(statuses(s)).toEqual({ fh1: 'guessed', fh2: 'guessed', s1: 'placed' })
    expect(statuses(measureState(MEASURE_BY_KEY.SS, pick('s1'), undefined))).toEqual({ s1: 'placed' })
  })

  it('a deleted femoral head is what PI needs', () => {
    const s = measureState(MEASURE_BY_KEY.PI, pick('fh2', 's1'), undefined)
    expect(statuses(s)).toEqual({ fh1: 'missing', fh2: 'placed', s1: 'placed' })
    expect(s.toPlace).toEqual(['fh1'])
    expect(s.measured).toBe(false)
    expect(needsText(s)).toBe('needs femoral head')
  })

  it('the second femoral head is optional: asked for only with the first, and never blocks a value', () => {
    const one = pick('fh1', 's1')
    const pi = measureState(MEASURE_BY_KEY.PI, one, undefined)
    expect(pi.needs[1]).toEqual({ id: 'fh2', status: 'missing', optional: true })
    expect(pi.measured).toBe(true)
    expect(pi.toPlace).toEqual([])
    const t4pa = measureState(MEASURE_BY_KEY.T4PA, one, undefined)
    expect(t4pa.toPlace).toEqual(['t4c'])
    expect(needsText(t4pa)).toBe('needs T4 body')
    // Without the first head, both are asked for, the second one to be skipped if the heads overlap.
    expect(measureState(MEASURE_BY_KEY.PI, pick('s1'), undefined).toPlace).toEqual(['fh1', 'fh2'])
  })

  it('a skipped second femoral head shows as skipped next to a first one, and as missing without it', () => {
    const skipped = new Set<FeatureId>(['fh2'])
    expect(measureState(MEASURE_BY_KEY.PI, pick('fh1', 's1'), undefined, skipped).needs[1].status).toBe('skipped')
    const none = measureState(MEASURE_BY_KEY.PI, {}, undefined, skipped)
    expect(none.needs[1].status).toBe('missing')
    expect(none.toPlace).toEqual(['fh1', 'fh2', 's1'])
    // Any other skipped landmark is still missing, and still asked for.
    const t4 = measureState(MEASURE_BY_KEY.T4PA, pick('fh1', 's1'), undefined, new Set<FeatureId>(['t4c']))
    expect(t4.needs[3].status).toBe('missing')
    expect(t4.toPlace).toEqual(['t4c'])
  })

  it('a half-placed endplate is not placed', () => {
    const s = measureState(MEASURE_BY_KEY.LL, { s1: ALL.s1, l1: [ALL.l1![0]] }, undefined)
    expect(statuses(s)).toEqual({ s1: 'placed', l1: 'missing' })
    expect(needsText(s)).toBe('needs L1 superior endplate')
  })

  it('coronal measurements read the same way', () => {
    const s = measureState(MEASURE_BY_KEY['Prox T Cobb'], pick('ptU'), undefined)
    expect(statuses(s)).toEqual({ ptU: 'placed', ptL: 'missing' })
    expect(needsText(s)).toBe('needs bottom endplate, lower end vertebra')
    expect(needsText(measureState(MEASURE_BY_KEY.PO, {}, undefined))).toBe('needs pelvis (iliac crests)')
    expect(needsText(measureState(MEASURE_BY_KEY['Main T Cobb'], {}, undefined))).toBe('needs 2 landmarks')
  })

  it('a set of several lists all its landmarks', () => {
    const all = measureState(MEASURE_BY_KEY['SET-ALL'], {}, undefined)
    expect(all.toPlace).toEqual(FEATURES.filter((f) => f.plane === 'sagittal').map((f) => f.id))
    const lp = measureState(MEASURE_BY_KEY['SET-LP'], pick(...GUESS), guessed)
    expect(lp.measured).toBe(true)
  })

  it('is measured exactly when the measurement has a value, for every combination of landmarks', () => {
    for (const plane of ['sagittal', 'coronal'] as const) {
      const ids = FEATURES.filter((f) => f.plane === plane).map((f) => f.id)
      const defs = MEASURE_GROUPS.filter((g) => g.plane === plane).flatMap((g) => g.items).filter((d) => !d.set)
      for (let mask = 0; mask < 1 << ids.length; mask++) {
        const f = pick(...ids.filter((_, i) => mask & (1 << i)))
        const keys = new Set(compute(f).results.map((r) => r.key))
        for (const d of defs) {
          const s = measureState(d, f, undefined)
          if (s.measured !== keys.has(d.key)) throw new Error(`${d.key} with ${Object.keys(f).join(',')}: measured ${s.measured}`)
          // Whatever stops it being measured is among what the prompts ask for.
          expect(s.missing.every((id) => s.toPlace.includes(id))).toBe(true)
        }
      }
    }
  })

  it('names each measurement as Results does', () => {
    const labels = new Map(compute(ALL).results.map((r) => [r.key, r.label]))
    for (const g of MEASURE_GROUPS) for (const d of g.items) if (!d.set) expect(d.name, d.key).toBe(labels.get(d.key))
  })
})
