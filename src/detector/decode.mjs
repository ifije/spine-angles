// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// Reading a network's maps: the same arithmetic as lumbar/train.py decode(), pelvis/pipeline.py top_peaks(),
// all_pairs(), hip_axis(), measure_pelvis() (the guided read-out) and lumbar/order.py peaks_from().
// A set of maps is one Float32Array, map after map, each H rows of W. These run beside the network (in the
// page's worker), so that only a few numbers travel back, not the maps.

const COARSE_D = 85.0          // hip axis to S1 midpoint, in pixels, at the size the step-1 network was trained on

function isTop(m, off, W, H, x, y, v, r) {                 // nothing higher within r pixels (a square, as max-pooling)
  const y0 = Math.max(y - r, 0), y1 = Math.min(y + r, H - 1), x0 = Math.max(x - r, 0), x1 = Math.min(x + r, W - 1)
  for (let yy = y0; yy <= y1; yy++) { const row = off + yy * W; for (let xx = x0; xx <= x1; xx++) if (m[row + xx] > v) return false }
  return true
}

/** pipeline.top_peaks(): up to k separate peaks of one map, strongest first: [x, y, value]. */
export function topPeaks(m, off, W, H, k = 8, floor = 0.2) {
  const found = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = m[off + y * W + x]
    if (v >= floor && v > 0 && isTop(m, off, W, H, x, y, v, 4)) found.push([x + 0.5, y + 0.5, v])
  }
  return found.sort((a, b) => b[2] - a[2]).slice(0, k)
}

function pairScore(hp, mp) {
  const dx = mp[0] - hp[0], dy = mp[1] - hp[1], d = Math.hypot(dx, dy)
  if (dy >= 0 || Math.abs(dx) > 1.75 * Math.abs(dy) || !(d >= 40 && d <= 140)) return 0
  return Math.min(hp[2], mp[2], 1) * Math.exp(-0.5 * ((d - COARSE_D) / 25) ** 2)
}

/** pipeline.all_pairs(): every hip-axis response with every S1 response that could make a pelvis: [score, hip, s1]. */
export function allPairs(m, W, H) {
  const out = []
  const hips = topPeaks(m, 0, W, H, 8, 0.1), s1s = topPeaks(m, W * H, W, H, 8, 0.1)
  for (const hp of hips) for (const mp of s1s) { const sc = pairScore(hp, mp); if (sc > 0.03) out.push([sc, hp, mp]) }
  return out
}

// Experiment 13 stage 2: the locating look. Step 1 trained at any size (hip axis to S1 from about 18 to 250 px of its input),
// so a pair is read at any distance in that span, scored by the weaker of its two peaks alone. Not part of the Python version.
export const LOCATE_D = [12, 300]

/** Every hip-axis response with every S1 response that could make a pelvis of any size: [score, hip, s1]. */
export function locatePairs(m, W, H) {
  const out = []
  const hips = topPeaks(m, 0, W, H, 8, 0.1), s1s = topPeaks(m, W * H, W, H, 8, 0.1)
  for (const hp of hips) for (const mp of s1s) {
    const dx = mp[0] - hp[0], dy = mp[1] - hp[1], d = Math.hypot(dx, dy)
    if (dy >= 0 || Math.abs(dx) > 1.75 * Math.abs(dy) || !(d >= LOCATE_D[0] && d <= LOCATE_D[1])) continue
    out.push([Math.min(hp[2], mp[2], 1), hp, mp])
  }
  return out
}

function argmax(m, off, n) {
  let best = -Infinity, at = 0
  for (let p = 0; p < n; p++) { const v = m[off + p]; if (v > best) { best = v; at = p } }
  return [at, best]
}

/** Centre of mass around (px, py) in a (2r+1) window, ignoring what is below 5% of the value there. */
function refine(m, off, W, H, px, py, r = 10) {
  const peak = m[off + py * W + px], thr = 0.05 * peak
  let tot = 0, sx = 0, sy = 0
  for (let yy = Math.max(py - r, 0); yy <= Math.min(py + r, H - 1); yy++) for (let xx = Math.max(px - r, 0); xx <= Math.min(px + r, W - 1); xx++) {
    const v = m[off + yy * W + xx] - thr
    if (v > 0) { tot += v; sx += v * xx; sy += v * yy }
  }
  tot = Math.max(tot, 1e-6)
  return [sx / tot + 0.5, sy / tot + 0.5, peak]
}

