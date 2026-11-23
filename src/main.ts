// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

import './style.css'
import { Pt, dist, mid } from './geometry'
import { Doc, Mat, Measure, ToolKind, NEED, TOOL_NAME, apply, invert, matrix, isDone, measureText } from './model'
import { drawOverlay, colorFor } from './draw'
import { loadPhoto, rotate90, flipH, toneCss, Tone } from './image'
import { exportView, resultsClipboard, copyResults, saveLabels, fileStamp } from './export'
import { buildLabels, hasLabels, readLabels } from './labels'
import {
  findDetector, findService, requestGuess, addDetectorFile, removeDetectorFile, endDetector, dropPublished, setGuessOff,
  NotOffered, DetectorFileError, type Detector, type Found,
} from './auto'
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
const LOUPE = 132
const LOUPE_ZOOM = 2.5

// ---------------------------------------------------------------- state

let src: HTMLCanvasElement | null = null
let doc: Doc = { measures: [], features: {}, tilt: 0 }
let undoStack: string[] = []
let nextId = 1
const view = { s: 1, tx: 0, ty: 0 }
let tone: Tone = { brightness: 1, contrast: 1, invert: false }

type Tool = ToolKind | 'guided' | null
let tool: Tool = null
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
/** A detector file is here, but this browser cannot run it; said once when a photo is opened. */
let notOffered = false
let notOfferedSaid = false
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
  ictx.drawImage(src, 0, 0)
  drawOverlay(octx, M, doc, { k: 1, selected, selectedFeature, sag: sagittal(), focus })
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
  li.drawImage(src, 0, 0)
  const lo = cvLoupeOverlay.getContext('2d')!
  lo.setTransform(dpr, 0, 0, dpr, 0, 0)
  lo.clearRect(0, 0, LOUPE, LOUPE)
  drawOverlay(lo, M, doc, { k: 1, selected, noLabels: true, sag: sagittal(), focus })
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

const snapshot = () => JSON.stringify({ doc, activeId, replacing })

function pushUndo(snap = snapshot()) {
  undoStack.push(snap)
  if (undoStack.length > 200) undoStack.shift()
}

function undo() {
  const snap = undoStack.pop()
  if (!snap) return
  const s = JSON.parse(snap) as { doc: Doc; activeId: number | null; replacing?: FeatureId | null }
  doc = s.doc
  replacing = tool === 'guided' ? s.replacing ?? null : null
  const partial = doc.measures.find((m) => !isDone(m))
  if (partial) {
    activeId = partial.id
    tool = partial.kind
  } else {
    activeId = null
  }
  if (selected !== null && !doc.measures.some((m) => m.id === selected)) selected = null
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
  if (!partialM && !partialF) return
  pushUndo()
  doc.measures = doc.measures.filter(isDone)
  for (const f of FEATURES) if (!isComplete(doc.features, f.id)) delete doc.features[f.id]
  activeId = null
}

function armTool(kind: ToolKind) {
  if (!src) return toast('Choose a photo first')
  const wasOn = tool === kind
  dropPartials()
  tool = wasOn ? null : kind
  activeId = null
  selected = null
  openSheet(null)
  refresh()
}

/**
 * Prompt for these landmarks, one tap at a time in the usual order (caudal to cranial), then come back to the open
 * measurement's panel. `again` is a landmark that is there already and is to be placed anew: it stays until the first tap.
 */
