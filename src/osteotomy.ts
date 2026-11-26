// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Planning a pedicle subtraction osteotomy (PSO): pure geometry, no drawing.
//
// Three points mark the wedge: the hinge (the tip of the wedge, at the front of the vertebral body), then the two
// points where the cuts reach the back wall of the body, in either order. Both cuts carry on straight past those
// points to the edge of the picture, so the posterior elements inside the wedge go too. Closing the wedge turns
// everything above it about the hinge until the upper cut lies on the lower cut; the pelvis and everything below the
// wedge stay where they are.

import { Pt, rot } from './geometry'
import type { Features } from './sagittal'

export interface Wedge {
  /** The hinge. */
  h: Pt
  /** The back point of the upper cut (on the side that moves) and of the lower cut. */
  pU: Pt
  pL: Pt
  /** Unit directions from the hinge along the upper and lower cuts, and along the wedge's middle line. */
  u: Pt
  l: Pt
  b: Pt
  /** The turn, in radians, that closes the wedge (positive is clockwise on screen, as canvas rotate). */
  theta: number
  /** The wedge angle at the hinge, degrees. */
  deg: number
}

/**
 * Why three points make no wedge: the cuts lie on one line, or the wedge opens up or down the picture instead of
 * towards the back (then which piece moves would be a guess).
 */
export type WedgeProblem = 'thin' | 'vertical'

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x
const unit = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}
/** Turn v by r radians, clockwise on screen (y down), the same sense as canvas rotate(). */
const turn = (v: Pt, r: number): Pt => {
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}
const signedAngle = (u: Pt, v: Pt) => Math.atan2(cross(u, v), dot(u, v))

/**
 * The wedge from the hinge and the two back points. `tilt` is the photo's levelling (degrees, as Doc.tilt): the
 * piece that holds the top of the levelled picture is the one that moves.
 */
export function makeWedge(h: Pt, a: Pt, c: Pt, tilt = 0): Wedge | WedgeProblem {
  const ua = unit(sub(a, h))
  const uc = unit(sub(c, h))
  const th = signedAngle(ua, uc)
  if (Math.abs(th) < (0.5 * Math.PI) / 180) return 'thin'
  // Straight up on the levelled screen, in photo coordinates.
  const up = rot({ x: 0, y: -1 }, -tilt)
  const phiUp = signedAngle(ua, up)
  if (Math.sign(phiUp) === Math.sign(th) && Math.abs(phiUp) < Math.abs(th)) return 'vertical'
  const b = unit(add(ua, uc))
  // A PSO's wedge opens towards the back: its middle line runs across the spine. Within 20 degrees of the vertical
  // the side that holds the top of the picture is not clear.
  if (Math.abs(dot(b, up)) > Math.cos((20 * Math.PI) / 180)) return 'vertical'
  const aUpper = Math.sign(cross(b, ua)) === Math.sign(cross(b, up))
  const [pU, pL] = aUpper ? [a, c] : [c, a]
  const u = unit(sub(pU, h))
  const l = unit(sub(pL, h))
  const theta = signedAngle(u, l)
  return { h, pU, pL, u, l, b, theta, deg: (Math.abs(theta) * 180) / Math.PI }
}

export const isWedge = (w: Wedge | WedgeProblem | null | undefined): w is Wedge => !!w && typeof w !== 'string'

/** Whether a point is on the side that moves (above the wedge's middle line). */
export const moves = (w: Wedge, p: Pt): boolean => Math.sign(cross(w.b, sub(p, w.h))) === Math.sign(cross(w.b, w.u))

/** Where a point ends up with the wedge closed by the fraction t (0 open, 1 closed). */
export const movePoint = (w: Wedge, p: Pt, t: number): Pt => {
  if (!t || !moves(w, p)) return p
  return add(w.h, turn(sub(p, w.h), t * w.theta))
}

/** Every landmark moved with its piece of the spine. */
export function moveFeatures(F: Features, w: Wedge, t: number): Features {
  const out: Features = {}
  for (const [id, pts] of Object.entries(F) as [keyof Features, Pt[]][]) {
    if (!pts) continue
    // A femoral head's rim point turns with its centre, so the circle keeps its size.
    out[id] = moves(w, pts[0]) && t ? pts.map((p) => add(w.h, turn(sub(p, w.h), t * w.theta))) : pts.slice()
  }
  return out
}

/**
 * The points of a free measurement moved with their pieces. With `pairs`, each pair of points is one line (Cobb's two
 * endplates, Slope's line) and moves whole, decided by its first point, so a line across the wedge does not bend.
 */
export function moveLinePoints(pts: Pt[], w: Wedge, t: number, pairs: boolean): Pt[] {
  if (!t) return pts
  return pts.map((p, i) => {
    const lead = pairs ? pts[i - (i % 2)] : p
    return moves(w, lead) ? add(w.h, turn(sub(p, w.h), t * w.theta)) : p
  })
}

function arc(h: Pt, dir: Pt, sweep: number, R: number, n = 36): Pt[] {
  const pts: Pt[] = []
  for (let k = 0; k <= n; k++) pts.push(add(h, mul(turn(dir, (sweep * k) / n), R)))
  return pts
}

/**
 * The two pieces of the picture as polygons reaching R from the hinge (R beyond the photo's corners): the piece that
 * moves runs from the upper cut round the top to the wedge's middle line carried on in front of the hinge; the still
 * piece from the lower cut round the bottom to the same line. The wedge between the cuts belongs to neither.
 */
export function pieces(w: Wedge, R: number): { moving: Pt[]; still: Pt[] } {
  const s = Math.sign(w.theta)
  const half = Math.PI - Math.abs(w.theta) / 2
  return { moving: [w.h, ...arc(w.h, w.u, -s * half, R)], still: [w.h, ...arc(w.h, w.l, s * half, R)] }
}
