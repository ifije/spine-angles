// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

import './style.css'
import { Pt, dist, mid, rot } from './geometry'
import { Doc, Mat, Measure, PlannedCage, ToolKind, NEED, TOOL_NAME, apply, invert, matrix, isDone, measureText } from './model'
import { drawOverlay, colorFor, drawPieces, drawWedge, drawCage } from './draw'
import {
  Wedge, WedgeProblem, makeWedge, isWedge, Cage, CageProblem, makeCage, isCage, Cut, psoCut, cageCut, moveThrough,
  moveFeaturesThrough, moveLinesThrough, discOutline, distToOutline, cageClash,
} from './osteotomy'
import { loadPhoto, rotate90, flipH, toneCss, Tone } from './image'
import { exportView, resultsClipboard, copyResults, saveLabels, fileStamp } from './export'
import { buildLabels, hasLabels, readLabels } from './labels'
import {
  findDetector, findService, requestGuess, addDetectorFile, removeDetectorFile, endDetector, dropPublished, setGuessOff,
  NotOffered, DetectorFileError, type Detector, type Found,
} from './auto'
import { guessView, failureText, ofMB } from './waiting'
import {
  FEATURES, FEATURE_BY_ID, MEASURE_GROUPS, MEASURE_BY_KEY, FeatureId, MeasureDef, MeasureState, NeedState, Plane, Result,
  stepsFor, isComplete, compute, formatValue, measureState, needsText,
} from './sagittal'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const stage = $('stage')
const cvImage = $<HTMLCanvasElement>('cv-image')
const cvOverlay = $<HTMLCanvasElement>('cv-overlay')
const ictx = cvImage.getContext('2d')!
const octx = cvOverlay.getContext('2d')!
const loupeEl = $('loupe')
const cvLoupeImage = $<HTMLCanvasElement>('loupe-image')
const cvLoupeOverlay = $<HTMLCanvasElement>('loupe-overlay')
/** The Tools chooser above the bottom bar: Cobb, Angle and Slope. */
const toolMenu = $('tool-menu')
const LOUPE = 132
const LOUPE_ZOOM = 2.5

// ---------------------------------------------------------------- state

let src: HTMLCanvasElement | null = null
let doc: Doc = { measures: [], features: {}, tilt: 0 }
let undoStack: string[] = []
let nextId = 1
const view = { s: 1, tx: 0, ty: 0 }
let tone: Tone = { brightness: 1, contrast: 1, invert: false }

type Tool = ToolKind | 'guided' | 'pso' | 'cage' | null
let tool: Tool = null
/** How far the planned osteotomy is closed: 0 open, 1 closed. Not part of the document, so undo leaves it. */
let psoClose = 0
/** Whether the cages' changes of their disc angles are shown on the photo (they are put back while points are tapped). */
let cageShown = true
/** The cage the Cage tool is changing (its place in doc.cages), or null for none chosen. */
let cageSel: number | null = null
/** The next taps place another cage (Add). */
let cageNew = false
/** The PSO and Cage tools plan on the photo; while one is out the landmarks are hidden. */
const planTool = (t: Tool) => t === 'pso' || t === 'cage'
/** Free measurement currently being placed. */
let activeId: number | null = null
let selected: number | null = null
/** Guided landmark tapped on the image, so it can be deleted on its own. */
let selectedFeature: FeatureId | null = null
/** Guided result shown on its own on the image (its key), or null to show them all. */
let focus: string | null = null
let steps: FeatureId[] = []
/** Name of the measurement being guided, shown in the prompt. */
let guidedTitle = ''
/** A landmark being placed again: it stays where it is until the first tap starts it anew. */
let replacing: FeatureId | null = null
/** The measurement whose own panel is open in the Guided sheet (its key), or null for the list. */
let panelKey: string | null = null
/** Where that panel was opened from, so that Back returns there. */
let panelFrom: 'guided' | 'results' = 'guided'
/** Where the Guided list was scrolled to before a panel opened. */
let listScroll = 0
/** Results' "Not measured yet" list: open or closed by the user, or null to have it open only while nothing is measured. */
let notYetOpen: boolean | null = null
/** Which set of guided measurements the Guided and Results panels show. */
let plane: Plane = 'sagittal'
try {
  if (localStorage.getItem('plane') === 'coronal') plane = 'coronal'
} catch {
  /* storage unavailable: start on sagittal */
}
const skipped = new Set<FeatureId>()
let facingOverride = 0
let age: number | undefined
/** The detector for automatic guesses: a detector file run on this device, or a service the user runs; null (the normal case) for none. */
let detector: Detector | null = null
/** The user has added a detector file (kept on this device, or for this session if the browser would not keep it). */
let detectorAdded = false
/** A detector is here, but this browser can run it in no way (neither the engine nor the slower way). */
let notOffered = false
/** Why a detector file could not be used, in plain words, or null. */
let detectorProblem: string | null = null
/** The on-device detector has started (its self-test passed) and is waiting for photos. */
let detectorReady = false
/** What was found last (the built-in detector's download, whether the guess is turned off). */
let found: Found | null = null
/** The built-in detector's download: bytes so far and in all; whether it failed (tried again at the next opening). */
let dlGot = 0
let dlTotal = 0
let dlFailed = false
/** Whether the built-in detector is kept on this device (null: not known yet). */
let keptHere: boolean | null = null
/** The slower way's own download (the runtime), where the engine cannot run: bytes so far and in all. */
let rtGot = 0
let rtTotal = 0
/** The app is still finding out whether there is a detector. */
let looking = true
/** The automatic guess wanted for the photo on screen (it opened, or Auto was tapped), until placed, skipped or failed;
 *  `edits`: the count of hand edits when it was asked for (`manual`: asked for with Auto, so placed even after hand edits). */
let wanted: { photo: HTMLCanvasElement; edits: number; manual: boolean } | null = null
/** Hand edits so far (every change a person makes): a guess asked for by opening a photo is not placed over them. */
let handEdits = 0
/** The guess for this photo is running (the detector is ready) since this time, or null. */
let findingSince: number | null = null
/** The detector became ready after the user worked by hand: Auto places the guess for what is not placed yet. */
let readyForAuto = false
/** Why the last attempt failed, in plain words, until dismissed or tried again; whether its line was closed. */
let guessFailure: string | null = null
let lineDismissed = false
/** The slower way is in use: why, and about how long a photo takes. */
let slower: { why: 'no-webgpu' | 'engine-failed' | null; perPhotoS: number | null } | null = null
/** Counts guess requests: a reply is used only if it is still the latest and for the same photo. */
let guessToken = 0
let guessing = false

type SheetId = 'adjust' | 'guided' | 'results'
let sheet: SheetId | null = null

let W = 0
let H = 0
let dpr = 1
let loupeAt: Pt | null = null

const viewMat = (): Mat => matrix(view.s, doc.tilt, view.tx, view.ty)
const sagittal = () => compute(doc.features, { tilt: doc.tilt, facing: facingOverride, age })

/** The planned osteotomy once its three points are there (or why they make no wedge), else null. */
const wedge = (): Wedge | WedgeProblem | null =>
  doc.pso?.length === 3 ? makeWedge(doc.pso[0], doc.pso[1], doc.pso[2], doc.tilt) : null
/**
 * Which way the patient faces, for the cage: the Facing button, else the landmarks' endplates, else the cage's own taps
 * (the front corner of each endplate is asked for first).
 */
function cageFacing(pts: Pt[]): number {
  if (facingOverride) return facingOverride
  if (FEATURES.some((f) => f.plane === 'sagittal' && f.kind === 'line' && isComplete(doc.features, f.id))) return sagittal().facing
  let v = 0
  for (let i = 0; i + 1 < pts.length; i += 2) v += Math.sign(rot(pts[i], doc.tilt).x - rot(pts[i + 1], doc.tilt).x)
  return v < 0 ? -1 : 1
}
const cagesOf = (): PlannedCage[] => doc.cages ?? []
/** Cage i once its four points are there (or why they make none), else null. */
function cageAt(i: number): Cage | CageProblem | null {
  const g = doc.cages?.[i]
  return g?.pts.length === 4 ? makeCage(g.pts, g.facing ?? cageFacing(g.pts), doc.tilt) : null
}
/** The angle cage i sets its disc to: the disc's own angle until it is changed. */
function cageTarget(i: number): number | null {
  const c = cageAt(i)
  return isCage(c) ? doc.cages![i].target ?? c.deg : null
}
/** Cage i's cut, when it changes its disc's angle; else null. */
function cageCutOf(i: number): Cut | null {
  const c = cageAt(i)
  const tg = cageTarget(i)
  return isCage(c) && tg !== null && Math.abs(tg - c.deg) > 1e-9 ? cageCut(c, tg, doc.tilt, `cage${i}`) : null
}
/** The plan's cuts as shown on the photo: the PSO as far as it is closed, the cages when shown and changing their discs. */
function shownCuts(): Cut[] {
  const cuts: Cut[] = []
  const w = wedge()
  if (isWedge(w) && psoClose > 0) cuts.push(psoCut(w, psoClose, doc.tilt))
  if (cageShown) cagesOf().forEach((_, i) => {
    const c = cageCutOf(i)
    if (c) cuts.push(c)
  })
  return cuts
}
/** The whole plan: the PSO closed, each cage at its angle. */
function plannedCuts(): Cut[] {
  const cuts: Cut[] = []
  const w = wedge()
  if (isWedge(w)) cuts.push(psoCut(w, 1, doc.tilt))
  cagesOf().forEach((_, i) => {
    const c = cageCutOf(i)
    if (c) cuts.push(c)
  })
  return cuts
}
const hasPlan = () => isWedge(wedge()) || cagesOf().some((_, i) => isCage(cageAt(i)))

/** p turned by r radians about h (clockwise on screen, as canvas rotate). */
function turnAbout(h: Pt, p: Pt, r: number): Pt {
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = p.x - h.x
  const dy = p.y - h.y
  return { x: h.x + dx * c - dy * s, y: h.y + dx * s + dy * c }
}
/**
 * Where corner j of cage i is drawn when it is kept at x: carried by the plan's other cuts as shown, and an upper corner
 * also turned by the cage's own change (which a dragged corner keeps).
 */
function cornerShown(i: number, j: number, x: Pt): Pt {
  const g = cagesOf()[i]
  const cuts = shownCuts()
  const own = cuts.find((c) => c.key === `cage${i}`)
  const others = cuts.filter((c) => c !== own)
  let p = x
  if (own && g.pts.length === 4) {
    const pts = g.pts.map((q, k) => (k === j ? x : q))
    const c = makeCage(pts, g.facing ?? cageFacing(pts), doc.tilt)
    if (isCage(c) && c.upper.includes(x)) p = turnAbout(c.h, x, own.turn)
  }
  return moveThrough(others, p)
}
/** The cage's outline as drawn. */
const cageShape = (i: number): Pt[] => discOutline(cagesOf()[i].pts.map((x, j) => cornerShown(i, j, x)))
/**
 * The kept point that `show` draws at q, starting from p: a point dragged on the plan as shown is kept where it is on the
 * photo as it is. Each step is exact for a map that turns and shifts; more steps follow a hinge that moves with the point.
 */
function pullBack(show: (x: Pt) => Pt, q: Pt, p: Pt): Pt {
  for (let n = 0; n < 4; n++) {
    const a = show(p)
    const b = show({ x: p.x + 1, y: p.y })
    const r = -Math.atan2(b.y - a.y, b.x - a.x)
    const d = { x: q.x - a.x, y: q.y - a.y }
    p = { x: p.x + d.x * Math.cos(r) - d.y * Math.sin(r), y: p.y + d.x * Math.sin(r) + d.y * Math.cos(r) }
  }
  return p
}
/** The document as shown: with the plan shown, everything above each cut moved with its piece of the spine. */
function shownDoc(): Doc {
  const cuts = shownCuts()
  if (!cuts.length) return doc
  return {
    ...doc,
    features: moveFeaturesThrough(doc.features, cuts),
    measures: doc.measures.map((m) => ({ ...m, pts: moveLinesThrough(m.pts, cuts, m.kind !== 'angle3') })),
  }
}
/** The guided results with these cuts made. Facing is the photo's own. */
const sagittalWith = (cuts: Cut[]) =>
  compute(moveFeaturesThrough(doc.features, cuts), { tilt: doc.tilt, facing: facingOverride || sagittal().facing, age })
