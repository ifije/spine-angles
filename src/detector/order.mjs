// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// The anatomical ordering step of lumbar/order.py: one candidate spot per corner, chosen together so that the
// eleven endplates make a plausible chain from L1 down to S1. solve() here is solve() there.
import { K, E, M, SIB } from './decode.mjs'

export const PARAMS = { prior_weight: 0.5, dead: 50.0, cap: 40.0, eps: 0.02, sib_min: 0.2, dedupe: 12.0, len_lo: 0.5, len_hi: 1.7 }

/** How endplate `lo` sits relative to endplate `up` (each [ax, ay, bx, by], front end first): offset of the midpoint
 *  along `up` and across it in mean endplate lengths, log length ratio, change of direction (mirrored for films facing right). */
function pairFeatures(up, lo, out) {
  const ux = up[2] - up[0], uy = up[3] - up[1], vx = lo[2] - lo[0], vy = lo[3] - lo[1]
  const lu = Math.max(Math.hypot(ux, uy), 1e-6), lv = Math.max(Math.hypot(vx, vy), 1e-6)
  const hx = ux / lu, hy = uy / lu, face = hx >= 0 ? 1 : -1
  const dx = (lo[0] + lo[2]) / 2 - (up[0] + up[2]) / 2, dy = (lo[1] + lo[3]) / 2 - (up[1] + up[3]) / 2
  const s = (lu + lv) / 2
  out[0] = (dx * hx + dy * hy) / s
  out[1] = (dx * -hy * face + dy * hx * face) / s
  out[2] = Math.log(lv / lu)
  out[3] = Math.atan2(hx * vy - hy * vx, hx * vx + hy * vy) * face
}

function candidates(pos, val, cross, prm) {
  const out = []
  for (let k = 0; k < K; k++) {
    const xy = [pos[k][0]], sc = [val[k][0]]
    for (let j = 1; j < M; j++) if (val[k][j] > 0) { xy.push(pos[k][j]); sc.push(val[k][j]) }
    SIB[k].forEach((s, si) => {
      if (s < 0 || s === k) return
      for (let j = 0; j < M; j++) {
        if (val[s][j] < prm.sib_min) continue
        const q = pos[s][j]
        let near = Infinity
        for (const a of xy) near = Math.min(near, Math.hypot(q[0] - a[0], q[1] - a[1]))
        if (near < prm.dedupe) continue
        xy.push(q); sc.push(Math.max(cross[k][si][j], 0))
      }
    })
    out.push({ xy, cost: sc.map((v) => -Math.log(Math.min(Math.max(v, prm.eps), 1))) })
  }
  return out
}

/** Best chain for one film. Returns { pts: 22 points, worst_link, lowest_value, moved }. */
export function solve({ pos, val, cross }, prior, prm = PARAMS) {
  const cand = candidates(pos, val, cross, prm)
  const lens = []
  for (let e = 0; e < E; e++) lens.push(Math.hypot(pos[2 * e + 1][0][0] - pos[2 * e][0][0], pos[2 * e + 1][0][1] - pos[2 * e][0][1]))
  const ref = lens.slice().sort((a, b) => a - b)[E >> 1]
  const states = []                                          // per endplate: ends [ax, ay, bx, by], cost, which candidates
  for (let e = 0; e < E; e++) {
    const a = cand[2 * e], b = cand[2 * e + 1]
    const all = []
    for (let ia = 0; ia < a.xy.length; ia++) for (let ib = 0; ib < b.xy.length; ib++) {
      const ln = Math.hypot(b.xy[ib][0] - a.xy[ia][0], b.xy[ib][1] - a.xy[ia][1])
      all.push({ ends: [a.xy[ia][0], a.xy[ia][1], b.xy[ib][0], b.xy[ib][1]], unary: a.cost[ia] + b.cost[ib], ia, ib, keep: ln > prm.len_lo * ref && ln < prm.len_hi * ref })
    }
    if (!all.some((s) => s.keep)) all[0].keep = true           // never leave an endplate without a state
    states.push(all.filter((s) => s.keep))
  }
  const w = prm.prior_weight, f = [0, 0, 0, 0]
  const link = (e, up, lo) => {                                // how far this pair is from the prior, in squared standard deviations
    pairFeatures(up.ends, lo.ends, f)
    const mean = prior.mean[e - 1], ic = prior.icov[e - 1]
    let d2 = 0
    for (let i = 0; i < 4; i++) { let row = 0; for (let j = 0; j < 4; j++) row += ic[i][j] * (f[j] - mean[j]); d2 += (f[i] - mean[i]) * row }
    return d2
  }
  let cost = states[0].map((s) => s.unary)
  const back = []
  for (let e = 1; e < E; e++) {
    const up = states[e - 1], lo = states[e], next = new Array(lo.length), arg = new Int32Array(lo.length)
    for (let b = 0; b < lo.length; b++) {
      let best = Infinity, at = 0
      for (let a = 0; a < up.length; a++) {
        const tot = cost[a] + 0.5 * w * Math.min(Math.max(link(e, up[a], lo[b]) - prm.dead, 0), prm.cap)
        if (tot < best) { best = tot; at = a }
      }
      arg[b] = at
      next[b] = best + lo[b].unary
    }
    back.push(arg)
    cost = next
  }
  let s = 0
  for (let i = 1; i < cost.length; i++) if (cost[i] < cost[s]) s = i
  const path = [s]
  for (let e = E - 1; e > 0; e--) { s = back[e - 1][s]; path.push(s) }
  path.reverse()
  const pts = []
  let worst = -Infinity, unary = -Infinity, moved = 0
  for (let e = 0; e < E; e++) {
    const st = states[e][path[e]]
    pts.push([st.ends[0], st.ends[1]], [st.ends[2], st.ends[3]])
    unary = Math.max(unary, st.unary)
    moved += (st.ia !== 0) + (st.ib !== 0)
    if (e > 0) worst = Math.max(worst, link(e, states[e - 1][path[e - 1]], st))
  }
  return { pts, worst_link: worst, lowest_value: Math.exp(-unary), moved }
}
