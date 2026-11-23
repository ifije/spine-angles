# Spine Angles

Quick angle measurements on a phone photo of a spine radiograph. Take a picture of the screen, tap a few landmarks, read the angles. No DICOM files, no account, nothing to install from an app store.

**Open it here: https://ifije.github.io/spine-angles/**

> Measurements made on a photograph are approximate. This is a convenience tool, not a medical device, and is not for diagnostic use.

## Put it on your iPhone

1. Open the link above in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. Open it from the home screen. It runs full-screen and keeps working with no signal.

It also works in any modern browser on Android, tablets and desktop.

## Privacy

Everything happens on your device. Photos are not uploaded, and no photo is kept after you close the app; the only file the app keeps is a detector file, if you add one for the automatic guess. Sharing an image is the only way anything leaves the phone, and you choose where it goes. (The one exception is a detector service you run yourself for the automatic guess: then each photo you open is sent to it, as described below.)

## Taking a good photo

- Shoot **square-on** to the monitor, or use a screenshot. A photo taken at an angle skews the measurements.
- If the film sits tilted in the photo, use **Adjust → Level** to straighten it. Measurements against vertical or horizontal (PT, SS, T1 slope, pelvic obliquity, T1 tilt) depend on this; angles between two lines (Cobb, lordosis, kyphosis) do not.
- Lengths such as SVA are not offered, because a photo has no reliable scale.

## Measuring

### Basic tools (bottom bar)

| Tool | Taps | Gives |
|---|---|---|
| **Cobb** | Both ends of one endplate, then both ends of the other | Angle between the two lines |
| **Angle** | Arm, vertex, arm | Angle at the vertex |
| **Slope** | Two ends of a line | Angle to horizontal or vertical, whichever is nearer |

### Guided measurements

Tap **Guided**, choose **Sagittal** or **Coronal**, then tap the measurement you want. The app asks only for the landmarks that measurement needs, and reuses any you have already placed.

- **Sagittal:** PI, PT, SS, LL, L4–S1, PI−LL, thoracic kyphosis (T4–T12), L1 pelvic angle, T4 pelvic angle, T1 pelvic angle, global tilt, T1 slope, C2–C7 lordosis, T1S−CL.
- **Coronal:** Cobb for the proximal thoracic, main thoracic, thoracolumbar/lumbar and lumbosacral fractional curves; pelvic obliquity; T1 tilt.

On sagittal endplates, tap the **anterior corner first**; that tells the app which way the patient faces. If it guesses wrong, use the **Facing** button in Results. On coronal films the order does not matter, and sides are reported as "higher on image left/right".

Each guided result is drawn on the image where it is measured. Tap a result in **Results** to show only that one.

### Adjusting and correcting

- **Drag** any point to refine it. A magnifier appears while you drag.
- **Pinch** to zoom, **drag** the image to pan, **double-tap** empty space to fit.
- **Undo** steps back one action at a time.
- **Clear** (top bar) removes everything. In Results, each section has its own Clear. To remove one landmark, tap it on the image and choose Delete.
- Swipe a bottom panel down to close it.

### Getting results out

- **Share** saves or sends exactly what is on screen, with the values printed underneath. Pan or zoom first to keep a patient name out of frame.
- **Copy results** (in Results) puts the values on the clipboard as a table for Mail, Notes or Word, with plain text for everything else.

### Building a labelled set

**Save labels** (in Results) saves two files with the same name: the whole photo as loaded (JPEG, with no overlay and no brightness change) and a `.json` record of every landmark you placed. Use it to collect your own labelled films, for example to train or test automatic landmark detection.

- Each landmark is named by level and position: `S1_sup_ant`, `S1_sup_post`, `L1_sup_ant`, `T12_inf_post`, `T1_center`, `femoral_head_a_center`. The ends of coronal lines are `_l` and `_r` by image side.
- Coordinates are pixels of the saved photo, x to the right and y down. The Level rotation is recorded (`app.level_deg`) but not applied.
- Which end of an endplate is anterior comes from the Facing direction, so check **Facing** before saving.
- A landmark you skipped in a guided measurement is listed under `labels.not_visible`.
- The computed parameters are included under `measurements`.