/** train.decode() for one map: [x, y, peak]. */
export function decodePeak(m, off, W, H) {
  const [at] = argmax(m, off, W * H)
  return refine(m, off, W, H, at % W, Math.floor(at / W))
}

/** pipeline.hip_axis(): the hip axis midpoint, the separate head centres and the strongest response. */
export function hipAxis(h, W, H, radius) {
  const [at, peak] = argmax(h, 0, W * H)
  const px = at % W, py = Math.floor(at / W), r2 = radius * radius
  let tot = 0, sx = 0, sy = 0
  const cand = []
  for (let y = Math.max(py - radius, 0); y <= Math.min(py + radius, H - 1); y++) for (let x = Math.max(px - radius, 0); x <= Math.min(px + radius, W - 1); x++) {
    if ((x - px) ** 2 + (y - py) ** 2 > r2) continue
    const v = h[y * W + x], w = v - 0.3 * peak
    if (w > 0) { tot += w; sx += w * x; sy += w * y }
    if (v >= 0.4 * peak && v > 0 && isTop(h, 0, W, H, x, y, v, 4)) cand.push([x + 0.5, y + 0.5, v])
  }
  tot = Math.max(tot, 1e-6)
  const heads = cand.sort((a, b) => b[2] - a[2]).slice(0, 2).map((c) => [c[0], c[1]])
  return { mid: [sx / tot + 0.5, sy / tot + 0.5], heads, peak }
}

const GUIDED_HIP_RADIUS = 130, HIP_RADIUS = 80, GUIDED_S1_REACH = 0.35, GUIDED_HIP_REACH = 0.45

/** The read-out of pipeline.measure_pelvis() on a close-up's maps (femoral heads, S1 front end, S1 back end), in the
 *  close-up's pixels. With `guide` ({ h0, m0 }: where step 1 put the hip axis and the S1 midpoint), only near them. */
export function fineRead(m, W, H, guide) {
  const n = W * H
  const hip = m.slice(0, n), a = m.slice(n, 2 * n), b = m.slice(2 * n, 3 * n)
  if (guide) {
    const [hx, hy] = guide.h0, [mx, my] = guide.m0
    const d = Math.hypot(hx - mx, hy - my), rs = (GUIDED_S1_REACH * d) ** 2, rh = (GUIDED_HIP_REACH * d) ** 2
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x, gx = x + 0.5, gy = y + 0.5
      if ((gx - hx) ** 2 + (gy - hy) ** 2 > rh) hip[p] = 0
      if ((gx - mx) ** 2 + (gy - my) ** 2 > rs) { a[p] = -1; b[p] = -1 }
    }
  }
  const A = decodePeak(a, 0, W, H), B = decodePeak(b, 0, W, H)
  const hp = hipAxis(hip, W, H, guide ? GUIDED_HIP_RADIUS : HIP_RADIUS)
  return { A: [A[0], A[1]], B: [B[0], B[1]], mid: hp.mid, heads: hp.heads, conf: { hip: hp.peak, s1_ant: A[2], s1_post: B[2] } }
}

// ---------------------------------------------------------------- lumbar candidates (order.peaks_from)

export const K = 22, E = 11, M = 6
const FLOOR = 0.03
// Experiment 14: the pixel numbers of the reading follow the lumbar network's input size and map size, so they come with the
// network, from its manifest entry (pack.py lumbar_spec(): `spec`, as phone/lumbar13.py settings() makes them). For armA_nei2_s:
// NMS 7 (a peak is the highest within 15 map pixels), DECODE_R 10 (the centre of mass over 21), NEAR_R 3 (a map's value near
// another corner's peak, over 7), stride 1 (input pixels per map pixel; the points are in input pixels once read).
export const reading = (spec) => ({ nms: spec.pixels.NMS, r: spec.pixels.DECODE_R, near: spec.pixels.NEAR_R, stride: spec.stride })
/** Corners of the same kind: same plate type (upper or lower) and same end (front or back). Padded with -1. */
export const SIB = Array.from({ length: K }, (_, k) => {
  const same = []
  for (let j = 0; j < K; j++) if ((j >> 1) % 2 === (k >> 1) % 2 && j % 2 === k % 2) same.push(j)
  while (same.length < 6) same.push(-1)
  return same
})

