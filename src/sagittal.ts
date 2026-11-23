// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Guided sagittal workflow: landmark definitions and parameter calculations.

import { Pt, mid, norm180, endplateSlope, tiltFromVertical, pelvicIncidence, rot, cobbAngle, slopeInfo } from './geometry'

export type FeatureId =
  | 'fh1' | 'fh2' | 's1' | 'l4' | 'l1' | 'l1c' | 't12' | 't4' | 't4c' | 't1' | 't1c' | 'c7' | 'c7c' | 'c2'
  // coronal
  | 'po' | 'ct1' | 'ptU' | 'ptL' | 'mtU' | 'mtL' | 'tlU' | 'tlL' | 'frU' | 'frL'

export type Plane = 'sagittal' | 'coronal'

export type FeatureKind = 'line' | 'point' | 'circle'

export interface FeatureDef {
  id: FeatureId
  plane: Plane
  kind: FeatureKind
  /** Short label drawn on the image. */
  tag: string
  /** Name used in prompts. */
  name: string
  /** One prompt per tap. */
  prompts: string[]
}

const line = (id: FeatureId, tag: string, name: string): FeatureDef => ({
  id, plane: 'sagittal', kind: 'line', tag, name,
  prompts: ['tap the anterior corner', 'now tap the posterior corner'],
})
const point = (id: FeatureId, tag: string, name: string): FeatureDef => ({
  id, plane: 'sagittal', kind: 'point', tag, name, prompts: ['tap the centre of the vertebral body'],
})
/** Coronal lines have no anterior/posterior end, so tap order never matters. */
const cline = (id: FeatureId, tag: string, name: string, prompts = ['tap one end', 'now tap the other end']): FeatureDef => ({
  id, plane: 'coronal', kind: 'line', tag, name, prompts,
})
const curve = (upper: FeatureId, lower: FeatureId, tag: string, name: string): FeatureDef[] => [
  cline(upper, tag, `${name} curve, top endplate of the upper end vertebra`),
  cline(lower, tag, `${name} curve, bottom endplate of the lower end vertebra`),
]

/** Prompting order: sagittal landmarks caudal to cranial, then coronal. */
export const FEATURES: FeatureDef[] = [
  { id: 'fh1', plane: 'sagittal', kind: 'circle', tag: 'FH', name: 'Femoral head',
    prompts: ['tap its centre, then drag the circle to fit'] },
  { id: 'fh2', plane: 'sagittal', kind: 'circle', tag: 'FH', name: 'Second femoral head',
    prompts: ['tap its centre, or skip if the heads overlap'] },
  line('s1', 'S1', 'S1 superior endplate'),
  line('l4', 'L4', 'L4 superior endplate'),
  line('l1', 'L1', 'L1 superior endplate'),
  point('l1c', 'L1', 'L1 body'),
  line('t12', 'T12', 'T12 inferior endplate'),
  line('t4', 'T4', 'T4 superior endplate'),
  point('t4c', 'T4', 'T4 body'),
  line('t1', 'T1', 'T1 superior endplate'),
  point('t1c', 'T1', 'T1 body'),
  line('c7', 'C7', 'C7 inferior endplate'),
  point('c7c', 'C7', 'C7 body'),
  line('c2', 'C2', 'C2 inferior endplate'),
  cline('po', 'PO', 'Pelvis', ['tap the top of one iliac crest (or sacral ala)', 'now tap the same point on the other side']),
  cline('ct1', 'T1', 'T1 upper endplate'),
  ...curve('ptU', 'ptL', 'PT', 'Proximal thoracic'),
  ...curve('mtU', 'mtL', 'MT', 'Main thoracic'),
  ...curve('tlU', 'tlL', 'TL/L', 'Thoracolumbar/lumbar'),
  cline('frU', 'Frac', 'Fractional curve, top endplate of L4 (or L3)'),
  cline('frL', 'Frac', 'Fractional curve, S1 endplate'),
]

export const FEATURE_BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f])) as Record<FeatureId, FeatureDef>

