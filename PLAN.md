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
- Where the guess comes from, in order: (1) **a detector file the user adds** ("Use a different detector file" on the start screen; checked, kept on the device in IndexedDB, removable), run on the device; (2) **the built-in detector** (since 0.4.0), published with the app in `public/detector/` (one file named by its content stamp; `index.json` names it, or pieces of it for a host that limits a file's size), run on the device; (3) **a detector service the user runs**, which is sent the photo, used only when the device cannot run a detector.
- The built-in detector (12.7 MB) is not part of the service worker's offline copy. The app downloads it in the background the first time it opens (the start screen shows the progress), keeps it in IndexedDB by its stamp, and reads it from there on every later opening: no request for the file, and the guess works offline. When `index.json` names a new stamp, the new file is downloaded and replaces the old one. If the download fails, the app works without a guess and tries again at the next opening (an older kept copy is used meanwhile); if storage is refused, the downloaded bytes are used for the session. One switch on the start screen turns the automatic guess off (remembered; it stops the download, removes the kept copies and asks no detector at all) and on again.
- **Without WebGPU (since 0.5.0) the slower way**: the same network on the processor through ONNX Runtime Web (processor-only build, MIT, one thread: the page is not cross-origin isolated), in a worker, behind the engine's interface, so the path and the record are the same. Used only where the engine cannot run (no WebGPU or adapter, or its self-test failed in 16-bit and 32-bit). It needs no second copy of the network: one graph without weights (34 kB, published beside the detector) serves both looks, the read look's weights unpacked from the detector file's 8-bit pack and the where look's made from them with the detector file's statistics. The runtime (about 4 MB compressed), the worker and the graph are fetched only then, once, and kept in IndexedDB (offline afterwards). The start screen says when the slower way is in use and about how long a photo takes (from its own warm-up looks), with "Make it faster" (iOS 26, or the Safari feature flag on iOS 17.4 to 18; a current Chrome, Edge or Safari). Where neither way runs: one plain line.
- **A photo opened before the detector is ready**: a line on the photo screen stays until the landmarks appear (looking for the detector, its download with progress, the slower way's download, getting ready, finding the landmarks with the seconds counting on the slower way); the Auto button shows the same state. A failure (a download that stops, a start that fails) stays on the line, in plain words, with "Try again"; Auto retries too. If the user starts placing landmarks by hand while waiting, nothing is placed by itself: the line says Auto is ready when it is.
- On the device the photo never leaves the page: it is read from the app's canvas, turned grey and given to a small WebGPU engine (hand-written shaders for this one family of networks, no machine-learning runtime) that runs one network in two looks: the whole picture shrunk, to find the spine; then a crop framed from S1, which gives the lumbar endplates, the femoral heads and both ends of S1. About a second on a phone. The engine is started once, self-tested and warmed up when the detector is found, and held.
- The network and every number of its reading come in the detector file, which is made and trained separately (on the BUU-LSPINE lumbar films and the sagittal pelvic radiographs of Chai et al.; credited in the README's Acknowledgements and in the app's Credits, with the statement that the datasets' owners have not endorsed the app). That file is the only trained content in this repository; the tests use a tiny made-up file. Where neither the engine nor the slower way can run, the app says so in one line and makes no guess.

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
  - `src/auto.ts` — finding a detector (and the slower way's files) and asking it for a guess
  - `src/waiting.ts` — what the photo screen says while a guess waits, runs or failed
  - `src/detector/` — the on-device detector: the engine and the landmark path (copied from the detector's own repository by `scripts/sync_detector.py`), the detector file's format (`file.ts`), the conversion of its answer to a `spine-labels/1` record (`record.ts`), downloading the built-in detector (`download.ts`), and keeping detector files on the device (`store.ts`)
- **Tests:** Vitest on the geometry module with known-answer cases, including checks that PI = PT + SS and that results survive image flip and rotation; on the label record; and on the detector file's format, its download (a tiny made-up file) and the guess's conversion.
- **Hosting:** static files on GitHub Pages or Cloudflare Pages (both free, HTTPS). During development, the Vite dev server is reachable from the phone on the same Wi-Fi.

## Licensing and naming

SpineForgePlanner is GPL-3.0. This project is written from scratch using standard published measurement definitions, with no code copied, so it is not bound by that licence. "SpineForge" is the original author's name and logo; this app should have its own name before it is shared publicly.

## Routine maintenance

There is no server and no data store, so there is little to clean:

- **On the phone:** images live in memory only and are gone when the app closes. A "Clear" button resets the session. The built-in detector (about 13 MB, kept by its stamp, replaced when a new one is published) and a detector file the user added are the only things kept; "Turn off" on the start screen removes the first, "Remove your detector file" the second. If case saving is added in Phase 4, it gets a "Delete all saved cases" control and a storage-used readout.
- **App cache:** the service worker cache is versioned per release and old versions are deleted on activation, so stale files do not accumulate.
- **Development machine:** `npm run clean` removes `dist/`, test coverage and Vite's cache. `node_modules/` and `dist/` are git-ignored, and so is any detector file outside `public/detector/` (`spine-detector*`): only the published one belongs in the repository. Test builds are made outside the repository.
- **Dependencies:** `npm outdated` and `npm audit` once a quarter; the dependency list is kept short on purpose.

## Project records

- `TODO.md` in this directory tracks progress.
- A summary note goes in the Obsidian vault at `~/Anansi/Projects/`.
