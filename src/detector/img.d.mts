// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Types for the part of img.mjs the app calls (the file itself is copied unchanged; see scripts/sync_detector.py).

/** A grey 8-bit picture, rows top to bottom. */
export interface Grey {
  d: Uint8Array
  w: number
  h: number
}

/** RGBA bytes (as a canvas gives them) to grey, with OpenCV's weights. */
export function grey(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Grey
