// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Draws measurements and landmarks. Used for the screen, the loupe and the exported image.

import { Pt, mid, dist } from './geometry'
import { Doc, Mat, apply, isDone, measureText } from './model'
import { FEATURES, FeatureId, SagittalResults, formatValue, isComplete } from './sagittal'
import { Wedge, WedgeProblem, isWedge, pieces } from './osteotomy'

export interface DrawOpts {
  /** Unit scale for line widths and text (1 on screen, larger for export). */
  k: number
  /** Id of the selected free measurement. */
  selected?: number | null
  /** Guided landmark that is selected; drawn heavier. */
  selectedFeature?: FeatureId | null
  /** Hide value labels (used inside the loupe). */
  noLabels?: boolean
  /** Computed guided results; when given, each is annotated on the image. */
  sag?: SagittalResults
  /** Result key to show on its own; the other guided annotations are hidden. */
  focus?: string | null
}

const PALETTE = ['#4cc9f0', '#ff5fa2', '#b8f35d', '#ff9f1c', '#c9a0ff', '#2ee6c8']
const C_ENDPLATE = '#ffd54a'
const C_PELVIS = '#7ee787'
const C_BODY = '#ff9f1c'
const C_GUIDE = 'rgba(255,255,255,0.75)'

/** Coronal lines are named by their value label once measured, so their tag is dropped. */
const CORONAL_KEY: Partial<Record<FeatureId, string>> = {
  po: 'PO', ct1: 'T1 tilt', ptU: 'Prox T Cobb', ptL: 'Prox T Cobb', mtU: 'Main T Cobb', mtL: 'Main T Cobb',
  tlU: 'TL/L Cobb', tlL: 'TL/L Cobb', frU: 'Fractional', frL: 'Fractional',
}

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

  // Labels and points already drawn, so later labels can step aside instead of printing on top.
  const placed: { x: number; y: number; w: number; h: number }[] = []

  /** A ring marks a draggable point without hiding the anatomy under it. */
  const ring = (p: Pt, color: string, r = 7) => {
    placed.push({ x: p.x - r * k, y: p.y - r * k, w: 2 * r * k, h: 2 * r * k })
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
    const w = ctx.measureText(text).width
    const h = size * k * 1.3
    const x = align === 'left' ? p.x : align === 'center' ? p.x - w / 2 : p.x - w
    let y = p.y
    for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      y = p.y + step * h
      const top = y - h / 2
      if (!placed.some((b) => x < b.x + b.w && x + w > b.x && top < b.y + b.h && top + h > b.y)) break
    }
    placed.push({ x, y: y - h / 2, w, h })
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4 * k
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, p.x, y)
    ctx.fillStyle = color
    ctx.fillText(text, p.x, y)
  }

  // ---- Guided landmarks ----
  const F = doc.features
  const done = (id: Parameters<typeof isComplete>[1]) => isComplete(F, id)
  const hipI = done('fh1') ? (done('fh2') ? mid(F.fh1![0], F.fh2![0]) : F.fh1![0]) : null
  const sacI = done('s1') ? mid(F.s1![0], F.s1![1]) : null

  if (hipI && done('fh2')) seg(S(F.fh1![0]), S(F.fh2![0]), C_PELVIS, 1.5)
  const val = new Map((o.sag?.results ?? []).map((r) => [r.key, r]))
  /** Whether a result is annotated: it must exist and, if one is isolated, be that one. */
  const show = (key: string) => val.has(key) && (!o.focus || o.focus === key)

  for (const def of FEATURES) {
    const pts = F[def.id]
    if (!pts || !pts.length) continue
    const s = pts.map(S)
    const hot = o.selectedFeature === def.id
    // A question mark stays on a landmark that an automatic guess placed until someone moves or keeps it.
    const guessed = doc.auto?.[def.id] !== undefined
    const tag = guessed ? `${def.tag}?` : def.tag
    if (def.kind === 'line') {
      if (s.length === 2) {
        seg(s[0], s[1], C_ENDPLATE, hot ? 3.5 : 2)
        const d = dist(s[0], s[1]) || 1
        const u = { x: (s[0].x - s[1].x) / d, y: (s[0].y - s[1].y) / d }
        const named = CORONAL_KEY[def.id]
        if (!(named && val.has(named))) label(tag, { x: s[0].x + u.x * 14 * k, y: s[0].y + u.y * 14 * k }, C_ENDPLATE, u.x >= 0 ? 'left' : 'right', 12)
      }
      s.forEach((p) => ring(p, C_ENDPLATE, hot ? 8 : 6))
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
      ring(s[0], C_PELVIS, hot ? 8 : 6)
      if (guessed) label(tag, { x: s[0].x + 12 * k, y: s[0].y }, C_PELVIS, 'left', 12)
    } else {
      ring(s[0], C_BODY, hot ? 8 : 6)
      label(tag, { x: s[0].x + 12 * k, y: s[0].y }, C_BODY, 'left', 12)
    }
  }

  // ---- Guided values, drawn at the anatomy they describe ----
  if (o.sag) {
    const f = o.sag.facing
    const text = (key: string) => `${key} ${formatValue(val.get(key)!)}`
    const dir = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x)
    /**
     * Arc across the smaller angle between two directions at c. The value sits outside the
     * angle, beside its first ray, because these angles are often too narrow to hold a label.
     */
    const arcLabel = (c: Pt, a1: number, a2: number, r: number, color: string, t: string) => {
      let d = a2 - a1
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      ctx.beginPath()
      ctx.arc(c.x, c.y, r, a1, a1 + d, d < 0)
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 3.5 * k
      ctx.stroke()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5 * k
      ctx.stroke()
      const away = d >= 0 ? -1 : 1
      const n = { x: -Math.sin(a1) * away, y: Math.cos(a1) * away }
      const q = { x: c.x + Math.cos(a1) * r + n.x * 10 * k, y: c.y + Math.sin(a1) * r + n.y * 10 * k }
      if (Math.abs(n.x) > 0.3) label(t, q, color, n.x > 0 ? 'left' : 'right', 13)
      else label(t, { x: q.x, y: q.y + n.y * 8 * k }, color, 'center', 13)
    }
    /** Screen positions of an endplate's anterior and posterior ends. */
    const ends = (id: FeatureId) => {
      const [a, b] = F[id]!.map(S)
      return (a.x - b.x) * f >= 0 ? { ant: a, post: b } : { ant: b, post: a }
    }
    /** Endplate against a horizontal drawn from its posterior corner (SS, T1 slope). */
    const slopeMark = (id: FeatureId, key: string, color: string) => {
      if (!show(key)) return
      const { ant, post } = ends(id)
      const len = dist(ant, post)
      seg(post, { x: post.x + f * len, y: post.y }, C_GUIDE, 1.2, [4, 5])
      arcLabel(post, f > 0 ? 0 : Math.PI, dir(post, ant), Math.min(36 * k, len * 0.7), color, text(key))
    }
    /** Value for an angle between two endplates, set on the posterior side between them. */
    const pairLabel = (a: FeatureId, b: FeatureId, key: string) => {
      if (!show(key)) return
      const ea = ends(a)
      const eb = ends(b)
      const x = f > 0 ? Math.min(ea.post.x, eb.post.x) - 14 * k : Math.max(ea.post.x, eb.post.x) + 14 * k
      label(text(key), { x, y: (ea.post.y + eb.post.y) / 2 }, C_ENDPLATE, f > 0 ? 'right' : 'left', 13)
      // When shown on its own, carry both endplates out so the pair being compared is obvious.
      if (o.focus === key) {
        for (const e of [ea, eb]) {
          const ex = { x: (e.post.x - e.ant.x) * 0.8, y: (e.post.y - e.ant.y) * 0.8 }
          seg(e.post, { x: e.post.x + ex.x, y: e.post.y + ex.y }, C_ENDPLATE, 1.2, [4, 5])
        }
      }
    }

    if (hipI && sacI) {
      const h = S(hipI)
      const m = S(sacI)
      const hm = dist(h, m)
      if (['PT', 'PI', 'L1PA', 'TPA', 'GT'].some(show)) seg(h, m, C_GUIDE, 1.5, [5, 5])
      if (show('PT')) {
        seg(h, { x: h.x, y: h.y - hm }, C_GUIDE, 1.2, [2, 5])
        arcLabel(h, -Math.PI / 2, dir(h, m), Math.max(hm * 0.5, 26 * k), C_PELVIS, text('PT'))
      }
      if (show('PI')) {
        // Perpendicular to the sacral endplate, pointing into the sacrum.
        const { ant, post } = ends('s1')
        const len = dist(ant, post) || 1
        let n = { x: -(ant.y - post.y) / len, y: (ant.x - post.x) / len }
        if (n.y < 0) n = { x: -n.x, y: -n.y }
        seg(m, { x: m.x + n.x * hm * 0.8, y: m.y + n.y * hm * 0.8 }, C_GUIDE, 1.2, [4, 5])
        arcLabel(m, Math.atan2(n.y, n.x), dir(m, h), Math.max(hm * 0.35, 22 * k), C_PELVIS, text('PI'))
      }
      // Radii scale with the pelvis so the arcs stay apart, and clear of the femoral head circle.
      for (const [key, id, frac, min] of [['L1PA', 'l1c', 0.68, 40], ['T4PA', 't4c', 0.77, 47], ['TPA', 't1c', 0.86, 54]] as const) {
        if (!show(key)) continue
        const c = S(F[id]![0])
        seg(h, c, C_GUIDE, 1.2, [5, 5])
        arcLabel(h, dir(h, m), dir(h, c), Math.max(hm * frac, min * k), C_BODY, text(key))
      }
      if (show('GT')) {
        seg(m, S(F.c7c![0]), C_GUIDE, 1.2, [5, 5])
        // Global tilt is measured at the sacrum against the hip-to-sacrum line carried on upwards.
        const reach = Math.max(hm * 0.8, 56 * k)
        const up = { x: m.x + ((m.x - h.x) / (hm || 1)) * reach, y: m.y + ((m.y - h.y) / (hm || 1)) * reach }
        seg(m, up, C_GUIDE, 1.2, [4, 5])
        arcLabel(m, dir(h, m), dir(m, S(F.c7c![0])), Math.max(hm * 0.6, 40 * k), C_BODY, text('GT'))
      }
    }
    slopeMark('s1', 'SS', C_PELVIS)
    slopeMark('t1', 'T1S', C_ENDPLATE)
    pairLabel('l1', 's1', 'LL')
    pairLabel('l4', 's1', 'L4S1')
    pairLabel('t4', 't12', 'TK')
    pairLabel('c2', 'c7', 'CL')

    // Coronal: Cobb value beside each curve; tilts against a dashed horizontal.
    const curveLabel = (upper: FeatureId, lower: FeatureId, key: string) => {
      if (!show(key)) return
      const pts = [...F[upper]!, ...F[lower]!].map(S)
      label(text(key), { x: Math.max(...pts.map((q) => q.x)) + 14 * k, y: pts.reduce((sum, q) => sum + q.y, 0) / 4 }, C_ENDPLATE, 'left', 13)
    }
    curveLabel('ptU', 'ptL', 'Prox T Cobb')
    curveLabel('mtU', 'mtL', 'Main T Cobb')
    curveLabel('tlU', 'tlL', 'TL/L Cobb')
    curveLabel('frU', 'frL', 'Fractional')
    const tiltMark = (id: FeatureId, key: string) => {
      if (!show(key)) return
      const [a, b] = F[id]!.map(S)
      // Horizontal from the lower end, so the angle opens upwards to the high side.
      const low = a.y >= b.y ? a : b
      const high = low === a ? b : a
      seg(low, { x: high.x, y: low.y }, C_GUIDE, 1.2, [4, 5])
      label(text(key), { x: (a.x + b.x) / 2, y: low.y + 18 * k }, C_ENDPLATE, 'center', 13)
    }
    tiltMark('po', 'PO')
    tiltMark('ct1', 'T1 tilt')
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

