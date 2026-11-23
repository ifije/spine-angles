// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC
// Copied unchanged from the detector's own repository by scripts/sync_detector.py: edit it there, not here.
// A small WebGPU engine for one family of networks (experiment 15, part D): the U-Nets of segmentation_models_pytorch with a
// ResNet-18-style encoder, one input channel, the slim decoder and a 3 x 3 head, run by hand-written WGSL compute shaders with no
// machine-learning runtime. The network comes as data (phone/engine15/export.py: a list of steps and the weights in the page's
// 8-bit pack form).
//
//   const device = await requestDevice()                       // 16-bit shaders asked for where the adapter offers them
//   const eng = await start(device, { steps, q8 }, [[512, 768], [288, 512]])   // sizes are width x height, multiples of 32
//   const maps = await eng.look(picture, [512, 768])            // picture: Float32Array of w * h numbers 0 to 255, row after row
//   // maps: Float32Array, map after map, each h rows of w (as phone/web/js/decode.mjs reads them)
//   eng.bytes                                                   // what it holds on the chip, in bytes
//   eng.end()
//
// How it works (the plain account is in experiments/phone/RESULT_15_engine.md):
// - Every activation lives on the chip in groups of four channels (channel group, row, column; a vec4 of 16-bit or 32-bit
//   numbers). A convolution step is one dispatch: each invocation computes a few neighbouring pixels of one row (PX) for a few
//   groups of four output channels (OB), adding up input group by input group, tap by tap, a 4 x 4 matrix of weights times a
//   vector of four input channels; bias, the ReLU and a ResNet block's addition are done on the way out. A U-Net join is a
//   convolution reading from two inputs, and the decoder's upsampling by 2 is that convolution reading its first input at half
//   the coordinates, so neither is ever written out. The stem reads the picture itself and scales it on the way in. The head
//   writes the maps one after another in the arithmetic in use (16-bit: two neighbouring pixels a 32-bit word), and the processor
//   turns them into 32-bit numbers through a table of all 65536 half floats.
// - Invocations are numbered along whole rows (one flat index, 64 a workgroup), so that a narrow deep layer wastes none; which
//   tiling an invocation gets (defaultTile) was measured step by step (e2e/sweep.py); so was everything dropped (the result file).
// - Every buffer is made once at start: the weights (unpacked from 8 bits to the arithmetic in use), and a fixed set of
//   activation buffers planned from the steps (an activation goes into a buffer no longer needed by then, so that what is held is
//   near the most the network needs at one moment), sized for the largest size asked for and shared by all of them; the picture's
//   buffer and one buffer the processor reads the maps from. A look writes the picture, records every step in one pass, copies
//   the maps out, and waits for them: nothing is made or destroyed per look.
// - 16-bit arithmetic (`enable f16`) where the device has 'shader-f16', 32-bit otherwise, chosen at start; the shader text is the
//   same but for the type names.

const GPU = () => globalThis.GPUBufferUsage
export const FEATURES_WANTED = ['shader-f16', 'timestamp-query']

/** A device on the adapter (powerPreference as given), with 16-bit shaders and timestamps where offered, and the adapter's own
 *  limits on buffer sizes (the defaults allow 128 MB a binding, which a large look in 32-bit can exceed). */
export async function requestDevice(o = {}) {
  if (!navigator.gpu) throw new Error('no WebGPU here')
  const adapter = await navigator.gpu.requestAdapter(o.powerPreference ? { powerPreference: o.powerPreference } : {})
  if (!adapter) throw new Error('no graphics adapter')
  const want = (o.features || FEATURES_WANTED).filter((f) => adapter.features.has(f) && !(o.no16 && f === 'shader-f16'))
  const L = adapter.limits, requiredLimits = {}
  for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxBindGroups',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension']) if (k in L) requiredLimits[k] = L[k]
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits })
  device.engineAdapterInfo = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : {}
  return device
}

// ------------------------------------------------------------------------------------------------ numbers
const F1 = new Float32Array(1), U1 = new Uint32Array(F1.buffer)
/** A number as a half float's 16 bits, rounded to the nearest, ties to even (numpy's astype(float16)). */
export function toHalf(v) {
  F1[0] = v
  const b = U1[0], sign = (b >>> 16) & 0x8000, exp = (b >>> 23) & 0xff, mant = b & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 112
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    const shift = 14 - e
    if (shift > 24) return sign
    const M = mant | 0x800000, m = M >>> shift, rest = M & ((1 << shift) - 1), half = 1 << (shift - 1)
    return sign | (rest > half || (rest === half && (m & 1)) ? m + 1 : m)
  }
  const h = sign | (e << 10) | (mant >>> 13), rest = mant & 0x1fff
  return rest > 0x1000 || (rest === 0x1000 && (h & 1)) ? h + 1 : h
}
let HALF = null
/** All 65536 half floats as 32-bit numbers (made once, 256 KB): reading 16-bit maps back is then one look-up a number. */
function halfTable() {
  if (HALF) return HALF
  HALF = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff
    HALF[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15)
  }
  return HALF
}

// ------------------------------------------------------------------------------------------------ the shaders
const head = (T) => (T === 'f16' ? 'enable f16;\n' : '')
const PARAMS = `struct P { hin: u32, win: u32, ca4: u32, cb4: u32, cout4: u32, cout: u32, hout: u32, wout: u32,
  ha: u32, wa: u32, hb: u32, wb: u32, upa: u32, upb: u32, relu: u32, xg: u32, m0: u32, m1: u32, g0: u32, x3: u32 }
@group(0) @binding(0) var<uniform> p: P;`