/** The guided results as shown. */
function shownSagittal() {
  const cuts = shownCuts()
  return cuts.length ? sagittalWith(cuts) : sagittal()
}

/**
 * The plan's own marks (the PSO's wedge, each cage's disc), each carried by the other cuts as shown. With the Cage tool
 * out, the cage being changed (or placed) has its corners ringed and the others are fainter.
 */
function drawPlanMarks(ctx: CanvasRenderingContext2D, M: Mat, k: number, onScreen: boolean) {
  const cuts = shownCuts()
  if (doc.pso?.length) {
    const others = cuts.filter((c) => c.kind !== 'pso')
    drawWedge(ctx, M, doc.pso, wedge(), psoClose, k, onScreen && tool === 'pso' && psoClose === 0, (p) => moveThrough(others, p))
  }
  const cages = cagesOf()
  const out = onScreen && tool === 'cage'
  const adding = placingCage()
  cages.forEach((g, i) => {
    if (!g.pts.length) return
    const own = cuts.find((c) => c.key === `cage${i}`)
    const others = cuts.filter((c) => c !== own)
    const chosen = out && !adding && i === cageSel
    const placingThis = out && g.pts.length < 4
    drawCage(ctx, M, g.pts, cageAt(i), cageTarget(i), own ? own.turn : 0, k, {
      rings: chosen || placingThis,
      dim: out && !chosen && !placingThis,
      num: cages.length > 1 ? i + 1 : 0,
      carry: (p) => moveThrough(others, p),
    })
  })
}

// ---------------------------------------------------------------- drawing

let drawQueued = false
function requestDraw() {
  if (drawQueued) return
  drawQueued = true
  requestAnimationFrame(() => {
    drawQueued = false
    draw()
  })
}

function draw() {
  const M = viewMat()
  ictx.setTransform(1, 0, 0, 1, 0, 0)
  ictx.clearRect(0, 0, cvImage.width, cvImage.height)
  octx.setTransform(dpr, 0, 0, dpr, 0, 0)
  octx.clearRect(0, 0, W, H)
  if (!src) return
  ictx.setTransform(M[0] * dpr, M[1] * dpr, M[2] * dpr, M[3] * dpr, M[4] * dpr, M[5] * dpr)
  ictx.imageSmoothingQuality = 'high'
  const cuts = shownCuts()
  if (cuts.length) drawPieces(ictx, src, cuts, 0.25)
  else ictx.drawImage(src, 0, 0)
  // While a planning tool is out, only the photo and the plan: the landmarks come back, moved, with Done.
  if (!planTool(tool)) drawOverlay(octx, M, shownDoc(), { k: 1, selected, selectedFeature, sag: shownSagittal(), focus })
  drawPlanMarks(octx, M, 1, true)
  if (loupeAt) drawLoupe()
}

function drawLoupe() {
  if (!src || !loupeAt) return
  const R = LOUPE / 2
  const base = matrix(view.s * LOUPE_ZOOM, doc.tilt, 0, 0)
  const c = apply(base, loupeAt)
  const M: Mat = [base[0], base[1], base[2], base[3], R - c.x, R - c.y]
  const li = cvLoupeImage.getContext('2d')!
  li.setTransform(1, 0, 0, 1, 0, 0)
  li.fillStyle = '#000'
  li.fillRect(0, 0, cvLoupeImage.width, cvLoupeImage.height)
  li.setTransform(M[0] * dpr, M[1] * dpr, M[2] * dpr, M[3] * dpr, M[4] * dpr, M[5] * dpr)
  // The plan as shown, so a corner dragged on it sits on the bone it is drawn on.
  const cuts = shownCuts()
  if (cuts.length) drawPieces(li, src, cuts, 0.25)
  else li.drawImage(src, 0, 0)
  const lo = cvLoupeOverlay.getContext('2d')!
  lo.setTransform(dpr, 0, 0, dpr, 0, 0)
  lo.clearRect(0, 0, LOUPE, LOUPE)
  if (!planTool(tool)) drawOverlay(lo, M, doc, { k: 1, selected, noLabels: true, sag: sagittal(), focus })
  drawPlanMarks(lo, M, 1, true)
  // Crosshair ticks, leaving the centre clear.
  for (const [color, width] of [['rgba(0,0,0,0.7)', 3], ['#fff', 1]] as const) {
    lo.strokeStyle = color
    lo.lineWidth = width
    lo.beginPath()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      lo.moveTo(R + dx * 14, R + dy * 14)
      lo.lineTo(R + dx * 40, R + dy * 40)
    }
    lo.stroke()
  }
}

function resize() {
  const r = stage.getBoundingClientRect()
  if (!r.width || !r.height) return
  const first = W === 0
  W = r.width
  H = r.height
  dpr = Math.min(window.devicePixelRatio || 1, 3)
  for (const c of [cvImage, cvOverlay]) {
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
  }
  for (const c of [cvLoupeImage, cvLoupeOverlay]) {
    c.width = c.height = Math.round(LOUPE * dpr)
  }
  if (first && src) fit()
  draw()
}
new ResizeObserver(resize).observe(stage)

/** The view that scales and centres the (levelled) photo in the stage. */
function fitView(): { s: number; tx: number; ty: number } {
  const m = matrix(1, doc.tilt, 0, 0)
  const cs = [{ x: 0, y: 0 }, { x: src!.width, y: 0 }, { x: 0, y: src!.height }, { x: src!.width, y: src!.height }].map((p) => apply(m, p))
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const bw = Math.max(...xs) - minX
  const bh = Math.max(...ys) - minY
  const s = Math.min(W / bw, H / bh) * 0.96
  return { s, tx: W / 2 - s * (minX + bw / 2), ty: H / 2 - s * (minY + bh / 2) }
}

/** Scale and centre the (levelled) photo in the stage. */
function fit() {
  if (!src || !W) return
  Object.assign(view, fitView())
  requestDraw()
}

/** Bring a landmark to the middle of the stage, at least twice the fitted size, and select it. */
function showFeature(id: FeatureId) {
  const pts = doc.features[id]
  if (!src || !W || !pts?.length) return
  const c = FEATURE_BY_ID[id].kind === 'line' && pts.length === 2 ? mid(pts[0], pts[1]) : pts[0]
  const s = Math.min(12, Math.max(view.s, 2 * fitView().s))
  const q = apply(matrix(s, doc.tilt, 0, 0), c)
  view.s = s
  view.tx = W / 2 - q.x
  view.ty = H / 2 - q.y
  selected = null
  selectedFeature = id
  refresh()
}

function zoomAt(p: Pt, factor: number) {
  if (!src) return
  const minS = 0.3 * Math.min(W / src.width, H / src.height)
  const s = Math.min(12, Math.max(minS, view.s * factor))
  const r = s / view.s
  view.tx = p.x - (p.x - view.tx) * r
  view.ty = p.y - (p.y - view.ty) * r
  view.s = s
  requestDraw()
}

function setTilt(deg: number) {
  const centre = { x: W / 2, y: H / 2 }
  const anchor = invert(viewMat(), centre)
  doc.tilt = deg
  const q = apply(matrix(view.s, deg, 0, 0), anchor)
  view.tx = centre.x - q.x
  view.ty = centre.y - q.y
}

// ---------------------------------------------------------------- undo

const snapshot = () => JSON.stringify({ doc, activeId, replacing, cageSel })

function pushUndo(snap = snapshot()) {
  handEdits++
  undoStack.push(snap)
  if (undoStack.length > 200) undoStack.shift()
}

function undo() {
  const snap = undoStack.pop()
  if (!snap) return
  handEdits++
  const s = JSON.parse(snap) as { doc: Doc; activeId: number | null; replacing?: FeatureId | null; cageSel?: number | null }
  doc = s.doc
  // The cage that was chosen then (a cage deleted and brought back is chosen again, not the one now in its place).
  if (s.cageSel !== undefined) cageSel = s.cageSel
  replacing = tool === 'guided' ? s.replacing ?? null : null
  const partial = doc.measures.find((m) => !isDone(m))
  if (partial) {
    activeId = partial.id
    tool = partial.kind
  } else {
    activeId = null
  }
  if (selected !== null && !doc.measures.some((m) => m.id === selected)) selected = null
  if (cageSel !== null && cageSel >= cagesOf().length) cageSel = cagesOf().length ? cagesOf().length - 1 : null
  // A measuring tool brought back by undo works on the photo as it is; undone past a plan tool's placing, the plan shows
  // again as it was.
  if (placing()) openPlan(planTool(tool))
  else if (planTool(tool) && reopen) showPlanAgain(false)
  syncAdjustInputs()
  // Undone past everything the prompts asked for: the prompts are over.
  if (tool === 'guided' && !currentStep()) return finishGuided()
  refresh()
}

// ---------------------------------------------------------------- tools

const FREE_PROMPTS: Record<ToolKind, string[]> = {
  cobb: ['tap one end of the first endplate', 'tap its other end', 'tap one end of the second endplate', 'tap its other end'],
  angle3: ['tap the end of one arm', 'tap the vertex', 'tap the end of the other arm'],
  slope: ['tap one end of the line', 'tap the other end'],
}

const currentStep = (): FeatureId | undefined =>
  steps.find((id) => id === replacing || (!isComplete(doc.features, id) && !skipped.has(id)))

/** Drop half-placed free measurements and half-placed landmarks. */
function dropPartials() {
  const partialM = doc.measures.some((m) => !isDone(m))
  const partialF = FEATURES.some((f) => doc.features[f.id] && !isComplete(doc.features, f.id))
  const partialP = !!doc.pso && doc.pso.length < 3
  const partialC = cagesOf().some((g) => g.pts.length < 4)
  if (!partialM && !partialF && !partialP && !partialC) return
  pushUndo()
  doc.measures = doc.measures.filter(isDone)
  for (const f of FEATURES) if (!isComplete(doc.features, f.id)) delete doc.features[f.id]
  if (partialP) delete doc.pso
  if (partialC) {
    doc.cages = cagesOf().filter((g) => g.pts.length === 4)
    if (!doc.cages.length) delete doc.cages
    if (cageSel !== null && cageSel >= cagesOf().length) cageSel = null
  }
  activeId = null
}

/** The Cage tool is placing a cage's corners: another one (Add, or none yet), or the last one, part-placed. */
function placingCage(): boolean {
  const cages = cagesOf()
  return tool === 'cage' && (cageNew || !cages.length || cages[cages.length - 1].pts.length < 4)
}

/** The tool out places points by tapping the photo (rather than working a slider). */
const placing = () =>
  !!tool && (tool === 'pso' ? (doc.pso?.length ?? 0) < 3 : tool === 'cage' ? placingCage() : true)

/** How the plan was shown before it was opened to place points, to show it so again once they are placed. */
let reopen: { pso: number; cages: boolean } | null = null

/**
 * Taps work on the photo as it is: a plan that moves the picture is put back first. It stays planned. `keep`: a plan tool
 * is placing points, and the plan is shown again as it was once they are placed (see showPlanAgain); a measuring tool
 * leaves it open.
 */
function openPlan(keep = false) {
  if (!keep) reopen = null
  if (!shownCuts().length) return
  if (keep) reopen = { pso: psoClose, cages: cageShown }
  psoClose = 0
  psoSlider.value = '0'
  cageShown = false
  toast('Plan opened to place points')
}

/**
 * A plan tool's points are placed (or the placing is cancelled): the plan is shown as it was before it was opened. A new
 * wedge starts open; the cages show their changes.
 */
function showPlanAgain(newWedge: boolean) {
  if (reopen && !newWedge && isWedge(wedge())) psoClose = reopen.pso
  psoSlider.value = String(Math.round(psoClose * 100))
  cageShown = true
  reopen = null
}

function armTool(kind: ToolKind) {
  if (!src) return toast('Choose a photo first')
  const wasOn = tool === kind
  if (!wasOn) openPlan()
  dropPartials()
  tool = wasOn ? null : kind
  activeId = null
  selected = null
  openSheet(null)
  refresh()
}

// ---------------------------------------------------------------- osteotomy (PSO)