// ---- Osteotomy (PSO) ----

const C_CUT = '#ff6b6b'

/**
 * Draw the photo cut into two pieces with the wedge closed by the fraction t: the still piece where it is, the piece
 * above the wedge turned about the hinge. The context's transform maps photo pixels to the output. `ghost` (0 to 1)
 * also draws the moving piece faintly where it was, so the change can be seen.
 */
export function drawCut(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, w: Wedge, t: number, ghost = 0): void {
  const R = 4 * Math.max(src.width, src.height)
  const { moving, still } = pieces(w, R)
  const clipTo = (P: Pt[]) => {
    ctx.beginPath()
    ctx.moveTo(P[0].x, P[0].y)
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i].x, P[i].y)
    ctx.closePath()
    ctx.clip()
  }
  ctx.save()
  clipTo(still)
  ctx.drawImage(src, 0, 0)
  ctx.restore()
  if (ghost > 0) {
    ctx.save()
    ctx.globalAlpha = ghost
    clipTo(moving)
    ctx.drawImage(src, 0, 0)
    ctx.restore()
  }
  ctx.save()
  ctx.translate(w.h.x, w.h.y)
  ctx.rotate(t * w.theta)
  ctx.translate(-w.h.x, -w.h.y)
  clipTo(moving)
  ctx.drawImage(src, 0, 0)
  ctx.restore()
}