Unlike Share, this saves the **whole photo**, including any name or date visible on it. Crop the photo before loading it if that matters. Nothing is uploaded; the files go wherever you send them from the share sheet.

### Automatic guess (optional, needs a detector)

The app can find the main landmarks itself and leave the correcting to you. It is off unless the app has a detector, so for everyone else nothing changes and nothing is uploaded.

**What it does.** With a detector, an **Auto** button appears and each photo you open gets a first guess: the femoral heads, the S1 endplate, the L4 and L1 endplates and the L1 body, placed as ordinary landmarks. PI, PT, SS, LL, L4–S1, PI−LL and the L1 pelvic angle are shown from them at once. Each guessed landmark carries a question mark (`S1?`) to show that nobody has checked it.

- Drag any of them into place, or tap one and choose **Delete** if it is wrong (a femoral head drawn where there is none, say) or **Keep** if it is right. Moving or keeping a landmark removes its question mark, and the angles follow. **Undo** takes back the whole guess.
- **Auto** again replaces only the guesses you have not touched.
- In **Save labels**, a landmark left exactly where the guess put it is recorded with `"annotator": "auto"`; everything you placed, moved or kept has `null`.
- A guess is a starting point, not a measurement: check every landmark before you use a value.

**Where the detector comes from.** The app looks, in this order:

1. **A detector file you added.** On the start screen, tap **Add detector file** and choose the file. The app checks it and keeps it on this device; **Remove detector file** in the same place deletes it again. The guess is then worked out on the phone itself, by its graphics chip, about a second after the photo opens, and the photo is sent nowhere. The detector file holds a landmark network that was trained separately; it is not included with the app.
2. **A detector file beside the app**, in a test build made for that (see For developers). It works the same way.
3. **A detector service you run yourself.** The app looks for one at the address it was loaded from, or at `?detector=http://host:port/` added to the page address (remembered; `?detector=` forgets it). A detector service is any service that answers `GET health` with `{"service": "spine-guess"}` and `POST guess` (the photo as JPEG) with a record in the Save labels format. Each photo you open is sent to that address, and only there.

The detector file needs **WebGPU**, a graphics feature of recent browsers. Where the browser does not offer it, the start screen says so in one line and no guess is made; everything else works as usual.

## Reference values

Results show Schwab modifiers, age-adjusted targets (enter the age in Results) and similar guides beside some values. These are aids, not recommendations; check them against your own sources before relying on them.

## For developers

```
npm install
npm run dev      # dev server, reachable from a phone on the same Wi-Fi
npm test         # measurement unit tests
npm run build    # type-check and build to dist/
npm run clean    # remove build output and caches
```

Vite and TypeScript, no backend. Pushing to `main` runs the tests and deploys to GitHub Pages. `python3 scripts/make_icons.py` regenerates the app icons. Design notes are in [PLAN.md](PLAN.md); open work is in [TODO.md](TODO.md).

The on-device detector's code (a small WebGPU engine and the landmark path that reads the network's answers) lives in `src/detector/`. It is written and tested in the detector's own repository; `python3 scripts/sync_detector.py` copies it again and lists any file that has changed (`--check` only lists). The detector file's format is described in `src/detector/file.ts`. No trained network is part of this repository.

`SPINE_ANGLES_TEST_BUILD=1 npm run build` makes a test build that also looks for a detector file served beside the app, in `detector/` (`detector/index.json` names the file, or its pieces for a host that limits a file's size), and has no offline mode or install prompt. The normal build never looks there.

## Licence

Copyright (C) 2026 Wolfray Applied Technologies, LLC.

Spine Angles is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

The "Spine Angles" name and icon are not covered by that licence.

## Contributing

Bug reports and suggestions are welcome as issues. Code contributions are not accepted without a contributor agreement in place first; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgement

Inspired by [SpineForgePlanner](https://github.com/AkbulutBB/SpineForgePlanner) by Dr. Bahadır Akbulut. This project was written independently and shares no code with it.