/** Candidates from the lumbar network's 22 maps (W x H, map pixels): pos [22][6][2] in input pixels, val [22][6] (-1 = no peak;
 *  slot 0 is the plain decoder's choice), cross [22][6][6] (the value of map k near the peaks of each map of the same kind of
 *  corner). p: reading(spec). */
export function peaksFrom(m, W, H, p) {
  const n = W * H, pos = [], val = [], at = [], { nms, r, near, stride } = p
  for (let k = 0; k < K; k++) {
    const off = k * n, cand = []
    let best = -Infinity, bi = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const q = y * W + x, v = m[off + q]
      if (v > best) { best = v; bi = q }
      if (v > FLOOR && isTop(m, off, W, H, x, y, v, nms)) cand.push([v, q])
    }
    cand.sort((a, b) => b[0] - a[0] || a[1] - b[1])
    const v6 = [], p6 = []
    for (let j = 0; j < M; j++) { v6.push(j < cand.length ? cand[j][0] : -1); p6.push(j < cand.length ? cand[j][1] : 0) }
    v6[0] = best; p6[0] = bi
    val.push(v6); at.push(p6)
    pos.push(p6.map((q) => { const c = refine(m, off, W, H, q % W, Math.floor(q / W), r); return [c[0] * stride, c[1] * stride] }))
  }
  const cross = []
  for (let k = 0; k < K; k++) {
    const off = k * n
    cross.push(SIB[k].map((s) => Array.from({ length: M }, (_, j) => {
      if (s < 0 || !(val[s][j] > 0)) return -1
      const q = at[s][j], px = q % W, py = Math.floor(q / W)
      let top = -Infinity
      for (let yy = Math.max(py - near, 0); yy <= Math.min(py + near, H - 1); yy++) for (let xx = Math.max(px - near, 0); xx <= Math.min(px + near, W - 1); xx++) top = Math.max(top, m[off + yy * W + xx])
      return top
    })))
  }
  return { pos, val, cross }
}

/** Experiment 14 step 6: peaksFrom()'s answer from what the lumbar network gives when the peak finding is part of it (pack.py
 *  add_peaks()): out.peaks_blocks (per map, its 8 blocks of 8 x 8 pixels with the strongest peaks, then its 2 with the largest
 *  values), out.peaks_regions (the map around each block, `margin` pixels beyond it, the edge repeated) and out.peaks_near (map k's
 *  largest value within NEAR_R at each pixel of the blocks of each sibling map). W, H: the maps' size; pk: the manifest's
 *  `peaks` (block, candBlocks, rawBlocks, margin). Inside the blocks the same tests as peaksFrom() in the same order, so the same
 *  numbers for every slot the ordering step reads (a slot with no peak, val -1, gets a place that is never read). */
