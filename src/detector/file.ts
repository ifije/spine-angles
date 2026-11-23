// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The detector file: one file with everything the on-device detector needs that is not code. It is made separately and is
// not part of this app. Format "spine-detector/1" (numbers little-endian):
//   bytes 0-7    the magic "SPINEDET"
//   bytes 8-11   H, the header's length in bytes (unsigned 32-bit)
//   bytes 12-    the header, UTF-8 JSON: { format, detector, title, made, bytes (the file's length), body (where the first
//                section starts), stamp (SHA-256, hex, of every byte from `body` to the end), sections: [{ name, kind, offset, length }] }
//   then the sections, each at an offset that is a multiple of 8, the small ones first:
//     path        JSON { spec: the landmark path's numbers, prior: the lumbar ordering step's prior, net: the network's looks }
//     steps       JSON: the network's steps for the engine (without the two looks' statistics and the self-test)
//     statistics  JSON: each look's own statistics, a scale and a shift a channel
//     selftest    JSON: the made-up picture's size and the network's expected answers on it, for both looks
//     weights     bytes: the network's 8-bit weights

export const DETECTOR_FORMAT = 'spine-detector/1'
const MAGIC = 'SPINEDET'
const NEEDED = ['path', 'steps', 'statistics', 'selftest', 'weights'] as const
const MAX_HEADER = 1 << 20

export interface Section {
  name: string
  kind: 'json' | 'bytes'
  offset: number
  length: number
}

export interface DetectorHeader {
  format: string
  detector: string
  title: string
  made: string
  bytes: number
  body: number
  stamp: string
  sections: Section[]
}

/** The engine's view of the network: which maps each look gives, the read look's size. */
export interface DetectorNet {
  kind: string
  key: string
  q8Bytes: number
  maps: number
  looks: { where: { maps: [number, number]; multiple?: number }; read: { size: [number, number]; maps: [number, number] } }
}

export interface DetectorParts {
  header: DetectorHeader
  /** The engine's steps as the engine takes them: the steps with both looks' statistics and the self-test put back. */
  steps: Record<string, unknown>
  weights: Uint8Array
  /** Every number of the landmark path. */
  spec: Record<string, unknown>
  /** The lumbar ordering step's prior. */
  prior: { mean: number[][]; icov: number[][][] }
  net: DetectorNet
  /** Whether the content stamp was checked (it needs the browser's SHA-256, offered on https and on this machine). */
  stamped: boolean
}

/** A file this app cannot use, with a reason in plain words. */
export class DetectorFileError extends Error {}

const NOT_ONE = 'This is not a detector file for this app.'
const DAMAGED = 'The detector file is damaged or incomplete.'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

const view = (buf: ArrayBuffer | Uint8Array): Uint8Array => (buf instanceof Uint8Array ? buf : new Uint8Array(buf))

/** The header, from the first bytes of a file. Null if `bytes` does not hold all of it yet; throws if it is not a detector file. */
export function readHeader(buf: ArrayBuffer | Uint8Array): DetectorHeader | null {
  const b = view(buf)
  if (b.length < 12) return null
  if (String.fromCharCode(...b.subarray(0, 8)) !== MAGIC) throw new DetectorFileError(NOT_ONE)
  const n = new DataView(b.buffer, b.byteOffset, 12).getUint32(8, true)
  if (n < 2 || n > MAX_HEADER) throw new DetectorFileError(NOT_ONE)
  if (b.length < 12 + n) return null
  let h: unknown
  try {
    h = JSON.parse(new TextDecoder().decode(b.subarray(12, 12 + n)))
  } catch {
    throw new DetectorFileError(NOT_ONE)
  }
  if (!isObj(h) || typeof h.format !== 'string' || !h.format.startsWith('spine-detector/')) throw new DetectorFileError(NOT_ONE)
  if (h.format !== DETECTOR_FORMAT) throw new DetectorFileError('This detector file is of a kind this version of the app cannot read.')
  const secs = h.sections
  if (!isCount(h.bytes) || !isCount(h.body) || h.body < 12 + n || typeof h.stamp !== 'string' || !/^[0-9a-f]{64}$/.test(h.stamp) || !Array.isArray(secs))
    throw new DetectorFileError(NOT_ONE)
  const seen = new Set<string>()
  let end = h.body
  for (const s of [...secs].sort((p, q) => (p?.offset ?? 0) - (q?.offset ?? 0))) {
    if (!isObj(s) || typeof s.name !== 'string' || (s.kind !== 'json' && s.kind !== 'bytes') || !isCount(s.offset) || !isCount(s.length)) throw new DetectorFileError(NOT_ONE)
    if (seen.has(s.name) || s.offset < end || s.offset + s.length > h.bytes) throw new DetectorFileError(NOT_ONE)
    seen.add(s.name)
    end = s.offset + s.length
  }
  for (const name of NEEDED) if (!seen.has(name)) throw new DetectorFileError(NOT_ONE)
  return h as unknown as DetectorHeader
}