export const pointsNeeded = (kind: FeatureKind): number => (kind === 'line' ? 2 : 1)
/** Points stored once complete (a circle keeps a second point on its rim). */
export const pointsStored = (kind: FeatureKind): number => (kind === 'point' ? 1 : 2)

/** A measurement the user can ask to be guided through. `key` matches Result.key. */
export interface MeasureDef {
  key: string
  label: string
  needs: FeatureId[]
}

const PELVIS: FeatureId[] = ['fh1', 'fh2', 's1']

export const MEASURE_GROUPS: { plane: Plane; title: string; items: MeasureDef[] }[] = [
  { plane: 'sagittal', title: 'Pelvis', items: [
    { key: 'PI', label: 'PI', needs: PELVIS },
    { key: 'PT', label: 'PT', needs: PELVIS },
    { key: 'SS', label: 'SS', needs: ['s1'] },
  ] },
  { plane: 'sagittal', title: 'Lumbar', items: [
    { key: 'LL', label: 'LL', needs: ['s1', 'l1'] },
    { key: 'L4S1', label: 'L4–S1', needs: ['s1', 'l4'] },
    { key: 'PI-LL', label: 'PI−LL', needs: [...PELVIS, 'l1'] },
  ] },
  { plane: 'sagittal', title: 'Thoracic', items: [{ key: 'TK', label: 'TK T4–T12', needs: ['t12', 't4'] }] },
  { plane: 'sagittal', title: 'Global', items: [
    { key: 'L1PA', label: 'L1PA', needs: [...PELVIS, 'l1c'] },
    { key: 'T4PA', label: 'T4PA', needs: [...PELVIS, 't4c'] },
    { key: 'TPA', label: 'TPA', needs: [...PELVIS, 't1c'] },
    { key: 'GT', label: 'Global tilt', needs: [...PELVIS, 'c7c'] },
  ] },
  { plane: 'sagittal', title: 'Cervical', items: [
    { key: 'T1S', label: 'T1 slope', needs: ['t1'] },
    { key: 'CL', label: 'C2–C7', needs: ['c7', 'c2'] },
    { key: 'T1S-CL', label: 'T1S−CL', needs: ['t1', 'c7', 'c2'] },
  ] },
  { plane: 'sagittal', title: 'Several at once', items: [
    { key: 'SET-LP', label: 'Pelvis + lumbar', needs: [...PELVIS, 'l4', 'l1'] },
    { key: 'SET-ALL', label: 'Everything', needs: FEATURES.filter((f) => f.plane === 'sagittal').map((f) => f.id) },
  ] },
  { plane: 'coronal', title: 'Curves (Cobb)', items: [
    { key: 'Prox T Cobb', label: 'Proximal thoracic', needs: ['ptU', 'ptL'] },
    { key: 'Main T Cobb', label: 'Main thoracic', needs: ['mtU', 'mtL'] },
    { key: 'TL/L Cobb', label: 'TL / lumbar', needs: ['tlU', 'tlL'] },
    { key: 'Fractional', label: 'Fractional', needs: ['frU', 'frL'] },
  ] },
  { plane: 'coronal', title: 'Pelvis and shoulders', items: [
    { key: 'PO', label: 'Pelvic obliquity', needs: ['po'] },
    { key: 'T1 tilt', label: 'T1 tilt', needs: ['ct1'] },
  ] },
  { plane: 'coronal', title: 'Several at once', items: [
    { key: 'SET-COR', label: 'All coronal', needs: FEATURES.filter((f) => f.plane === 'coronal').map((f) => f.id) },
  ] },
]

/** The given landmarks in prompting order (caudal to cranial), without duplicates. */
export function stepsFor(needs: FeatureId[]): FeatureId[] {
  const wanted = new Set(needs)
  return FEATURES.filter((f) => wanted.has(f.id)).map((f) => f.id)
}

export type Features = Partial<Record<FeatureId, Pt[]>>

export function isComplete(features: Features, id: FeatureId): boolean {
  const pts = features[id]
  return !!pts && pts.length >= pointsStored(FEATURE_BY_ID[id].kind)
}

