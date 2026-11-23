// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Types for the part of engine.mjs the app calls directly (the file itself is copied unchanged; see scripts/sync_detector.py).

/** The self-test's made-up picture (0 to 255), rows of w. */
export function phantom(w: number, h: number): Float32Array

/** The largest difference between maps and the stored answer, as a share of the answer's range. */
export function deviation(want: unknown, maps: Float32Array, w: number, h: number): number