const section = (h: DetectorHeader, name: string): Section => h.sections.find((s) => s.name === name)!

function json(b: Uint8Array, s: Section): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(b.subarray(s.offset, s.offset + s.length)))
  } catch {
    throw new DetectorFileError(DAMAGED)
  }
}

/** The parts other than the weights, checked for what the engine and the path read. */
function assemble(b: Uint8Array, h: DetectorHeader, weightsLength: number): Omit<DetectorParts, 'weights' | 'stamped'> {
  const path = json(b, section(h, 'path'))
  const steps = json(b, section(h, 'steps'))
  const statistics = json(b, section(h, 'statistics'))
  const selftest = json(b, section(h, 'selftest'))
  if (!isObj(path) || !isObj(path.spec) || !isObj(path.prior) || !isObj(path.net)) throw new DetectorFileError(DAMAGED)
  if (!isObj(steps) || steps.format !== 'engine15-steps-1' || steps.q8Bytes !== weightsLength) throw new DetectorFileError(DAMAGED)
  if (!isObj(statistics) || !isObj(statistics.where) || !isObj(statistics.read)) throw new DetectorFileError(DAMAGED)
  if (!isObj(selftest) || !isObj(selftest.where) || !isObj(selftest.read)) throw new DetectorFileError(DAMAGED)
  const net = path.net as unknown as DetectorNet
  if (!isObj(net.looks) || !isObj(net.looks.where) || !isObj(net.looks.read) || !Array.isArray(net.looks.read.size)) throw new DetectorFileError(DAMAGED)
  return {
    header: h,
    steps: { ...steps, looks: statistics, selftest },
    spec: path.spec,
    prior: path.prior as unknown as DetectorParts['prior'],
    net: { ...net, q8Bytes: weightsLength },
  }
}

/**
 * The first piece of a file that arrives in pieces: the header and, if this piece holds them, everything but the weights,
 * so that the engine can be prepared while the weights are still on their way. Null if it does not hold them.
 */
export function readEarly(buf: ArrayBuffer | Uint8Array): Omit<DetectorParts, 'weights' | 'stamped'> | null {
  const b = view(buf)
  const h = readHeader(b)
  if (!h) return null
  const w = section(h, 'weights')
  if (h.sections.some((s) => s.name !== 'weights' && s.offset + s.length > b.length)) return null
  return assemble(b, h, w.length)
}

async function sha256(b: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const d = new Uint8Array(await subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))
    return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** A whole detector file, checked: its layout, its content stamp (where the browser can compute it), and each part. */
export async function readDetectorFile(buf: ArrayBuffer | Uint8Array): Promise<DetectorParts> {
  const b = view(buf)
  const h = readHeader(b)
  if (!h || h.bytes !== b.length) throw new DetectorFileError(DAMAGED)
  const digest = await sha256(b.subarray(h.body))
  if (digest !== null && digest !== h.stamp) throw new DetectorFileError(DAMAGED)
  const w = section(h, 'weights')
  return { ...assemble(b, h, w.length), weights: b.subarray(w.offset, w.offset + w.length), stamped: digest !== null }
}