function placeLandmarks(ids: FeatureId[], title: string, again: FeatureId | null = null) {
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
 * Ask the detector for its best guess and place it as ordinary landmarks, to be dragged,
 * kept or deleted. Landmarks a person placed, moved or kept are left alone; guesses from an
 * earlier run that nobody touched are replaced.
 */
async function runGuess() {
  if (!src || !detector || guessing) return
  const photo = src
  const token = ++guessToken
  guessing = true
  refresh()
  try {
    const rec = await requestGuess(detector, photo)
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
    toast(n ? `${n} landmark${n > 1 ? 's' : ''} guessed. Drag to adjust; tap one to delete it.` : 'Nothing was found to place on this photo')
  } catch (err) {
    if (token === guessToken) toast(err instanceof NotOffered ? NOT_OFFERED : `No automatic guess: ${err instanceof Error ? err.message : 'it failed'}`)
  } finally {
    if (token === guessToken) {
      guessing = false
      refresh()
    }
  }
}

/** Clear one group: the basic tools' measurements, or one plane's guided landmarks. */
function clearGroup(group: 'basic' | Plane) {
  pushUndo()
  if (group === 'basic') {
    doc.measures = []
    selected = null
    activeId = null
    if (tool && tool !== 'guided') tool = null
  } else {
    for (const f of FEATURES) if (f.plane === group) delete doc.features[f.id]
    selectedFeature = null
    skipped.clear()
    if (tool === 'guided') tool = null
  }
  refresh()
}

function clearAll() {
  if (!doc.measures.length && !Object.keys(doc.features).length) return
  pushUndo()
  doc.measures = []
  doc.features = {}
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
}

function hitHandle(screen: Pt, radius: number): Handle | null {
  const M = viewMat()
  let best: Handle | null = null
  let bestD = radius
  const consider = (h: Handle) => {
    const d = dist(apply(M, h.pts[h.i]), screen)
    if (d <= bestD) {
      bestD = d
      best = h
    }
  }
  for (const m of doc.measures) m.pts.forEach((_, i) => consider({ pts: m.pts, i, measureId: m.id }))
  for (const f of FEATURES) doc.features[f.id]?.forEach((_, i) => consider({ pts: doc.features[f.id]!, i, feature: f.id }))
  return best
}

function moveHandle(h: Handle, p: Pt) {
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
  if (gesture.moved) pushUndo(gesture.before)
  loupeAt = null
  loupeEl.hidden = true
}

cvOverlay.addEventListener('pointerdown', (e) => {
  if (!src) return
  e.preventDefault()
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
    const sp = apply(viewMat(), h.pts[h.i])
    gesture = { type: 'drag', id: e.pointerId, h, start: p, off: { x: sp.x - p.x, y: sp.y - p.y }, before: snapshot(), moved: false }
    if (!tool) {
      selected = h.measureId ?? null
      selectedFeature = h.feature ?? null
    }
    showLoupe(h.pts[h.i], p)
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
    const ip = invert(viewMat(), { x: p.x + g.off.x, y: p.y + g.off.y })
    ip.x = Math.min(src.width, Math.max(0, ip.x))
    ip.y = Math.min(src.height, Math.max(0, ip.y))
    moveHandle(g.h, ip)
    showLoupe(g.h.pts[g.h.i], p)
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
  if (!(e.target as Element).closest?.('#sheet')) e.preventDefault()
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
  actions.replaceChildren()
  let text = ''
  if (src && tool === 'guided') {
    const cur = currentStep()
    if (cur) {
      const def = FEATURE_BY_ID[cur]
      const n = cur === replacing ? 0 : doc.features[cur]?.length ?? 0
      text = `${guidedTitle} ${steps.indexOf(cur) + 1}/${steps.length} · ${def.name}: ${def.prompts[Math.min(n, def.prompts.length - 1)]}`
      actions.append(button('Skip', skipStep), button('Done', finishGuided))
    }
  } else if (src && tool && tool !== 'guided') {
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
  } else if (src && guessing) {
    text = detector?.kind === 'device' && downloading() ? `Getting the landmark detector (${mb(dlGot)} of ${mb(dlTotal)})…` : 'Finding landmarks…'
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
  const btnAuto = $<HTMLButtonElement>('btn-auto')
  btnAuto.hidden = !detector
  btnAuto.disabled = !has || guessing
  $<HTMLButtonElement>('btn-undo').disabled = !undoStack.length
  for (const id of ['btn-adjust', 'btn-clear', 'btn-share']) $<HTMLButtonElement>(id).disabled = !has
  $('btn-adjust').classList.toggle('on', sheet === 'adjust')
  document.querySelectorAll<HTMLElement>('#tools [data-tool]').forEach((b) => {
    const t = b.dataset.tool
    b.classList.toggle('on', t === tool || (t === 'guided' && sheet === 'guided'))
  })
  $('btn-results').classList.toggle('on', sheet === 'results')
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
  const hasWork = doc.measures.length > 0 || Object.keys(doc.features).length > 0
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
  if (detector) void runGuess()
  else if (notOffered && !notOfferedSaid) {
    notOfferedSaid = true
    toast(NOT_OFFERED)
  }
}

function transformPhoto(next: HTMLCanvasElement, map: (p: Pt) => Pt) {
  src = next
  for (const m of doc.measures) m.pts = m.pts.map(map)
  for (const f of FEATURES) if (doc.features[f.id]) doc.features[f.id] = doc.features[f.id]!.map(map)
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
$('btn-auto').addEventListener('click', () => void runGuess())

// ---------------------------------------------------------------- finding a detector

const NOT_OFFERED = 'The automatic guess needs a graphics feature (WebGPU) that this browser does not offer.'
const PRIVACY = $('note-privacy').textContent ?? ''

const hostOf = (base: string) => {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`
/** The built-in detector is still downloading. */
const downloading = () => found?.published?.from === 'download' && !detectorReady && dlTotal > 0 && dlGot < dlTotal

/** Say on the start screen what the automatic guess is doing, in plain words, with its one switch. */
function showDetector() {
  const d = detector
  const off = !!found?.off
  const size = mb(found?.published?.bytes || dlTotal || 13e6)
  let text: string
  if (off) text = 'Automatic landmark guess: off.'
  else if (d?.kind === 'device') {
    if (downloading()) text = `Automatic landmark guess: downloading the landmark detector, ${mb(dlGot)} of ${mb(dlTotal)}. This happens once; it is then kept on this device.`
    else if (!detectorReady) text = 'Automatic landmark guess: getting ready…'
    else if (d.from === 'added') text = 'Automatic landmark guess: on, with your own detector file.'
    else if (keptHere === false) text = 'Automatic landmark guess: on. This browser does not let the app keep the landmark detector, so it is downloaded again each time the app opens.'
    else text = 'Automatic landmark guess: on.'
  } else if (notOffered) text = NOT_OFFERED
  else if (detectorProblem) text = detectorProblem
  else if (dlFailed) text = 'Automatic landmark guess: the landmark detector could not be downloaded. The app tries again the next time it opens.'
  else if (found?.later) text = `Automatic landmark guess: the landmark detector (${size}) will be downloaded the next time the app opens with a connection.`
  else if (d?.kind === 'service') text = `Automatic landmark guess: on, from the detector at ${hostOf(d.base)}.`
  else text = 'Automatic landmark guess: off.'
  $('auto-text').textContent = text
  const toggle = $<HTMLButtonElement>('btn-auto-toggle')
  // One switch: off stops the download and removes the kept copy; on fetches it again. Nothing to switch where nothing can run.
  toggle.hidden = !off && !d && !dlFailed && !found?.later && !detectorProblem
  toggle.textContent = off ? 'Turn on' : 'Turn off'
  const bar = $('auto-bar')
  bar.hidden = !(d?.kind === 'device' && downloading())
  ;(bar.querySelector('.fill') as HTMLElement).style.width = dlTotal ? `${Math.round((100 * dlGot) / dlTotal)}%` : '0'
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

/** Use what was found. A detector whose engine cannot run here gives way to a detector service, if the user runs one. */
function useDetector(f: Found) {
  if (detector !== f.detector) endDetector(detector)
  found = f
  detector = f.detector
  notOffered = f.notOffered
  detectorAdded = f.added
  detectorProblem = null
  detectorReady = false
  dlFailed = false
  keptHere = null
  const d = detector
  if (d?.kind === 'device') {
    f.published?.kept.then((k) => {
      if (detector !== d) return
      keptHere = k
      showDetector()
    })
    d.device.ready.then(() => {
      if (detector !== d) return
      detectorReady = true
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
      else if (f.published?.from === 'download') dlFailed = true
      else detectorProblem = `The automatic guess could not start: ${err instanceof Error ? err.message : 'it failed'}.`
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
  if (detector && src && !doc.measures.length && !Object.keys(doc.features).length) void runGuess()
}

let redownloaded = false
let finding: AbortController | null = null
let shownMb = -1
/** Look for a detector (and download the built-in one if it is not kept here yet), in the background. */
function startFinding() {
  finding?.abort()
  const ctl = (finding = new AbortController())
  dlGot = dlTotal = 0
  void findDetector({
    signal: ctl.signal,
    progress: (got, total) => {
      if (finding !== ctl) return
      dlGot = got
      dlTotal = total
      const now = Math.floor(got / 1e6)
      if (now === shownMb && got < total) return
      shownMb = now
      showDetector()
      if (guessing) updateHint()
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
  await setGuessOff(true)
  useDetector({ detector: null, notOffered: false, added: detectorAdded, off: true, published: null, later: false })
  toast('Automatic guess turned off. The landmark detector was removed from this device.')
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
    const base = { notOffered: false, added: true, off: false, published: null, later: false }
    if (got.notOffered) {
      endDetector(detector)
      detector = null
      const service = await findService()
      useDetector({ ...base, detector: service ? { kind: 'service', base: service } : null, notOffered: true })
      toast(NOT_OFFERED)
      return
    }
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
    const t = b.dataset.tool as ToolKind | 'guided'
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
  refresh()
})
$('in-age').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  age = v > 0 ? v : undefined
  refresh()
})
$('btn-copy').addEventListener('click', async () => {
  const results = resultsClipboard(doc, sagittal(), measureName)
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
    const outcome = await exportView({ src, doc, tone, M: viewMat(), W, H, sagittal: sagittal(), focus })
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
    else armTool(tool)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
    deleteMeasure(selected)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFeature) {
    deleteFeature(selectedFeature)
  }
})

syncAdjustInputs()
refresh()
