// Export of the current view as a shareable JPEG, and results as plain text.

import { Doc, Mat, Measure, isDone, measureText } from './model'
import { drawOverlay } from './draw'
import { bakeTone, Tone } from './image'
import { SagittalResults, formatValue } from './sagittal'

export interface ExportInput {
  src: HTMLCanvasElement
  doc: Doc
  tone: Tone
  /** Current view matrix (image px -> stage CSS px). */
  M: Mat
  W: number
  H: number
  sagittal: SagittalResults
}

const CAPTION = 'Measured on a photograph. Approximate; not for diagnostic use.'

/** Render exactly what is on screen (so anything panned out of view is left out), plus a results footer. */
export function renderExport(input: ExportInput): HTMLCanvasElement {
  const { src, doc, tone, M, W, H, sagittal } = input
  const k = Math.max(2, Math.min(3, 2000 / Math.max(W, H)))
  const w = Math.round(W * k)
  const h = Math.round(H * k)
  const font = (size: number, weight = 600) => `${weight} ${size * k}px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif`

  // Lay out the footer first so the canvas can be sized.
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font(15)
  const pad = 12 * k
  const gap = 18 * k
  const rows: string[][] = [[]]
  let x = pad
  for (const r of sagittal.results) {
    const item = `${r.key} ${formatValue(r)}`
    const iw = measure.measureText(item).width
    if (x + iw > w - pad && rows[rows.length - 1].length) {
      rows.push([])
      x = pad
    }
    rows[rows.length - 1].push(item)
    x += iw + gap
  }
  const lineH = 24 * k
  const nRows = sagittal.results.length ? rows.length : 0
  const footerH = pad + nRows * lineH + 18 * k + pad * 0.5

  const c = document.createElement('canvas')
  c.width = w
  c.height = h + Math.round(footerH)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)

  const Mk = M.map((v) => v * k) as Mat
  // Tone is baked on a transparent layer so the black surround is not brightened or inverted.
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lctx = layer.getContext('2d')!
  lctx.setTransform(Mk[0], Mk[1], Mk[2], Mk[3], Mk[4], Mk[5])
  lctx.imageSmoothingQuality = 'high'
  lctx.drawImage(src, 0, 0)
  lctx.setTransform(1, 0, 0, 1, 0, 0)
  bakeTone(lctx, w, h, tone)
  ctx.drawImage(layer, 0, 0)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  drawOverlay(ctx, Mk, doc, { k, selected: null })
  ctx.restore()

  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, h, w, footerH)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  let y = h + pad + lineH / 2
  if (nRows) {
    ctx.font = font(15)
    ctx.fillStyle = '#e8ebef'
    for (const row of rows) {
      let rx = pad
      for (const item of row) {
        ctx.fillText(item, rx, y)
        rx += ctx.measureText(item).width + gap
      }
      y += lineH
    }
  }
  ctx.font = font(11, 400)
  ctx.fillStyle = '#98a2ae'
  ctx.fillText(CAPTION, pad, y - lineH / 2 + 9 * k)
  return c
}

/** Share through the system share sheet where available, otherwise download. */
export async function exportView(input: ExportInput): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const canvas = renderExport(input)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92))
  if (!blob) throw new Error('export failed')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = new File([blob], `spine-angles-${stamp}.jpg`, { type: 'image/jpeg' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // Fall through to a download if sharing was refused.
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}

export interface ClipboardResults {
  plain: string
  html: string
}

const HEADER = 'Spine measurements (from photo, approximate)'
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Results for the clipboard in two forms: an HTML table for apps that accept formatting
 * (Mail, Notes, Word) and plain text for those that do not.
 *
 * The plain text must not begin with "WORD:" - iOS reads that as a URL scheme and Mail then
 * pastes the whole thing percent-encoded. Hence the header line and no colons after names.
 */
export function resultsClipboard(doc: Doc, sagittal: SagittalResults, nameOf: (m: Measure) => string): ClipboardResults | null {
  const rows: { name: string; short: string; value: string; note: string }[] = []
  for (const m of doc.measures.filter(isDone)) {
    rows.push({ name: nameOf(m), short: nameOf(m), value: measureText(m, doc.tilt) ?? '', note: '' })
  }
  for (const r of sagittal.results) {
    const name = r.plane === 'sagittal' ? `${r.label} (${r.key})` : r.label
    // Which side is high is part of a coronal reading, so it goes in the plain text too.
    const side = r.plane === 'coronal' && r.note ? ` (${r.note})` : ''
    rows.push({ name, short: r.key, value: formatValue(r) + side, note: r.plane === 'coronal' ? '' : r.note ?? '' })
  }
  if (!rows.length) return null
  const plain = [HEADER, ...rows.map((r) => `${r.short}  ${r.value}`)].join('\n')
  const cell = (tag: string, text: string, align = 'left') =>
    `<${tag} align="${align}" style="padding:4px 10px;border:1px solid #999">${esc(text)}</${tag}>`
  const html =
    `<p>${esc(HEADER)}</p>` +
    '<table cellspacing="0" style="border-collapse:collapse">' +
    `<tr>${cell('th', 'Parameter')}${cell('th', 'Value', 'right')}${cell('th', 'Note')}</tr>` +
    rows.map((r) => `<tr>${cell('td', r.name)}${cell('td', r.value, 'right')}${cell('td', r.note)}</tr>`).join('') +
    '</table>'
  return { plain, html }
}

/** Put both forms on the clipboard; fall back to plain text where rich copy is unavailable. */
export async function copyResults(c: ClipboardResults): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([c.html], { type: 'text/html' }),
          'text/plain': new Blob([c.plain], { type: 'text/plain' }),
        }),
      ])
      return
    } catch {
      // Try the plain route below.
    }
  }
  await navigator.clipboard.writeText(c.plain)
}
