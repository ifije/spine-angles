// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// Grey 8-bit pictures and the few things the pipeline does to them, written to give what OpenCV gives in
// pelvis/pcommon.py and pelvis/pipeline.py (resizing by area and by interpolation, cutting a box, turning).
// A picture is { d: Uint8Array, w, h }, rows top to bottom. Checked against OpenCV by phone/web/check_img.py.

/** Python's round(): halves go to the even number. */
export function pyRound(x) {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
const u8 = (v) => { const r = pyRound(v); return r < 0 ? 0 : r > 255 ? 255 : r }

export const blank = (w, h) => ({ d: new Uint8Array(w * h), w, h })

// ---------------------------------------------------------------- resizing

function areaTab(ssize, dsize) {                       // OpenCV's computeResizeAreaTab
  const scale = 1 / (dsize / ssize)
  const start = new Int32Array(dsize + 1), si = [], al = []
  for (let dx = 0; dx < dsize; dx++) {
    start[dx] = si.length
    const fsx1 = dx * scale, fsx2 = fsx1 + scale
    const cell = Math.min(scale, ssize - fsx1)
    let sx1 = Math.ceil(fsx1), sx2 = Math.floor(fsx2)
    sx2 = Math.min(sx2, ssize - 1)
    sx1 = Math.min(sx1, sx2)
    if (sx1 - fsx1 > 1e-3) { si.push(sx1 - 1); al.push((sx1 - fsx1) / cell) }
    for (let sx = sx1; sx < sx2; sx++) { si.push(sx); al.push(1 / cell) }
    if (fsx2 - sx2 > 1e-3) { si.push(sx2); al.push(Math.min(Math.min(fsx2 - sx2, 1), cell) / cell) }
  }
  start[dsize] = si.length
  return { start, si: Int32Array.from(si), al: Float32Array.from(al) }
}

function resizeArea(src, dw, dh) {
  const { d: S, w: sw, h: sh } = src
  const out = new Uint8Array(dw * dh)
  const kx = sw / dw, ky = sh / dh
  if (Number.isInteger(kx) && Number.isInteger(ky)) {            // whole blocks: OpenCV's fast path
    const two = kx === 2 && ky === 2, inv = Math.fround(1 / (kx * ky))
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      let sum = 0
      for (let j = 0; j < ky; j++) { const at = (y * ky + j) * sw + x * kx; for (let i = 0; i < kx; i++) sum += S[at + i] }
      out[y * dw + x] = two ? (sum + 2) >> 2 : u8(Math.fround(sum * inv))
    }
    return { d: out, w: dw, h: dh }
  }
  const X = areaTab(sw, dw), Y = areaTab(sh, dh)
  const buf = new Float32Array(dw), sum = new Float32Array(dw)
  let have = -1
  for (let dy = 0; dy < dh; dy++) {
    sum.fill(0)
    for (let k = Y.start[dy]; k < Y.start[dy + 1]; k++) {
      const sy = Y.si[k], beta = Y.al[k]
      if (sy !== have) {                                          // a source row shared by two output rows is read once
        const row = sy * sw
        for (let dx = 0; dx < dw; dx++) {
          let acc = 0
          for (let t = X.start[dx], e = X.start[dx + 1]; t < e; t++) acc += S[row + X.si[t]] * X.al[t]
          buf[dx] = acc
        }
        have = sy
      }
      for (let dx = 0; dx < dw; dx++) sum[dx] += beta * buf[dx]
    }
    const at = dy * dw
    for (let dx = 0; dx < dw; dx++) out[at + dx] = u8(sum[dx])
  }
  return { d: out, w: dw, h: dh }
}

function linearTab(ssize, dsize, clampEnds) {                    // OpenCV's fixed-point coefficients, 11 bits
  const scale = 1 / (dsize / ssize)
  const at = new Int32Array(dsize), a0 = new Int32Array(dsize), a1 = new Int32Array(dsize)
  for (let dx = 0; dx < dsize; dx++) {
    let f = Math.fround((dx + 0.5) * scale - 0.5)
    let s = Math.floor(f)
    f = Math.fround(f - s)
    if (clampEnds) {
      if (s < 0) { f = 0; s = 0 }
      if (s >= ssize - 1) { f = 0; s = ssize - 1 }
    }
    at[dx] = s
    a0[dx] = pyRound(Math.fround(1 - f) * 2048)
    a1[dx] = pyRound(f * 2048)
  }
  return { at, a0, a1 }
}