export function peaksFromBlocks(out, W, H, p, pk) {
  const { nms, r, stride } = p, B = pk.block, KB = pk.candBlocks, NB = pk.candBlocks + pk.rawBlocks, R = pk.margin, S = B + 2 * R, Wb = W / B
  const blk = out.peaks_blocks.data, reg = out.peaks_regions.data, nv = out.peaks_near.data
  const pos = [], val = [], home = [], at = [], blocks = []
  for (let k = 0; k < K; k++) {
    const gs = []
    for (let i = 0; i < NB; i++) { const b = Number(blk[k * NB + i]), by = Math.floor(b / Wb), bx = b % Wb; gs.push({ y0: by * B, x0: bx * B, off: (k * NB + i) * S * S }) }
    blocks.push(gs)
    const get = (g, x, y) => reg[g.off + (y - g.y0 + R) * S + (x - g.x0 + R)]
    const cand = []
    for (let i = 0; i < KB; i++) {
      const g = gs[i]
      for (let y = g.y0; y < g.y0 + B; y++) for (let x = g.x0; x < g.x0 + B; x++) {
        const v = get(g, x, y)
        if (!(v > FLOOR)) continue
        let top = true                                                // isTop(): nothing higher within nms pixels
        for (let yy = Math.max(y - nms, 0); top && yy <= Math.min(y + nms, H - 1); yy++) for (let xx = Math.max(x - nms, 0); xx <= Math.min(x + nms, W - 1); xx++) if (get(g, xx, yy) > v) { top = false; break }
        if (top) cand.push([v, y * W + x, i])
      }
    }
    cand.sort((a, b) => b[0] - a[0] || a[1] - b[1])
    let best = -Infinity, bi = 0, bg = KB                             // the largest value, its first place
    for (let i = KB; i < NB; i++) {
      const g = gs[i]
      for (let y = g.y0; y < g.y0 + B; y++) for (let x = g.x0; x < g.x0 + B; x++) { const v = get(g, x, y), q = y * W + x; if (v > best || (v === best && q < bi)) { best = v; bi = q; bg = i } }
    }
    const v6 = [], p6 = [], g6 = []
    for (let j = 0; j < M; j++) { v6.push(j < cand.length ? cand[j][0] : -1); p6.push(j < cand.length ? cand[j][1] : 0); g6.push(j < cand.length ? cand[j][2] : -1) }
    v6[0] = best; p6[0] = bi; g6[0] = bg
    val.push(v6); at.push(p6); home.push(g6)
    pos.push(p6.map((q, j) => {
      if (g6[j] < 0) return [0.5 * stride, 0.5 * stride]
      const g = gs[g6[j]], px = q % W, py = Math.floor(q / W), peak = get(g, px, py), thr = 0.05 * peak      // refine()
      let tot = 0, sx = 0, sy = 0
      for (let yy = Math.max(py - r, 0); yy <= Math.min(py + r, H - 1); yy++) for (let xx = Math.max(px - r, 0); xx <= Math.min(px + r, W - 1); xx++) {
        const v = get(g, xx, yy) - thr
        if (v > 0) { tot += v; sx += v * xx; sy += v * yy }
      }
      tot = Math.max(tot, 1e-6)
      return [(sx / tot + 0.5) * stride, (sy / tot + 0.5) * stride]
    }))
  }
  const per = NB * B * B, cross = []
  for (let k = 0; k < K; k++) cross.push(SIB[k].map((s, si) => Array.from({ length: M }, (_, j) => {
    if (s < 0 || !(val[s][j] > 0)) return -1
    const g = blocks[s][home[s][j]], q = at[s][j], px = q % W, py = Math.floor(q / W)
    return nv[k * M * per + si * per + home[s][j] * B * B + (py - g.y0) * B + (px - g.x0)]
  })))
  return { pos, val, cross }
}

/** The body-outline network's answer as 0/1 bytes. */
export function outline(m, W, H) {
  const on = new Uint8Array(W * H)
  for (let p = 0; p < on.length; p++) on[p] = m[p] > 0 ? 1 : 0
  return on
}

/** What to do with a network's maps, by name: these run where the network runs. W, H: the maps' size (experiment 14: the
 *  lumbar network's may be smaller than its input; spec says by how much, and the pixel numbers of its reading). */
export const READ = {
  pairs: (m, W, H) => allPairs(m, W, H),
  locate: (m, W, H) => locatePairs(m, W, H),
  fine: (m, W, H, guide) => fineRead(m, W, H, guide),
  lumbar: (m, W, H, extra, spec) => peaksFrom(m, W, H, reading(spec)),
  // step 6: from what the network gives when the peak finding is part of it; w, h the input's size
  lumbarList: (out, w, h, extra, spec) => peaksFromBlocks(out, w / spec.stride, h / spec.stride, reading(spec), spec.peaks),
  outline: (m, W, H) => outline(m, W, H),
}
