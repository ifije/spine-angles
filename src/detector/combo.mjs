// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// Experiment 15 (RESULT_15_page.md): the combined network's path, phone/combo15_path.py's Combo.guess() and .guess_from_drag(),
// function for function (the names are kept so that the two can be read side by side). One network, two looks:
//   where: the whole picture shrunk to about 0.15 megapixels: S1 midpoint, hip axis midpoint, L1 upper endplate midpoint (place, size);
//   read:  a 384 x 576 crop framed from S1 at the trained size: the 22 lumbar points, the femoral heads and both ends of S1;
//   a second read look only when the first chain is flagged or its size disagrees with the size assumed by more than 15%.
// After a drag along an L4 or L5 endplate: the read look alone, framed from the drag.
//
// The network is reached through look(kind, pic) -> { d: Float32Array, maps, first, w, h, ms }: the raw maps of one look (kind
// 'where' or 'read', pic a grey picture { d, w, h }), whoever runs it (backend-ort.mjs, the runtime; backend-hand.mjs, hand-written
// shaders; backend-node.mjs in Node). `first`: the index of the first map in d (a backend may give only a look's own maps). The maps
// are read here, on the page. Every number comes from the network's manifest entry (`spec`, pack.py combo_spec(), from the
// variant's variant.json); none is typed here. Coordinates are picture pixels, pixel-corner convention.
import { resized, pad32, cropBox } from './img.mjs'
import { solve, PARAMS } from './order.mjs'
import { peaksFrom } from './decode.mjs'

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const deg = (r) => (r * 180) / Math.PI
const one = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100
const r2 = (v) => Math.round(v * 100) / 100
const NAMES = ['L1', 'L2', 'L3', 'L4', 'L5'].flatMap((lv) => ['sup', 'inf'].map((pl) => `${lv}_${pl}`)).concat(['S1_sup']).flatMap((e) => [`${e}_ant`, `${e}_post`])
const leftToRight = (a, b) => { const v = b[0] >= a[0] ? [b[0] - a[0], b[1] - a[1]] : [a[0] - b[0], a[1] - b[1]]; return deg(Math.atan2(v[1], v[0])) }
const wrap180 = (a) => { const r = ((((a + 180) % 360) + 360) % 360) - 180; return r === -180 ? 180 : r }
const tiltError = (p, r) => { const d = Math.abs(wrap180(p - r)); return Math.min(d, 180 - d) }
const median = (v) => { const s = v.slice().sort((a, b) => a - b), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2 }
const endplateMedian = (pts) => median(Array.from({ length: 11 }, (_, e) => dist(pts[2 * e], pts[2 * e + 1])))

function isTop(m, off, W, H, x, y, v, r) {                 // nothing higher within r pixels (a square, as max-pooling)
  const y0 = Math.max(y - r, 0), y1 = Math.min(y + r, H - 1), x0 = Math.max(x - r, 0), x1 = Math.min(x + r, W - 1)
  for (let yy = y0; yy <= y1; yy++) { const row = off + yy * W; for (let xx = x0; xx <= x1; xx++) if (m[row + xx] > v) return false }
  return true
}
/** Centre of mass of a (2r+1) window around (px, py), what is below `cut` of the value at the peak `v` left out; +0.5 (pixel corners). */
function centre(m, off, W, H, px, py, r, v, cut) {
  const thr = cut * v
  let tot = 0, sx = 0, sy = 0
  for (let yy = Math.max(py - r, 0); yy <= Math.min(py + r, H - 1); yy++) for (let xx = Math.max(px - r, 0); xx <= Math.min(px + r, W - 1); xx++) {
    const w = m[off + yy * W + xx] - thr
    if (w > 0) { tot += w; sx += w * xx; sy += w * yy }
  }
  tot = Math.max(tot, 1e-6)
  return [sx / tot + 0.5, sy / tot + 0.5]
}
function argmax(m, off, n) {
  let best = -Infinity, at = 0
  for (let p = 0; p < n; p++) { const v = m[off + p]; if (v > best) { best = v; at = p } }
  return [at, best]
}
/** One map of a look, by its index in the network's 28 maps. */
const mapAt = (r, k) => {
  const i = k - (r.first || 0)
  if (i < 0 || i >= r.maps) throw new Error(`map ${k} is not in this look's answer (maps ${r.first || 0} to ${(r.first || 0) + r.maps - 1})`)
  return i * r.w * r.h
}

