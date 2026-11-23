# Spine measurement app for phone photos — Plan

## Goal

A phone-first tool for quick angular spine measurements on ordinary photos (JPEG/PNG/HEIC from the camera or photo library). Inspired by [SpineForgePlanner](https://github.com/AkbulutBB/SpineForgePlanner), but built for convenience on an iPhone rather than DICOM precision on a desktop.

Not a diagnostic device. Angles only by default; anything that needs real-world scale is optional.

## Key decision: web app (PWA), not a native iOS app

A Progressive Web App installed to the home screen covers everything needed:

| Need | PWA on iPhone |
|---|---|
| Take a photo or pick one from the library | Yes, standard file picker offers Camera / Photo Library / Files |
| Pinch-zoom, pan, drag landmarks | Yes, touch and pointer events on a canvas |
| Works with no signal (OR, basement clinic) | Yes, service worker caches the app |
| Home-screen icon, full-screen | Yes, "Add to Home Screen" |
| Save or share the annotated image | Yes, iOS share sheet |
| Images stay on the phone | Yes, all processing is in the browser; nothing is uploaded |

What native would add (not needed now): App Store distribution and deeper Photos integration. It costs $99/year, needs a Mac and Xcode, and medical-measurement apps draw extra App Store review. If that is ever wanted, the same web code can be wrapped with Capacitor without a rewrite.

## What changes because the input is a photo, not DICOM

1. **No scale.** Angles are scale-independent, so they are unaffected. Lengths (SVA, C2–C7 SVA) are not available unless the user calibrates against a known length. Angular substitutes for global alignment (T1 pelvic angle, global tilt) need no calibration and are included instead.
2. **Perspective distortion.** A photo of a monitor taken off-axis skews angles; uniform scaling does not, but keystone does. Mitigations: an on-screen tip to shoot square-on (or use a screenshot), and later an optional four-corner straighten tool.
3. **Finger covers the target.** Each landmark gets a magnifier loupe offset above the finger, and every point stays draggable after placement.
4. **Large photos.** iPhone photos are 12–48 MP and Safari caps canvas size, so images are downscaled on load (about 4096 px on the long edge). This does not affect angles.
5. **Patient identifiers.** Photos of screens often include a name or MRN. Nothing leaves the device, and exported images include only the cropped view the user chooses.

## Features

### Phase 1 — Quick measure (MVP)
- Load a photo from camera or library; EXIF orientation handled
- Pinch-zoom, pan, rotate 90°, flip, brightness/contrast
- Free tools: Cobb angle (two lines), three-point angle, line-to-vertical and line-to-horizontal
- Loupe for precise placement; drag to adjust; undo; delete
- Live angle labels drawn on the image
- Export the annotated image through the share sheet; copy results as text

### Phase 2 — Guided sagittal workflow
Step-by-step prompts ("tap the anterior S1 endplate"), skippable so partial sets still give results.

- Pelvic: PI, PT, SS (femoral heads as circles, sacral endplate)
- Lumbar: LL (L1–S1), L4–S1 lordosis, PI–LL mismatch
- Thoracic: TK (T4–T12), T1 slope
- Cervical: C2–C7 lordosis, T1S–CL
- Global, angular only: T1 pelvic angle (TPA), global tilt
- Interpretation helpers: SRS-Schwab modifiers for PT and PI–LL, age-adjusted targets, Roussouly type
- Coronal: multiple Cobb angles on one image

### Phase 3 — Install and deploy
- PWA manifest, icons, offline service worker
- Deploy to static HTTPS hosting
- On-device test pass on iPhone Safari

### Automatic guess (added after the first release)
A first guess of the sagittal landmarks, for the user to drag, keep or delete; never a measurement on its own.
- Guessed: the femoral heads, the S1, L4 and L1 endplates and the L1 body, placed as ordinary guided landmarks with a question mark until moved or kept; PI, PT, SS, LL, L4–S1, PI−LL and the L1 pelvic angle follow from them. Auto again replaces only untouched guesses; Save labels marks untouched guesses `"annotator": "auto"`.
- Where the guess comes from, in order: (1) **a detector file the user adds** ("Add detector file" on the start screen; checked, kept on the device in IndexedDB, removable), run on the device; (2) **a detector file beside the app**, only in a test build made to look for one; (3) **a detector service the user runs**, which is sent the photo. With none, the app is exactly as before and fetches nothing new.
- On the device the photo never leaves the page: it is read from the app's canvas, turned grey and given to a small WebGPU engine (hand-written shaders for this one family of networks, no machine-learning runtime) that runs one network in two looks: the whole picture shrunk, to find the spine; then a crop framed from S1, which gives the lumbar endplates, the femoral heads and both ends of S1. About a second on a phone. The engine is started once, self-tested and warmed up when the detector is found, and held.
- The network and every number of its reading come in the detector file, which is made and trained separately and is not part of this repository. Without WebGPU (or if the engine's self-test fails) the app says so in one line and makes no guess.

### Phase 4 — Optional, later
- Four-corner perspective straighten
- Calibration against a known length to unlock SVA and other distances
- Save cases on-device and compare pre-op to post-op
- Osteotomy and cage simulation (the planning side of SpineForgePlanner)

## Technical design

- **Stack:** Vite + TypeScript, single-page app, HTML canvas for rendering. No backend, no accounts, no analytics.
- **Structure:**
  - `src/geometry.ts` — pure functions for angles, unit tested
  - `src/sagittal.ts` — guided landmarks and spinopelvic parameter calculations
  - `src/model.ts`, `src/draw.ts` — measurement model and overlay drawing (screen, loupe, export)
  - `src/image.ts`, `src/export.ts` — photo loading/transforms and share/export
  - `src/main.ts` — viewer, touch handling and UI
  - `src/labels.ts` — the `spine-labels/1` record (Save labels) and the way back from it (a guess)
  - `src/auto.ts` — finding a detector and asking it for a guess
  - `src/detector/` — the on-device detector: the engine and the landmark path (copied from the detector's own repository by `scripts/sync_detector.py`), the detector file's format (`file.ts`), the conversion of its answer to a `spine-labels/1` record (`record.ts`), and keeping the added file (`store.ts`)
- **Tests:** Vitest on the geometry module with known-answer cases, including checks that PI = PT + SS and that results survive image flip and rotation; on the label record; and on the detector file's format (a tiny made-up file) and the guess's conversion.
- **Hosting:** static files on GitHub Pages or Cloudflare Pages (both free, HTTPS). During development, the Vite dev server is reachable from the phone on the same Wi-Fi.

## Licensing and naming

SpineForgePlanner is GPL-3.0. This project is written from scratch using standard published measurement definitions, with no code copied, so it is not bound by that licence. "SpineForge" is the original author's name and logo; this app should have its own name before it is shared publicly.

## Routine maintenance

There is no server and no data store, so there is little to clean:

- **On the phone:** images live in memory only and are gone when the app closes. A "Clear" button resets the session. A detector file the user added (about 13 MB) is the only thing kept; "Remove detector file" on the start screen deletes it. If case saving is added in Phase 4, it gets a "Delete all saved cases" control and a storage-used readout.
- **App cache:** the service worker cache is versioned per release and old versions are deleted on activation, so stale files do not accumulate.
- **Development machine:** `npm run clean` removes `dist/`, test coverage and Vite's cache. `node_modules/` and `dist/` are git-ignored, and so are detector files (`public/detector/`, `spine-detector*`), which hold a trained network and never belong in the repository. Test builds are made outside the repository.
- **Dependencies:** `npm outdated` and `npm audit` once a quarter; the dependency list is kept short on purpose.

## Project records

- `TODO.md` in this directory tracks progress.
- A summary note goes in the Obsidian vault at `~/Anansi/Projects/`.
