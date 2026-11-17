// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Pure geometry. Image coordinates: x to the right, y downwards.

export interface Pt {
  x: number
  y: number
}

export const DEG = 180 / Math.PI

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x

/** Rotate a point about the origin (degrees, clockwise on screen because y is down). */
export function rot(p: Pt, deg: number): Pt {
  const r = deg / DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Wrap an angle in degrees to (-180, 180]. */
export function norm180(a: number): number {
  a = a % 360
  if (a > 180) a -= 360
  if (a <= -180) a += 360
  return a
}

/** Unsigned angle between two vectors, 0..180. */
function between(u: Pt, v: Pt): number {
  return Math.abs(Math.atan2(cross(u, v), dot(u, v))) * DEG
}

/** Acute angle between two undirected lines, 0..90. */
export function acuteAngle(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  const a = between(sub(a2, a1), sub(b2, b1))
  return a > 90 ? 180 - a : a
}

/**
 * Cobb angle between two endplate lines, independent of the order the points were tapped.
 *
 * Two undirected lines only define an angle up to 90 degrees, so curves beyond 90 need
 * extra information. Endplates sit across the spine, so each line's normal is pointed
 * along the chord joining the two line midpoints and the angle is taken between those
 * normals. When a line runs nearly along the chord (not an endplate-like layout, e.g.
 * two posterior wall tangents) that orientation is unreliable and the acute angle is used.
 */
export function cobbAngle(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  const acute = acuteAngle(a1, a2, b1, b2)
  const chord = sub(mid(b1, b2), mid(a1, a2))
  if (Math.hypot(chord.x, chord.y) < 1e-9) return acute
  const normalAlong = (p: Pt, q: Pt): Pt => {
    const d = sub(q, p)
    const n = { x: -d.y, y: d.x }
    return dot(n, chord) < 0 ? { x: -n.x, y: -n.y } : n
  }
  const n1 = normalAlong(a1, a2)
  const n2 = normalAlong(b1, b2)
  if (between(n1, chord) > 70 || between(n2, chord) > 70) return acute
  return between(n1, n2)
}

/** Angle at vertex v between rays v->a and v->b, 0..180. */
export function angle3(a: Pt, v: Pt, b: Pt): number {
  return between(sub(a, v), sub(b, v))
}

export interface SlopeInfo {
  /** Acute angle to the horizontal, 0..90. */
  toHorizontal: number
  /** Acute angle to the vertical, 0..90. */
  toVertical: number
  /** The nearer reference axis. */
  ref: 'horizontal' | 'vertical'
  /** Angle to the nearer reference axis, 0..45. */
  angle: number
}

export function slopeInfo(a: Pt, b: Pt): SlopeInfo {
  const d = sub(b, a)
  const toHorizontal = Math.atan2(Math.abs(d.y), Math.abs(d.x)) * DEG
  const toVertical = 90 - toHorizontal
  const ref = toHorizontal <= 45 ? 'horizontal' : 'vertical'
  return { toHorizontal, toVertical, ref, angle: Math.min(toHorizontal, toVertical) }
}

/**
 * Slope of an endplate line: positive when its anterior end is lower than its posterior end.
 * `facing` is +1 when anterior is towards +x (image right), -1 when towards -x.
 * Tap order does not matter; the line is treated as undirected. Result in (-90, 90].
 */
export function endplateSlope(p: Pt, q: Pt, facing: number): number {
  let d = sub(q, p)
  if (d.x * facing < 0) d = { x: -d.x, y: -d.y }
  return Math.atan2(d.y, d.x * facing) * DEG
}

/**
 * Tilt of the line from -> to measured from vertical (upwards), positive when `to`
 * is anterior to `from`.
 */
export function tiltFromVertical(from: Pt, to: Pt, facing: number): number {
  return Math.atan2((to.x - from.x) * facing, -(to.y - from.y)) * DEG
}

/**
 * Pelvic incidence measured directly: the angle between the perpendicular to the sacral
 * endplate at its midpoint and the line from that midpoint to the hip axis.
 */
export function pelvicIncidence(s1a: Pt, s1b: Pt, hip: Pt, facing: number): number {
  // Work in an anatomical frame: x anterior, y up.
  const A = (p: Pt): Pt => ({ x: p.x * facing, y: -p.y })
  let e = sub(A(s1b), A(s1a))
  if (e.x < 0) e = { x: -e.x, y: -e.y }
  const n = { x: e.y, y: -e.x } // caudal normal
  const v = sub(A(hip), A(mid(s1a, s1b)))
  return Math.atan2(cross(n, v), dot(n, v)) * DEG
}