const PSO_PROMPTS = [
  'tap the hinge, at the front of the vertebral body',
  'tap where one cut meets the back wall of the body',
  'tap where the other cut meets the back wall',
]

/** The PSO button: start placing the wedge, or show its slider again; tapped again, put it away. */
function armPso() {
  armPlan('pso')
}

/** A planning tool's button: start placing its points, or show its slider again; tapped again, put it away. */
function armPlan(which: 'pso' | 'cage') {
  if (!src) return toast('Choose a photo first')
  if (tool === which) return finishPlan()
  // From another plan tool part-way through placing its points: the plan shows as it was.
  if (planTool(tool) && placing()) showPlanAgain(false)
  dropPartials()
  tool = which
  activeId = null
  selected = null
  selectedFeature = null
  if (which === 'cage') {
    // Back to the cage changed last (or the last one made); with none yet, the taps place the first.
    cageNew = false
    const n = cagesOf().length
    if (cageSel === null || cageSel >= n) cageSel = n ? n - 1 : null
  }
  if (placing()) openPlan(true)
  else if (which === 'cage') cageShown = true
  openSheet(null)
  refresh()
  if (doc.measures.length || Object.keys(doc.features).length) toast('Landmarks hidden while you plan; Done brings them back')
}

/** Done: the plan stays as it is and Results shows what it changes. */
function finishPlan() {
  // Done (or Cancel) before the points were all placed: the plan shows as it was.
  if (placing()) showPlanAgain(false)
  cageNew = false
  dropPartials()
  tool = null
  openSheet(hasPlan() ? 'results' : null)
  refresh()
}

/** A step of the plan tapped in Results: its tool, with that step to change. */
function editPlan(which: 'pso' | number) {
  if (which === 'pso') {
    if (tool !== 'pso') armPlan('pso')
    else openSheet(null)
    return
  }
  if (tool === 'cage' && placingCage()) {
    // The part-placed cage goes (it is the last, so the index stays right) and the plan shows as it was.
    showPlanAgain(false)
    cageNew = false
    dropPartials()
  }
  if (tool !== 'cage') armPlan('cage')
  cageSel = which
  cageNew = false
  cageShown = true
  openSheet(null)
  refresh()
}

function removePlan() {
  if (!doc.pso && !doc.cages) return
  pushUndo()
  delete doc.pso
  delete doc.cages
  psoClose = 0
  cageSel = null
  cageNew = false
  reopen = null
  if (planTool(tool)) tool = null
  refresh()
}

function removePso() {
  if (!doc.pso) return
  pushUndo()
  delete doc.pso
  psoClose = 0
  if (tool === 'pso') tool = null
  refresh()
}

/** A finger is on a plan's slider: the hint bar is not rebuilt under it (iOS can drop a drag whose element is moved). */
let planSliding = false
/** The closing slider lives in the hint bar. It is made once, so that redrawing the hint never takes it from under a finger. */
const psoSlider = document.createElement('input')
psoSlider.type = 'range'
psoSlider.id = 'in-pso'
psoSlider.min = '0'
psoSlider.max = '100'
psoSlider.step = '1'
psoSlider.value = '0'
psoSlider.setAttribute('aria-label', 'How far the wedge is closed')
psoSlider.addEventListener('input', () => {
  psoClose = Number(psoSlider.value) / 100
  reopen = null
  // Only the picture and the hint's text follow while sliding; the rest catches up when the finger lifts.
  const w = wedge()
  if (isWedge(w)) $('hint-text').textContent = psoText(w)
  requestDraw()
})
psoSlider.addEventListener('change', () => {
  planSliding = false
  refresh()
})
psoSlider.addEventListener('pointerdown', () => (planSliding = true))
psoSlider.addEventListener('pointerup', () => (planSliding = false))
psoSlider.addEventListener('pointercancel', () => (planSliding = false))

function psoText(w: Wedge): string {
  return psoClose === 0 ? `PSO ${Math.round(w.deg)}°: slide to close` : `PSO ${Math.round(w.deg)}°, ${Math.round(psoClose * 100)}% closed`
}

// ---------------------------------------------------------------- interbody cage

const CAGE_PROMPTS = [
  'tap the front corner of the upper endplate of the disc',
  'tap its back corner',
  'tap the front corner of the lower endplate',
  'tap its back corner',
]

function armCage() {
  armPlan('cage')
}

/** Add: the next four taps place another cage, on the photo as it is. */
function addCage() {
  cageNew = true
  openPlan(true)
  refresh()
}

/** Cancel while placing: the part-placed cage goes; back to the cages there are, or the tool goes when there are none. */
function cancelCage() {
  cageNew = false
  dropPartials()
  const n = cagesOf().length
  if (!n) return finishPlan()
  if (cageSel === null || cageSel >= n) cageSel = n - 1
  showPlanAgain(false)
  refresh()
}

/** Take cage i out of the plan; the others keep their numbers in order. */
function removeCage(i: number) {
  const cages = cagesOf()
  if (!cages[i]) return
  pushUndo()
  cages.splice(i, 1)
  if (!cages.length) delete doc.cages
  if (cageSel !== null) cageSel = cageSel === i ? null : cageSel > i ? cageSel - 1 : cageSel
  if (tool === 'cage' && !cagesOf().length) tool = null
  refresh()
}

/** Why a corner cannot go where it was tapped or dragged: it would make cage n overlap another. */
function clashText(corners: number, n: number): string {
  if (corners === 4) return `That disc would overlap cage ${n}: cages cannot overlap`
  if (corners === 2) return `That endplate would cross cage ${n}: cages cannot overlap`
  return `That is inside cage ${n}: cages cannot overlap`
}

