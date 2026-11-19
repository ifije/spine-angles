// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Landmark export for building a labelled set of films: one record per photo, in the
// "spine-labels/1" format, with every landmark named by level and position.

import { Doc, ToolKind, isDone, measureText } from './model'
import { Pt, dist, rot } from './geometry'
import { FEATURES, FeatureId, Result } from './sagittal'

export const LABEL_SCHEMA = 'spine-labels/1'

type Plate = [level: string, plate: 'sup' | 'inf']

/** Sagittal endplates. The two ends are exported as `<level>_<plate>_ant` and `_post`. */
const SAG_LINES: Partial<Record<FeatureId, Plate>> = {
  s1: ['S1', 'sup'], l4: ['L4', 'sup'], l1: ['L1', 'sup'], t12: ['T12', 'inf'],
  t4: ['T4', 'sup'], t1: ['T1', 'sup'], c7: ['C7', 'inf'], c2: ['C2', 'inf'],
}
const SAG_POINTS: Partial<Record<FeatureId, string>> = { l1c: 'L1_center', t1c: 'T1_center', c7c: 'C7_center' }
const HEADS: Partial<Record<FeatureId, string>> = { fh1: 'femoral_head_a', fh2: 'femoral_head_b' }
/**
 * Coronal lines. The two ends are exported as `<stem>_l` and `_r` by IMAGE side. Where the
 * app cannot know the level or structure that was tapped, the name is kept under `other:`.
 */
const COR_LINES: Partial<Record<FeatureId, string>> = {
  po: 'other:pelvis_ref', ct1: 'T1_sup',
  ptU: 'cobb_pt_upper', ptL: 'cobb_pt_lower', mtU: 'cobb_mt_upper', mtL: 'cobb_mt_lower',
  tlU: 'cobb_tl_upper', tlL: 'cobb_tl_lower', frU: 'other:fractional_upper', frL: 'S1_sup',
}

/** Name of a whole landmark (not one of its points), used to list what was marked not visible. */
export function featureLabel(id: FeatureId): string {
  const line = SAG_LINES[id]
  return line ? `${line[0]}_${line[1]}` : SAG_POINTS[id] ?? HEADS[id] ?? COR_LINES[id] ?? id
}

export interface LabelLandmark {
  name: string
  x: number
  y: number
  visible: boolean
  annotator: string | null
}

export interface LabelRecord {
  schema: string
  dataset: string
  image_id: string
  image: { path: string; width: number; height: number; bit_depth: number; source_path: null; source_format: string; was_colour: boolean }
  tier: 'private'
  licence: null
  view: 'lateral' | 'frontal' | 'unknown'
  region: 'cervical' | 'thoracic' | 'lumbar' | 'whole_spine' | 'pelvis' | 'other'
  facing: 'left' | 'right' | null
  synthetic: false
  standing: null
  landmarks: LabelLandmark[]
  circles: { name: string; cx: number; cy: number; r: number; annotator: string | null }[]
  polygons: never[]
  boxes: never[]
  masks: never[]
  measurements: Record<string, number>
  labels: { not_visible: string[] }
  patient: Record<string, never>
  source_labels: string
  notes: string
  app: {
    name: string
    version: string
    saved: string
    /** Rotation, in degrees, that levels the photo. Coordinates are NOT rotated. */
    level_deg: number
    facing_auto: boolean
    /** Units of the measurements that are not in degrees. */
    units: Record<string, string>
    free_measurements: { kind: ToolKind; points: [number, number][]; value: string }[]
  }
}

export interface LabelInput {
  doc: Doc
  /** Size of the saved image in pixels; coordinates are in this grid. */
  width: number
  height: number
  /** +1 if the patient faces image right, -1 if left (from the sagittal calculation). */
  facing: 1 | -1
  facingAuto: boolean
  skipped: FeatureId[]
  results: Result[]
  imageFile: string
  imageId: string
  /** ISO timestamp. */
  saved: string
  appVersion: string
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number) => Math.round(v * 10) / 10

function regionOf(names: string[], view: LabelRecord['view']): LabelRecord['region'] {
  const has = (re: RegExp) => names.some((n) => re.test(n))
  const cervical = has(/^C\d/)
  const thoracic = has(/^T\d/)
  const lumbar = has(/^L\d/)
  const pelvis = has(/^(S1_|femoral_head_|other:pelvis_ref)/)
  if (view === 'frontal') {
    if (has(/^cobb_/) || (thoracic && pelvis)) return 'whole_spine'
    return pelvis && !thoracic && !lumbar ? 'pelvis' : 'other'
  }
  // "High" is anything at or above T4; "low" is lumbar or pelvic.
  if ((cervical || has(/^T[1-4]_/)) && (lumbar || pelvis)) return 'whole_spine'
  if (lumbar || (pelvis && thoracic)) return 'lumbar'
  if (pelvis) return 'pelvis'
  // T1 alone is the T1 slope, a cervical parameter.
  if (cervical || (thoracic && !has(/^T([2-9]|1[0-2])_/))) return 'cervical'
  if (thoracic) return 'thoracic'
  return 'other'
}