// ---------------------------------------------------------------- where

/** Combo.where_peaks(): local maxima over pool x pool of at least `floor`, the best k, each refined by the centre of mass of a
 *  (2r+1) window (less `cut` of its value): [x, y, value] in map pixels. */
function wherePeaks(r, k, w) {
  const off = mapAt(r, k), W = r.w, H = r.h, m = r.d, half = (w.pool - 1) / 2, found = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = m[off + y * W + x]
    if (v >= w.floor && v > 0 && isTop(m, off, W, H, x, y, v, half)) found.push([v, y * W + x])
  }
  found.sort((a, b) => b[0] - a[0] || a[1] - b[1])
  return found.slice(0, w.k).map(([v, p]) => [...centre(m, off, W, H, p % W, Math.floor(p / W), w.r, v, w.cut), v])
}

/** Combo.where_look(): candidates, best first: { score, M (S1 midpoint), H (hip axis or null), T (L1 or null), E (size) } in picture
 *  pixels; at most `keep`, one per place. */
export async function whereLook(look, spec, img, work) {
  const w = spec.where, f = Math.min(1, Math.sqrt(w.pixels / (img.w * img.h)))
  const small = resized(img, f), sx = small.w / img.w, sy = small.h / img.h
  const r = await counted(look, 'where', pad32(small), work)
  const back = (q) => [q[0] / sx, q[1] / sy]
  const [s1s, hips, tops] = [spec.maps.where_s1, spec.maps.where_hips, spec.maps.where_l1].map((k) => wherePeaks(r, k, w))
  const cands = []
  for (const mp of s1s) {
    const hs = hips.filter((hp) => hp[1] > mp[1] && Math.abs(hp[0] - mp[0]) <= w.hips.across * (hp[1] - mp[1]) && w.hips.d[0] <= Math.hypot(hp[0] - mp[0], hp[1] - mp[1]) && Math.hypot(hp[0] - mp[0], hp[1] - mp[1]) <= w.hips.d[1])
    const ts = tops.filter((tp) => tp[1] < mp[1] && Math.abs(tp[0] - mp[0]) <= w.l1.across * (mp[1] - tp[1]) && w.l1.d[0] <= Math.hypot(tp[0] - mp[0], tp[1] - mp[1]) && Math.hypot(tp[0] - mp[0], tp[1] - mp[1]) <= w.l1.d[1])
    const M = back(mp)
    for (const hp of [...hs, null]) for (const tp of [...ts, null]) {
      if (hp === null && tp === null) continue
      const H = hp === null ? null : back(hp), T = tp === null ? null : back(tp)
      const logs = [], ws = []
      if (H !== null) { logs.push(Math.log(dist(H, M) / w.HIP_E)); ws.push(w.w_hips) }
      if (T !== null) { logs.push(Math.log(dist(T, M) / w.L1_E)); ws.push(w.w_l1) }
      if (logs.length === 2 && Math.abs(logs[0] - logs[1]) > w.apart_log) continue          // the hips and L1 disagree on the size: not one spine
      let num = 0, den = 0
      for (let i = 0; i < logs.length; i++) { num += logs[i] * ws[i]; den += ws[i] }
      const E = Math.exp(num / den)
      const score = Math.min(mp[2], 1) * ((hp ? Math.min(hp[2], 1) : 0) + (tp ? Math.min(tp[2], 1) : 0)) / 2
      cands.push({ score, M, H, T, E })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const kept = []
  for (const c of cands) {                                       // one candidate per place
    if (kept.every((q) => dist(c.M, q.M) > w.apart * Math.min(c.E, q.E))) kept.push(c)
    if (kept.length === w.keep) break
  }
  return kept
}

// ---------------------------------------------------------------- read

/** Combo.box(): the read crop (x0, y0, w, h) in picture pixels for an S1 midpoint M and a size E. */
export function box(spec, M, E) {
  const [W, H] = spec.read.size, sc = spec.read.E_px / E, w = W / sc, h = H / sc
  return [M[0] - spec.read.S1_at[0] * w, M[1] - spec.read.S1_at[1] * h, w, h]
}

/** Combo.hip_axis(): the hip axis midpoint (centre of mass above `cut` of the peak within `radius` of the strongest response), the
 *  head centres (peaks over pool x pool of at least `floor` of the strongest, within the same radius; the best two) and the peak. */
function hipAxis(m, off, W, H, p) {
  const [at, peak] = argmax(m, off, W * H), px = at % W, py = Math.floor(at / W), rr = p.hip_radius * p.hip_radius, R = Math.floor(p.hip_radius), half = p.head_pool >> 1
  let tot = 0, sx = 0, sy = 0
  const cand = []
  for (let y = Math.max(py - R, 0); y <= Math.min(py + R, H - 1); y++) for (let x = Math.max(px - R, 0); x <= Math.min(px + R, W - 1); x++) {
    if ((x - px) ** 2 + (y - py) ** 2 > rr) continue
    const v = m[off + y * W + x], w = v - p.hip_cut * peak
    if (w > 0) { tot += w; sx += w * x; sy += w * y }
    if (v >= p.head_floor * peak && v > 0 && isTop(m, off, W, H, x, y, v, half)) cand.push([v, y * W + x])
  }
  tot = Math.max(tot, 1e-6)
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1])
  return { mid: [sx / tot + 0.5, sy / tot + 0.5], heads: cand.slice(0, 2).map(([, q]) => [q % W + 0.5, Math.floor(q / W) + 0.5]), peak }
}