/** The cage, if any, whose disc as drawn is at p (photo pixels) or within tol of it: the nearest. */
function cageNear(p: Pt, tol: number): number | null {
  let best: number | null = null
  let bestD = tol
  cagesOf().forEach((g, i) => {
    if (g.pts.length < 4) return
    const d = distToOutline(cageShape(i), p)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** Cage i's other cages, each its four corners, with their own numbers. */
function otherCages(i: number): { pts: Pt[]; n: number }[] {
  return cagesOf().flatMap((g, k) => (k !== i && g.pts.length === 4 ? [{ pts: g.pts, n: k + 1 }] : []))
}

let clashToldAt = 0
/**
 * A corner of cage i dragged to p: refused where the cage would overlap another. The cage keeps `keep`, its change of
 * angle when the drag began (none: the disc as measured), even if the disc runs up the picture part-way through.
 */
function moveCorner(i: number, j: number, p: Pt, keep?: number) {
  const g = cagesOf()[i]
  const pts = g.pts.map((q, k) => (k === j ? p : q))
  const others = otherCages(i)
  const k = cageClash(pts, others.map((o) => o.pts))
  if (k >= 0) {
    if (performance.now() - clashToldAt > 1500) toast(clashText(4, others[k].n))
    clashToldAt = performance.now()
    return
  }
  g.pts[j] = p
  const now = cageAt(i)
  if (keep !== undefined && isCage(now)) g.target = now.deg + keep
}

/** The disc-angle slider, made once like the PSO's. A change is one undo step, taken when the finger lifts. */
const cageSlider = document.createElement('input')
cageSlider.type = 'range'
cageSlider.id = 'in-cage'
cageSlider.step = '1'
cageSlider.setAttribute('aria-label', 'The disc angle the cage sets')
let cageBefore: string | null = null
cageSlider.addEventListener('input', () => {
  const i = cageSel
  if (i === null || !cagesOf()[i]) return
  if (cageBefore === null) cageBefore = snapshot()
  setCageTarget(i, Number(cageSlider.value))
  cageShown = true
  $('hint-text').textContent = cageText(i)
  requestDraw()
})
/** The finger lifts (or the browser says the value changed): one undo step, if anything changed. */
function endCageSlide() {
  if (cageBefore !== null && cageBefore !== snapshot()) pushUndo(cageBefore)
  cageBefore = null
  planSliding = false
  refresh()
}
cageSlider.addEventListener('change', endCageSlide)
cageSlider.addEventListener('pointerdown', () => (planSliding = true))
cageSlider.addEventListener('pointerup', endCageSlide)
cageSlider.addEventListener('pointercancel', endCageSlide)

/** One degree more or less for the cage being changed, from the buttons beside the slider. */
function stepCage(by: number) {
  const i = cageSel
  const tg = i === null ? null : cageTarget(i)
  if (i === null || tg === null) return
  pushUndo()
  setCageTarget(i, Math.round(tg) + by)
  cageShown = true
  refresh()
}

/** Whole degrees; the whole degree nearest the disc's measured angle means the disc as measured. */
function setCageTarget(i: number, v: number) {
  const c = cageAt(i)
  const g = cagesOf()[i]
  if (!g || !isCage(c)) return
  if (v === Math.round(c.deg)) delete g.target
  else g.target = v
}

function cageText(i: number): string {
  const c = cageAt(i)
  const name = `Cage ${i + 1}`
  if (!isCage(c)) return `${name}: the disc should run across the spine. Drag its corners.`
  const tg = cageTarget(i) ?? c.deg
  return Math.round(tg) === Math.round(c.deg) ? `${name}: disc ${Math.round(c.deg)}°, slide to change` : `${name}: disc ${Math.round(c.deg)}° → ${Math.round(tg)}°`
}

/**
 * Prompt for these landmarks, one tap at a time in the usual order (caudal to cranial), then come back to the open
 * measurement's panel. `again` is a landmark that is there already and is to be placed anew: it stays until the first tap.
 */
function placeLandmarks(ids: FeatureId[], title: string, again: FeatureId | null = null) {
  openPlan()
  dropPartials()
  // A second femoral head that was skipped stays skipped until landmarks are cleared, unless it is asked for.
  const keepFh2 = skipped.has('fh2') && isComplete(doc.features, 'fh1') && !ids.includes('fh2')
  skipped.clear()
  if (keepFh2) skipped.add('fh2')
  steps = stepsFor(ids).filter((id) => id === again || !isComplete(doc.features, id))
  if (!steps.length) return refresh()
  replacing = again
  guidedTitle = title
  selected = null
  // The landmark being placed again is drawn heavier until it is replaced.
  selectedFeature = again
  tool = 'guided'
  openSheet(null)
  refresh()
}

function finishGuided() {
  dropPartials()
  tool = null
  replacing = null
  selectedFeature = null
  // Back to the measurement the prompts were for, where its value now shows.
  openSheet(panelKey ? 'guided' : 'results')
  refresh()
}

function skipStep() {
  const cur = currentStep()
  if (!cur) return
  if (doc.features[cur]) {
    pushUndo()
    delete doc.features[cur]
  }
  if (cur === replacing) replacing = null
  skipped.add(cur)
  if (!currentStep()) finishGuided()
  else refresh()
}

function defaultHeadRadius(): number {
  const F = doc.features
  if (isComplete(F, 'fh1')) return dist(F.fh1![0], F.fh1![1])
  if (isComplete(F, 's1')) return 0.7 * dist(F.s1![0], F.s1![1])
  return 0.035 * Math.max(src!.width, src!.height)
}

let lastTap = 0
function onTap(screen: Pt) {
  if (!src) return
  const p = invert(viewMat(), screen)
  const inside = p.x >= 0 && p.y >= 0 && p.x <= src.width && p.y <= src.height
  const now = performance.now()
  if (!tool) {
    if (selected !== null || selectedFeature) {
      selected = null
      selectedFeature = null
    } else if (now - lastTap < 320) fit()
    lastTap = now
    refresh()
    return
  }
  if (!inside) return
  if (tool === 'pso') {
    if ((doc.pso?.length ?? 0) >= 3) return
    pushUndo()
    ;(doc.pso ??= []).push(p)
    if (doc.pso.length === 3) {
      psoClose = 0
      showPlanAgain(true)
    }
    refresh()
    return
  }
  if (tool === 'cage') {
    if (!placingCage()) {
      // A tap on a cage's disc (or near it: a disc is a few points tall on a phone) chooses it to change.
      const i = cageNear(p, 24 / view.s)
      if (i !== null && i !== cageSel) {
        cageSel = i
        cageShown = true
        refresh()
      }
      return
    }
    const cages = cagesOf()
    const last = cages[cages.length - 1]
    const fresh = !last || last.pts.length >= 4
    const pts = fresh ? [p] : [...last.pts, p]
    // Cages may not overlap: a corner that would make this one overlap another is not placed.
    const others = otherCages(-1)
    const k = cageClash(pts, others.map((o) => o.pts))
    if (k >= 0) return toast(clashText(pts.length, others[k].n))
    pushUndo()
    const g: PlannedCage = fresh ? { pts: [] } : last
    if (fresh) (doc.cages ??= []).push(g)
    g.pts.push(p)
    if (g.pts.length === 4) {
      // Which way the patient faces is settled now, so a later landmark or guess cannot turn the cage round.
      g.facing = cageFacing(g.pts) < 0 ? -1 : 1
      showPlanAgain(false)
      cageNew = false
      cageSel = cagesOf().length - 1
    }
    refresh()
    return
  }
  if (tool === 'guided') {
    const cur = currentStep()
    if (!cur) return
    pushUndo()
    if (cur === replacing) {
      // Placed again: the first tap starts it anew, as the user's own landmark.
      doc.features[cur] = []
      if (doc.auto) delete doc.auto[cur]
      replacing = null
      selectedFeature = null
    }
    const pts = doc.features[cur] ?? (doc.features[cur] = [])
    pts.push(p)
    if (FEATURE_BY_ID[cur].kind === 'circle') {
      const r = defaultHeadRadius()
      pts.push({ x: p.x + r * Math.SQRT1_2, y: p.y - r * Math.SQRT1_2 })
    }
    if (!currentStep()) finishGuided()
    else refresh()
    return
  }
  pushUndo()
  let m = doc.measures.find((x) => x.id === activeId)
  if (!m) {
    m = { id: nextId++, kind: tool, pts: [] }
    doc.measures.push(m)
    activeId = m.id
  }
  m.pts.push(p)
  if (isDone(m)) {
    selected = m.id
    activeId = null
    tool = null
  }
  refresh()
}

function deleteMeasure(id: number) {
  pushUndo()
  doc.measures = doc.measures.filter((m) => m.id !== id)
  if (selected === id) selected = null
  if (activeId === id) activeId = null
  refresh()
}

function deleteFeature(id: FeatureId) {
  if (!doc.features[id]) return
  pushUndo()
  delete doc.features[id]
  selectedFeature = null
  refresh()
}

/** Accept an automatic guess where it is: it stops being marked as a guess. */
function keepFeature(id: FeatureId) {
  if (doc.auto?.[id] === undefined) return
  pushUndo()
  delete doc.auto[id]
  refresh()
}

// ---------------------------------------------------------------- automatic guess

/**
 * Ask the detector for its best guess and place it as ordinary landmarks, to be dragged, kept or deleted. Landmarks a person
 * placed, moved or kept are left alone; guesses from an earlier run that nobody touched are replaced. A guess asked for by
 * opening a photo waits for the detector (the photo screen says how far it is) and is not placed if the user has started
 * by hand meanwhile: then the line says that Auto is ready. One asked for with Auto is placed in any case.
 */
async function runGuess() {
  if (!src || !detector || guessing || !wanted || wanted.photo !== src) return
  const photo = src
  const want = wanted
  const d = detector
  const token = ++guessToken
  guessing = true
  guessFailure = null
  readyForAuto = false
  lineDismissed = false
  refresh()
  let stage: 'download' | 'runtime' | 'start' | 'guess' = 'start'
  try {
    if (d.kind === 'device') {
      try {
        await d.device.ready
      } catch (err) {
        stage = err instanceof NotOffered ? 'start' : d.device.failedAt === 'runtime' ? 'runtime' : d.device.failedAt === 'file' ? 'download' : 'start'
        throw err
      }
    }
    if (token !== guessToken || photo !== src) return
    if (!want.manual && handEdits !== want.edits) {
      // The user started by hand while waiting: nothing is placed for them; Auto is there when they want it.
      readyForAuto = true
      return
    }
    stage = 'guess'
    findingSince = performance.now()
    refresh()
    const rec = await requestGuess(d, photo)
    if (token !== guessToken || photo !== src) return
    const got = readLabels(rec, 0.035 * Math.max(photo.width, photo.height))
    pushUndo()
    const stale = Object.keys(doc.auto ?? {}) as FeatureId[]
    for (const id of stale) delete doc.features[id]
    doc.auto = {}
    let n = 0
    for (const f of FEATURES) {
      const pts = got.features[f.id]
      if (!pts || doc.features[f.id]) continue
      doc.features[f.id] = pts
      doc.auto[f.id] = got.confidence[f.id] ?? 0
      n++
    }
    if (!n && !stale.length) undoStack.pop() // nothing changed, so there is nothing to undo
    if (wanted === want) wanted = null
    toast(n ? `${n} landmark${n > 1 ? 's' : ''} guessed. Drag to adjust; tap one to delete it.` : 'Nothing was found to place on this photo')
  } catch (err) {
    if (token === guessToken && !(err instanceof NotOffered)) guessFailure = failureText(err, stage)
  } finally {
    if (token === guessToken) {
      guessing = false
      findingSince = null
      refresh()
    }
  }
}

/** Auto, or "Try again": a guess for the photo on screen, placed even over hand work (only where nothing is placed). After a
 *  failure the detector is looked for again (a download that stopped starts again). */
function askGuess() {
  if (!src) return
  wanted = { photo: src, edits: handEdits, manual: true }
  readyForAuto = false
  lineDismissed = false
  const failedBefore = !!guessFailure || dlFailed || !!detectorProblem || !!found?.later || !detector
  guessFailure = null
  if (failedBefore && !guessing) {
    redownloaded = false
    startFinding()
    refresh()
    return
  }
  void runGuess()
}

/** Clear one group: the basic tools' measurements, or one plane's guided landmarks. */
function clearGroup(group: 'basic' | Plane) {
  pushUndo()
  if (group === 'basic') {
    doc.measures = []
    selected = null
    activeId = null
    if (tool && tool !== 'guided' && !planTool(tool)) tool = null
  } else {
    for (const f of FEATURES) if (f.plane === group) delete doc.features[f.id]
    selectedFeature = null
    skipped.clear()
    if (tool === 'guided') tool = null
  }
  refresh()
}

function clearAll() {
  if (!doc.measures.length && !Object.keys(doc.features).length && !doc.pso && !doc.cages) return
  pushUndo()
  doc.measures = []
  doc.features = {}
  delete doc.pso
  delete doc.cages
  psoClose = 0
  cageSel = null
  cageNew = false
  reopen = null
  skipped.clear()
  tool = null
  activeId = null
  selected = null
  selectedFeature = null
  refresh()
}

// ---------------------------------------------------------------- pointer input

interface Handle {
  pts: Pt[]
  i: number
  measureId?: number
  feature?: FeatureId
  /** A cage's corner: the cage's place in doc.cages. */
  cage?: number
  /** For a cage's corner: the cage's change of angle when the drag began (target − measured), which it keeps. */
  keep?: number
  /** Where the point is drawn when it is kept at x (a plan's point, carried by the plan as shown); else where it is kept. */
  show?: (x: Pt) => Pt
}

/** Where a handle's point is drawn, in photo pixels. */
const shownAt = (h: Handle): Pt => (h.show ? h.show(h.pts[h.i]) : h.pts[h.i])

function hitHandle(screen: Pt, radius: number): Handle | null {
  const M = viewMat()
  let best: Handle | null = null
  let bestD = radius
  const consider = (h: Handle) => {
    const d = dist(apply(M, shownAt(h)), screen)
    if (d <= bestD) {
      bestD = d
      best = h
    }
  }
  // With the PSO tool out the landmarks are hidden, so only the wedge's points can be dragged (while it is open; cages
  // shown below it carry them, and a drag is carried back); while its three points go down, every tap places one (two
  // back points can be a few pixels apart).
  if (tool === 'pso') {
    if ((doc.pso?.length ?? 0) < 3 || psoClose > 0) return null
    const others = shownCuts()
    const show = (x: Pt) => moveThrough(others, x)
    doc.pso!.forEach((_, i) => consider({ pts: doc.pso!, i, show }))
    return best
  }
  // With the Cage tool out, the corners of the cage being changed, where they are drawn.
  if (tool === 'cage') {
    const i = cageSel
    const g = i === null ? undefined : cagesOf()[i]
    if (i === null || !g || g.pts.length < 4 || placingCage()) return null
    // A touch nearer another cage's disc is a tap that chooses that cage, not a drag of this one's corner.
    const near = cageNear(invert(M, screen), radius / view.s)
    if (near !== null && near !== i) return null
    const c = cageAt(i)
    const keep = isCage(c) && g.target !== undefined ? g.target - c.deg : undefined
    g.pts.forEach((_, j) => consider({ pts: g.pts, i: j, cage: i, keep, show: (x) => cornerShown(i, j, x) }))
    return best
  }
  // With the plan shown, the landmarks are drawn away from where they are kept: nothing is dragged until it is put back.
  if (shownCuts().length) return null
  for (const m of doc.measures) m.pts.forEach((_, i) => consider({ pts: m.pts, i, measureId: m.id }))
  for (const f of FEATURES) doc.features[f.id]?.forEach((_, i) => consider({ pts: doc.features[f.id]!, i, feature: f.id }))
  return best
}

function moveHandle(h: Handle, p: Pt) {
  if (h.cage !== undefined) return moveCorner(h.cage, h.i, p, h.keep)
  const old = h.pts[h.i]
  // A guess that has been moved is the user's landmark from then on.
  if (h.feature && doc.auto) delete doc.auto[h.feature]
  h.pts[h.i] = p
  // Dragging a femoral head's centre carries its rim point with it.
  if (h.feature && FEATURE_BY_ID[h.feature].kind === 'circle' && h.i === 0 && h.pts[1]) {
    h.pts[1] = { x: h.pts[1].x + p.x - old.x, y: h.pts[1].y + p.y - old.y }
  }
}

type Gesture =
  | { type: 'tap'; id: number; start: Pt }
  | { type: 'pan'; id: number; last: Pt }
  | { type: 'drag'; id: number; h: Handle; start: Pt; off: Pt; before: string; moved: boolean }
  | { type: 'pinch'; d0: number; m0: Pt; s0: number; tx0: number; ty0: number }

const pointers = new Map<number, Pt>()
let gesture: Gesture | null = null

const eventPos = (e: PointerEvent | WheelEvent): Pt => {
  const r = cvOverlay.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function showLoupe(at: Pt, finger: Pt) {
  loupeAt = at
  loupeEl.hidden = false
  // Sit top-left unless the finger is working there.
  loupeEl.classList.toggle('right', finger.x < W / 2 && finger.y < LOUPE + 70)
}

function endDrag() {
  if (gesture?.type !== 'drag') return
  if (gesture.moved && gesture.before !== snapshot()) pushUndo(gesture.before)
  loupeAt = null
  loupeEl.hidden = true
}

cvOverlay.addEventListener('pointerdown', (e) => {
  if (!src) return
  e.preventDefault()
  // A touch on the photo with the Tools chooser open only closes the chooser.
  if (!toolMenu.hidden) return showToolMenu(false)
  try {
    cvOverlay.setPointerCapture(e.pointerId)
  } catch {
    /* capture is a nicety; gestures still work without it */
  }
  const p = eventPos(e)
  pointers.set(e.pointerId, p)
  if (pointers.size === 2) {
    endDrag()
    const [a, b] = [...pointers.values()]
    gesture = { type: 'pinch', d0: Math.max(1, dist(a, b)), m0: mid(a, b), s0: view.s, tx0: view.tx, ty0: view.ty }
    refresh()
    return
  }
  if (pointers.size > 2) return
  const h = hitHandle(p, e.pointerType === 'mouse' ? 12 : 26)
  if (h) {
    const sp = apply(viewMat(), shownAt(h))
    gesture = { type: 'drag', id: e.pointerId, h, start: p, off: { x: sp.x - p.x, y: sp.y - p.y }, before: snapshot(), moved: false }
    if (!tool) {
      selected = h.measureId ?? null
      selectedFeature = h.feature ?? null
    }
    showLoupe(shownAt(h), p)
    refresh()
  } else {
    gesture = { type: 'tap', id: e.pointerId, start: p }
  }
})

cvOverlay.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !src) return
  const p = eventPos(e)
  pointers.set(e.pointerId, p)
  const g = gesture
  if (!g) return
  if (g.type === 'pinch') {
    if (pointers.size < 2) return
    const [a, b] = [...pointers.values()]
    const m = mid(a, b)
    const minS = 0.3 * Math.min(W / src.width, H / src.height)
    const s = Math.min(12, Math.max(minS, (g.s0 * dist(a, b)) / g.d0))
    const r = s / g.s0
    view.s = s
    view.tx = m.x - (g.m0.x - g.tx0) * r
    view.ty = m.y - (g.m0.y - g.ty0) * r
    requestDraw()
  } else if (g.id !== e.pointerId) {
    return
  } else if (g.type === 'drag') {
    // Ignore the small wobble of a tap so that selecting a point does not nudge it.
    if (!g.moved && dist(p, g.start) < 3) return
    g.moved = true
    let ip = invert(viewMat(), { x: p.x + g.off.x, y: p.y + g.off.y })
    // A plan's point drawn where the plan carries it is kept where that is on the photo as it is.
    if (g.h.show) ip = pullBack(g.h.show, ip, g.h.pts[g.h.i])
    ip.x = Math.min(src.width, Math.max(0, ip.x))
    ip.y = Math.min(src.height, Math.max(0, ip.y))
    moveHandle(g.h, ip)
    showLoupe(shownAt(g.h), p)
    refresh()
  } else if (g.type === 'tap') {
    if (dist(p, g.start) > 8) gesture = { type: 'pan', id: g.id, last: p }
  } else {
    view.tx += p.x - g.last.x
    view.ty += p.y - g.last.y
    g.last = p
    requestDraw()
  }
})

function pointerEnd(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return
  const g = gesture
  if (!g) return
  if (g.type === 'pinch') {
    // Carry on panning with whichever finger is still down.
    const rest = [...pointers.entries()][0]
    gesture = rest ? { type: 'pan', id: rest[0], last: rest[1] } : null
    return
  }
  if (g.id !== e.pointerId) return
  gesture = null
  if (g.type === 'drag') {
    gesture = g
    endDrag()
    gesture = null
    // With a tool armed, a tap that happens to land on an existing point (e.g. an endplate
    // already used for a Cobb angle) still places the new point there.
    if (!g.moved && tool && e.type === 'pointerup') onTap(g.start)
    else refresh()
  } else if (g.type === 'tap' && e.type === 'pointerup') {
    onTap(g.start)
  }
}
cvOverlay.addEventListener('pointerup', pointerEnd)
cvOverlay.addEventListener('pointercancel', pointerEnd)
// A tap on the photo can open a panel, or the hint, right under the finger (the last landmark of a guided measurement
// brings its panel back). The click the browser then makes from the same touch must not land on it and press a button.
cvOverlay.addEventListener('touchend', (e) => e.preventDefault(), { passive: false })

cvOverlay.addEventListener('wheel', (e) => {
  e.preventDefault()
  zoomAt(eventPos(e), Math.exp(-e.deltaY * 0.0015))
}, { passive: false })

// Stop Safari's page-level pinch and rubber-band scrolling; the sheet still scrolls.
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('touchmove', (e) => {
  // The PSO's closing slider sits in the hint bar on the photo, and needs its drag.
  if (!(e.target as Element).closest?.('#sheet, #hint input[type="range"]')) e.preventDefault()
}, { passive: false })

// ---------------------------------------------------------------- UI

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', onClick)
  return b
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** "Cobb 2" style names, numbered per tool in the order they were made. */
function measureName(m: Measure): string {
  const n = doc.measures.filter((x) => x.kind === m.kind && x.id <= m.id).length
  return `${TOOL_NAME[m.kind]} ${n}`
}

function updateHint() {
  const hint = $('hint')
  const actions = $('hint-actions')
  if (planSliding && planTool(tool)) {
    const w = wedge()
    if (tool === 'pso' && isWedge(w)) $('hint-text').textContent = psoText(w)
    if (tool === 'cage' && cageSel !== null && cagesOf()[cageSel]) $('hint-text').textContent = cageText(cageSel)
    return
  }
  actions.replaceChildren()
  const more = $('hint-more')
  more.replaceChildren()
  hint.classList.remove('two', 'more')
  let text = ''
  if (src && tool === 'guided') {
    const cur = currentStep()
    if (cur) {
      const def = FEATURE_BY_ID[cur]
      const n = cur === replacing ? 0 : doc.features[cur]?.length ?? 0
      text = `${guidedTitle} ${steps.indexOf(cur) + 1}/${steps.length} · ${def.name}: ${def.prompts[Math.min(n, def.prompts.length - 1)]}`
      actions.append(button('Skip', skipStep), button('Done', finishGuided))
    }
  } else if (src && tool === 'pso') {
    const n = doc.pso?.length ?? 0
    const w = wedge()
    if (n < 3) {
      text = `PSO ${n + 1}/3: ${PSO_PROMPTS[n]}`
      actions.append(button('Cancel', armPso))
    } else if (!isWedge(w)) {
      text = w === 'thin' ? 'PSO: the two cuts lie on one line. Drag a back point.' : 'PSO: the wedge should open towards the back. Put the hinge at the front, both back points behind it.'
      actions.append(button('Remove', removePso, 'danger'), button('Done', finishPlan))
    } else {
      text = psoText(w)
      psoSlider.value = String(Math.round(psoClose * 100))
      actions.append(psoSlider, button('Done', finishPlan))
    }
  } else if (src && tool === 'cage') {
    const cages = cagesOf()
    const i = cageSel
    if (placingCage()) {
      const last = cages[cages.length - 1]
      const part = !!last && last.pts.length < 4
      const n = part ? last.pts.length : 0
      const num = part ? cages.length : cages.length + 1
      text = num === 1 ? `Cage ${n + 1}/4: ${CAGE_PROMPTS[n]}` : `Cage ${num} · ${n + 1}/4: ${CAGE_PROMPTS[n]}`
      actions.append(button('Cancel', cancelCage))
    } else if (i === null || !cages[i]) {
      text = 'Cage: tap a cage to change it, or add another'
      actions.append(button('Add', addCage), button('Done', finishPlan))
    } else {
      const c = cageAt(i)
      text = cageText(i)
      hint.classList.add('two', 'more')
      more.append(button('Add', addCage), button('Delete', () => removeCage(i), 'danger'))
      if (isCage(c)) {
        const tg = Math.round(cageTarget(i) ?? c.deg)
        cageSlider.min = String(Math.min(-10, Math.round(c.deg) - 10))
        cageSlider.max = String(Math.max(40, Math.round(c.deg) + 10))
        cageSlider.value = String(tg)
        actions.append(button('−', () => stepCage(-1), 'step'), cageSlider, button('+', () => stepCage(1), 'step'), button('Done', finishPlan))
      } else {
        actions.append(button('Done', finishPlan))
      }
    }
  } else if (src && tool && !planTool(tool) && tool !== 'guided') {
    const n = doc.measures.find((m) => m.id === activeId)?.pts.length ?? 0
    text = `${TOOL_NAME[tool]} ${n + 1}/${NEED[tool]}: ${FREE_PROMPTS[tool][n]}`
    const kind = tool
    actions.append(button('Cancel', () => armTool(kind)))
  } else if (src && selected !== null) {
    const m = doc.measures.find((x) => x.id === selected)
    if (m) {
      const id = m.id
      text = `${measureName(m)}: ${measureText(m, doc.tilt) ?? ''}`
      actions.append(button('Delete', () => deleteMeasure(id), 'danger'))
    }
  } else if (src && selectedFeature && doc.features[selectedFeature]) {
    const id = selectedFeature
    const guessed = doc.auto?.[id] !== undefined
    text = `${FEATURE_BY_ID[id].name} landmark${guessed ? ' (automatic guess)' : ''}`
    if (guessed) actions.append(button('Keep', () => keepFeature(id)))
    actions.append(button('Delete', () => deleteFeature(id), 'danger'))
  } else if (src && focus) {
    const r = sagittal().results.find((x) => x.key === focus)
    if (r) {
      text = `Showing only ${r.label}: ${formatValue(r)}`
      actions.append(button('Show all', () => {
        focus = null
        refresh()
      }))
    }
  }
  $('hint-text').textContent = text
  hint.hidden = !text
}

/** Section heading with its own Clear button. */
function sectionHead(title: string, onClear: (() => void) | null): HTMLElement {
  const head = el('div', 'sec')
  head.append(el('h3', '', title))
  if (onClear) head.append(button('Clear', onClear))
  return head
}

function renderResults() {
  const body = $('results-body')
  body.replaceChildren()
  const done = doc.measures.filter(isDone)
  if (done.length) {
    body.append(sectionHead('Measurements', () => clearGroup('basic')))
    for (const m of done) {
      const row = el('div', 'res' + (m.id === selected ? ' sel' : ''))
      const name = el('div', 'name', measureName(m))
      name.style.color = colorFor(m.id)
      const id = m.id
      row.append(name, el('div', 'val', measureText(m, doc.tilt) ?? ''), button('✕', () => deleteMeasure(id)))
      body.append(row)
    }
  }
  const sag = sagittal()
  if (plane === 'sagittal' && hasPlan()) renderPlan(body, sag)
  const shown = sag.results.filter((r) => r.plane === plane)
  const hasLandmarks = FEATURES.some((f) => f.plane === plane && doc.features[f.id])
  body.append(sectionHead(plane === 'sagittal' ? 'Sagittal parameters' : 'Coronal parameters', hasLandmarks ? () => clearGroup(plane) : null))
  if (!shown.length) {
    body.append(el('div', 'empty-note', 'None yet. Tap a measurement below to see the landmarks it needs.'))
  }
  for (const r of shown) {
    const row = el('div', 'res tap' + (r.key === focus ? ' sel' : ''))
    row.addEventListener('click', () => {
      focus = focus === r.key ? null : r.key
      selected = null
      refresh()
    })
    const name = el('div', 'name', `${r.label}`)
    if (r.note) name.append(el('small', '', r.note))
    row.append(name, el('div', 'val', formatValue(r)), el('span', ''))
    body.append(row)
  }
  renderNotYet(body, shown.length > 0)
  // Facing and age only apply to the sagittal parameters.
  $('btn-facing').hidden = plane !== 'sagittal'
  $('age-wrap').hidden = plane !== 'sagittal'
  $('btn-facing').textContent = `Facing ${sag.facing > 0 ? 'right' : 'left'}${facingOverride ? '' : ' (auto)'}`
}

/** The measures a plan is judged by: always listed when they can be measured. */
const PLAN_KEYS = ['LL', 'L4S1', 'PI-LL', 'L1PA', 'T4PA', 'TPA']
/** The pelvis's own measures, which the plan holds still. */
const PELVIS_KEYS = ['PI', 'PT', 'SS']

interface PlanStep {
  name: string
  value: string
  remove: () => void
  /** Its tool, with this step to change. */
  edit: () => void
}

/** The plan's steps, each with what it does, a way to change it and a way to take it out. */
function planSteps(): PlanStep[] {
  const out: PlanStep[] = []
  const w = wedge()
  if (isWedge(w)) out.push({ name: 'PSO wedge', value: `${w.deg.toFixed(1)}°`, remove: removePso, edit: () => editPlan('pso') })
  cagesOf().forEach((_, i) => {
    const c = cageAt(i)
    if (!isCage(c)) return
    out.push({
      name: `Cage ${i + 1}: disc angle`, value: `${c.deg.toFixed(1)}° → ${(cageTarget(i) ?? c.deg).toFixed(1)}°`,
      remove: () => removeCage(i), edit: () => editPlan(i),
    })
  })
  return out
}

/** What the whole plan does: each sagittal measure before and after it (those it leaves alone are skipped). */
function planChanges(before = sagittal()): { before: Result; after: Result }[] {
  const after = sagittalWith(plannedCuts())
  const out: { before: Result; after: Result }[] = []
  for (const b of before.results) {
    if (b.plane !== 'sagittal' || PELVIS_KEYS.includes(b.key)) continue
    const a = after.results.find((r) => r.key === b.key)
    if (!a || (!PLAN_KEYS.includes(b.key) && Math.abs(a.value - b.value) < 0.05)) continue
    out.push({ before: b, after: a })
  }
  return out
}

/** Results' plan section: each step, then each measure before and after the whole plan. */
function renderPlan(body: HTMLElement, before: ReturnType<typeof compute>) {
  body.append(sectionHead('Plan', removePlan))
  for (const s of planSteps()) {
    // Tapped, the step's tool comes out to change it; its ✕ takes it out.
    const row = el('div', 'res plan tap')
    row.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('button')) s.edit()
    })
    row.append(el('div', 'name', s.name), el('div', 'val', s.value), button('✕', s.remove))
    body.append(row)
  }
  const changes = planChanges(before)
  for (const { before: b, after: a } of changes) {
    const r = el('div', 'res plan')
    const name = el('div', 'name', b.label)
    const d = a.value - b.value
    name.append(el('small', '', `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(b.unit === '%' ? 0 : 1)}${b.unit}`))
    r.append(name, el('div', 'val', `${formatValue(b)} → ${formatValue(a)}`), el('span', ''))
    body.append(r)
  }
  body.append(el('div', 'empty-note', changes.length
    ? 'After the whole plan: everything above each cut turns about its hinge; the pelvis stays where it is. The image shows the plan as far as it is shown.'
    : 'Place S1 and L1 (Guided) to see what the plan does to lordosis; the femoral heads too for PI − LL and the pelvic angles.'))
}

