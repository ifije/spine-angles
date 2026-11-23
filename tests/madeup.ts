// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// A tiny made-up detector file for the tests, in the layout of the real one (no trained number is in this repository).

import { DETECTOR_FORMAT } from '../src/detector/file'

export const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
export const MADE_UP_WEIGHTS = Uint8Array.from({ length: 37 }, (_, i) => (i * 7 + 3) & 255)

export function sections(over: Record<string, unknown> = {}): Record<string, Uint8Array> {
  return {
    path: enc({ spec: { variant: 'made up', accept: { shown: 0.15 } }, prior: { mean: [[0, 0, 0, 0]], icov: [[[1, 0, 0, 0]]] },
      net: { kind: 'engine15', key: 'toy', q8Bytes: MADE_UP_WEIGHTS.length, maps: 3, looks: { where: { maps: [2, 3] }, read: { size: [32, 32], maps: [0, 2] } } }, ...((over.path as object) ?? {}) }),
    steps: enc({ format: 'engine15-steps-1', q8Bytes: MADE_UP_WEIGHTS.length, steps: [{ op: 'conv' }], ...((over.steps as object) ?? {}) }),
    statistics: enc({ names: ['where', 'read'], where: { scale: 'AA==', shift: 'AA==' }, read: { scale: 'AA==', shift: 'AA==' } }),
    selftest: enc({ where: { size: [32, 32], peaks: [] }, read: { size: [32, 32], peaks: [] } }),
    weights: (over.weights as Uint8Array) ?? MADE_UP_WEIGHTS,
  }
}

/** The layout make_detector.py writes: magic, header length, header, then each section at a multiple of 8. */
export async function makeFile(parts = sections(), o: { format?: string; magic?: string; drop?: string; overlap?: boolean } = {}): Promise<Uint8Array> {
  const order = ['path', 'steps', 'statistics', 'selftest', 'weights'].filter((n) => n !== o.drop)
  let headerLen = 400
  for (;;) {
    let at = 12 + headerLen
    at += (8 - (at % 8)) % 8
    const body = at
    const secs = order.map((name) => {
      const s = { name, kind: name === 'weights' ? 'bytes' : 'json', offset: at, length: parts[name].length }
      at += parts[name].length
      at += (8 - (at % 8)) % 8
      return s
    })
    const last = secs[secs.length - 1]
    const total = last.offset + last.length
    if (o.overlap) secs[1].offset = secs[0].offset + 8
    const out = new Uint8Array(total)
    for (const s of secs) out.set(parts[s.name].subarray(0, Math.min(parts[s.name].length, total - s.offset)), s.offset)
    const stamp = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(body))), (x) => x.toString(16).padStart(2, '0')).join('')
    const header = enc({ format: o.format ?? DETECTOR_FORMAT, detector: 'toy', title: 'made up', made: '2026-11-23', bytes: total, body, stamp, sections: secs })
    if (header.length > headerLen) {
      headerLen = header.length
      continue
    }
    out.set(new TextEncoder().encode((o.magic ?? 'SPINEDET').padEnd(8).slice(0, 8)), 0)
    new DataView(out.buffer).setUint32(8, header.length, true)
    out.set(header, 12)
    return out
  }
}

