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

export function resultsText(doc: Doc, sagittal: SagittalResults, nameOf: (m: Measure) => string): string {
  const lines: string[] = []
  for (const m of doc.measures.filter(isDone)) lines.push(`${nameOf(m)}: ${measureText(m, doc.tilt)}`)
  for (const r of sagittal.results) lines.push(`${r.key}: ${formatValue(r)}`)
  return lines.join('\n')
}