export interface Result {
  plane: Plane
  key: string
  label: string
  value: number
  unit: '°' | '%'
  note?: string
}

export interface SagittalResults {
  /** +1 if the patient faces image right, -1 if left. */
  facing: 1 | -1
  results: Result[]
}

/**
 * Which way the patient faces. Endplates are tapped anterior corner first, so each
 * complete endplate votes; `override` (non-zero) wins.
 */
export function detectFacing(features: Features, override = 0): 1 | -1 {
  if (override) return override > 0 ? 1 : -1
  let votes = 0
  for (const f of FEATURES) {
    const pts = features[f.id]
    if (f.plane === 'sagittal' && f.kind === 'line' && pts && pts.length === 2) votes += Math.sign(pts[0].x - pts[1].x)
  }
  if (votes !== 0) return votes > 0 ? 1 : -1
  const s1 = features.s1
  return s1 && s1.length === 2 && s1[0].x < s1[1].x ? -1 : 1
}

export interface ComputeOptions {
  /** Image levelling in degrees; landmarks are rotated by this before measuring. */
  tilt?: number
  /** 0 = auto, otherwise +1 / -1. */
  facing?: number
  age?: number
}

const fmt = (v: number) => `${Math.round(v)}°`

export function compute(raw: Features, opts: ComputeOptions = {}): SagittalResults {
  const tilt = opts.tilt ?? 0
  const f: Features = {}
  for (const def of FEATURES) {
    const pts = raw[def.id]
    if (pts) f[def.id] = tilt ? pts.map((p) => rot(p, tilt)) : pts
  }
  const facing = detectFacing(f, opts.facing ?? 0)
  const has = (id: FeatureId) => isComplete(f, id)
  const slope = (id: FeatureId) => endplateSlope(f[id]![0], f[id]![1], facing)
  const age = opts.age && opts.age >= 18 && opts.age <= 110 ? opts.age : undefined
  const out: Result[] = []
  const push = (key: string, label: string, value: number, note?: string, unit: '°' | '%' = '°') =>
    out.push({ plane: 'sagittal', key, label, value, unit, note })

  const hip = has('fh1') ? (has('fh2') ? mid(f.fh1![0], f.fh2![0]) : f.fh1![0]) : undefined
  const sacrum = has('s1') ? mid(f.s1![0], f.s1![1]) : undefined

  let pi: number | undefined
  let pt: number | undefined
  let ss: number | undefined
  let ll: number | undefined

  if (has('s1')) ss = slope('s1')
  if (hip && sacrum) {
    pi = pelvicIncidence(f.s1![0], f.s1![1], hip, facing)
    pt = -tiltFromVertical(hip, sacrum, facing)
    push('PI', 'Pelvic incidence', pi)
    const mod = pt < 20 ? '0' : pt <= 30 ? '+' : '++'
    let note = `Schwab ${mod}`
    if (age) note += ` · age target ≈ ${fmt((age - 55) / 3 + 20)}`
    push('PT', 'Pelvic tilt', pt, note)
  }
  if (ss !== undefined) {
    const type = ss < 35 ? 'Roussouly 1–2' : ss <= 45 ? 'Roussouly 3' : 'Roussouly 4'
    push('SS', 'Sacral slope', ss, type)
  }
  if (has('s1') && has('l1')) {
    ll = norm180(ss! - slope('l1'))
    push('LL', 'Lumbar lordosis L1–S1', ll, pi !== undefined ? `target PI ± 9: ${fmt(pi - 9)} to ${fmt(pi + 9)}` : undefined)
  }
  if (has('s1') && has('l4')) {
    const l4s1 = norm180(ss! - slope('l4'))
    push('L4S1', 'L4–S1 lordosis', l4s1)
    if (ll !== undefined && ll > 5) {
      push('LDI', 'Lordosis distribution', (l4s1 / ll) * 100, 'typical 50–80%', '%')
    }
  }
  if (pi !== undefined && ll !== undefined) {
    const mm = norm180(pi - ll)
    const mod = mm < 10 ? '0' : mm <= 20 ? '+' : '++'
    let note = `Schwab ${mod}`
    if (age) note += ` · age target ≈ ${fmt((age - 55) / 2 + 3)}`
    push('PI-LL', 'PI − LL mismatch', mm, note)
  }
  if (has('t4') && has('t12')) {
    push('TK', 'Thoracic kyphosis T4–T12', norm180(slope('t4') - slope('t12')))
  }
  if (hip && sacrum && has('l1c')) {
    const v = norm180(tiltFromVertical(hip, f.l1c![0], facing) + pt!)
    push('L1PA', 'L1 pelvic angle', v, `expected ≈ ${fmt(0.5 * pi! - 21)} (0.5 × PI − 21)`)
  }
  if (hip && sacrum && has('t4c')) {
    const v = norm180(tiltFromVertical(hip, f.t4c![0], facing) + pt!)
    // The T4-L1-hip axis is read from the two together, so the difference is shown when L1PA is there.
    const l1pa = has('l1c') ? norm180(tiltFromVertical(hip, f.l1c![0], facing) + pt!) : undefined
    push('T4PA', 'T4 pelvic angle', v, l1pa === undefined ? undefined : `T4PA − L1PA = ${fmt(v - l1pa)}`)
  }
  if (hip && sacrum && has('t1c')) {
    push('TPA', 'T1 pelvic angle', norm180(tiltFromVertical(hip, f.t1c![0], facing) + pt!), 'target < 14°')
  }
  if (hip && sacrum && has('c7c')) {
    push('GT', 'Global tilt', norm180(tiltFromVertical(sacrum, f.c7c![0], facing) + pt!))
  }
  let t1s: number | undefined
  let cl: number | undefined
  if (has('t1')) {
    t1s = slope('t1')
    push('T1S', 'T1 slope', t1s)
  }
  if (has('c2') && has('c7')) {
    cl = norm180(slope('c7') - slope('c2'))
    push('CL', 'C2–C7 lordosis', cl, cl < 0 ? 'kyphotic' : undefined)
  }
  if (t1s !== undefined && cl !== undefined) push('T1S-CL', 'T1 slope − CL', t1s - cl)

  // ---- Coronal ----
  // Angles against horizontal, with which side of the image sits higher (the photo does not
  // say whether it is a PA or AP view, so sides are given as image left/right).
  const tiltOf = (id: FeatureId, key: string, label: string) => {
    if (!has(id)) return
    const [a, b] = f[id]!
    const angle = slopeInfo(a, b).toHorizontal
    const high = a.y === b.y ? null : (a.y < b.y ? a : b).x < (a.y < b.y ? b : a).x ? 'left' : 'right'
    out.push({ plane: 'coronal', key, label, value: angle, unit: '°', note: high && angle >= 0.05 ? `higher on image ${high}` : 'level' })
  }
  const cobbOf = (upper: FeatureId, lower: FeatureId, key: string, label: string) => {
    if (!has(upper) || !has(lower)) return
    const value = cobbAngle(f[upper]![0], f[upper]![1], f[lower]![0], f[lower]![1])
    out.push({ plane: 'coronal', key, label, value, unit: '°' })
  }
  cobbOf('ptU', 'ptL', 'Prox T Cobb', 'Proximal thoracic Cobb')
  cobbOf('mtU', 'mtL', 'Main T Cobb', 'Main thoracic Cobb')
  cobbOf('tlU', 'tlL', 'TL/L Cobb', 'Thoracolumbar/lumbar Cobb')
  cobbOf('frU', 'frL', 'Fractional', 'Lumbosacral fractional curve')
  tiltOf('po', 'PO', 'Pelvic obliquity')
  tiltOf('ct1', 'T1 tilt', 'T1 tilt')

  return { facing, results: out }
}

export function formatValue(r: Result): string {
  return `${r.value.toFixed(r.unit === '%' ? 0 : 1)}${r.unit}`
}