/** Combo.read_look(): one read look in the box; M0, H0: where the S1 midpoint and the hip axis are expected (picture pixels; H0 null:
 *  below S1 at the expected distance; M0 null, the drag path: from this look's own chain). The chain and the pelvis in picture pixels. */
export async function readLook(look, spec, prior, img, bx, M0, H0, work) {
  const [W, H] = spec.read.size, L = spec.read.lumbar, P = spec.read.pelvis
  const { img: crop, org, sc } = cropBox(img, bx[0], bx[1], bx[2], bx[3], W, H)
  const r = await counted(look, 'read', crop, work)
  if (r.w !== W || r.h !== H) throw new Error(`the read look gave ${r.w} x ${r.h} maps, not ${W} x ${H}`)
  const lo = mapAt(r, spec.maps.lumbar[0])
  const cands = peaksFrom(lo ? r.d.subarray(lo) : r.d, W, H, { nms: L.NMS, r: L.DECODE_R, near: L.NEAR_R, stride: L.stride })
  const s = solve(cands, prior, { ...PARAMS, dedupe: L.DEDUPE })
  const eRead = endplateMedian(s.pts), scm = (sc[0] + sc[1]) / 2
  const chain = { pts: s.pts.map((q) => [q[0] / sc[0] + org[0], q[1] / sc[1] + org[1]]), worst_link: s.worst_link, flagged: s.worst_link > spec.accept.dead,
    support: s.lowest_value, E: eRead / scm, size_fit: Math.exp(-0.5 * ((eRead - L.LUMBAR_LEN) / L.FIT_SD) ** 2) }
  // the close-up's three maps, read as measure_pelvis(guided=True) reads them
  let m0, h0
  if (M0 === null) { m0 = mid(s.pts[20], s.pts[21]); h0 = [m0[0], m0[1] + spec.where.HIP_E * eRead] }
  else {
    m0 = [(M0[0] - org[0]) * sc[0], (M0[1] - org[1]) * sc[1]]
    h0 = H0 === null ? [m0[0], m0[1] + spec.where.HIP_E * spec.read.E_px] : [(H0[0] - org[0]) * sc[0], (H0[1] - org[1]) * sc[1]]
  }
  const d = dist(h0, m0), n = W * H, rs = (P.s1_reach * d) ** 2, rh = (P.hip_reach * d) ** 2
  const hip = r.d.slice(mapAt(r, spec.maps.heads), mapAt(r, spec.maps.heads) + n), a = r.d.slice(mapAt(r, spec.maps.s1_front), mapAt(r, spec.maps.s1_front) + n)
  const b = r.d.slice(mapAt(r, spec.maps.s1_back), mapAt(r, spec.maps.s1_back) + n)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, gx = x + 0.5, gy = y + 0.5
    if (!((gx - h0[0]) ** 2 + (gy - h0[1]) ** 2 <= rh)) hip[p] = 0
    if (!((gx - m0[0]) ** 2 + (gy - m0[1]) ** 2 <= rs)) { a[p] = -1; b[p] = -1 }
  }
  const end = (mm) => { const [q, v] = argmax(mm, 0, n); return [...centre(mm, 0, W, H, q % W, Math.floor(q / W), P.S1_R, v, 0.05), v] }
  const A0 = end(a), B0 = end(b), hp = hipAxis(hip, 0, W, H, P)
  const back = (q) => [q[0] / sc[0] + org[0], q[1] / sc[1] + org[1]]
  const A = back(A0), B = back(B0), Hh = back(hp.mid)
  const conf = { hip: hp.peak, s1_ant: A0[2], s1_post: B0[2] }
  const ratio = dist(B, A) / Math.max(dist(Hh, mid(A, B)), 1.0)
  const pel = { A, B, H: Hh, heads: hp.heads.map(back), conf, verify: Math.min(conf.hip, conf.s1_ant, conf.s1_post, 1.0), ratio,
    plausible: spec.accept.s1_ratio[0] <= ratio && ratio <= spec.accept.s1_ratio[1] }
  return { chain, pel, box: bx }
}