/** What the Share footer says about the plan, or nothing without one. */
function planNote(): string | undefined {
  const parts: string[] = []
  const w = wedge()
  if (isWedge(w)) parts.push(`PSO ${Math.round(w.deg)}° ${psoClose >= 1 ? 'closed' : psoClose > 0 ? `${Math.round(psoClose * 100)}% closed` : 'open'}`)
  const many = cagesOf().length > 1
  cagesOf().forEach((_, i) => {
    const c = cageAt(i)
    const tg = cageTarget(i)
    if (isCage(c) && tg !== null) {
      parts.push(`${many ? `cage ${i + 1} ` : ''}disc ${Math.round(c.deg)}° → ${Math.round(tg)}°${cageShown ? '' : ' (not shown)'}`)
    }
  })
  return parts.length ? `Plan: ${parts.join('; ')}. Values as shown.` : undefined
}

/** The state of a guided measurement with the current landmarks (shared by the list, the panel and Results). */
const stateOf = (def: MeasureDef): MeasureState => measureState(def, doc.features, doc.auto, skipped)
const planeOf = (def: MeasureDef): Plane => FEATURE_BY_ID[def.needs[0]].plane

const STATUS_WORDS: Record<NeedState['status'], string> = {
  placed: 'placed', guessed: 'guessed, not checked', missing: 'not placed', skipped: 'skipped',
}
const needWords = (n: NeedState) => STATUS_WORDS[n.status] + (n.optional && n.status !== 'placed' && n.status !== 'guessed' ? ' · optional' : '')

