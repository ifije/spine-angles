// Draws measurements and landmarks. Used for the screen, the loupe and the exported image.

import { Pt, mid, dist } from './geometry'
import { Doc, Mat, apply, isDone, measureText } from './model'
import { FEATURES, isComplete } from './sagittal'

export interface DrawOpts {
  /** Unit scale for line widths and text (1 on screen, larger for export). */
  k: number
  /** Id of the selected free measurement. */
  selected?: number | null
  /** Hide value labels (used inside the loupe). */
  noLabels?: boolean
}

const PALETTE = ['#4cc9f0', '#ff5fa2', '#b8f35d', '#ff9f1c', '#c9a0ff', '#2ee6c8']
const C_ENDPLATE = '#ffd54a'
const C_PELVIS = '#7ee787'
const C_BODY = '#ff9f1c'
const C_GUIDE = 'rgba(255,255,255,0.75)'

export const colorFor = (id: number): string => PALETTE[(id - 1) % PALETTE.length]

export function drawOverlay(ctx: CanvasRenderingContext2D, M: Mat, doc: Doc, o: DrawOpts): void {
  const k = o.k
  const S = (p: Pt) => apply(M, p)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const seg = (a: Pt, b: Pt, color: string, width = 2, dash?: number[]) => {
    ctx.beginPath()
    ctx.setLineDash(dash ? dash.map((d) => d * k) : [])
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = (width + 2) * k
    if (!dash) ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = width * k
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** A ring marks a draggable point without hiding the anatomy under it. */
  const ring = (p: Pt, color: string, r = 7) => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, r * k, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 4 * k
    ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * k
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(p.x, p.y, 1.3 * k, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }

  const label = (text: string, p: Pt, color: string, align: CanvasTextAlign = 'left', size = 14) => {
    if (o.noLabels) return
    ctx.font = `600 ${size * k}px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif`
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4 * k
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, p.x, p.y)
    ctx.fillStyle = color
    ctx.fillText(text, p.x, p.y)
  }

  // ---- Guided landmarks ----
  const F = doc.features
  const done = (id: Parameters<typeof isComplete>[1]) => isComplete(F, id)
  const hipI = done('fh1') ? (done('fh2') ? mid(F.fh1![0], F.fh2![0]) : F.fh1![0]) : null
  const sacI = done('s1') ? mid(F.s1![0], F.s1![1]) : null

  if (hipI && done('fh2')) seg(S(F.fh1![0]), S(F.fh2![0]), C_PELVIS, 1.5)
  if (hipI && sacI) {
    const h = S(hipI)
    const m = S(sacI)
    seg(h, m, C_GUIDE, 1.5, [5, 5])
    seg(h, { x: h.x, y: h.y - dist(h, m) }, C_GUIDE, 1.2, [2, 5])
    if (done('l1c')) seg(h, S(F.l1c![0]), C_GUIDE, 1.2, [5, 5])
    if (done('t1c')) seg(h, S(F.t1c![0]), C_GUIDE, 1.2, [5, 5])
    if (done('c7c')) seg(m, S(F.c7c![0]), C_GUIDE, 1.2, [5, 5])
  }

  for (const def of FEATURES) {
    const pts = F[def.id]
    if (!pts || !pts.length) continue
    const s = pts.map(S)
    if (def.kind === 'line') {
      if (s.length === 2) {
        seg(s[0], s[1], C_ENDPLATE, 2)
        const d = dist(s[0], s[1]) || 1
        const u = { x: (s[0].x - s[1].x) / d, y: (s[0].y - s[1].y) / d }
        label(def.tag, { x: s[0].x + u.x * 14 * k, y: s[0].y + u.y * 14 * k }, C_ENDPLATE, u.x >= 0 ? 'left' : 'right', 12)
      }
      s.forEach((p) => ring(p, C_ENDPLATE, 6))
    } else if (def.kind === 'circle') {
      if (s.length === 2) {
        ctx.beginPath()
        ctx.arc(s[0].x, s[0].y, dist(s[0], s[1]), 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.lineWidth = 4 * k
        ctx.stroke()
        ctx.strokeStyle = C_PELVIS
        ctx.lineWidth = 2 * k
        ctx.stroke()
        ring(s[1], C_PELVIS, 4)
      }
      ring(s[0], C_PELVIS, 6)
    } else {
      ring(s[0], C_BODY, 6)
      label(def.tag, { x: s[0].x + 12 * k, y: s[0].y }, C_BODY, 'left', 12)
    }
  }

  // ---- Free measurements ----
  for (const m of doc.measures) {
    const color = colorFor(m.id)
    const s = m.pts.map(S)
    const text = measureText(m, doc.tilt)
    const sel = o.selected === m.id
    const w = sel ? 3 : 2

    if (m.kind === 'cobb') {
      for (let i = 0; i + 1 < s.length; i += 2) {
        const a = s[i]
        const b = s[i + 1]
        // Faint extensions make it easier to judge the line against the endplate.
        const ex = { x: (b.x - a.x) * 0.35, y: (b.y - a.y) * 0.35 }
        seg({ x: a.x - ex.x, y: a.y - ex.y }, { x: b.x + ex.x, y: b.y + ex.y }, color, 1, [3, 5])
        seg(a, b, color, w)
      }
      if (text) {
        const x = Math.max(...s.map((p) => p.x)) + 14 * k
        const y = (s[0].y + s[1].y + s[2].y + s[3].y) / 4
        label(text, { x, y }, color)
      }
    } else if (m.kind === 'angle3') {
      for (let i = 0; i + 1 < s.length; i++) seg(s[i], s[i + 1], color, w)
      if (isDone(m) && text) {
        const v = s[1]
        const a1 = Math.atan2(s[0].y - v.y, s[0].x - v.x)
        const a2 = Math.atan2(s[2].y - v.y, s[2].x - v.x)
        let d = a2 - a1
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        const r = Math.min(26 * k, dist(v, s[0]) * 0.6, dist(v, s[2]) * 0.6)
        ctx.beginPath()
        ctx.arc(v.x, v.y, r, a1, a1 + d, d < 0)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5 * k
        ctx.stroke()
        const bis = a1 + d / 2
        const lp = { x: v.x + Math.cos(bis) * (r + 26 * k), y: v.y + Math.sin(bis) * (r + 26 * k) }
        label(text, lp, color, 'center')
      }
    } else {
      if (s.length === 2) {
        const horiz = Math.abs(s[1].x - s[0].x) >= Math.abs(s[1].y - s[0].y)
        const ref = horiz ? { x: s[1].x, y: s[0].y } : { x: s[0].x, y: s[1].y }
        seg(s[0], ref, color, 1.2, [4, 5])
        seg(s[0], s[1], color, w)
        if (text) {
          // Offset the label square to the line, on its lower or right-hand side.
          const c = mid(s[0], s[1])
          const len = dist(s[0], s[1]) || 1
          let n = { x: -(s[1].y - s[0].y) / len, y: (s[1].x - s[0].x) / len }
          if (horiz ? n.y < 0 : n.x < 0) n = { x: -n.x, y: -n.y }
          if (horiz) label(text, { x: c.x + n.x * 22 * k, y: c.y + n.y * 22 * k }, color, 'center')
          else label(text, { x: c.x + n.x * 14 * k, y: c.y + n.y * 14 * k }, color, 'left')
        }
      }
    }
    s.forEach((p) => ring(p, color, sel ? 8 : 7))
  }
  ctx.restore()
}
