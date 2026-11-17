import './style.css'
import { Pt, dist, mid } from './geometry'
import { Doc, Mat, Measure, ToolKind, NEED, TOOL_NAME, apply, invert, matrix, isDone, measureText } from './model'
import { drawOverlay, colorFor } from './draw'
import { loadPhoto, rotate90, flipH, toneCss, Tone } from './image'
import { exportView, resultsClipboard, copyResults } from './export'
import {
  FEATURES, FEATURE_BY_ID, MEASURE_GROUPS, FeatureId, MeasureDef, Plane,
  stepsFor, isComplete, compute, formatValue,
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
let steps: FeatureId[] = []
/** Name of the measurement being guided, shown in the prompt. */
let guidedTitle = ''
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
  drawOverlay(octx, M, doc, { k: 1, selected })
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
  drawOverlay(lo, M, doc, { k: 1, selected, noLabels: true })
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

/** Scale and centre the (levelled) photo in the stage. */
function fit() {
  if (!src || !W) return
  const m = matrix(1, doc.tilt, 0, 0)
  const cs = [{ x: 0, y: 0 }, { x: src.width, y: 0 }, { x: 0, y: src.height }, { x: src.width, y: src.height }].map((p) => apply(m, p))
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const bw = Math.max(...xs) - minX
  const bh = Math.max(...ys) - minY
  view.s = Math.min(W / bw, H / bh) * 0.96
  view.tx = W / 2 - view.s * (minX + bw / 2)
  view.ty = H / 2 - view.s * (minY + bh / 2)
  requestDraw()
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

const snapshot = () => JSON.stringify({ doc, activeId })

function pushUndo(snap = snapshot()) {
  undoStack.push(snap)
  if (undoStack.length > 200) undoStack.shift()
}

function undo() {
  const snap = undoStack.pop()
  if (!snap) return
  const s = JSON.parse(snap) as { doc: Doc; activeId: number | null }
  doc = s.doc
  const partial = doc.measures.find((m) => !isDone(m))
  if (partial) {
    activeId = partial.id
    tool = partial.kind
  } else {
    activeId = null
  }
  if (selected !== null && !doc.measures.some((m) => m.id === selected)) selected = null
  syncAdjustInputs()
  refresh()
}

// ---------------------------------------------------------------- tools

const FREE_PROMPTS: Record<ToolKind, string[]> = {
  cobb: ['tap one end of the first endplate', 'tap its other end', 'tap one end of the second endplate', 'tap its other end'],
  angle3: ['tap the end of one arm', 'tap the vertex', 'tap the end of the other arm'],
  slope: ['tap one end of the line', 'tap the other end'],
}

const currentStep = (): FeatureId | undefined =>
  steps.find((id) => !isComplete(doc.features, id) && !skipped.has(id))

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

function startGuided(def: MeasureDef) {
  dropPartials()
  // A second femoral head that was skipped stays skipped until landmarks are cleared.
  const keepFh2 = skipped.has('fh2') && isComplete(doc.features, 'fh1')
  skipped.clear()
  if (keepFh2) skipped.add('fh2')
  // Only prompt for what this measurement needs and is not placed yet.
  steps = stepsFor(def.needs).filter((id) => !isComplete(doc.features, id) && !skipped.has(id))
  guidedTitle = def.label
  selected = null
  if (!steps.length) {
    toast(`${def.label} is already measured`)
    tool = null
    openSheet('results')
  } else {
    tool = 'guided'
    openSheet(null)
  }
  refresh()
}

function finishGuided() {
  dropPartials()
  tool = null
  openSheet('results')
  refresh()
}

function skipStep() {
  const cur = currentStep()
  if (!cur) return
  if (doc.features[cur]) {
    pushUndo()
    delete doc.features[cur]
  }
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
    if (selected !== null) selected = null
    else if (now - lastTap < 320) fit()
    lastTap = now
    refresh()
    return
  }
  if (!inside) return
  if (tool === 'guided') {
    const cur = currentStep()
    if (!cur) return
    pushUndo()
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

function clearAll() {
  if (!doc.measures.length && !Object.keys(doc.features).length) return
  pushUndo()
  doc.measures = []
  doc.features = {}
  skipped.clear()
  tool = null
  activeId = null
  selected = null
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
    if (h.measureId !== undefined && !tool) selected = h.measureId
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
      const n = doc.features[cur]?.length ?? 0
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
  }
  $('hint-text').textContent = text
  hint.hidden = !text
}

function renderResults() {
  const body = $('results-body')
  body.replaceChildren()
  const done = doc.measures.filter(isDone)
  if (done.length) {
    body.append(el('h3', '', 'Measurements'))
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
  body.append(el('h3', '', plane === 'sagittal' ? 'Sagittal parameters' : 'Coronal parameters'))
  if (!shown.length) {
    body.append(el('div', 'empty-note', 'None yet. Use Guided to place landmarks.'))
  }
  for (const r of shown) {
    const row = el('div', 'res')
    const name = el('div', 'name', `${r.label}`)
    if (r.note) name.append(el('small', '', r.note))
    row.append(name, el('div', 'val', formatValue(r)), el('span', ''))
    body.append(row)
  }
  // Facing and age only apply to the sagittal parameters.
  $('btn-facing').hidden = plane !== 'sagittal'
  $('age-wrap').hidden = plane !== 'sagittal'
  $('btn-facing').textContent = `Facing ${sag.facing > 0 ? 'right' : 'left'}${facingOverride ? '' : ' (auto)'}`
}

function renderGuided() {
  const body = $('guided-body')
  body.replaceChildren()
  const values = new Map(sagittal().results.map((r) => [r.key, formatValue(r)]))
  for (const group of MEASURE_GROUPS.filter((g) => g.plane === plane)) {
    body.append(el('h3', '', group.title))
    const chips = el('div', 'chips')
    for (const item of group.items) {
      const b = button(item.label, () => startGuided(item), 'chip')
      const v = values.get(item.key)
      if (v) {
        b.classList.add('done')
        b.append(el('small', '', v))
      }
      chips.append(b)
    }
    body.append(chips)
  }
  $('guided-note').textContent =
    plane === 'sagittal'
      ? 'You are only asked for landmarks that measurement needs and that are not placed yet. On each endplate tap the anterior corner first.'
      : 'Tap the two ends of each line in either order. Level the photo first (Adjust): pelvic obliquity and T1 tilt are measured against horizontal.'
}

function openSheet(id: SheetId | null) {
  sheet = id
  $('sheet').hidden = !id
  for (const s of ['adjust', 'guided', 'results'] as const) $(`sheet-${s}`).hidden = s !== id
  $('plane-tabs').hidden = id !== 'guided' && id !== 'results'
}

function toggleSheet(id: SheetId) {
  if (id !== 'results' && !src) return toast('Choose a photo first')
  openSheet(sheet === id ? null : id)
  refresh()
}

function refresh() {
  updateHint()
  const has = !!src
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
  facingOverride = 0
  // Age belongs to the previous patient; leaving it would apply their age targets to this one.
  age = undefined
  $<HTMLInputElement>('in-age').value = ''
  steps = []
  skipped.clear()
  openSheet(null)
  syncAdjustInputs()
  refresh()
  // The stage may have changed size when the sheet closed; fit after layout settles.
  requestAnimationFrame(() => {
    resize()
    fit()
  })
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

$('btn-share').addEventListener('click', async () => {
  if (!src) return
  try {
    const outcome = await exportView({ src, doc, tone, M: viewMat(), W, H, sagittal: sagittal() })
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
  }
})

syncAdjustInputs()
refresh()