/** A convolution (kernel K, stride S, padding Pd) over one or two inputs of groups of four channels; c: { T, A, K, S, Pd, PX, OB,
 *  WX, WY, flat, two, add, out: 'act' | 'maps' | 'maps16', stem, u8, scaled }. T: the storage type, A: the type sums are kept in;
 *  u8: the stem reads the picture as grey bytes, four to a word; scaled: the bias buffer holds a scale and a shift a group of
 *  four channels (a look of a network with two), applied on the way out. */
export function convWGSL(c) {
  const { T, A, K, S, Pd, PX, OB, WX, WY } = c
  const NX = (PX - 1) * S + K, KK = K * K, L = []
  const cvt = (e) => (A === T ? e : `vec4<${A}>(${e})`)
  L.push(head(T) + PARAMS)
  if (c.stem) {
    L.push(`@group(0) @binding(1) var<storage, read> Wt: array<vec4<${T}>>;`)
    L.push(`@group(0) @binding(2) var<storage, read> Bs: array<vec4<${T}>>;`)
    L.push(c.u8 ? `@group(0) @binding(3) var<storage, read> XA: array<u32>;` : `@group(0) @binding(3) var<storage, read> XA: array<f32>;`)
  } else {
    L.push(`@group(0) @binding(1) var<storage, read> Wt: array<mat4x4<${T}>>;`)
    L.push(`@group(0) @binding(2) var<storage, read> Bs: array<vec4<${T}>>;`)
    L.push(`@group(0) @binding(3) var<storage, read> XA: array<vec4<${T}>>;`)
    if (c.two) L.push(`@group(0) @binding(4) var<storage, read> XB: array<vec4<${T}>>;`)
  }
  if (c.add) L.push(`@group(0) @binding(5) var<storage, read> R: array<vec4<${T}>>;`)
  if (c.out === 'act') L.push(`@group(0) @binding(6) var<storage, read_write> Y: array<vec4<${T}>>;`)
  else if (c.out === 'maps') L.push(`@group(0) @binding(6) var<storage, read_write> Y: array<f32>;`)
  else L.push(`@group(0) @binding(6) var<storage, read_write> Y: array<u32>;`)
  // c.flat: invocations numbered along whole rows (one index: column group, then row), so that no invocation falls outside a
  // narrow layer; otherwise a WX x WY tile of column groups and rows
  L.push(c.flat ? `@compute @workgroup_size(${WX * WY}, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox0 = (gid.x % p.xg) * ${PX}u;
  let oy = gid.x / p.xg;
  let ob = gid.z * ${OB}u + p.g0;` : `@compute @workgroup_size(${WX}, ${WY}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox0 = gid.x * ${PX}u;
  let oy = gid.y;
  let ob = gid.z * ${OB}u + p.g0;`)
  L.push(`  if (ox0 >= p.wout || oy >= p.hout) { return; }
  let cin4 = p.ca4 + p.cb4;
  let ixb = i32(ox0 * ${S}u) - ${Pd};
  let wlast = i32(p.win) - 1;`)
  for (let o = 0; o < OB; o++) {
    L.push(`  let ob${o} = min(ob + ${o}u, p.cout4 - 1u);`)
    for (let q = 0; q < PX; q++) L.push(c.scaled ? `  var a${o}_${q} = vec4<${A}>();` : `  var a${o}_${q} = vec4<${A}>(Bs[ob${o}]);`)
  }
  for (let j = 0; j < NX; j++) L.push(`  let ix${j} = ixb + ${j}; let ok${j} = ix${j} >= 0 && ix${j} <= wlast;`)
  const srcs = c.stem ? [['XA', 'a']] : c.two ? [['XA', 'a'], ['XB', 'b']] : [['XA', 'a']]
  for (const [X, s] of srcs) {
    if (c.stem) {
      for (let j = 0; j < NX; j++) L.push(`  let c${s}${j} = u32(clamp(ix${j}, 0, wlast));`)
      L.push(`  for (var ky = 0u; ky < ${K}u; ky++) {
    let iy = i32(oy * ${S}u + ky) - ${Pd};
    if (iy < 0 || iy >= i32(p.hin)) { continue; }
    let row = u32(iy) * p.win;`)
      // the picture scaled on the way in, in 32-bit, as the exported graph does it (outside the picture: 0 after scaling)
      for (let j = 0; j < NX; j++) L.push(`    let x${j} = select(${T}(0.0), ${T}(${c.stem}), ok${j});`.replace('@', c.u8 ? `f32((XA[(row + c${s}${j}) >> 2u] >> (((row + c${s}${j}) & 3u) * 8u)) & 255u)` : `XA[row + c${s}${j}]`))
      L.push(`    let wb = ky * ${K}u;`)
      for (let kx = 0; kx < K; kx++) for (let o = 0; o < OB; o++) {
        L.push(`    { let w = Wt[ob${o} * ${KK}u + wb + ${kx}u];`)
        for (let q = 0; q < PX; q++) L.push(`      a${o}_${q} += ${cvt(`w * x${q * S + kx}`)};`)
        L.push('    }')
      }
      L.push('  }')
      continue
    }
    const up = s === 'a' ? 'p.upa' : 'p.upb', hs = `p.h${s}`, ws = `p.w${s}`, c4 = `p.c${s}4`, off = s === 'a' ? '' : ' + p.ca4'
    for (let j = 0; j < NX; j++) L.push(`  let c${s}${j} = u32(clamp(ix${j}, 0, wlast)) >> ${up};`)
    L.push(`  for (var ci = 0u; ci < ${c4}; ci++) {
    for (var ky = 0u; ky < ${K}u; ky++) {
      let iy = i32(oy * ${S}u + ky) - ${Pd};
      if (iy < 0 || iy >= i32(p.hin)) { continue; }
      let row = (ci * ${hs} + (u32(iy) >> ${up})) * ${ws};`)
    for (let j = 0; j < NX; j++) L.push(`      let x${j} = select(vec4<${T}>(), ${X}[row + c${s}${j}], ok${j});`)
    for (let o = 0; o < OB; o++) L.push(`      let wb${o} = (ob${o} * cin4 + ci${off}) * ${KK}u + ky * ${K}u;`)
    for (let kx = 0; kx < K; kx++) for (let o = 0; o < OB; o++) {
      L.push(`      { let w = Wt[wb${o} + ${kx}u];`)
      for (let q = 0; q < PX; q++) L.push(`        a${o}_${q} += ${cvt(`w * x${q * S + kx}`)};`)
      L.push('      }')
    }
    L.push('    }\n  }')
  }
  // on the way out: the look's scale and shift (c.scaled), the block's addition, the ReLU, the write
  for (let o = 0; o < OB; o++) {
    L.push(`  if (ob + ${o}u < p.cout4) {`)
    if (c.scaled) {
      L.push(`    let sc${o} = vec4<${A}>(Bs[2u * ob${o}]); let sh${o} = vec4<${A}>(Bs[2u * ob${o} + 1u]);`)
      for (let q = 0; q < PX; q++) L.push(`    a${o}_${q} = a${o}_${q} * sc${o} + sh${o};`)
    }
    for (let q = 0; q < PX; q++) {
      L.push(`    if (ox0 + ${q}u < p.wout) {`)
      if (c.out === 'act') {
        L.push(`      let i = ((ob + ${o}u) * p.hout + oy) * p.wout + ox0 + ${q}u;`)
        L.push(`      var v = a${o}_${q};`)
        if (c.add) L.push(`      v += vec4<${A}>(R[i]);`)
        L.push(`      if (p.relu != 0u) { v = max(v, vec4<${A}>()); }`)
        L.push(`      Y[i] = vec4<${T}>(v);`)
      } else if (c.out === 'maps') {
        L.push(`      let v = vec4<f32>(a${o}_${q});`)
        for (let r = 0; r < 4; r++) L.push(`      { let c = (ob + ${o}u) * 4u + ${r}u; if (c >= p.m0 && c < p.m1 && c < p.cout) { Y[((c - p.m0) * p.hout + oy) * p.wout + ox0 + ${q}u] = v[${r}]; } }`)
      }
      L.push('    }')
    }
    if (c.out === 'maps16') {                                   // two neighbouring pixels a 32-bit word, as half floats
      for (let q = 0; q < PX; q += 2) {
        L.push(`    if (ox0 + ${q}u < p.wout) {`)
        L.push(`      let v0 = vec4<f32>(a${o}_${q}); let v1 = vec4<f32>(a${o}_${q + 1});`)
        for (let r = 0; r < 4; r++) L.push(`      { let c = (ob + ${o}u) * 4u + ${r}u; if (c >= p.m0 && c < p.m1 && c < p.cout) { Y[(((c - p.m0) * p.hout + oy) * p.wout + ox0 + ${q}u) / 2u] = pack2x16float(vec2<f32>(v0[${r}], v1[${r}])); } }`)
        L.push('    }')
      }
    }
    L.push('  }')
  }
  L.push('}')
  return L.join('\n')
}