// ---------------------------------------------------------------- acceptance and the record

/** Combo.judge(): tier and quality of one look, as the present path decides (drag: as the drag build decides). */
export function judge(spec, lk, drag = false) {
  const { pel, chain: ch } = lk, a = spec.accept
  if (pel !== null && pel.verify >= a.shown) {
    const accepted = pel.verify >= a.accepted && pel.plausible
    const tilt = tiltError(leftToRight(pel.A, pel.B), leftToRight(ch.pts[20], ch.pts[21]))
    const lumbarOk = !ch.flagged && ch.support >= a.support && tilt <= a.s1_agree
    return { tier: accepted ? (lumbarOk ? 'all' : 'pelvis') : 'guess', q: pel.verify, accepted, lumbar_ok: lumbarOk, tilt }
  }
  const sound = !ch.flagged && ch.support >= a.support, good = sound && (drag || ch.size_fit >= a.size_fit)
  return { tier: good ? 'lumbar' : drag ? 'guess' : 'none', q: ch.support * ch.size_fit, accepted: false, lumbar_ok: good, tilt: null }
}

/** The landmarks of one look as Combo.record() names them: [{ name, x, y, confidence }], rounded to a hundredth of a pixel. */
export function named(spec, lk) {
  const { pel, chain: ch } = lk, out = []
  const add = (name, p, c) => out.push({ name, x: r2(p[0]), y: r2(p[1]), confidence: one(c) })
  const pelvisMode = pel !== null && pel.verify >= spec.accept.shown, chainGiven = !ch.flagged
  if (pelvisMode) {
    pel.heads.slice(0, 2).forEach((c, i) => add(`femoral_head_${'ab'[i]}_center`, c, pel.conf.hip))
    add('S1_sup_ant', pel.A, pel.conf.s1_ant)
    add('S1_sup_post', pel.B, pel.conf.s1_post)
  } else if (chainGiven) {
    add('S1_sup_ant', ch.pts[20], ch.support)
    add('S1_sup_post', ch.pts[21], ch.support)
  }
  if (chainGiven) {
    NAMES.slice(0, 20).forEach((name, k) => add(name, ch.pts[k], ch.support))
    add('L1_center', [0, 1].map((i) => (ch.pts[0][i] + ch.pts[1][i] + ch.pts[2][i] + ch.pts[3][i]) / 4), ch.support)
  }
  return { landmarks: out, pelvisMode, chainGiven }
}

