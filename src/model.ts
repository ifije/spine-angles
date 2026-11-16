// Document model shared by the UI, drawing and export code.

import { Pt, rot, cobbAngle, angle3, slopeInfo } from './geometry'
import type { Features } from './sagittal'

export type ToolKind = 'cobb' | 'angle3' | 'slope'

export interface Measure {
  id: number
  kind: ToolKind
  pts: Pt[]
}

export const NEED: Record<ToolKind, number> = { cobb: 4, angle3: 3, slope: 2 }
export const TOOL_NAME: Record<ToolKind, string> = { cobb: 'Cobb', angle3: 'Angle', slope: 'Slope' }

export interface Doc {
  measures: Measure[]
  features: Features
  /** Levelling rotation applied to the photo, degrees. */
  tilt: number
}

export const isDone = (m: Measure): boolean => m.pts.length >= NEED[m.kind]

/** Readout for a completed measurement, or null while it is still being placed. */
export function measureText(m: Measure, tilt: number): string | null {
  if (!isDone(m)) return null
  const p = m.pts
  if (m.kind === 'cobb') return `${cobbAngle(p[0], p[1], p[2], p[3]).toFixed(1)}°`
  if (m.kind === 'angle3') return `${angle3(p[0], p[1], p[2]).toFixed(1)}°`
  const s = slopeInfo(rot(p[0], tilt), rot(p[1], tilt))
  return `${s.angle.toFixed(1)}° to ${s.ref}`
}

/** 2x3 affine matrix in canvas setTransform order: image px -> output px. */
export type Mat = [number, number, number, number, number, number]

export const apply = (m: Mat, p: Pt): Pt => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
})

/** Matrix for scale s, rotation `tilt` degrees about the image origin, then translation. */
export function matrix(s: number, tilt: number, tx: number, ty: number): Mat {
  const r = (tilt * Math.PI) / 180
  const c = Math.cos(r) * s
  const sn = Math.sin(r) * s
  return [c, sn, -sn, c, tx, ty]
}

export function invert(m: Mat, q: Pt): Pt {
  const det = m[0] * m[3] - m[1] * m[2]
  const x = q.x - m[4]
  const y = q.y - m[5]
  return { x: (m[3] * x - m[2] * y) / det, y: (-m[1] * x + m[0] * y) / det }
}