/** 3 x 3 max pooling, stride 2, padding 1, one output vector a invocation. */
export function poolWGSL(T) {
  const at = (c, y, x, h, w) => `((${c}) * ${h} + ${y}) * ${w} + ${x}`
  return `${head(T)}${PARAMS}
@group(0) @binding(3) var<storage, read> X: array<vec4<${T}>>;
@group(0) @binding(6) var<storage, read_write> Y: array<vec4<${T}>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.wout || g.y >= p.hout) { return; }
  var v = X[${at('g.z', 'g.y * 2u', 'g.x * 2u', 'p.hin', 'p.win')}];
  for (var ky = 0u; ky < 3u; ky++) {
    let iy = i32(g.y * 2u + ky) - 1;
    if (iy < 0 || iy >= i32(p.hin)) { continue; }
    for (var kx = 0u; kx < 3u; kx++) {
      let ix = i32(g.x * 2u + kx) - 1;
      if (ix < 0 || ix >= i32(p.win)) { continue; }
      v = max(v, X[${at('g.z', 'u32(iy)', 'u32(ix)', 'p.hin', 'p.win')}]);
    }
  }
  Y[${at('g.z', 'g.y', 'g.x', 'p.hout', 'p.wout')}] = v;
}`
}

/** Nearest upsampling by 2, or the addition of two values (with the ReLU if p.relu): the step kinds this family never needs on
 *  their own (export.py folds them into the convolutions), kept for a network that does. */
export function upWGSL(T) {
  const at = (c, y, x, h, w) => `((${c}) * ${h} + ${y}) * ${w} + ${x}`
  return `${head(T)}${PARAMS}
@group(0) @binding(3) var<storage, read> X: array<vec4<${T}>>;
@group(0) @binding(6) var<storage, read_write> Y: array<vec4<${T}>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.wout || g.y >= p.hout) { return; }
  Y[${at('g.z', 'g.y', 'g.x', 'p.hout', 'p.wout')}] = X[${at('g.z', 'g.y / 2u', 'g.x / 2u', 'p.hin', 'p.win')}];
}`
}
export function addWGSL(T) {
  return `${head(T)}${PARAMS}
@group(0) @binding(3) var<storage, read> X: array<vec4<${T}>>;
@group(0) @binding(4) var<storage, read> Z: array<vec4<${T}>>;
@group(0) @binding(6) var<storage, read_write> Y: array<vec4<${T}>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.wout || g.y >= p.hout) { return; }
  let i = (g.z * p.hout + g.y) * p.wout + g.x;
  var v = X[i] + Z[i];
  if (p.relu != 0u) { v = max(v, vec4<${T}>()); }
  Y[i] = v;
}`
}