/** The guess as pipeline.mjs guess() gives it (the same record shape the page draws), from the look kept; `a3`: what the path did. */
function record(spec, img, lk, j, a3, search) {
  const { landmarks, pelvisMode, chainGiven } = named(spec, lk), pel = lk.pel, ch = lk.chain
  const at = Object.fromEntries(landmarks.map((l) => [l.name, l]))
  const rd = (q) => [r2(q[0]), r2(q[1])]
  return {
    width: img.w, height: img.h, landmarks, facing: at.S1_sup_ant && at.S1_sup_post ? (at.S1_sup_ant.x > at.S1_sup_post.x ? 'right' : 'left') : null,
    guess: { tier: j.tier, pipeline_result: spec.labels[j.tier], pelvis_confidence: pel === null ? null : one(pel.verify), lumbar_support: one(ch.support),
      lumbar_chain_given: chainGiven, s1_from: pelvisMode ? 'close-up maps' : chainGiven ? 'lumbar chain' : null, s1_confirmed_by_second_network: null,
      s1_tilt_difference_between_networks: j.tilt === null ? null : Math.round(j.tilt * 10) / 10, turned_quarters: 0, mirrored: false, bodies: 0, body_found: null,
      search, lumbar_framing: null, accepted: j.accepted, lumbar_ok: j.lumbar_ok, a3 },
    pelvis: pelvisMode ? { A: rd(pel.A), B: rd(pel.B), H: rd(pel.H), verify: pel.verify, plausible: pel.plausible } : null,
    chain: { flagged: ch.flagged, support: ch.support, size_fit: ch.size_fit },
  }
}

/** A look through `look`, counted per kind as Combo.forward() counts: [looks, megapixels in all, the largest look], and its milliseconds. */
async function counted(look, kind, pic, work) {
  const r = await look(kind, pic)
  const w = (work[kind] ||= [0, 0, 0, 0]), m = pic.w * pic.h / 1e6
  w[0]++; w[1] += m; w[2] = Math.max(w[2], m); w[3] += r.ms || 0
  return r
}
const workOut = (work) => Object.fromEntries(Object.entries(work).map(([k, v]) => [k, [v[0], Math.round(v[1] * 1e4) / 1e4, Math.round(v[2] * 1e4) / 1e4, Math.round(v[3])]]))

// ---------------------------------------------------------------- the two entries

/** Combo.guess(): the automatic path. hooks.onRead(early): called once the first read look is decoded, with what it would draw
 *  ({ landmarks, pelvis, confidence, support, more: whether a second look follows }). */
export async function guessA3(look, spec, prior, img, hooks = {}) {
  const work = {}, band = spec.second.band
  const cands = await whereLook(look, spec, img, work)
  if (!cands.length) return search(look, spec, prior, img, work)
  const c = cands[0]
  const l1 = await readLook(look, spec, prior, img, box(spec, c.M, c.E), c.M, c.H, work)
  const { chain: ch, pel } = l1
  const sizeRatio = ch.E / c.E
  const why = ch.flagged ? 'flagged' : !(1 / band <= sizeRatio && sizeRatio <= band) ? 'size' : null
  hooks.onRead?.({ ...named(spec, l1), confidence: one(pel.verify), support: one(ch.support), more: !!why })
  const looks = [l1]
  let how = null
  if (why) {
    const sure = Math.min(pel.conf.s1_ant, pel.conf.s1_post) >= spec.second.sure
    const S = sure ? [pel.A, pel.B] : [ch.pts[20], ch.pts[21]]
    let H2 = pel.conf.hip >= spec.accept.shown ? pel.H : null, M2, E2
    if (!ch.flagged) { M2 = mid(S[0], S[1]); E2 = ch.E; how = 'refit from look 1' }
    else if (sure) { M2 = mid(S[0], S[1]); E2 = dist(pel.B, pel.A) / spec.second.S1_E; how = 'from look 1\'s close-up S1' }
    else if (cands.length > 1) { M2 = cands[1].M; E2 = cands[1].E; H2 = cands[1].H; how = 'the where look\'s next candidate' }
    else { M2 = mid(S[0], S[1]); E2 = c.E; how = 'moved to look 1\'s S1' }
    looks.push(await readLook(look, spec, prior, img, box(spec, M2, E2), M2, H2, work))
  }
  const judged = looks.map((lk) => judge(spec, lk))
  let best = 0
  for (let i = 1; i < looks.length; i++) {                         // max by (rank, quality, i): equal, the later
    const a = judged[i], b = judged[best]
    if (spec.rank[a.tier] > spec.rank[b.tier] || (spec.rank[a.tier] === spec.rank[b.tier] && a.q >= b.q)) best = i
  }
  const a3 = { path: 'where+read', second_look: why, second_how: how, kept_look: best + 1, size_ratio: Math.round(sizeRatio * 1000) / 1000,
    where: { score: Math.round(c.score * 1000) / 1000, hips: c.H !== null, l1: c.T !== null, candidates: cands.length }, work: workOut(work) }
  return record(spec, img, looks[best], judged[best], a3, why ? 'one network: where, read, second read' : 'one network: where, read')
}

