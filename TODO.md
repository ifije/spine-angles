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
- [x] Schwab modifiers, age-adjusted targets, Roussouly grouping by SS
- [x] Multi-curve coronal Cobb (add as many Cobb measurements as needed)

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