/**
 * A landmark's tag, as drawn on the image, in its state: placed (filled), guessed and not checked (outlined, with a question
 * mark), or not placed (hollow, dashed outline); a skipped one is struck through.
 */
function tagEl(n: NeedState): HTMLElement {
  const f = FEATURE_BY_ID[n.id]
  const t = el('span', `tag ${n.status} k-${f.kind}`, n.status === 'guessed' ? `${f.tag}?` : f.tag)
  t.title = `${f.short}: ${needWords(n)}`
  return t
}

const chevron = () => el('span', 'chev', '›')

/** One measurement in the Guided list: its name, its value or what it still needs, and its landmarks' tags. */
function measureRow(def: MeasureDef, values: Map<string, Result>): HTMLElement {
  const st = stateOf(def)
  const r = values.get(def.key)
  const row = button('', () => openPanel(def.key, 'guided'), 'mrow')
  row.dataset.key = def.key
  const all = st.needs.every((n) => n.status !== 'missing')
  const status = def.set
    ? el('span', st.measured ? 'mrow-val small' : 'mrow-need', st.measured ? (all ? 'all placed' : '') : needsText(st))
    : r ? el('span', 'mrow-val', formatValue(r)) : el('span', 'mrow-need', needsText(st))
  const tags = el('span', 'tags')
  if (def.set) {
    const have = st.needs.filter((n) => n.status === 'placed' || n.status === 'guessed').length
    tags.append(el('span', 'count', `${have} of ${st.needs.length} landmarks placed`))
  } else {
    for (const n of st.needs) tags.append(tagEl(n))
  }
  row.append(el('span', 'mrow-name', def.label), status, tags, chevron())
  row.setAttribute('aria-label', `${def.name}: ${r ? formatValue(r) : status.textContent || tags.textContent}`)
  return row
}

function renderGuided() {
  const def = panelKey ? MEASURE_BY_KEY[panelKey] : undefined
  if (panelKey && (!def || planeOf(def) !== plane)) panelKey = null
  $('guided-list').hidden = !!panelKey
  $('guided-panel').hidden = !panelKey
  $('plane-tabs').hidden = !!panelKey
  if (panelKey && def) return renderPanel(def)
  const body = $('guided-body')
  body.replaceChildren()
  const values = new Map(sagittal().results.map((r) => [r.key, r]))
  for (const group of MEASURE_GROUPS.filter((g) => g.plane === plane)) {
    body.append(el('h3', '', group.title))
    const list = el('div', 'mlist')
    for (const item of group.items) list.append(measureRow(item, values))
    body.append(list)
  }
  $('guided-note').textContent =
    plane === 'sagittal'
      ? 'On each endplate tap the anterior corner first. Landmarks already placed are reused.'
      : 'Tap the two ends of each line in either order. Level the photo first (Adjust): pelvic obliquity and T1 tilt are measured against horizontal.'
}

/** A measurement's own panel: its value, the landmarks it needs with their state, and a way to place what is missing. */
function renderPanel(def: MeasureDef) {
  const box = $('guided-panel')
  box.replaceChildren()
  const st = stateOf(def)
  const r = sagittal().results.find((x) => x.key === def.key)
  const head = el('div', 'p-head')
  const back = button('‹', closePanel, 'back')
  back.title = panelFrom === 'results' ? 'Back to Results' : 'Back to all measurements'
  back.setAttribute('aria-label', back.title)
  const title = el('div', 'p-title')
  title.append(el('h2', '', def.name))
  if (def.label !== def.name) title.append(el('span', 'p-key', def.label))
  head.append(back, title)
  box.append(head)
  if (r) {
    const v = el('div', 'p-val', formatValue(r))
    if (r.note) v.append(el('small', '', r.note))
    box.append(v)
  } else {
    box.append(el('p', 'p-status', def.set && st.measured ? 'Every landmark it needs is placed.' : `Not measured yet: it ${needsText(st)}.`))
  }
  if (!st.measured) {
    const n = st.toPlace.length
    const label = n === 1 ? 'Place the missing landmark' : `Place the ${n} missing landmarks`
    box.append(button(label, () => placeLandmarks(st.toPlace, def.label), 'primary wide main'))
  } else if (!def.set && r) {
    const on = focus === def.key
    box.append(button(on ? 'Show all measurements' : 'Show on the image', () => {
      focus = on ? null : def.key
      selected = null
      selectedFeature = null
      refresh()
    }, 'wide main' + (on ? ' on' : '')))
  }
  box.append(el('h3', '', 'Landmarks it needs'))
  const list = el('div', 'lms')
  for (const n of st.needs) {
    const f = FEATURE_BY_ID[n.id]
    const present = n.status === 'placed' || n.status === 'guessed'
    const line = el('div', 'lm' + (present ? ' stack' : '') + (selectedFeature === n.id ? ' sel' : ''))
    line.dataset.id = n.id
    const info = el('div', 'lm-info')
    const name = el('div', 'lm-name')
    name.append(tagEl(n), el('span', '', f.short))
    info.append(name, el('div', `lm-state ${n.status}`, needWords(n)))
    const acts = el('div', 'lm-acts')
    if (present) {
      acts.append(button('Show', () => showFeature(n.id)))
      if (n.status === 'guessed') acts.append(button('Keep', () => keepFeature(n.id)))
      acts.append(button('Place again', () => placeLandmarks([n.id], def.label, n.id)))
    } else {
      acts.append(button('Place', () => placeLandmarks([n.id], def.label)))
    }
    line.append(info, acts)
    list.append(line)
  }
  box.append(list)
  if (st.needs.some((n) => n.status === 'guessed')) {
    box.append(el('p', 'fine', 'A question mark means the automatic guess placed it and nobody has checked it: Show it, then drag it into place, Keep it, or Place it again.'))
  }
}

function openPanel(key: string, from: 'guided' | 'results') {
  if (sheet === 'guided' && !panelKey) listScroll = $('sheet').scrollTop
  panelKey = key
  panelFrom = from
  openSheet('guided')
  refresh()
  $('sheet').scrollTop = 0
}

function closePanel() {
  const from = panelFrom
  panelKey = null
  openSheet(from)
  refresh()
  $('sheet').scrollTop = from === 'guided' ? listScroll : 0
}

/** Results: the current plane's measurements that have no value yet, each with what it needs; one opens its panel. */
function renderNotYet(body: HTMLElement, anyShown: boolean) {
  const left = MEASURE_GROUPS.filter((g) => g.plane === plane).flatMap((g) => g.items)
    .filter((d) => !d.set).map(stateOf).filter((x) => !x.measured)
  if (!left.length) return
  const open = notYetOpen ?? !anyShown
  const head = button('', () => {
    notYetOpen = !open
    refresh()
  }, 'notyet-head')
  head.setAttribute('aria-expanded', String(open))
  head.append(el('span', '', `Not measured yet (${left.length})`), el('span', 'chev' + (open ? ' open' : ''), '›'))
  body.append(head)
  if (!open) return
  const list = el('div', 'mlist notyet')
  for (const x of left) {
    const row = button('', () => openPanel(x.def.key, 'results'), 'mrow compact')
    row.dataset.key = x.def.key
    row.append(el('span', 'mrow-name', x.def.label), el('span', 'mrow-need', needsText(x)), chevron())
    row.setAttribute('aria-label', `${x.def.name}: ${needsText(x)}`)
    list.append(row)
  }
  body.append(list)
}

function openSheet(id: SheetId | null) {
  sheet = id
  $('sheet').hidden = !id
  for (const s of ['adjust', 'guided', 'results'] as const) $(`sheet-${s}`).hidden = s !== id
  // A measurement's own panel belongs to one plane, so the switch is shown with the list only.
  $('plane-tabs').hidden = !(id === 'results' || (id === 'guided' && !panelKey))
}

function toggleSheet(id: SheetId) {
  if (id !== 'results' && !src) return toast('Choose a photo first')
  openSheet(sheet === id ? null : id)
  refresh()
}

function refresh() {
  // An isolated result that no longer exists (landmark cleared or undone) stops being isolated.
  if (focus && !sagittal().results.some((r) => r.key === focus)) focus = null
  if (selectedFeature && !doc.features[selectedFeature]) selectedFeature = null
  // A landmark that is gone is no longer anybody's guess.
  if (doc.auto) for (const id of Object.keys(doc.auto) as FeatureId[]) if (!doc.features[id]) delete doc.auto[id]
  updateHint()
  const has = !!src
  showGuessState()
  $<HTMLButtonElement>('btn-undo').disabled = !undoStack.length
  for (const id of ['btn-adjust', 'btn-clear', 'btn-share']) $<HTMLButtonElement>(id).disabled = !has
  $('btn-adjust').classList.toggle('on', sheet === 'adjust')
  document.querySelectorAll<HTMLElement>('#tools [data-tool]').forEach((b) => {
    const t = b.dataset.tool
    b.classList.toggle('on', t === tool || (t === 'guided' && sheet === 'guided'))
  })
  $('btn-results').classList.toggle('on', sheet === 'results')
  $('btn-tools').classList.toggle('on', !toolMenu.hidden || tool === 'cobb' || tool === 'angle3' || tool === 'slope')
  document.querySelectorAll<HTMLElement>('#plane-tabs [data-plane]').forEach((b) => b.classList.toggle('on', b.dataset.plane === plane))
  $('empty').hidden = has
  if (sheet === 'results') renderResults()
  if (sheet === 'guided') renderGuided()
  requestDraw()
}

let toastTimer = 0
function toast(msg: string) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (t.hidden = true), 2400)
}

