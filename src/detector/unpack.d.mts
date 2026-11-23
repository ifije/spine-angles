// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Types for the part of unpack.mjs the app calls (the file itself is copied unchanged; see scripts/sync_detector.py).

/** The 8-bit pack back into the 32-bit weights file the network's graph reads; `over` replaces some tensors' numbers. */
export function unpack(entry: { bytes: number; tensors: number[][] }, blob: ArrayBuffer, over?: Map<number, Float32Array> | null): Float32Array
