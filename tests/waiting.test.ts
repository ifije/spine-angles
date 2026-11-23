// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// What the photo screen says while the automatic guess is not simply done: never a photo open with nothing placed and
// nothing said.

import { describe, it, expect } from 'vitest'
import { guessView, failureText, ofMB, type GuessState } from '../src/waiting'

const base: GuessState = {
  wanted: true, off: false, looking: false, kind: 'device', stage: 'file', download: null, slower: null, finding: null,
  byHand: false, readyForAuto: false, failed: null, cannotRun: false, dismissed: false,
}
const view = (o: Partial<GuessState>) => guessView({ ...base, ...o })

describe('the automatic guess on the photo screen', () => {
  it('says the detector is downloading, how far, and that the landmarks will follow', () => {
    const v = view({ download: { what: 'detector', got: 4.2e6, total: 12.7e6 } })
    expect(v.line?.text).toBe('Automatic guess: downloading the landmark detector, 4 of 13 MB. The landmarks will appear when it is ready.')
    expect(v.line?.progress).toBe(33)
    expect(v.line?.retry).toBe(false)
    expect(v.auto).toEqual({ hidden: false, disabled: true, label: 'Auto…', progress: 33 })
  })

  it('says so before the detector is even known, and while it gets ready', () => {
    expect(view({ looking: true, kind: null, stage: null }).line?.text).toBe('Automatic guess: looking for the landmark detector…')
    expect(view({ stage: 'engine' }).line?.text).toBe('Automatic guess: getting ready. The landmarks will appear when it is ready.')
    expect(view({ stage: 'engine' }).auto.label).toBe('Auto…')
  })

  it('says what the slower way is doing: its download, its start, and the seconds of a guess', () => {
    const slower = { why: 'no-webgpu' as const, perPhotoS: 6 }
    expect(view({ stage: 'runtime', slower, download: { what: 'runtime', got: 1e6, total: 3.9e6 } }).line?.text)
      .toBe('Automatic guess: this browser has no WebGPU, so the app is downloading the slower way, 1.0 of 3.9 MB. The landmarks will appear when it is ready.')
    expect(view({ stage: 'runtime', slower: { why: 'engine-failed', perPhotoS: null }, download: { what: 'runtime', got: 2e6, total: 3.9e6 } }).line?.text)
      .toBe("Automatic guess: this device's graphics chip did not pass the detector's check, so the app is downloading the slower way, 2.0 of 3.9 MB. The landmarks will appear when it is ready.")
    expect(view({ stage: 'processor', slower }).line?.text).toBe('Automatic guess: getting the slower way ready. The landmarks will appear when it is ready.')
    expect(view({ stage: 'ready', slower, finding: 3.4 }).line?.text).toBe('Automatic guess: finding the landmarks the slower way, 3 s of about 6…')
    expect(view({ stage: 'ready', finding: 0.2 }).line?.text).toBe('Automatic guess: finding the landmarks…')
  })

  it('stays quiet when the guess is ready and nothing is asked of it, and Auto is there', () => {
    const v = view({ stage: 'ready' })
    expect(v.line).toBeNull()
    expect(v.auto).toEqual({ hidden: false, disabled: false, label: 'Auto', progress: null })
    expect(view({ kind: 'service', stage: null }).line).toBeNull()
  })

  it('tells someone who started by hand that nothing will be placed for them, then that Auto is ready', () => {
    expect(view({ byHand: true, download: { what: 'detector', got: 7e6, total: 12.7e6 } }).line?.text)
      .toBe('Automatic guess: downloading the landmark detector, 7 of 13 MB. You have started by hand, so nothing will be placed for you: tap Auto when it is ready.')
    const v = view({ stage: 'ready', readyForAuto: true })
    expect(v.line?.text).toBe('The automatic guess is ready: tap Auto to place the landmarks you have not placed yet.')
    expect(v.line?.dismiss).toBe(true)
    expect(v.auto.disabled).toBe(false)
    expect(view({ stage: 'ready', readyForAuto: true, dismissed: true }).line).toBeNull()
  })

  it('keeps a failure on screen, with Try again, until it is closed; Auto retries too', () => {
    const failed = failureText(new TypeError('network error'), 'download')
    const v = view({ failed, stage: 'failed' })
    expect(v.line).toEqual({ text: 'Automatic guess: the landmark detector could not be downloaded (the connection stopped).', progress: null, retry: true, dismiss: true })
    expect(v.auto).toEqual({ hidden: false, disabled: false, label: 'Auto', progress: null })
    expect(view({ failed, dismissed: true }).line).toBeNull()
    expect(failureText(new Error('x'), 'runtime')).toMatch(/slower way could not be downloaded/)
    expect(failureText(new Error('out of memory'), 'start')).toBe('Automatic guess: it could not start (out of memory).')
  })

  it('says once, plainly, when nothing can run here, and offers no Auto', () => {
    const v = view({ cannotRun: true, kind: null, stage: null })
    expect(v.line?.text).toBe('The automatic guess cannot run in this browser. Measure with the tools as usual.')
    expect(v.auto.hidden).toBe(true)
  })

  it('says nothing and offers nothing when the guess is off, or there is no photo waiting', () => {
    expect(view({ off: true }).line).toBeNull()
    expect(view({ off: true }).auto.hidden).toBe(true)
    expect(view({ wanted: false, download: { what: 'detector', got: 1e6, total: 12.7e6 } }).line).toBeNull()
    expect(view({ wanted: false, download: { what: 'detector', got: 1e6, total: 12.7e6 } }).auto).toEqual({ hidden: false, disabled: true, label: 'Auto…', progress: 7 })
  })

  it('gives sizes in whole MB, or to a tenth below 10 MB', () => {
    expect(ofMB(4.2e6, 12.7e6)).toBe('4 of 13 MB')
    expect(ofMB(0.4e6, 3.95e6)).toBe('0.4 of 4.0 MB')
    expect(ofMB(5e6, 3.95e6)).toBe('4.0 of 4.0 MB')
  })

  it('never leaves a waiting photo without a line, whatever the stage', () => {
    for (const stage of ['file', 'engine', 'runtime', 'processor'] as const) {
      for (const download of [null, { what: 'detector' as const, got: 1, total: 10 }, { what: 'runtime' as const, got: 1, total: 10 }]) {
        for (const looking of [false, true]) expect(view({ stage, download, looking }).line, `${stage} ${download?.what} ${looking}`).not.toBeNull()
      }
    }
  })
})