// ------------------------------------------------------------------------------------------------ choices per step
/** How a convolution step is cut into invocations (measured on the integrated Radeon here, RESULT_15_engine.md): an invocation
 *  computes PX neighbouring pixels of a row for OB groups of four output channels; invocations are numbered along whole rows
 *  (flat), 64 a workgroup. 16-bit: 4 pixels x 16 channels; 32-bit: 2 pixels x 16 channels; the stem 2 x 32. Overridable (opts.tile). */
export function defaultTile(st, T) {
  if (st.norm) return { PX: 2, OB: 8, WX: 64, WY: 1, flat: 1 }         // the stem: 2 pixels x 32 channels in both
  return T === 'f16' ? { PX: 4, OB: 4, WX: 64, WY: 1, flat: 1 } : { PX: 2, OB: 4, WX: 64, WY: 1, flat: 1 }
}

// ------------------------------------------------------------------------------------------------ the engine
const ceil = (a, b) => Math.ceil(a / b)
const align = (n, a = 256) => Math.ceil(n / a) * a

/** Start the engine on `device` for network `net` ({ steps: the steps file, q8: its weights as an ArrayBuffer or bytes }) and
 *  the sizes it will be asked for ([[w, h], ...] or [[w, h, look], ...]; multiples of 32). opts: { arithmetic: 'auto' | 'f16' |
 *  'f32', accumulate: 'same' | 'f32', maps: 'f32' | 'f16' (how the maps travel back to the processor: by default as they were
 *  computed), input: 'f32' | 'u8' (the picture as 32-bit numbers or as grey bytes), capacity: the largest picture area (pixels)
 *  any look may be given (default: the largest size), stats: 'shader' | 'copies' (a network with two looks, steps.looks: each
 *  look's scale and shift a channel applied by the shaders on the way out, or the weights held once for each look), tile }.
 *  A look of a size not given here is planned when first asked for (bindings and numbers only); a look larger than the capacity
 *  makes the activation buffers again, once. opts.lookMaps: { look: [first, end) } the maps each look gives back (the head computes
 *  and writes only those). */