function applyTone() {
  const css = toneCss(tone)
  cvImage.style.filter = css
  cvLoupeImage.style.filter = css
}

function syncAdjustInputs() {
  $<HTMLInputElement>('in-brightness').value = String(tone.brightness)
  $<HTMLInputElement>('in-contrast').value = String(tone.contrast)
  $<HTMLInputElement>('in-tilt').value = String(doc.tilt)
  $('out-tilt').textContent = `${doc.tilt.toFixed(1)}°`
  $('btn-invert').classList.toggle('on', tone.invert)
  applyTone()
}

// ---------------------------------------------------------------- photo

async function openPhoto(file: Blob) {
  const hasWork = doc.measures.length > 0 || Object.keys(doc.features).length > 0 || !!doc.pso || !!doc.cages
  if (src && hasWork && !confirm('Replace the current photo and its measurements?')) return
  try {
    src = await loadPhoto(file)
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not open that image')
    return
  }
  doc = { measures: [], features: {}, tilt: 0 }
  undoStack = []
  tone = { brightness: 1, contrast: 1, invert: false }
  tool = null
  psoClose = 0
  cageShown = true
  cageSel = null
  cageNew = false
  reopen = null
  activeId = null
  selected = null
  selectedFeature = null
  facingOverride = 0
  // Age belongs to the previous patient; leaving it would apply their age targets to this one.
  age = undefined
  $<HTMLInputElement>('in-age').value = ''
  steps = []
  replacing = null
  panelKey = null
  skipped.clear()
  openSheet(null)
  syncAdjustInputs()
  refresh()
  // The stage may have changed size when the sheet closed; fit after layout settles.
  requestAnimationFrame(() => {
    resize()
    fit()
  })
  // A reply still on its way belongs to the previous photo.
  guessToken++
  guessing = false
  findingSince = null
  guessFailure = null
  readyForAuto = false
  lineDismissed = false
  wanted = found?.off ? null : { photo: src, edits: handEdits, manual: false }
  if (detector) void runGuess()
  refresh()
}

function transformPhoto(next: HTMLCanvasElement, map: (p: Pt) => Pt) {
  src = next
  for (const m of doc.measures) m.pts = m.pts.map(map)
  for (const f of FEATURES) if (doc.features[f.id]) doc.features[f.id] = doc.features[f.id]!.map(map)
  if (doc.pso) doc.pso = doc.pso.map(map)
  for (const g of cagesOf()) g.pts = g.pts.map(map)
  // Earlier snapshots refer to the old orientation.
  undoStack = []
  fit()
  refresh()
}

const fileInput = $<HTMLInputElement>('file')
const pickPhoto = () => fileInput.click()
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  fileInput.value = ''
  if (f) void openPhoto(f)
})
$('btn-open').addEventListener('click', pickPhoto)
$('btn-open-big').addEventListener('click', pickPhoto)

document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
  if (f) void openPhoto(f)
})
stage.addEventListener('dragover', (e) => e.preventDefault())
stage.addEventListener('drop', (e) => {
  e.preventDefault()
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'))
  if (f) void openPhoto(f)
})

// ---------------------------------------------------------------- wiring

// Swipe a bottom panel down to dismiss it (or tap its handle).
{
  const sheetEl = $('sheet')
  let startY = 0
  let startT = 0
  let dy = 0
  let tracking = false
  let dragging = false

  const closeSheet = () => {
    sheetEl.style.transition = 'transform 0.16s ease-in'
    sheetEl.style.transform = 'translateY(100%)'
    window.setTimeout(() => {
      sheetEl.style.transition = ''
      sheetEl.style.transform = ''
      openSheet(null)
      refresh()
    }, 160)
  }

  $('sheet-grab').addEventListener('click', closeSheet)

  sheetEl.addEventListener('touchstart', (e) => {
    const t = e.target as HTMLElement
    // Sliders and text fields keep their own gestures; a scrolled list scrolls first.
    tracking = e.touches.length === 1 && !t.closest('input') && (sheetEl.scrollTop <= 0 || !!t.closest('#sheet-grab'))
    dragging = false
    dy = 0
    startY = e.touches[0].clientY
    startT = performance.now()
  }, { passive: true })

  sheetEl.addEventListener('touchmove', (e) => {
    if (!tracking) return
    dy = e.touches[0].clientY - startY
    if (!dragging) {
      if (dy < -6) tracking = false // moving up: let the list scroll
      if (dy < 8) return
      dragging = true
      sheetEl.style.transition = ''
    }
    e.preventDefault()
    sheetEl.style.transform = `translateY(${Math.max(0, dy)}px)`
  }, { passive: false })

  const end = () => {
    if (!dragging) return
    dragging = false
    tracking = false
    const fast = dy > 24 && dy / (performance.now() - startT) > 0.5
    if (dy > 70 || fast) return closeSheet()
    sheetEl.style.transition = 'transform 0.16s ease-out'
    sheetEl.style.transform = ''
  }
  sheetEl.addEventListener('touchend', end)
  sheetEl.addEventListener('touchcancel', end)
}

$('btn-undo').addEventListener('click', undo)
$('btn-auto').addEventListener('click', askGuess)

// ---------------------------------------------------------------- finding a detector

const CANNOT_RUN = 'Automatic landmark guess: it cannot run in this browser. Measure with the tools as usual.'
const PRIVACY = $('note-privacy').textContent ?? ''