/**
 * The wedge's marks on the overlay: the points tapped so far (rings, drawn while they can be dragged), the triangle of
 * bone taken out with both cuts carried on past the back points, and the angle at the hinge. `w` is the wedge once
 * all three points are there (or why they make none); `t` how far it is closed.
 */
export function drawWedge(ctx: CanvasRenderingContext2D, M: Mat, pts: Pt[], w: Wedge | WedgeProblem | null, t: number, k: number, rings: boolean): void {
  const S = (p: Pt) => apply(M, p)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const stroke = (color: string, width: number, dash: number[] = []) => {
    ctx.setLineDash(dash.map((d) => d * k))
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = (width + 2) * k
    if (!dash.length) ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = width * k
    ctx.stroke()
    ctx.setLineDash([])
  }
  const s = pts.map(S)
  if (isWedge(w)) {
    const h = S(w.h)
    const pL = S(w.pL)
    // The upper back point as it turns with its piece.
    const c = Math.cos(t * w.theta)
    const sn = Math.sin(t * w.theta)
    const d = { x: w.pU.x - w.h.x, y: w.pU.y - w.h.y }
    const pU = S({ x: w.h.x + d.x * c - d.y * sn, y: w.h.y + d.x * sn + d.y * c })
    const far = (p: Pt) => {
      const v = { x: p.x - h.x, y: p.y - h.y }
      const n = Math.hypot(v.x, v.y) || 1
      return { x: p.x + (v.x / n) * 4000 * k, y: p.y + (v.y / n) * 4000 * k }
    }
    if (t < 1) {
      // Beyond the back points, inside the wedge: taken too.
      const fu = far(pU)
      const fl = far(pL)
      ctx.beginPath()
      ctx.moveTo(pU.x, pU.y)
      ctx.lineTo(fu.x, fu.y)
      ctx.lineTo(fl.x, fl.y)
      ctx.lineTo(pL.x, pL.y)
      ctx.closePath()
      ctx.fillStyle = t === 0 ? 'rgba(255,107,107,0.12)' : 'rgba(255,107,107,0.06)'
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(h.x, h.y)
      ctx.lineTo(pU.x, pU.y)
      ctx.lineTo(pL.x, pL.y)
      ctx.closePath()
      ctx.fillStyle = t === 0 ? 'rgba(255,107,107,0.38)' : 'rgba(255,107,107,0.2)'
      ctx.fill()
      stroke(C_CUT, 2)
      ctx.beginPath()
      ctx.moveTo(pU.x, pU.y)
      ctx.lineTo(fu.x, fu.y)
      ctx.moveTo(pL.x, pL.y)
      ctx.lineTo(fl.x, fl.y)
      stroke(C_CUT, 1.4, [6, 5])
    } else {
      // Closed: the line where the two cuts now meet.
      ctx.beginPath()
      ctx.moveTo(h.x, h.y)
      ctx.lineTo(pL.x + (pL.x - h.x) * 0.6, pL.y + (pL.y - h.y) * 0.6)
      stroke(C_CUT, 1.4, [3, 4])
    }
    // The angle, in front of the hinge.
    const b = { x: (S(w.pU).x + pL.x) / 2 - h.x, y: (S(w.pU).y + pL.y) / 2 - h.y }
    const bn = Math.hypot(b.x, b.y) || 1
    const q = { x: h.x - (b.x / bn) * 30 * k, y: h.y - (b.y / bn) * 30 * k }
    const text = t === 0 ? `${Math.round(w.deg)}°` : t >= 1 ? `${Math.round(w.deg)}° closed` : `${Math.round(w.deg * (1 - t))}° open`
    ctx.font = `700 ${14 * k}px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4 * k
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, q.x, q.y)
    ctx.fillStyle = C_CUT
    ctx.fillText(text, q.x, q.y)
  } else if (s.length >= 2) {
    // Placing: the first cut so far.
    ctx.beginPath()
    ctx.moveTo(s[0].x, s[0].y)
    for (const p of s.slice(1)) {
      ctx.moveTo(s[0].x, s[0].y)
      ctx.lineTo(p.x, p.y)
    }
    stroke(C_CUT, 2)
  }
  if (rings || !isWedge(w)) {
    s.forEach((p, i) => {
      if (t > 0 && i > 0 && isWedge(w)) return
      ctx.beginPath()
      ctx.arc(p.x, p.y, (i === 0 ? 8 : 7) * k, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 4 * k
      ctx.stroke()
      ctx.strokeStyle = i === 0 ? '#ffd54a' : C_CUT
      ctx.lineWidth = 2 * k
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.3 * k, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
    })
  }
  ctx.restore()
}