/** Build the label record for the current photo. Pure: no DOM access. */
export function buildLabels(input: LabelInput): LabelRecord {
  const { doc, facing } = input
  const level = (p: Pt) => (doc.tilt ? rot(p, doc.tilt) : p)
  const landmarks: LabelLandmark[] = []
  const circles: LabelRecord['circles'] = []
  const add = (name: string, p: Pt) => landmarks.push({ name, x: r2(p.x), y: r2(p.y), visible: true, annotator: null })
  let sagittal = false
  let coronal = false
  let sagittalLine = false

  for (const f of FEATURES) {
    const pts = doc.features[f.id]
    if (!pts || !pts.length) continue
    const head = HEADS[f.id]
    const point = SAG_POINTS[f.id]
    const plate = SAG_LINES[f.id]
    const stem = COR_LINES[f.id]
    if (head) {
      add(`${head}_center`, pts[0])
      if (pts.length >= 2) circles.push({ name: head, cx: r2(pts[0].x), cy: r2(pts[0].y), r: r2(dist(pts[0], pts[1])), annotator: null })
      sagittal = true
    } else if (point) {
      add(point, pts[0])
      sagittal = true
    } else if (plate && pts.length >= 2) {
      // Anterior is the end further towards the way the patient faces, judged on the
      // levelled photo. Tap order (anterior first) only decides a dead heat.
      const a = level(pts[0]).x * facing
      const b = level(pts[1]).x * facing
      const [ant, post] = a >= b ? [pts[0], pts[1]] : [pts[1], pts[0]]
      add(`${plate[0]}_${plate[1]}_ant`, ant)
      add(`${plate[0]}_${plate[1]}_post`, post)
      sagittal = true
      sagittalLine = true
    } else if (stem && pts.length >= 2) {
      const [l, r] = level(pts[0]).x <= level(pts[1]).x ? [pts[0], pts[1]] : [pts[1], pts[0]]
      add(`${stem}_l`, l)
      add(`${stem}_r`, r)
      coronal = true
    }
  }

  const view: LabelRecord['view'] = sagittal && !coronal ? 'lateral' : coronal && !sagittal ? 'frontal' : 'unknown'
  // Without an endplate or a manual choice, the facing direction is only a default.
  const facingKnown = view === 'lateral' && (sagittalLine || !input.facingAuto)
  const planes = new Set<string>([...(sagittal ? ['sagittal'] : []), ...(coronal ? ['coronal'] : [])])
  const measurements: Record<string, number> = {}
  const units: Record<string, string> = {}
  for (const r of input.results) {
    if (!planes.has(r.plane)) continue
    measurements[r.key] = r1(r.value)
    if (r.unit !== '°') units[r.key] = r.unit
  }

  return {
    schema: LABEL_SCHEMA,
    dataset: 'spine_angles_app',
    image_id: input.imageId,
    image: { path: input.imageFile, width: input.width, height: input.height, bit_depth: 8, source_path: null, source_format: 'jpeg', was_colour: true },
    tier: 'private',
    licence: null,
    view,
    region: regionOf(landmarks.map((l) => l.name), view),
    facing: facingKnown ? (facing > 0 ? 'right' : 'left') : null,
    synthetic: false,
    standing: null,
    landmarks,
    circles,
    polygons: [],
    boxes: [],
    masks: [],
    measurements,
    labels: { not_visible: input.skipped.filter((id) => !doc.features[id]).map(featureLabel) },
    patient: {},
    source_labels: 'Spine Angles app',
    notes: 'Labelled by hand on a photograph. If the photo was taken at an angle to the film, the geometry is skewed.',
    app: {
      name: 'Spine Angles',
      version: input.appVersion,
      saved: input.saved,
      level_deg: r2(doc.tilt),
      facing_auto: input.facingAuto,
      units,
      free_measurements: doc.measures.filter(isDone).map((m) => ({
        kind: m.kind,
        points: m.pts.map((p): [number, number] => [r2(p.x), r2(p.y)]),
        value: measureText(m, doc.tilt) ?? '',
      })),
    },
  }
}

/** True when there is something worth saving. */
export const hasLabels = (r: LabelRecord): boolean => r.landmarks.length > 0 || r.app.free_measurements.length > 0