function resizeLinear(src, dw, dh) {
  const { d: S, w: sw, h: sh } = src
  const out = new Uint8Array(dw * dh)
  const X = linearTab(sw, dw, true), Y = linearTab(sh, dh, false)
  const rows = [new Int32Array(dw), new Int32Array(dw)], held = [-1, -1]
  const clip = (v) => (v < 0 ? 0 : v >= sh ? sh - 1 : v)
  const fill = (buf, sy) => {
    const row = sy * sw
    for (let dx = 0; dx < dw; dx++) {
      const s = X.at[dx]
      buf[dx] = s >= sw - 1 ? S[row + s] * 2048 : S[row + s] * X.a0[dx] + S[row + s + 1] * X.a1[dx]
    }
  }
  for (let dy = 0; dy < dh; dy++) {
    const want = [clip(Y.at[dy]), clip(Y.at[dy] + 1)]
    if (held[1] === want[0] && held[0] !== want[0]) { const t = rows[0]; rows[0] = rows[1]; rows[1] = t; held[0] = held[1]; held[1] = -1 }
    for (let k = 0; k < 2; k++) if (held[k] !== want[k]) {
      if (k === 1 && want[1] === want[0]) rows[1].set(rows[0]); else fill(rows[k], want[k])
      held[k] = want[k]
    }
    const b0 = Y.a0[dy], b1 = Y.a1[dy], r0 = rows[0], r1 = rows[1], at = dy * dw
    for (let dx = 0; dx < dw; dx++) out[at + dx] = (((b0 * (r0[dx] >> 4)) >> 16) + ((b1 * (r1[dx] >> 4)) >> 16) + 2) >> 2
  }
  return { d: out, w: dw, h: dh }
}

/** cv2.resize(src, (dw, dh), interpolation=INTER_AREA if area else INTER_LINEAR). */
export function resize(src, dw, dh, area) {
  if (dw === src.w && dh === src.h) return { d: src.d.slice(), w: dw, h: dh }
  return area && dw <= src.w && dh <= src.h ? resizeArea(src, dw, dh) : resizeLinear(src, dw, dh)
}

/** pipeline.resized(): the picture times f, by area when shrinking. */
export function resized(img, f) {
  return resize(img, Math.max(32, pyRound(img.w * f)), Math.max(32, pyRound(img.h * f)), f < 1)
}

/** pipeline.pad32(): padded with black at the right and bottom to multiples of 32. */
export function pad32(img) {
  const W = Math.floor((img.w + 31) / 32) * 32, H = Math.floor((img.h + 31) / 32) * 32
  if (W === img.w && H === img.h) return img
  const out = blank(W, H)
  for (let y = 0; y < img.h; y++) out.d.set(img.d.subarray(y * img.w, (y + 1) * img.w), y * W)
  return out
}

/** pcommon.crop_box(): the box, black where it leaves the picture, resized. Returns { img, org: [x0, y0], sc: [sx, sy] }. */
export function cropBox(img, x0, y0, w, h, ow, oh) {
  x0 = pyRound(x0); y0 = pyRound(y0); w = Math.max(2, pyRound(w)); h = Math.max(2, pyRound(h))
  const box = blank(w, h)
  const sx0 = Math.max(x0, 0), sy0 = Math.max(y0, 0), sx1 = Math.min(x0 + w, img.w), sy1 = Math.min(y0 + h, img.h)
  if (sx1 > sx0 && sy1 > sy0) for (let y = sy0; y < sy1; y++) box.d.set(img.d.subarray(y * img.w + sx0, y * img.w + sx1), (y - y0) * w + (sx0 - x0))
  return { img: resize(box, ow, oh, ow < w), org: [x0, y0], sc: [ow / w, oh / h] }
}

/** img[y0:y1, x0:x1] */
export function cut(img, x0, y0, x1, y1) {
  const out = blank(x1 - x0, y1 - y0)
  for (let y = y0; y < y1; y++) out.d.set(img.d.subarray(y * img.w + x0, y * img.w + x1), (y - y0) * out.w)
  return out
}

/** numpy.rot90(img, k) for k = 1 (a quarter anticlockwise) or 3 (a quarter clockwise). */
export function rot90(img, k) {
  const { d, w, h } = img, out = blank(h, w)                    // out has w rows and h columns
  if (k === 1) { for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out.d[i * h + j] = d[j * w + (w - 1 - i)] }
  else for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out.d[i * h + j] = d[(h - 1 - j) * w + i]
  return out
}

/** img[:, ::-1] */
export function mirror(img) {
  const { d, w, h } = img, out = blank(w, h)
  for (let y = 0; y < h; y++) { const at = y * w; for (let x = 0; x < w; x++) out.d[at + x] = d[at + w - 1 - x] }
  return out
}

/** RGBA bytes (as a canvas gives them) to grey, with OpenCV's weights. */
export function grey(rgba, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14
  return { d: out, w, h }
}

// ---------------------------------------------------------------- the body outline
// bodymask.predict() makes the outline at 384 pixels and blows it up to the picture's size; pipeline.regions()
// then boxes each body and grows the outline a little. A phone photograph has twelve million pixels, so the
// outline is kept small here and asked point by point; the answers are the same as OpenCV's on the full picture.