/** Combo.search(): no where candidate: the read look over the whole picture at the lumbar search's sizes (chain only). */
async function search(look, spec, prior, img, work) {
  const long = Math.max(img.w, img.h), L = spec.read.lumbar, fs = []
  for (const side of spec.search.sides) {
    const f = Math.min(side / long, Math.sqrt(spec.search.cap / (img.w * img.h)))
    if (fs.every((g) => Math.abs(f - g) > 1e-6)) fs.push(f)
  }
  let best = null
  for (const f of fs) {
    const canvas = pad32(resized(img, f))
    const r = await counted(look, 'read', canvas, work)
    const lo = mapAt(r, spec.maps.lumbar[0])
    const s = solve(peaksFrom(lo ? r.d.subarray(lo) : r.d, r.w, r.h, { nms: L.NMS, r: L.DECODE_R, near: L.NEAR_R, stride: L.stride }), prior, { ...PARAMS, dedupe: L.DEDUPE })
    const eRead = endplateMedian(s.pts), fit = Math.exp(-0.5 * ((eRead - L.LUMBAR_LEN) / L.FIT_SD) ** 2), flagged = s.worst_link > spec.accept.dead
    const ch = { pts: s.pts.map((q) => [q[0] / f, q[1] / f]), worst_link: s.worst_link, flagged, support: s.lowest_value, E: eRead / f, size_fit: fit }
    const score = (flagged ? 0.25 : 1.0) * ch.support * fit
    if (best === null || score > best[0]) best = [score, ch]
  }
  const lk = { chain: best[1], pel: null }
  const a3 = { path: 'search', second_look: null, second_how: null, kept_look: null, where: null, work: workOut(work) }
  return record(spec, img, lk, judge(spec, lk), a3, 'one network: no place found, the read look over the whole picture')
}

/** Combo.guess_from_drag(): from one drag along an L4 or L5 endplate (drag = [[x, y], [x, y]], picture pixels, either way round): the
 *  read look framed from the drag as an L4 lower endplate; a second look framed from the first chain's S1 when that chain is flagged
 *  or the drag's length over the chain's endplate nearest it is outside 1/1.15 to 1.15; that look kept. No where look. */
export async function guessA3FromDrag(look, spec, prior, img, drag, hooks = {}) {
  const work = {}, [p, q] = drag, [W, H] = spec.read.size, band = spec.drag.band
  const L = dist(q, p), m = mid(p, q), E = L / spec.drag.L4I_E, sc = spec.read.E_px / E, w = W / sc, h = H / sc
  const yAt = spec.read.S1_at[1] * H - spec.drag.L4I_UP * spec.read.E_px                // where the drag's midpoint sits in the read frame
  const l1 = await readLook(look, spec, prior, img, [m[0] - spec.drag.across * w, m[1] - yAt / sc, w, h], null, null, work)
  const pts = l1.chain.pts
  let e = 0, nearest = Infinity
  for (let k = 0; k < 11; k++) { const d = dist(mid(pts[2 * k], pts[2 * k + 1]), m); if (d < nearest) { nearest = d; e = k } }
  const ratio = L / Math.max(dist(pts[2 * e + 1], pts[2 * e]), 1e-6)
  const why = l1.chain.flagged ? 'flagged' : !(1 / band <= ratio && ratio <= band) ? 'length' : null
  hooks.onRead?.({ ...named(spec, l1), confidence: one(l1.pel.verify), support: one(l1.chain.support), more: !!why })
  let lk = l1
  if (why) lk = await readLook(look, spec, prior, img, box(spec, mid(pts[20], pts[21]), l1.chain.E), null, null, work)
  const j = judge(spec, lk, true)
  const a3 = { path: 'drag', second_look: why, kept_look: why ? 2 : 1, work: workOut(work) }
  const rec = record(spec, img, lk, j, a3, why ? 'one network: drag, read, second read' : 'one network: drag, read')
  rec.guess.drag = { ratio: Math.round(ratio * 1000) / 1000, second_look: !!why, why, first_flagged: l1.chain.flagged, chain_flagged: lk.chain.flagged, hips_pair_found: null }
  return rec
}
