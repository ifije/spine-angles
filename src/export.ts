// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Export of the current view as a shareable JPEG, results as plain text, and labelled examples.

import { Doc, Mat, Measure, isDone, measureText } from './model'
import { drawOverlay } from './draw'
import { bakeTone, Tone } from './image'
import { SagittalResults, formatValue } from './sagittal'
import type { LabelRecord } from './labels'

export interface ExportInput {
  src: HTMLCanvasElement
  doc: Doc
  tone: Tone
  /** Current view matrix (image px -> stage CSS px). */
  M: Mat
  W: number
  H: number
  sagittal: SagittalResults
  /** Result isolated on screen, if any; the exported image matches. */
  focus?: string | null
  /** Draws the photo in place of a plain drawImage (a planned osteotomy, closed); the context maps photo pixels. */
  paint?: (ctx: CanvasRenderingContext2D) => void
  /** Draws on top of the overlay, with the same matrix and scale (the osteotomy's wedge). */
  decorate?: (ctx: CanvasRenderingContext2D, M: Mat, k: number) => void
  /** A line for the footer, before the caption (what the values show). */
  note?: string
  /** Draw the landmarks and measurements (false while the PSO tool hides them on screen). Default true. */
  overlay?: boolean
}

const CAPTION = 'Measured on a photograph. Approximate; not for diagnostic use.'

/** Render exactly what is on screen (so anything panned out of view is left out), plus a results footer. */
export function renderExport(input: ExportInput): HTMLCanvasElement {
  const { src, doc, tone, M, W, H, sagittal, focus, paint, decorate, note, overlay = true } = input
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
  const noteH = note ? 20 * k : 0
  const footerH = pad + nRows * lineH + noteH + 18 * k + pad * 0.5

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
  if (paint) paint(lctx)
  else lctx.drawImage(src, 0, 0)
  lctx.setTransform(1, 0, 0, 1, 0, 0)
  bakeTone(lctx, w, h, tone)
  ctx.drawImage(layer, 0, 0)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  if (overlay) drawOverlay(ctx, Mk, doc, { k, selected: null, sag: sagittal, focus })
  decorate?.(ctx, Mk, k)
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
  if (note) {
    let size = 13
    ctx.font = font(size, 600)
    while (size > 8 && ctx.measureText(note).width > w - 2 * pad) ctx.font = font(--size, 600)
    ctx.fillStyle = '#ff6b6b'
    ctx.fillText(note, pad, y - lineH / 2 + 9 * k)
    y += noteH
  }
  ctx.font = font(11, 400)
  ctx.fillStyle = '#98a2ae'
  ctx.fillText(CAPTION, pad, y - lineH / 2 + 9 * k)
  return c
}

type Delivery = 'shared' | 'downloaded' | 'cancelled'

/** Hand files to the system share sheet where it accepts them, otherwise download them. */
async function deliver(files: File[]): Promise<Delivery> {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // Fall through to a download if sharing was refused.
    }
  }
  for (const [i, file] of files.entries()) {
    // Browsers drop a second download started in the same instant as the first.
    if (i) await new Promise((res) => setTimeout(res, 400))
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return 'downloaded'
}

const jpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('export failed'))), 'image/jpeg', quality))

/** Timestamp for file names, e.g. 2026-11-18-17-03-59. */
export const fileStamp = (d = new Date()): string => d.toISOString().slice(0, 19).replace(/[:T]/g, '-')

/** Share through the system share sheet where available, otherwise download. */
export async function exportView(input: ExportInput): Promise<Delivery> {
  const blob = await jpeg(renderExport(input), 0.92)
  return deliver([new File([blob], `spine-angles-${fileStamp()}.jpg`, { type: 'image/jpeg' })])
}

/**
 * Save a labelled example: the whole photo as loaded (no overlay, no brightness or contrast
 * change) and its label record, as two files that share a name.
 */
export async function saveLabels(src: HTMLCanvasElement, record: LabelRecord): Promise<Delivery> {
  const image = new File([await jpeg(src, 0.95)], record.image.path, { type: 'image/jpeg' })
  const labels = new File([JSON.stringify(record, null, 1)], `${record.image_id}.json`, { type: 'application/json' })
  return deliver([image, labels])
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
/** `extra`: rows added at the end (a planned osteotomy and the values after it). */
export function resultsClipboard(
  doc: Doc, sagittal: SagittalResults, nameOf: (m: Measure) => string,
  extra: { name: string; short: string; value: string; note: string }[] = [],
): ClipboardResults | null {
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
  rows.push(...extra)
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
