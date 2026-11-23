// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Types for the part of combo.mjs the app calls (the file itself is copied unchanged; see scripts/sync_detector.py).

import type { Grey } from './img.mjs'
import type { PathLandmark, PathResult } from './record'

/** The raw maps of one look of the network. */
export interface LookResult {
  d: Float32Array
  maps: number
  first: number
  w: number
  h: number
  ms?: number
}

export type Look = (kind: 'where' | 'read', pic: Grey) => Promise<LookResult>

/** The automatic path: the where look on the whole picture, a read look framed from it, a second read look when needed. */
export function guessA3(look: Look, spec: unknown, prior: unknown, img: Grey, hooks?: { onRead?: (early: unknown) => void }): Promise<PathResult>

/** The landmarks one look gives, and the decision behind them (a pelvis shown; a lumbar chain given). */
export function named(spec: unknown, look: unknown): { landmarks: PathLandmark[]; pelvisMode: boolean; chainGiven: boolean }
