// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Types for the part of backend-engine.mjs the app calls (the file itself is copied unchanged; see scripts/sync_detector.py).

import type { Grey } from './img.mjs'
import type { LookResult } from './combo.mjs'

/** The network as the engine's backend takes it: its files by name, its looks. */
export interface EngineNet {
  kind: 'engine15'
  key: string
  steps: string
  pieces: string[]
  q8Bytes: number
  maps: number
  looks: { where: { maps: [number, number]; multiple?: number }; read: { size: [number, number]; maps: [number, number] } }
}

export interface EngineStart {
  arithmetic: 'f16' | 'f32'
  selfTest: { where: number; read: number }
  heldBytes: number
  startMs: number
  filesMs: number
  deviceMs: number
  engineMs: { unpack: number; compile: number; all: number }
  selfTestMs: number
  describe: string
  refused16?: string
}

export interface EngineBackend {
  kind: string
  start(): Promise<EngineStart>
  look(look: 'where' | 'read', pic: Grey): Promise<LookResult>
  readonly heldBytes: number
  end(): Promise<void>
}

/** The engine's shaders compiled ahead from the steps alone, on the device the engine's own start is then handed. */
export function prepare(stepsBytes: ArrayBuffer | Uint8Array, o: { net: EngineNet; arithmetic?: 'auto' | 'f16' | 'f32'; test?: string }):
  Promise<{ compileMs: number; unpackMs: number; ms: number; arithmetic: string; pipelines: number }>

/** After the engine's own start: what prepare() held is given back. */
export function release(): { handedOver: boolean } | null

export function makeBackend(o: {
  net: EngineNet
  files: { get(name: string): Promise<ArrayBuffer> }
  base?: string
  arithmetic?: 'auto' | 'f16' | 'f32'
  test?: string
  mark?: (state: unknown) => void
  stepped?: (from: string, to: string, why: string) => void
}): Promise<EngineBackend>