export async function start(device, net, sizes, opts = {}) {
  const t0 = performance.now()
  const doc = net.steps
  if (doc.format !== 'engine15-steps-1') throw new Error('not a steps file of this engine: ' + doc.format)
  const has16 = device.features.has('shader-f16')
  const want = opts.arithmetic || 'auto'
  if (want === 'f16' && !has16) throw new Error('16-bit arithmetic asked for, but the device has no shader-f16')
  const T = want === 'f32' ? 'f32' : has16 ? 'f16' : 'f32'
  const A = opts.accumulate === 'f32' ? 'f32' : T
  const mapsAs = opts.maps === 'f16' || opts.maps === 'f32' ? opts.maps : T               // the maps back as computed, unless asked otherwise
  const input = opts.input === 'u8' ? 'u8' : 'f32'
  const V = T === 'f16' ? 8 : 16                                 // bytes a vector of four
  const steps = doc.steps.map((s) => ({ ...s })), values = doc.values             // (copies: what is worked out per step stays with this engine)
  const LK = doc.looks || null                                  // two looks over one set of weights (export.py export_a3)
  const LOOKS = LK ? LK.names : ['main']
  const stats = LK ? (opts.stats === 'copies' ? 'copies' : 'shader') : 'none'
  for (const [w, h] of sizes) if (w % doc.multiple || h % doc.multiple) throw new Error(`sizes must be multiples of ${doc.multiple}: ${w} x ${h}`)
  const limit = device.limits.maxStorageBufferBindingSize
  const mapB = mapsAs === 'f16' ? 2 : 4
  /** bytes of value v for a picture of `area` pixels (exact: every size is a multiple of 32) */
  const bytesAt = (v, area) => (v === doc.output ? doc.maps * area * mapB : ceil(values[v].c, 4) * (area / (values[v].d * values[v].d)) * V)
  const bytesOf = (v, w, h) => bytesAt(v, w * h)
  // ---- the plan: which buffer each activation lives in (one plan for every size: they all scale with the picture's area)
  const last = new Array(values.length).fill(-1)
  steps.forEach((s, i) => { for (const v of [...s.in, ...(s.add != null ? [s.add] : [])]) last[v] = i })
  last[doc.output] = Infinity
  const slotOf = new Array(values.length).fill(-1), perPixel = [], free = []           // each buffer's bytes a picture pixel
  steps.forEach((s, i) => {
    const need = bytesAt(s.out, 1)
    let pick = -1
    for (const k of free) if (perPixel[k] >= need && (pick < 0 || perPixel[k] < perPixel[pick])) pick = k
    if (pick < 0) for (const k of free) if (pick < 0 || perPixel[k] > perPixel[pick]) pick = k
    if (pick < 0) { perPixel.push(0); pick = perPixel.length - 1 } else free.splice(free.indexOf(pick), 1)
    perPixel[pick] = Math.max(perPixel[pick], need)
    slotOf[s.out] = pick
    for (const v of new Set([...s.in, ...(s.add != null ? [s.add] : [])])) if (last[v] === i && v !== 0) free.push(slotOf[v])
  })
  const S = GPU()
  const made = []
  const buffer = (size, usage, label) => { const b = device.createBuffer({ size: Math.max(16, align(size, 16)), usage, label }); made.push(b); return b }
  // the buffers that depend on the largest picture: made now, and again (once) if a larger look is asked for
  let cap = 0, slotBufs = [], inBuf = null, readBuf = null, grown = 0
  const fit = (area) => {
    for (let v = 1; v < values.length; v++) if (bytesAt(v, area) > limit) throw new Error(`a look of ${(area / 1e6).toFixed(2)} megapixels needs ${(bytesAt(v, area) / 2 ** 20).toFixed(0)} MB in one buffer; this device allows ${(limit / 2 ** 20).toFixed(0)} MB`)
    for (const b of [...slotBufs, inBuf, readBuf]) if (b) { try { b.destroy() } catch {} made.splice(made.indexOf(b), 1) }
    cap = area
    slotBufs = perPixel.map((n, k) => buffer(n * area, S.STORAGE | S.COPY_SRC, 'activations ' + k))
    inBuf = buffer(area * (input === 'u8' ? 1 : 4), S.STORAGE | S.COPY_DST, 'picture')
    readBuf = buffer(bytesAt(doc.output, area), S.MAP_READ | S.COPY_DST, 'maps for the processor')
  }
  fit(Math.max(opts.capacity || 0, ...sizes.map(([w, h]) => w * h)))
  // ---- the weights: unpacked from 8 bits into each step's layout, in the arithmetic in use
  const q8 = net.q8 instanceof ArrayBuffer ? net.q8 : net.q8.byteOffset % 4 ? net.q8.slice().buffer : net.q8.buffer.slice(net.q8.byteOffset, net.q8.byteOffset + net.q8.byteLength)
  const convs = steps.filter((s) => s.op === 'conv')
  const tileOf = (s) => ({ ...defaultTile(s, T), ...(typeof opts.tile === 'function' ? opts.tile(s, values[s.out].d) : opts.tile || {}) })
  for (const s of convs) {
    s._tile = tileOf(s)
    if (s.head && mapsAs === 'f16' && s._tile.PX % 2) s._tile.PX += 1             // (16-bit maps: two neighbouring pixels a word)
  }
  // each look's scale and shift a channel (doc.looks; base64 32-bit numbers, all convolutions one after another)
  const f32of = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer) }
  const lookTab = LK ? Object.fromEntries(LOOKS.map((L) => [L, { scale: f32of(LK[L].scale), shift: f32of(LK[L].shift) }])) : null
  const wLooks = stats === 'copies' ? LOOKS : ['main']                                   // one weights buffer, or one a look
  const pairs = stats === 'shader' ? 2 : 1                                                // (scale, shift) or bias, a group of four channels
  let wAt = 0, bAt = 0
  convs.forEach((s, j) => {
    s._j = j
    s._wAt = wAt; s._wLen = s.norm ? ceil(s.cout, 4) * s.k * s.k * V : ceil(s.cout, 4) * ceil(s.cin, 4) * s.k * s.k * 4 * V
    s._bAt = bAt; s._bLen = ceil(s.cout, 4) * V * pairs
    wAt = align(wAt + s._wLen); bAt = align(bAt + s._bLen)
  })
  // written straight into the buffers, mapped at creation (no staging copy kept by the browser, no second copy in JavaScript),
  // unless opts.upload === 'write' (measured: RESULT_15_engine.md)
  const direct = opts.upload !== 'write'
  const mapped = (size, label) => { const b = device.createBuffer({ size: Math.max(16, align(size, 16)), usage: S.STORAGE | (direct ? 0 : S.COPY_DST), mappedAtCreation: direct, label }); made.push(b); return b }
  const wBufs = Object.fromEntries(wLooks.map((L) => [L, mapped(wAt, 'weights ' + L)]))
  const bLooks = LK ? LOOKS : ['main']
  const bBufs = Object.fromEntries(bLooks.map((L) => [L, mapped(bAt, 'biases ' + L)]))
  const wMaps = direct ? Object.fromEntries(wLooks.map((L) => [L, wBufs[L].getMappedRange()])) : null
  const bMaps = direct ? Object.fromEntries(bLooks.map((L) => [L, bBufs[L].getMappedRange()])) : null
  const tW = performance.now()
  const tab = new Float32Array(256), tab16 = new Uint16Array(256)
  const view = (map, at, n) => (T === 'f16' ? (map ? new Uint16Array(map, at, n) : new Uint16Array(n)) : (map ? new Float32Array(map, at, n) : new Float32Array(n)))
  const put = T === 'f16' ? (d, i, v) => { d[i] = toHalf(v) } : (d, i, v) => { d[i] = v }
  for (const s of convs) {
    const [, n, kind, ch, at] = doc.tensors[s.w]
    if (kind !== 1 || ch !== s.cout || n !== s.cout * s.cin * s.k * s.k) throw new Error('weights not as the steps say: step ' + s.name)
    const q = new Int8Array(q8, at, n), sc = new Float32Array(q8, Math.ceil((at + n) / 4) * 4, ch)
    const KK = s.k * s.k, cin = s.cin, cin4 = ceil(cin, 4), cout4 = ceil(s.cout, 4)
    const off = LK ? LK.offsets[s._j] : 0
    for (const L of wLooks) {
      const dst = view(direct ? wMaps[L] : null, s._wAt, s._wLen / (T === 'f16' ? 2 : 4))
      for (let o = 0; o < s.cout; o++) {
        const m = L === 'main' ? 1 : lookTab[L].scale[off + o]                          // (copies: the look's weights folded in)
        for (let v = -128; v < 128; v++) { tab[v & 255] = Math.fround(Math.fround(v * sc[o]) * m); tab16[v & 255] = toHalf(tab[v & 255]) }
        const t = T === 'f16' ? tab16 : tab, cob = o >> 2, r = o & 3
        for (let i = 0; i < cin; i++) for (let k = 0; k < KK; k++) {
          const qv = q[(o * cin + i) * KK + k] & 255
          if (s.norm) dst[(cob * KK + k) * 4 + r] = t[qv]                                     // vec4 per (group, tap)
          else dst[((cob * cin4 + (i >> 2)) * KK + k) * 16 + (i & 3) * 4 + r] = t[qv]         // mat4x4 per (group out, group in, tap): column = input channel
        }
      }
      if (!direct) device.queue.writeBuffer(wBufs[L], s._wAt, dst)
    }
    const [, nb, kb, , atb] = doc.tensors[s.b]
    if (kb !== 0 || nb !== s.cout) throw new Error('bias not as the steps say: step ' + s.name)
    const bias = new Float32Array(q8, atb, nb)
    for (const L of bLooks) {
      const bd = view(direct ? bMaps[L] : null, s._bAt, cout4 * 4 * pairs)
      for (let o = 0; o < nb; o++) {
        const shift = L === 'main' ? bias[o] : lookTab[L].shift[off + o]
        if (pairs === 2) { put(bd, ((o >> 2) * 2) * 4 + (o & 3), lookTab[L].scale[off + o]); put(bd, ((o >> 2) * 2 + 1) * 4 + (o & 3), shift) }
        else put(bd, o, shift)
      }
      if (!direct) device.queue.writeBuffer(bBufs[L], s._bAt, bd)
    }
  }
  if (direct) for (const b of [...Object.values(wBufs), ...Object.values(bBufs)]) b.unmap()
  const unpackMs = performance.now() - tW
  // ---- the pipelines, one for each kind of step that occurs (compiled at once, in parallel)
  const stemExpr = (norm) => {                      // the picture's scaling, in the order the graph does it, in 32-bit
    let e = '@'
    for (const [op, k] of norm) e = op === 'div' ? `(${e} / ${k.toPrecision(9)})` : op === 'sub' ? `(${e} - ${k.toPrecision(9)})` : op === 'mul' ? `(${e} * ${k.toPrecision(9)})` : `(${e} + ${k.toPrecision(9)})`
    return e
  }
  const codes = new Map()
  for (const s of steps) {
    let key
    if (s.op === 'conv') {
      const t = s._tile
      const out = s.head ? (mapsAs === 'f16' ? 'maps16' : 'maps') : 'act'
      const c = { T, A, K: s.k, S: s.s, Pd: s.p, PX: t.PX, OB: t.OB, WX: t.WX, WY: t.WY, flat: !!t.flat, two: s.in.length === 2, add: s.add != null, out,
        stem: s.norm ? stemExpr(s.norm) : null, u8: !!s.norm && input === 'u8', scaled: stats === 'shader' }
      key = JSON.stringify(c)
      if (!codes.has(key)) codes.set(key, convWGSL(c))
    } else if (s.op === 'maxpool') { key = 'pool'; if (!codes.has(key)) codes.set(key, poolWGSL(T)) }
    else if (s.op === 'upsample') { key = 'up'; if (!codes.has(key)) codes.set(key, upWGSL(T)) }
    else if (s.op === 'add') { key = 'add'; if (!codes.has(key)) codes.set(key, addWGSL(T)) }
    else throw new Error('a step this engine does not know: ' + s.op)
    s._key = key
  }
  if (opts.test === 'break16' && T === 'f16') for (const k of codes.keys()) codes.set(k, codes.get(k) + '\nfn broken( {}')   // (for the checks: a 16-bit shader that does not compile)
  const tC = performance.now()
  const pipes = new Map()
  await Promise.all([...codes].map(async ([key, code]) => {
    const module = device.createShaderModule({ code, label: key.slice(0, 80) })
    const info = await module.getCompilationInfo?.()
    const errors = info ? info.messages.filter((m) => m.type === 'error') : []
    if (errors.length) throw new Error('a shader did not compile: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ').slice(0, 300))
    pipes.set(key, await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } }))
  }))
  const compileMs = performance.now() - tC
  // ---- a plan for each look and size: every step's numbers (a 256-byte block a step), its bindings and its dispatch
  const plans = new Map()
  /** The maps a look gives back: [first, end) among the network's (opts.lookMaps; every map by default). */
  const rangeOf = (L) => { const r = opts.lookMaps && opts.lookMaps[L]; return r ? [r[0], r[1]] : [0, doc.maps] }
  function makePlan(L, w, h) {
    const uni = buffer(steps.length * 256, S.UNIFORM | S.COPY_DST, 'step numbers ' + L + ' ' + w + 'x' + h)
    const u = new Uint32Array(steps.length * 64)
    const list = steps.map((s, i) => {
      const dims = (v) => [h / values[v].d, w / values[v].d]
      const [ho, wo] = dims(s.out), A0 = s.in[0], B0 = s.in[1]
      const up = s.up || [0, 0]
      const [ha, wa] = dims(A0), [hb, wb] = B0 != null ? dims(B0) : [0, 0]
      const hin = s.op === 'conv' ? ha * (up[0] ? 2 : 1) : ha, win = s.op === 'conv' ? wa * (up[0] ? 2 : 1) : wa
      const cout = s.op === 'conv' ? s.cout : values[s.out].c
      const xg = s.op === 'conv' ? ceil(wo, s._tile.PX) : 0
      const [m0, m1] = s.head ? rangeOf(L) : [0, cout], g0 = s.head ? m0 >> 2 : 0
      u.set([hin, win, s.norm ? 1 : ceil(values[A0].c, 4), B0 != null ? ceil(values[B0].c, 4) : 0, ceil(cout, 4), cout, ho, wo, ha, wa, hb, wb, up[0] || 0, up[1] || 0, s.relu ? 1 : 0, xg, m0, m1, g0, 0], i * 64)
      const bind = (binding, v) => ({ binding, resource: { buffer: v === 0 ? inBuf : slotBufs[slotOf[v]], offset: 0, size: align(v === 0 ? w * h * (input === 'u8' ? 1 : 4) : bytesOf(v, w, h), 4) } })
      const entries = [{ binding: 0, resource: { buffer: uni, offset: i * 256, size: 80 } }]
      if (s.op === 'conv') {
        entries.push({ binding: 1, resource: { buffer: wBufs[stats === 'copies' ? L : 'main'], offset: s._wAt, size: s._wLen } },
          { binding: 2, resource: { buffer: bBufs[LK ? L : 'main'], offset: s._bAt, size: s._bLen } })
        entries.push(bind(3, A0))
        if (B0 != null) entries.push(bind(4, B0))
        if (s.add != null) entries.push(bind(5, s.add))
        entries.push(bind(6, s.out))
      } else if (s.op === 'add') entries.push(bind(3, A0), bind(4, B0), bind(6, s.out))
      else entries.push(bind(3, A0), bind(6, s.out))
      const pipe = pipes.get(s._key)
      const group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries })
      const t = s._tile
      const groups = ceil(s.head ? rangeOf(L)[1] : cout, 4) - g0                       // (the head: only the groups of its look's maps)
      const wg = s.op !== 'conv' ? [ceil(wo, 8), ceil(ho, 8), ceil(values[s.out].c, 4)]
        : t.flat ? [ceil(xg * ho, t.WX * t.WY), 1, ceil(groups, t.OB)] : [ceil(xg, t.WX), ceil(ho, t.WY), ceil(groups, t.OB)]
      return { pipe, group, wg, name: s.name, op: s.op }
    })
    device.queue.writeBuffer(uni, 0, u)
    const P = { look: L, w, h, uni, list, mapsBytes: (rangeOf(L)[1] - rangeOf(L)[0]) * w * h * mapB, slot: slotBufs[slotOf[doc.output]] }
    plans.set(L + ':' + w + 'x' + h, P)
    return P
  }
  const looksOf = (s) => (s[2] ? [s[2]] : LOOKS)
  for (const s of sizes) for (const L of looksOf(s)) makePlan(L, s[0], s[1])
  await device.queue.onSubmittedWorkDone()
  const bytes = {}
  const count = () => {
    Object.assign(bytes, { weights: [...Object.values(wBufs), ...Object.values(bBufs)].reduce((a, b) => a + b.size, 0), activations: slotBufs.reduce((a, b) => a + b.size, 0),
      picture: inBuf.size, readBack: readBuf.size, numbers: [...plans.values()].reduce((a, P) => a + P.uni.size, 0) })
    bytes.total = bytes.weights + bytes.activations + bytes.picture + bytes.readBack + bytes.numbers
  }
  count()
  let busy = Promise.resolve(), ended = false

  function encode(P, enc, timestamps) {
    if (!timestamps) {
      const pass = enc.beginComputePass()
      for (const x of P.list) { pass.setPipeline(x.pipe); pass.setBindGroup(0, x.group); pass.dispatchWorkgroups(...x.wg) }
      pass.end()
      return
    }
    P.list.forEach((x, i) => {
      const pass = enc.beginComputePass({ timestampWrites: { querySet: timestamps, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } })
      pass.setPipeline(x.pipe); pass.setBindGroup(0, x.group); pass.dispatchWorkgroups(...x.wg)
      pass.end()
    })
  }
  /** The plan for a look and size: made when first asked for; a size beyond the capacity makes the large buffers again (once). */
  const planOf = ([w, h], L) => {
    L = L || LOOKS[0]
    if (!LOOKS.includes(L)) throw new Error(`this network has no look "${L}" (it has ${LOOKS.join(', ')})`)
    if (w % doc.multiple || h % doc.multiple || !(w > 0) || !(h > 0)) throw new Error(`sizes must be multiples of ${doc.multiple}: ${w} x ${h}`)
    let P = plans.get(L + ':' + w + 'x' + h)
    if (P) return P
    if (w * h > cap) {
      fit(w * h)
      grown++
      const old = [...plans.values()]
      plans.clear()
      for (const Q of old) { made.splice(made.indexOf(Q.uni), 1); Q.uni.destroy(); makePlan(Q.look, Q.w, Q.h) }
    }
    P = makePlan(L, w, h)
    count()
    return P
  }
  const upload = (P, picture) => {
    const n = P.w * P.h
    if (input === 'u8' ? !(picture instanceof Uint8Array || picture instanceof Uint8ClampedArray) || picture.length !== n : !(picture instanceof Float32Array) || picture.length !== n)
      throw new Error(`the picture must be ${input === 'u8' ? 'grey bytes (Uint8Array)' : 'a Float32Array'} of ${P.w} x ${P.h}`)
    device.queue.writeBuffer(inBuf, 0, picture.buffer, picture.byteOffset, picture.byteLength)
  }

  const engine = {
    arithmetic: T, accumulate: A, maps: mapsAs, mapsCount: doc.maps, mapRange: rangeOf, input, looks: LOOKS, stats, bytes, slots: perPixel.length,
    get slotBytes() { return slotBufs.map((b) => b.size) }, get capacity() { return cap }, get grown() { return grown }, get plans() { return plans.size },
    sizes: sizes.map((s) => [...s]),
    startMs: { unpack: Math.round(unpackMs), compile: Math.round(compileMs), all: 0 }, pipelines: codes.size,
    describe: `${T === 'f16' ? '16' : '32'}-bit${A !== T ? ' with 32-bit sums' : ''}, ${steps.length} steps, ${codes.size} shaders, ${perPixel.length} activation buffers${LK ? `, looks ${LOOKS.join(' and ')} (${stats === 'shader' ? 'a scale and shift a channel in the shaders' : 'weights held for each look'})` : ''}`,
    /** One look: the picture (w * h numbers 0 to 255: a Float32Array, or grey bytes with input 'u8') in, the maps (Float32Array,
     *  maps x h x w; with opts.lookMaps only the look's own, from mapRange(look)[0]) out. `out` may be given to be filled instead of a new array. o.look: which look (a network with two);
     *  o.read === false: the maps stay on the chip (timing only). */
    look(picture, size, out, o = {}) {
      const run = busy.then(async () => {
        if (ended) throw new Error('the engine has ended')
        const P = planOf(size, o.look)
        upload(P, picture)
        const enc = device.createCommandEncoder()
        encode(P, enc, null)
        if (o.read === false) { device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); return null }
        enc.copyBufferToBuffer(P.slot, 0, readBuf, 0, P.mapsBytes)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ, 0, P.mapsBytes)
        const n = P.mapsBytes / mapB
        const dst = out && out.length >= n ? out : new Float32Array(n)
        if (mapsAs === 'f16') { const H = halfTable(), src = new Uint16Array(readBuf.getMappedRange(0, P.mapsBytes)); for (let i = 0; i < n; i++) dst[i] = H[src[i]] }
        else dst.set(new Float32Array(readBuf.getMappedRange(0, P.mapsBytes)))
        readBuf.unmap()
        return dst
      })
      busy = run.catch(() => {})
      return run
    },
    /** The self-test: the made-up picture of phone/web/pack.py phantom() at the size of `want` (pack.py summary() of the 32-bit
     *  network's maps on it) against the answer stored with the network: the largest difference in a cell mean or a peak, as a
     *  share of the range (the guess page's bar is 0.05). Run it first (o.look: which look). */
    async check(want, o = {}) {
      const [h, w] = want.size
      const ph = phantom(w, h)
      const maps = await engine.look(input === 'u8' ? Uint8Array.from(ph) : ph, [w, h], null, o)
      const d = deviation(want, maps, w, h)
      return Number.isFinite(d) ? d : Infinity
    },
    /** Each step's time on the chip for one look at `size` (timestamps where the device has them, otherwise each step submitted
     *  on its own and waited for), the median of `reps`: [{ name, op, ms }]. */
    async profile(picture, size, reps = 5, o = {}) {
      await busy
      const P = planOf(size, o.look)
      upload(P, picture)
      const n = P.list.length, all = P.list.map(() => [])
      if (device.features.has('timestamp-query')) {
        const qs = device.createQuerySet({ type: 'timestamp', count: 2 * n })
        const res = device.createBuffer({ size: 16 * n, usage: S.QUERY_RESOLVE | S.COPY_SRC }), rd = device.createBuffer({ size: 16 * n, usage: S.MAP_READ | S.COPY_DST })
        for (let r = 0; r < reps; r++) {
          const enc = device.createCommandEncoder()
          encode(P, enc, qs)
          enc.resolveQuerySet(qs, 0, 2 * n, res, 0)
          enc.copyBufferToBuffer(res, 0, rd, 0, 16 * n)
          device.queue.submit([enc.finish()])
          await rd.mapAsync(GPUMapMode.READ)
          const t = new BigInt64Array(rd.getMappedRange().slice(0))
          rd.unmap()
          for (let i = 0; i < n; i++) all[i].push(Number(t[2 * i + 1] - t[2 * i]) / 1e6)
        }
        qs.destroy(); res.destroy(); rd.destroy()
      } else {
        for (let r = 0; r < reps; r++) for (let i = 0; i < n; i++) {
          const x = P.list[i], enc = device.createCommandEncoder(), pass = enc.beginComputePass()
          pass.setPipeline(x.pipe); pass.setBindGroup(0, x.group); pass.dispatchWorkgroups(...x.wg); pass.end()
          const t = performance.now()
          device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone()
          all[i].push(performance.now() - t)
        }
      }
      const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1]
      return P.list.map((x, i) => ({ name: x.name, op: x.op, wg: x.wg, ms: Math.round(med(all[i]) * 1000) / 1000 }))
    },
    end() {
      ended = true
      for (const b of made) { try { b.destroy() } catch {} }
    },
  }
  engine.startMs.all = Math.round(performance.now() - t0)
  return engine
}