const hostOf = (base: string) => {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`
/** The built-in detector, or the slower way's files, still downloading. */
const downloading = () => found?.published?.from === 'download' && !detectorReady && dlTotal > 0 && dlGot < dlTotal
const runtimeDownloading = () => detector?.kind === 'device' && detector.device.stage === 'runtime' && rtTotal > 0 && rtGot < rtTotal
/** Why the slower way: known from its start (while its files download), then from what it said when ready. */
const slowerReason = () => slower?.why ?? (detector?.kind === 'device' ? detector.device.why : null)
const slowerWhy = () => (slowerReason() === 'engine-failed' ? "this device's graphics chip did not pass the detector's check" : 'this browser has no WebGPU')

/** Say on the start screen what the automatic guess is doing, in plain words, with its one switch. */
function showDetector() {
  const d = detector
  const off = !!found?.off
  const size = mb(found?.published?.bytes || dlTotal || 13e6)
  let text: string
  if (off) text = 'Automatic landmark guess: off.'
  else if (d?.kind === 'device') {
    if (downloading()) text = `Automatic landmark guess: downloading the landmark detector, ${ofMB(dlGot, dlTotal)}. This happens once; it is then kept on this device.`
    else if (runtimeDownloading()) text = `Automatic landmark guess: ${slowerWhy()}, so the app is downloading what the slower way needs, ${ofMB(rtGot, rtTotal)}. This happens once.`
    else if (!detectorReady) text = d.device.stage === 'runtime' || d.device.stage === 'processor' ? 'Automatic landmark guess: getting the slower way ready…' : 'Automatic landmark guess: getting ready…'
    else if (slower) text = `Automatic landmark guess: on, the slower way: ${slowerWhy()}. A photo takes about ${slower.perPhotoS ?? 'ten'} seconds.`
    else if (d.from === 'added') text = 'Automatic landmark guess: on, with your own detector file.'
    else if (keptHere === false) text = 'Automatic landmark guess: on. This browser does not let the app keep the landmark detector, so it is downloaded again each time the app opens.'
    else text = 'Automatic landmark guess: on.'
  } else if (notOffered) text = CANNOT_RUN
  else if (detectorProblem) text = detectorProblem
  else if (dlFailed) text = 'Automatic landmark guess: the landmark detector could not be downloaded. The app tries again the next time it opens.'
  else if (found?.later) text = `Automatic landmark guess: the landmark detector (${size}) will be downloaded the next time the app opens with a connection.`
  else if (d?.kind === 'service') text = `Automatic landmark guess: on, from the detector at ${hostOf(d.base)}.`
  else if (looking) text = 'Automatic landmark guess: getting ready…'
  else text = 'Automatic landmark guess: off.'
  $('auto-text').textContent = text
  const toggle = $<HTMLButtonElement>('btn-auto-toggle')
  // One switch: off stops the download and removes the kept copy; on fetches it again. Nothing to switch where nothing can run.
  toggle.hidden = !off && !d && !dlFailed && !found?.later && !detectorProblem
  toggle.textContent = off ? 'Turn on' : 'Turn off'
  const bar = $('auto-bar')
  const dl = downloading() ? [dlGot, dlTotal] : runtimeDownloading() ? [rtGot, rtTotal] : null
  bar.hidden = !(d?.kind === 'device' && dl)
  ;(bar.querySelector('.fill') as HTMLElement).style.width = dl ? `${Math.round((100 * dl[0]) / dl[1])}%` : '0'
  $('faster').hidden = !(d?.kind === 'device' && detectorReady && slower)
  $('btn-detector-add').hidden = detectorAdded
  $('btn-detector-remove').hidden = !detectorAdded
  $('own-text').textContent = detectorAdded
    ? 'Your own detector file is kept on this device and used instead of the built-in one.'
    : 'If you have a detector file of your own, add it here. It is kept on this device and used instead of the built-in one.'
  $('note-privacy').textContent =
    d?.kind === 'device' ? 'Automatic guess is on: it is worked out on this device, and your photo is sent nowhere.'
      : d?.kind === 'service' ? `Automatic guess is on: each photo you open is sent to the detector at ${hostOf(d.base)} to find landmarks, and nowhere else.`
      : PRIVACY
}

/** The photo screen's line about the automatic guess, and the Auto button, from the state above (waiting.ts). */
function showGuessState() {
  const d = detector
  const dl = downloading() ? { what: 'detector' as const, got: dlGot, total: dlTotal } : runtimeDownloading() ? { what: 'runtime' as const, got: rtGot, total: rtTotal } : null
  const v = guessView({
    wanted: !!src && !!wanted && wanted.photo === src,
    off: !!found?.off,
    looking,
    kind: d?.kind ?? null,
    stage: d?.kind === 'device' ? (detectorReady ? 'ready' : d.device.stage) : null,
    download: dl,
    slower: d?.kind === 'device' && (slower || d.device.stage === 'runtime' || d.device.stage === 'processor') ? slower ?? { why: slowerReason(), perPhotoS: null } : null,
    finding: findingSince === null ? null : (performance.now() - findingSince) / 1000,
    byHand: !!wanted && !wanted.manual && handEdits !== wanted.edits,
    readyForAuto,
    failed: guessFailure ?? (src && wanted && !d && !looking && !notOffered && (dlFailed || detectorProblem || found?.later)
      ? dlFailed ? failureText(null, 'download') : detectorProblem ?? `Automatic guess: the landmark detector will be downloaded the next time there is a connection.`
      : null),
    cannotRun: notOffered && !d,
    dismissed: lineDismissed,
  })
  const line = $('wait-line')
  line.hidden = !v.line
  if (v.line) {
    $('wait-text').textContent = v.line.text
    $('wait-bar').hidden = v.line.progress === null
    ;($('wait-bar').querySelector('.fill') as HTMLElement).style.width = `${v.line.progress ?? 0}%`
    $('btn-wait-retry').hidden = !v.line.retry
    $('btn-wait-close').hidden = !v.line.dismiss
  }
  stage.style.setProperty('--wait-h', v.line ? `${line.offsetHeight + 8}px` : '0px')
  const auto = $<HTMLButtonElement>('btn-auto')
  auto.hidden = v.auto.hidden || !src
  auto.disabled = v.auto.disabled || !src
  auto.textContent = v.auto.label
  // how far its download is, filled behind the label
  // busy, not dead: the guess is on its way (not dimmed like a button that does nothing)
  auto.classList.toggle('busy', v.auto.disabled && !v.auto.hidden && v.auto.label !== 'Auto')
  auto.style.background = v.auto.progress === null ? '' : `linear-gradient(to right, rgba(255, 213, 74, 0.45) ${v.auto.progress}%, var(--panel-2) ${v.auto.progress}%)`
}

// While a guess runs the slower way, its seconds count on the photo screen.
setInterval(() => {
  if (findingSince !== null && slower) showGuessState()
}, 500)

/** Use what was found. A detector whose engine cannot run here gives way to a detector service, if the user runs one. */
function useDetector(f: Found) {
  if (detector !== f.detector) endDetector(detector)
  found = f
  looking = false
  detector = f.detector
  notOffered = f.notOffered
  detectorAdded = f.added
  detectorProblem = null
  detectorReady = false
  dlFailed = false
  keptHere = null
  slower = null
  const d = detector
  if (d?.kind === 'device') {
    f.published?.kept.then((k) => {
      if (detector !== d) return
      keptHere = k
      showDetector()
    })
    // the start's stages (the slower way's files, its start) are shown as they come
    const watching = setInterval(() => {
      if (detector !== d || detectorReady || d.device.stage === 'failed') return clearInterval(watching)
      showDetector()
      showGuessState()
    }, 400)
    d.device.ready.then((info) => {
      if (detector !== d) return
      detectorReady = true
      slower = info.how === 'processor' ? { why: info.why, perPhotoS: info.perPhotoS } : null
      showDetector()
      refresh()
    }, async (err) => {
      if (detector !== d) return
      detector = null
      if (err instanceof NotOffered) notOffered = true
      else if (err instanceof DetectorFileError && f.published?.from === 'store' && !redownloaded) {
        // The copy kept on this device is damaged: it is removed and the detector downloaded again, once.
        redownloaded = true
        await dropPublished()
        return startFinding()
      } else if (err instanceof DetectorFileError) detectorProblem = err.message
      else if (d.device.failedAt === 'file' && f.published?.from === 'download') dlFailed = true
      else detectorProblem = failureText(err, d.device.failedAt === 'runtime' ? 'runtime' : 'start')
      showDetector()
      refresh()
      const base = await findService()
      if (base && detector === null) {
        detector = { kind: 'service', base }
        showDetector()
        refresh()
      }
    })
  }
  showDetector()
  refresh()
  // A photo that opened before the detector was known gets its guess now.
  if (detector && src && wanted && wanted.photo === src) void runGuess()
}

let redownloaded = false
let finding: AbortController | null = null
let shownMb = -1
/** Look for a detector (and download the built-in one if it is not kept here yet), in the background. */
function startFinding() {
  finding?.abort()
  const ctl = (finding = new AbortController())
  dlGot = dlTotal = rtGot = rtTotal = 0
  looking = true
  showDetector()
  void findDetector({
    signal: ctl.signal,
    progress: (got, total, what) => {
      if (finding !== ctl) return
      if (what === 'runtime') {
        rtGot = got
        rtTotal = total
      } else {
        dlGot = got
        dlTotal = total
      }
      const now = Math.floor(got / 2.5e5)
      if (now === shownMb && got < total) return
      shownMb = now
      showDetector()
      showGuessState()
    },
  }).then((f) => {
    if (finding === ctl) useDetector(f)
  })
}

// The built-in detector is fetched once, in the background, and kept on this device; later openings read it from there.
startFinding()

$('btn-auto-toggle').addEventListener('click', async () => {
  if (found?.off) {
    await setGuessOff(false)
    toast('Automatic guess turned on')
    startFinding()
    return
  }
  finding?.abort()
  finding = null
  endDetector(detector)
  detector = null
  guessToken++
  guessing = false
  findingSince = null
  wanted = null
  await setGuessOff(true)
  useDetector({ detector: null, notOffered: false, added: detectorAdded, off: true, published: null, later: false, gpu: true })
  toast('Automatic guess turned off. What it had downloaded was removed from this device.')
})
$('btn-wait-retry').addEventListener('click', askGuess)
$('btn-wait-close').addEventListener('click', () => {
  lineDismissed = true
  refresh()
})

const detectorInput = $<HTMLInputElement>('detector-file')
$('btn-detector-add').addEventListener('click', () => detectorInput.click())
detectorInput.addEventListener('change', async () => {
  const f = detectorInput.files?.[0]
  detectorInput.value = ''
  if (!f) return
  try {
    const got = await addDetectorFile(f)
    finding?.abort()
    finding = null
    const base = { notOffered: false, added: true, off: false, published: null, later: false, gpu: true }
    useDetector({ ...base, detector: got.detector })
    toast(got.kept ? 'Detector file added and kept on this device.' : 'Detector file added for this session only: this browser would not keep it.')
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That file could not be used.')
  }
})
$('btn-detector-remove').addEventListener('click', async () => {
  if (!confirm('Remove your detector file from this device? The app goes back to its built-in detector.')) return
  await removeDetectorFile()
  endDetector(detector)
  detector = null
  detectorAdded = false
  startFinding()
  toast('Your detector file was removed')
})
$('btn-clear').addEventListener('click', clearAll)
$('btn-adjust').addEventListener('click', () => toggleSheet('adjust'))
$('btn-results').addEventListener('click', () => toggleSheet('results'))

document.querySelectorAll<HTMLElement>('#tools [data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.dataset.tool as ToolKind | 'guided' | 'pso' | 'cage'
    if (t === 'pso') return armPso()
    if (t === 'cage') return armCage()
    if (t !== 'guided') return armTool(t)
    if (tool === 'guided') {
      finishGuided()
      openSheet(null)
      refresh()
    } else {
      // The bottom bar always opens the list; a measurement's panel is reached from it.
      if (sheet !== 'guided') panelKey = null
      toggleSheet('guided')
    }
  })
})

// ---------------------------------------------------------------- the Tools chooser

/** Open or close the Tools chooser, over the Tools button and inside the screen. */
function showToolMenu(open: boolean) {
  if (open === !toolMenu.hidden) return
  toolMenu.hidden = !open
  const b = $('btn-tools')
  b.setAttribute('aria-expanded', String(open))
  if (open) {
    const room = (toolMenu.offsetParent as HTMLElement | null)?.clientWidth ?? window.innerWidth
    const left = b.offsetLeft + b.offsetWidth / 2 - toolMenu.offsetWidth / 2
    toolMenu.style.left = `${Math.max(6, Math.min(left, room - toolMenu.offsetWidth - 6))}px`
  }
  refresh()
}

$('btn-tools').addEventListener('click', () => {
  if (!src) return toast('Choose a photo first')
  showToolMenu(toolMenu.hidden === true)
})
// A tool chosen (its own listener puts it out, or away if it was out), then the chooser closes.
toolMenu.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-tool]')) showToolMenu(false)
})
// A touch anywhere else closes the chooser and does what it would have done; on the photo it does nothing more.
document.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as Node
    if (!toolMenu.hidden && t !== cvOverlay && !toolMenu.contains(t) && !$('btn-tools').contains(t)) showToolMenu(false)
  },
  true,
)
// It is placed when it opens, so a turned screen closes it.
window.addEventListener('resize', () => showToolMenu(false))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !toolMenu.hidden) {
    e.stopImmediatePropagation()
    showToolMenu(false)
  }
})

document.querySelectorAll<HTMLElement>('#plane-tabs [data-plane]').forEach((b) => {
  b.addEventListener('click', () => {
    plane = b.dataset.plane as Plane
    try {
      localStorage.setItem('plane', plane)
    } catch {
      /* not remembered */
    }
    refresh()
  })
})

$('btn-guided-clear').addEventListener('click', () => {
  if (!Object.keys(doc.features).length) return
  pushUndo()
  doc.features = {}
  skipped.clear()
  toast('Landmarks cleared')
  refresh()
})

$('in-brightness').addEventListener('input', (e) => {
  tone.brightness = Number((e.target as HTMLInputElement).value)
  applyTone()
})
$('in-contrast').addEventListener('input', (e) => {
  tone.contrast = Number((e.target as HTMLInputElement).value)
  applyTone()
})
$('in-tilt').addEventListener('input', (e) => {
  setTilt(Number((e.target as HTMLInputElement).value))
  $('out-tilt').textContent = `${doc.tilt.toFixed(1)}°`
  refresh()
})
$('btn-invert').addEventListener('click', () => {
  tone.invert = !tone.invert
  syncAdjustInputs()
})
$('btn-rotate').addEventListener('click', () => {
  if (!src) return
  const h = src.height
  transformPhoto(rotate90(src), (p) => ({ x: h - p.y, y: p.x }))
})
$('btn-flip').addEventListener('click', () => {
  if (!src) return
  const w = src.width
  doc.tilt = -doc.tilt
  for (const g of cagesOf()) if (g.facing) g.facing = g.facing > 0 ? -1 : 1
  transformPhoto(flipH(src), (p) => ({ x: w - p.x, y: p.y }))
  syncAdjustInputs()
})
$('btn-fit').addEventListener('click', fit)
$('btn-reset').addEventListener('click', () => {
  tone = { brightness: 1, contrast: 1, invert: false }
  setTilt(0)
  syncAdjustInputs()
  fit()
  refresh()
})

$('btn-facing').addEventListener('click', () => {
  facingOverride = facingOverride ? 0 : -sagittal().facing
  // The cages follow the photo's facing; each disc is measured anew, so the angle it was set to goes back to as measured.
  const f = sagittal().facing
  let changed = false
  for (const g of cagesOf()) {
    if (g.facing === undefined || g.facing === f) continue
    if (!changed) pushUndo()
    changed = true
    g.facing = f
    delete g.target
  }
  refresh()
})
$('in-age').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  age = v > 0 ? v : undefined
  refresh()
})
$('btn-copy').addEventListener('click', async () => {
  const plan = hasPlan()
    ? [
        ...planSteps().map((s) => ({ name: `${s.name} (planned)`, short: s.name, value: s.value, note: 'the pelvis held still' })),
        ...planChanges().map(({ before: b, after: a }) => ({
          name: `${a.label} after the plan (${a.key})`, short: `${a.key} after plan`, value: formatValue(a), note: `before ${formatValue(b)}`,
        })),
      ]
    : []
  const results = resultsClipboard(doc, sagittal(), measureName, plan)
  if (!results) return toast('Nothing to copy yet')
  try {
    await copyResults(results)
    toast('Results copied')
  } catch {
    toast('Copy was blocked by the browser')
  }
})

const LABELS_NOTICE = 'spine-angles:labels-notice'
$('btn-labels').addEventListener('click', async () => {
  if (!src) return toast('Choose a photo first')
  const sag = sagittal()
  const id = `spine-labels-${fileStamp()}`
  const record = buildLabels({
    doc, width: src.width, height: src.height,
    facing: sag.facing, facingAuto: !facingOverride,
    skipped: [...skipped], results: sag.results,
    imageFile: `${id}.jpg`, imageId: id,
    saved: new Date().toISOString(), appVersion: __APP_VERSION__,
  })
  if (!hasLabels(record)) return toast('Place some landmarks first')
  // Unlike Share, this saves the whole photo, so say so once.
  let seen = false
  try {
    seen = localStorage.getItem(LABELS_NOTICE) === '1'
  } catch {
    // Storage unavailable: ask every time.
  }
  if (!seen) {
    const ok = confirm(
      'Save labels stores the whole photo together with the landmark positions.\n\n' +
        'Anything visible on the photo, such as a name or date, is included. Continue?',
    )
    if (!ok) return
    try {
      localStorage.setItem(LABELS_NOTICE, '1')
    } catch {
      // Not remembered; the question comes back next time.
    }
  }
  try {
    const outcome = await saveLabels(src, record)
    if (outcome === 'downloaded') toast('Photo and labels saved')
  } catch {
    toast('Could not save the labels')
  }
})

$('btn-share').addEventListener('click', async () => {
  if (!src) return
  try {
    const cuts = shownCuts()
    const photo = src
    const outcome = await exportView({
      src, doc: shownDoc(), tone, M: viewMat(), W, H, sagittal: shownSagittal(), focus, overlay: !planTool(tool),
      paint: cuts.length ? (c) => drawPieces(c, photo, cuts, 0.25) : undefined,
      decorate: doc.pso?.length || doc.cages?.length ? (c, M, k) => drawPlanMarks(c, M, k, false) : undefined,
      note: planNote(),
    })
    if (outcome === 'downloaded') toast('Image saved')
  } catch {
    toast('Could not export the image')
  }
})

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undo()
  } else if (e.key === 'Escape' && tool) {
    if (tool === 'guided') finishGuided()
    else if (planTool(tool)) finishPlan()
    else armTool(tool)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
    deleteMeasure(selected)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFeature) {
    deleteFeature(selectedFeature)
  }
})

syncAdjustInputs()
refresh()
