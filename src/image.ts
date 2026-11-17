// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// Loading and transforming the photo. The working copy is an offscreen canvas.

/** Longest edge of the working copy. Keeps well inside Safari's canvas area limit. */
const MAX_EDGE = 4096

export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('This file could not be read as an image.'))
      img.src = url
    })
    // naturalWidth/Height already reflect EXIF orientation in current browsers.
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * scale))
    c.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Rotate 90 degrees clockwise. A point (x, y) moves to (oldHeight - y, x). */
export function rotate90(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.height
  c.height = src.width
  const ctx = c.getContext('2d')!
  ctx.translate(c.width, 0)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(src, 0, 0)
  return c
}

/** Mirror left-right. A point (x, y) moves to (width - x, y). */
export function flipH(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d')!
  ctx.translate(c.width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(src, 0, 0)
  return c
}

export interface Tone {
  brightness: number
  contrast: number
  invert: boolean
}

export const toneCss = (t: Tone): string =>
  `brightness(${t.brightness}) contrast(${t.contrast})${t.invert ? ' invert(1)' : ''}`

/**
 * Apply the same tone adjustment as `toneCss` directly to pixels. On screen the adjustment
 * is a CSS filter (canvas filters are not available in Safari), so exports bake it in here.
 */
export function bakeTone(ctx: CanvasRenderingContext2D, w: number, h: number, t: Tone): void {
  if (t.brightness === 1 && t.contrast === 1 && !t.invert) return
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let v = Math.min(1, (i / 255) * t.brightness)
    v = Math.min(1, Math.max(0, (v - 0.5) * t.contrast + 0.5))
    if (t.invert) v = 1 - v
    lut[i] = Math.round(v * 255)
  }
  const data = ctx.getImageData(0, 0, w, h)
  const d = data.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]
    d[i + 1] = lut[d[i + 1]]
    d[i + 2] = lut[d[i + 2]]
  }
  ctx.putImageData(data, 0, 0)
}