/** Connected pieces (touching sides or corners) of a small 0/1 picture: labels (0 = none) and each piece's pixel count. */
export function pieces(m, w, h) {
  const lab = new Int32Array(w * h), count = [0], stack = []
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!m[p0] || lab[p0]) continue
    const id = count.length
    let n = 0
    lab[p0] = id; stack.push(p0)
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w
      n++
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const q = yy * w + xx
        if (m[q] && !lab[q]) { lab[q] = id; stack.push(q) }
      }
    }
    count.push(n)
  }
  return { lab, count }
}

/** The body outline of a W x H picture from the outline network's answer on the shrunken picture (sw x sh of a 384 canvas). */
export function bodyMask(logits, canvas, sw, sh, W, H) {
  const m = new Uint8Array(sw * sh)
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) m[y * sw + x] = logits[y * canvas + x] > 0 ? 1 : 0
  const { lab, count } = pieces(m, sw, sh)
  const keep = new Uint8Array(sw * sh)
  for (let p = 0; p < keep.length; p++) keep[p] = lab[p] && count[lab[p]] > 0.01 * m.length ? 1 : 0
  // which small pixel each picture pixel takes its value from (OpenCV's nearest-neighbour resize), and how many take each
  const fx = 1 / (W / sw), fy = 1 / (H / sh)
  const mapX = new Int32Array(W), mapY = new Int32Array(H), nX = new Float64Array(sw), nY = new Float64Array(sh)
  const firstX = new Int32Array(sw).fill(-1), lastX = new Int32Array(sw), firstY = new Int32Array(sh).fill(-1), lastY = new Int32Array(sh)
  for (let X = 0; X < W; X++) { const s = Math.min(Math.floor(X * fx), sw - 1); mapX[X] = s; nX[s]++; if (firstX[s] < 0) firstX[s] = X; lastX[s] = X }
  for (let Y = 0; Y < H; Y++) { const s = Math.min(Math.floor(Y * fy), sh - 1); mapY[Y] = s; nY[s]++; if (firstY[s] < 0) firstY[s] = Y; lastY[s] = Y }
  let area = 0
  const run = new Int32Array((sw + 1) * sh)                       // per row, how many kept pixels lie left of each column
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    run[y * (sw + 1) + x + 1] = run[y * (sw + 1) + x] + keep[y * sw + x]
    if (keep[y * sw + x]) area += nX[x] * nY[y]
  }
  const grow = Math.max(3, Math.trunc(0.03 * Math.max(W, H))) | 1  // pipeline.grown(): an ellipse this many pixels across
  const r = grow >> 1
  const half = new Int32Array(r + 1)
  for (let dy = 0; dy <= r; dy++) half[dy] = r ? pyRound(r * Math.sqrt((r * r - dy * dy) * (1 / (r * r)))) : 0
  return {
    W, H, sw, sh, keep, share: area / (W * H),
    /** is picture pixel (X, Y) inside the outline? */
    at(X, Y) { return X >= 0 && Y >= 0 && X < W && Y < H && keep[mapY[Y] * sw + mapX[X]] === 1 },
    /** is picture pixel (X, Y) inside the grown outline (where the pipeline may look)? */
    allow(X, Y) {
      if (X < 0 || Y < 0 || X >= W || Y >= H) return false
      for (let dy = -r; dy <= r; dy++) {
        const yy = Y + dy
        if (yy < 0 || yy >= H) continue
        const hw = half[dy < 0 ? -dy : dy], xa = Math.max(X - hw, 0), xb = Math.min(X + hw, W - 1)
        const row = mapY[yy] * (sw + 1)
        if (run[row + mapX[xb] + 1] - run[row + mapX[xa]] > 0) return true
      }
      return false
    },
    /** pipeline.body_boxes(): a box (x0, y0, x1, y1) around each separate body, largest first, with a margin. */
    boxes(margin = 0.06, most = 4, minShare = 0.15) {
      const { lab, count } = pieces(keep, sw, sh)
      const st = count.map(() => ({ area: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1 }))
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const k = lab[y * sw + x]
        if (!k) continue
        const s = st[k]
        s.area += nX[x] * nY[y]
        s.x0 = Math.min(s.x0, firstX[x]); s.x1 = Math.max(s.x1, lastX[x]); s.y0 = Math.min(s.y0, firstY[y]); s.y1 = Math.max(s.y1, lastY[y])
      }
      const order = st.map((s, k) => ({ ...s, k })).slice(1).sort((a, b) => b.area - a.area || b.k - a.k)
      const out = []
      for (const s of order.slice(0, most)) {
        if (s.area < minShare * order[0].area) break
        const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1, pad = margin * Math.max(w, h)
        out.push([Math.max(0, Math.trunc(s.x0 - pad)), Math.max(0, Math.trunc(s.y0 - pad)), Math.min(W, Math.trunc(s.x0 + w + pad) + 1), Math.min(H, Math.trunc(s.y0 + h + pad) + 1)])
      }
      return out
    },
  }
}