// ------------------------------------------------------------------------------------------------ the self-test's picture and measure
/** phone/web/pack.py phantom(): a brightness ramp, a chequer of 16-pixel squares, four bright ellipses (0 to 255), rows of w. */
export function phantom(w, h) {
  const d = new Float32Array(w * h)
  const blobs = [[3, 2, 10, 14], [5, 5, 12, 9], [2, 6, 8, 8], [6, 3, 7, 16]].map(([cx, cy, a, b]) =>
    [Math.floor((cx * w) / 8), Math.floor((cy * h) / 8), Math.max(1, Math.floor((a * w) / 64)), Math.max(1, Math.floor((b * h) / 64))])
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 40 + Math.floor((120 * y) / h) + (((x >> 4) + (y >> 4)) & 1) * 25
    for (const [cx, cy, A, B] of blobs) { const dx = x - cx, dy = y - cy; if (dx * dx * B * B + dy * dy * A * A <= A * A * B * B) v += 60 }
    d[y * w + x] = Math.min(255, v)
  }
  return d
}

/** phone/web/pack.py deviation(): the largest difference in a cell mean (8 x 8 cells a map) or a peak value between maps (map
 *  after map, h rows of w) and the stored summary, as a share of the range of the stored 32-bit maps. */
export function deviation(want, maps, w, h) {
  const n = w * h, ys = [], xs = []
  for (let i = 0; i <= 8; i++) { ys.push(Math.floor((i * h) / 8)); xs.push(Math.floor((i * w) / 8)) }
  let worst = 0
  for (let k = 0; k < want.pooled.length; k++) {
    const off = k * n
    let peak = -Infinity
    for (let p = 0; p < n; p++) { const v = maps[off + p]; if (!Number.isFinite(v)) return Infinity; if (v > peak) peak = v }
    worst = Math.max(worst, Math.abs(peak - want.peaks[k][2]))
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      let s = 0
      for (let y = ys[i]; y < ys[i + 1]; y++) for (let x = xs[j]; x < xs[j + 1]; x++) s += maps[off + y * w + x]
      worst = Math.max(worst, Math.abs(s / ((ys[i + 1] - ys[i]) * (xs[j + 1] - xs[j])) - want.pooled[k][i * 8 + j]))
    }
  }
  return worst / Math.max(want.range, 1e-6)
}
