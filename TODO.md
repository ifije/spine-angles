# TODO

See [PLAN.md](PLAN.md) for the full plan. Live at https://ifije.github.io/spine-angles/

## Setup
- [x] Review SpineForgePlanner for scope
- [x] Write plan
- [x] Plan approved; scope (measurement first) and hosting (GitHub Pages) decided
- [x] Scaffold Vite + TypeScript project, git init, `.gitignore`, `npm run clean`
- [x] Create Obsidian note in `~/Anansi/Projects/Spine Angles.md`

## Phase 1 — Quick measure
- [x] Image load (camera/library/paste/drop), downscale, EXIF orientation
- [x] Canvas viewer: pinch-zoom, pan, rotate, flip, brightness/contrast/invert
- [x] Level (fine rotation) for tilted photos
- [x] Geometry module with unit tests
- [x] Loupe and draggable points
- [x] Tools: Cobb, three-point angle, slope to horizontal/vertical
- [x] Undo, delete, clear
- [x] Export annotated image; copy results

## Phase 2 — Guided sagittal workflow
- [x] Landmark prompts with skip, grouped by region
- [x] PI, PT, SS
- [x] LL, L4–S1, lordosis distribution, PI–LL
- [x] TK, T1 slope
- [x] C2–C7 lordosis, T1S–CL
- [x] TPA, L1PA, global tilt
- [x] T4 pelvic angle (T4 body placed by hand), shown with its difference from L1PA
- [x] Schwab modifiers, age-adjusted targets, Roussouly grouping by SS
- [x] Multi-curve coronal Cobb (add as many Cobb measurements as needed)

## Coronal (added after first release)
- [x] Sagittal / Coronal switch in the Guided and Results panels
- [x] Cobb per curve: proximal thoracic, main thoracic, TL/lumbar, fractional
- [x] Pelvic obliquity, T1 tilt (against horizontal, with the high side)
- [ ] Other coronal angles if wanted: clavicle angle, L4/L5 tilt, end-vertebra tilt, sacral obliquity
- [ ] Coronal balance (needs calibration, or an angle-based stand-in)

## Labelling (added 2026-11-18)
- [x] Save labels: photo plus a landmark record in the `spine-labels/1` format
- [ ] Check Save labels on a real iPhone (share sheet with two files, Save to Files)
- [ ] Reopen a saved photo and record to continue or correct it
- [ ] Option to save only the on-screen region, to keep names out of the saved photo

## Automatic guess (added 2026-11-20; on the device 2026-11-23)
- [x] Guess from a detector service the user runs: Auto button, question marks, Keep, Delete, Auto again, `"annotator": "auto"` in Save labels
- [x] On-device detector: WebGPU engine and landmark path in `src/detector/`, copied by `scripts/sync_detector.py`
- [x] Detector file format; "Add detector file" / "Remove detector file", kept on the device
- [x] Test build that finds a detector file beside the app (`SPINE_ANGLES_TEST_BUILD=1`), no offline mode
- [x] One plain line when the browser has no WebGPU
- [ ] Try the on-device guess on a real iPhone in Safari, installed and not (does Safari offer WebGPU there?)
- [ ] A way to guess without WebGPU (the processor), if Safari needs it
- [x] The detector's code is published with the app (2026-11-23)
- [x] The trained detector is published with the app (0.4.0): downloaded once in the background, kept on the device by its stamp, works offline, replaced when a new one is published; one switch to turn it off and on; Credits on the start screen and Acknowledgements in the README
- [ ] Check the first download and offline use on a real iPhone (installed and not), and how long the first download takes there
- [x] T4 pelvic angle as a guided measurement (T4 body placed by hand)
- [x] Guided: each measurement shows the landmarks it needs, which are placed, guessed or missing, and places the missing ones
- [ ] Check L1 pelvic angle from the guess against hand-placed landmarks
- [ ] Find the T4 body automatically (needs films with the thoracic spine marked)

## Phase 3 — Install and deploy
- [x] Manifest, icons, service worker with versioned cache
- [x] Deploy to GitHub Pages (auto-deploys on push to `main`)
- [x] Smoke test in phone-emulated Chromium
- [ ] Test on a real iPhone in Safari and as a home-screen app
- [ ] Check reference formulas against sources (Lafage age targets, L1PA = 0.5 × PI − 21, TPA < 14°)
- [ ] Choose a final name ("Spine Angles" is a working name)

## Phase 4 — Later
- [ ] Perspective straighten
- [ ] Length calibration (SVA)
- [ ] Saved cases, pre/post comparison
- [ ] Osteotomy and cage simulation
- [ ] Full Roussouly typing (needs lordosis apex, not just SS)
