// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// NAME.q8 (phone/web/pack.py) back into the 32-bit weights file a network's layout expects: convolutions were
// stored in 8 bits with one scale per output channel, everything else as it was.
/** entry: the network's line of manifest.json; blob: an ArrayBuffer holding NAME.q8 from its first byte. over (experiment 15, the
 *  combined network's where look): a Map from a tensor's place in NAME.q8 to the numbers that replace its per-channel scales (a
 *  convolution: the same 8-bit codes) or its values (lookTable()); without it, NAME.q8 as it is. */
export function unpack(entry, blob, over = null) {
  const out = new Float32Array(entry.bytes / 4), q = new Int8Array(blob)
  for (const [off, n, kind, channels, at] of entry.tensors) {
    const o = off / 4
    if (kind === 1) {
      const scale = over?.get(at) || new Float32Array(blob, Math.ceil((at + n) / 4) * 4, channels), per = n / channels
      for (let c = 0; c < channels; c++) { const s = scale[c], from = at + c * per, to = o + c * per; for (let i = 0; i < per; i++) out[to + i] = q[from + i] * s }
    } else out.set(over?.get(at) || new Float32Array(blob, at, n), o)
  }
  return out
}

/** Experiment 15: the where look's table of the combined network (pack.py combo()), lying in `buf` from byte `at`: a Map from each
 *  replaced tensor's place in NAME.q8 to its numbers, for unpack() and unpack16(). */
export function lookTable(entry, buf, at) {
  const over = new Map()
  let o = at
  for (const [i, cnt] of entry.where.table) { over.set(entry.tensors[i][4], new Float32Array(buf, o, cnt)); o += 4 * cnt }
  return over
}

const F = new Float32Array(1), U = new Uint32Array(F.buffer), TINY = Math.fround(1e-7)
/** A number as a half float's 16 bits: onnxconverter_common's convert_np_to_float16 (numbers nearer zero than 1e-7 are
 *  kept at 1e-7, finite ones beyond 1e4 at 1e4), then numpy's rounding to the nearest half float, ties to even. */
export function toHalf(v) {
  F[0] = v
  let x = F[0]
  if (x > 0 && x < TINY) x = TINY
  else if (x < 0 && x > -TINY) x = -TINY
  else if (x > 1e4 && x < Infinity) x = 1e4
  else if (x < -1e4 && x > -Infinity) x = -1e4
  F[0] = x
  const b = U[0], sign = (b >>> 16) & 0x8000, exp = (b >>> 23) & 0xff, mant = b & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 112                                               // the half float's exponent field
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {                                                     // a subnormal half float, or zero
    const shift = 14 - e
    if (shift > 24) return sign
    const M = mant | 0x800000, m = M >>> shift, rest = M & ((1 << shift) - 1), half = 1 << (shift - 1)
    return sign | (rest > half || (rest === half && (m & 1)) ? m + 1 : m)
  }
  const h = sign | (e << 10) | (mant >>> 13), rest = mant & 0x1fff
  return rest > 0x1000 || (rest === 0x1000 && (h & 1)) ? h + 1 : h
}

/** NAME.f16.bin for the 16-bit layout (experiment 13) from the same NAME.q8: entry16 is the manifest's `f16` part; each of its
 *  tensors [offset, numbers, kind, channels, place in NAME.q8, half] is written as half floats (half = 1) or as 32-bit numbers.
 *  Experiment 15: an 8-bit weight takes one of 256 values in its channel, so for a channel of many weights the 256 half floats are
 *  worked out once and looked up (the very same numbers, about ten times faster; checked bit for bit, RESULT_15_start.md). */
export function unpack16(entry16, blob, over = null) {
  const out = new ArrayBuffer(entry16.bytes), q = new Int8Array(blob), tab = new Uint16Array(256)
  for (const [off, n, kind, channels, at, half] of entry16.tensors) {
    if (kind === 1 && half && n / channels >= 64) {
      const dst = new Uint16Array(out, off, n), scale = over?.get(at) || new Float32Array(blob, Math.ceil((at + n) / 4) * 4, channels), per = n / channels
      for (let c = 0; c < channels; c++) {
        const s = scale[c], from = at + c * per, to = c * per
        for (let v = -128; v < 128; v++) tab[v & 255] = toHalf(Math.fround(v * s))
        for (let i = 0; i < per; i++) dst[to + i] = tab[q[from + i] & 255]
      }
      continue
    }
    const dst = half ? new Uint16Array(out, off, n) : new Float32Array(out, off, n)
    const put = half ? (i, v) => { dst[i] = toHalf(v) } : (i, v) => { dst[i] = v }
    if (kind === 1) {
      const scale = over?.get(at) || new Float32Array(blob, Math.ceil((at + n) / 4) * 4, channels), per = n / channels
      for (let c = 0; c < channels; c++) { const s = scale[c], from = at + c * per, to = c * per; for (let i = 0; i < per; i++) put(to + i, Math.fround(q[from + i] * s)) }
    } else { const src = over?.get(at) || new Float32Array(blob, at, n); for (let i = 0; i < n; i++) put(i, src[i]) }
  }
  return new Uint8Array(out)
}
