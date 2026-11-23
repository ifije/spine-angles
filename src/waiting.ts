// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// What the photo screen says about the automatic guess while it is not simply done: a line that stays (not a notice that
// goes) from the moment a photo is open until its landmarks are placed, with the download's progress, the slower way's
// progress, and a failure with "Try again". And what the Auto button shows meanwhile. Pure: the app passes its state in.

export interface GuessState {
  /** A photo is open, and an automatic guess is wanted for it (it opened, or Auto was tapped). */
  wanted: boolean
  /** The user turned the automatic guess off. */
  off: boolean
  /** The app is still finding out whether there is a detector (the first answers have not come). */
  looking: boolean
  /** The detector in use: on this device, a service, or none. */
  kind: 'device' | 'service' | null
  /** The on-device detector's start: getting its file, starting on the chip, getting the slower way's files, starting it. */
  stage: 'file' | 'engine' | 'runtime' | 'processor' | 'ready' | 'failed' | null
  /** A download in progress: the detector file, or the slower way's files. Bytes so far and in all. */
  download: { what: 'detector' | 'runtime'; got: number; total: number } | null
  /** The on-device detector runs the slower way (no WebGPU, or the chip failed its check), and about how long a photo takes. */
  slower: { why: 'no-webgpu' | 'engine-failed' | null; perPhotoS: number | null } | null
  /** A guess for this photo is running now (the detector is ready), for this many seconds. */
  finding: number | null
  /** The user placed or changed landmarks by hand while waiting: nothing will be placed for them by itself. */
  byHand: boolean
  /** The detector became ready after the user worked by hand: Auto places the guess for what is not placed yet. */
  readyForAuto: boolean
  /** Why the last attempt failed, in plain words, until it is dismissed or tried again. */
  failed: string | null
  /** Nothing can run here at all (neither the engine nor the slower way). */
  cannotRun: boolean
  /** The user closed the line about a failure, or about Auto being ready. */
  dismissed: boolean
}

export interface GuessView {
  /** The line on the photo screen, or null for none. */
  line: { text: string; progress: number | null; retry: boolean; dismiss: boolean } | null
  /** The Auto button: "Auto…" while the guess is on its way, with how far its download is (filled behind the label). */
  auto: { hidden: boolean; disabled: boolean; label: string; progress: number | null }
}

/** "4 of 13 MB"; below 10 MB in all, to a tenth ("1.2 of 3.9 MB"). */
export function ofMB(got: number, total: number): string {
  const f = (n: number) => (total < 10e6 ? (n / 1e6).toFixed(1) : String(Math.round(n / 1e6)))
  return `${f(Math.min(got, total))} of ${f(total)} MB`
}
const pct = (d: { got: number; total: number }) => (d.total > 0 ? Math.min(100, Math.floor((100 * d.got) / d.total)) : 0)

export function guessView(s: GuessState): GuessView {
  const hidden = { hidden: true, disabled: true, label: 'Auto', progress: null }
  const idle = { hidden: false, disabled: false, label: 'Auto', progress: null }
  if (s.off) return { line: null, auto: hidden }
  if (s.cannotRun) {
    return {
      line: s.wanted && !s.dismissed
        ? { text: 'The automatic guess cannot run in this browser. Measure with the tools as usual.', progress: null, retry: false, dismiss: true }
        : null,
      auto: hidden,
    }
  }
  if (s.failed) {
    return {
      line: s.wanted && !s.dismissed ? { text: s.failed, progress: null, retry: true, dismiss: true } : null,
      auto: idle,
    }
  }
  if (!s.kind && !s.looking) return { line: null, auto: hidden }
  const busy = { hidden: false, disabled: true, label: 'Auto…' }
  const busyAuto = { ...busy, progress: s.download ? pct(s.download) : null }
  if (s.finding !== null && s.wanted) {
    const text = s.slower
      ? `Automatic guess: finding the landmarks the slower way, ${Math.floor(s.finding)} s${s.slower.perPhotoS ? ` of about ${s.slower.perPhotoS}` : ''}…`
      : 'Automatic guess: finding the landmarks…'
    return { line: { text, progress: null, retry: false, dismiss: false }, auto: { ...busy, progress: null } }
  }
  if (s.readyForAuto) {
    return {
      line: s.wanted && !s.dismissed
        ? { text: 'The automatic guess is ready: tap Auto to place the landmarks you have not placed yet.', progress: null, retry: false, dismiss: true }
        : null,
      auto: idle,
    }
  }
  const ready = s.kind === 'service' || s.stage === 'ready'
  if (ready || !s.wanted) {
    if (ready) return { line: null, auto: idle }
    // Not ready yet and no photo waits: the Auto button shows the progress too.
    return { line: null, auto: busyAuto }
  }
  // A photo waits for the detector.
  const after = s.byHand
    ? ' You have started by hand, so nothing will be placed for you: tap Auto when it is ready.'
    : ' The landmarks will appear when it is ready.'
  let text: string
  let progress: number | null = null
  if (s.looking) text = 'Automatic guess: looking for the landmark detector…'
  else if (s.download && s.download.what === 'detector') {
    text = `Automatic guess: downloading the landmark detector, ${ofMB(s.download.got, s.download.total)}.${after}`
    progress = pct(s.download)
  } else if (s.download) {
    const why = s.slower?.why === 'engine-failed' ? "this device's graphics chip did not pass the detector's check" : 'this browser has no WebGPU'
    text = `Automatic guess: ${why}, so the app is downloading the slower way, ${ofMB(s.download.got, s.download.total)}.${after}`
    progress = pct(s.download)
  } else if (s.stage === 'runtime' || s.stage === 'processor') text = `Automatic guess: getting the slower way ready.${after}`
  else text = `Automatic guess: getting ready.${after}`
  return { line: { text, progress, retry: false, dismiss: false }, auto: busyAuto }
}

/** The plain words for a failed attempt. */
export function failureText(err: unknown, what: 'download' | 'runtime' | 'start' | 'guess'): string {
  const why = err instanceof Error ? err.message : String(err)
  if (what === 'download') return 'Automatic guess: the landmark detector could not be downloaded (the connection stopped).'
  if (what === 'runtime') return 'Automatic guess: the files for the slower way could not be downloaded (the connection stopped).'
  if (what === 'start') return `Automatic guess: it could not start (${why}).`
  return `Automatic guess: it could not finish on this photo (${why}).`
}
