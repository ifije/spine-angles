// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The on-device guess as a "spine-labels/1" record: the same record a detector service sends, so that the app places it
// exactly as it places a service's guess. The landmark path decides what is given (its `named()`): the femoral heads and
// both ends of S1 when it shows a pelvis; S1 from the lumbar chain when it shows none but has a chain; the lumbar endplates
// L1 to L5 and the centre of the L1 body when the chain is not tangled. Each landmark has the path's confidence, 0 to 1.

import { LABEL_SCHEMA, type LabelRecord } from '../labels'

/** One landmark as the path gives it, in the photo's pixels. */
export interface PathLandmark {
  name: string
  x: number
  y: number
  confidence: number
}

/** What the landmark path gives for one photo (only the parts this conversion reads). */
export interface PathResult {
  width: number
  height: number
  landmarks: PathLandmark[]
  facing: 'left' | 'right' | null
  guess: {
    tier: string
    pipeline_result: string
    pelvis_confidence: number | null
    lumbar_support: number | null
    lumbar_chain_given: boolean
    s1_from: string | null
    s1_tilt_difference_between_networks: number | null
    a3?: { second_look?: string | null; kept_look?: number | null; path?: string; work?: Record<string, number[]> } | null
  }
}

/** What the guess adds to the record: how it was made (no picture, no name). */
export interface GuessInfo {
  pipeline_result: string
  tier?: string
  pelvis_confidence: number | null
  lumbar_support: number | null
  lumbar_chain_given: boolean
  s1_from: string | null
  [more: string]: unknown
}

/** A guess: a label record without the app's own part, with how it was made. */
export type GuessRecord = Omit<LabelRecord, 'app'> & { guess?: GuessInfo }

export interface MadeOnDevice {
  /** The detector file's name for its network and the first digits of its content stamp. */
  detector: string
  stamp: string
  /** The arithmetic the engine ran in: 'f16' (16-bit numbers, 32-bit sums) or 'f32'. */
  arithmetic: string
  seconds: number
}

/** The path's result as the record a detector service sends (pelvis/guess.py of the detector's repository). */
export function toGuessRecord(r: PathResult, made: MadeOnDevice): GuessRecord {
  const landmarks = r.landmarks.map((l) => ({ name: l.name, x: l.x, y: l.y, visible: true, annotator: 'auto', confidence: l.confidence }))
  const chain = r.guess.lumbar_chain_given && landmarks.some((l) => l.name === 'L1_center')
  const g = r.guess
  return {
    schema: LABEL_SCHEMA,
    dataset: 'spine_detect_guess',
    image_id: '',
    image: { path: '', width: r.width, height: r.height, bit_depth: 8, source_path: null, source_format: 'canvas', was_colour: false },
    tier: 'private',
    licence: null,
    view: landmarks.length ? 'lateral' : 'unknown',
    region: chain ? 'lumbar' : landmarks.length ? 'pelvis' : 'other',
    facing: r.facing,
    synthetic: false,
    standing: null,
    landmarks,
    circles: [],
    polygons: [],
    boxes: [],
    masks: [],
    measurements: {},
    labels: { not_visible: [] },
    patient: {},
    source_labels: 'automatic guess (worked out on this device), not reviewed by a person',
    notes: 'Every landmark here was placed by the automatic guess. Research software, not validated for clinical use.',
    guess: {
      pipeline_result: g.pipeline_result,
      tier: g.tier,
      pelvis_confidence: g.pelvis_confidence,
      lumbar_support: g.lumbar_support,
      lumbar_chain_given: g.lumbar_chain_given,
      s1_from: g.s1_from,
      s1_confirmed_by_second_network: null,
      s1_tilt_difference_between_networks: g.s1_tilt_difference_between_networks,
      turned_quarters: 0,
      mirrored: false,
      second_look: g.a3?.second_look ?? null,
      // per kind of look: how many, megapixels in all, the largest, milliseconds on the graphics chip
      looks: g.a3?.work ?? null,
      on_device: true,
      networks: { detector: made.detector, stamp: made.stamp, arithmetic: made.arithmetic },
      seconds: Math.round(made.seconds * 100) / 100,
    },
  }
}
