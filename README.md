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

Everything happens on your device. Photos are not uploaded, and no photo is kept after you close the app. The only file the app keeps is the landmark detector for the automatic guess (about 13 MB, downloaded once). Sharing an image is the only way anything leaves the phone, and you choose where it goes. (The one exception is a detector service you run yourself, described under Automatic guess: then each photo you open is sent to it.)

## Taking a good photo

- Shoot **square-on** to the monitor, or use a screenshot. A photo taken at an angle skews the measurements.
- If the film sits tilted in the photo, use **Adjust → Level** to straighten it. Measurements against vertical or horizontal (PT, SS, T1 slope, pelvic obliquity, T1 tilt) depend on this; angles between two lines (Cobb, lordosis, kyphosis) do not.
- Lengths such as SVA are not offered, because a photo has no reliable scale.

## Measuring

### Basic tools (Tools, in the bottom bar)

Tap **Tools** and choose one. Tap the one that is out again to put it away; tap anywhere else to close the chooser.

| Tool | Taps | Gives |
|---|---|---|
| **Cobb** | Both ends of one endplate, then both ends of the other | Angle between the two lines |
| **Angle** | Arm, vertex, arm | Angle at the vertex |
| **Slope** | Two ends of a line | Angle to horizontal or vertical, whichever is nearer |

While one is out, only the measurement being placed is shown: the landmarks, the other lines and a planned PSO or cage come back when it is finished or cancelled.

### Guided measurements

Tap **Guided** and choose **Sagittal** or **Coronal**. Each measurement is listed with its value once it can be worked out, and with the landmarks it uses as small tags, the same tags that are drawn on the image (FH, S1, L4, L1, T4 …):

- a filled tag is placed;
- a tag with a question mark (`S1?`) was placed by the automatic guess and nobody has checked it yet;
- a hollow, dashed tag is not placed yet.

A measurement that cannot be worked out yet says what it is missing, for example "needs T4 body" or "needs 3 landmarks".

Tap a measurement to open its page. It lists every landmark the measurement needs, says whether each is placed, guessed or not placed, and offers what you can do with it:

- **Place** a landmark that is not there. The page closes, the bar at the bottom of the image asks for each tap, and then the page comes back with the value.
- **Place the missing landmarks** does this for all of them, in the usual order (from the hips upwards). **Skip** a landmark you cannot see; **Done** stops early. **Undo** takes back one tap at a time.
- **Show** moves the image so the landmark is in view and selects it.
- **Keep** accepts a guessed landmark where it is; its question mark goes.
- **Place again** asks for a landmark anew; the old one stays until your first tap.
- Once the measurement has a value, **Show on the image** draws only that one.

Landmarks are shared: one you place for PI is used by every measurement that needs it. The second femoral head is optional; with one head, its centre is used. If the heads overlap, tap **Skip** when the app asks for the second one.

In **Results**, **Not measured yet** lists the measurements of the current view that have no value yet and what each one needs. Tap one to open its page.

- **Sagittal:** PI, PT, SS, LL, L4–S1, PI−LL, thoracic kyphosis (T4–T12), L1 pelvic angle, T4 pelvic angle, T1 pelvic angle, global tilt, T1 slope, C2–C7 lordosis, T1S−CL.
- **Coronal:** Cobb for the proximal thoracic, main thoracic, thoracolumbar/lumbar and lumbosacral fractional curves; pelvic obliquity; T1 tilt.

On sagittal endplates, tap the **anterior corner first**; that tells the app which way the patient faces. If it guesses wrong, use the **Facing** button in Results. On coronal films the order does not matter, and sides are reported as "higher on image left/right".

Each guided result is drawn on the image where it is measured. Tap a result in **Results** to show only that one.

### Planning a PSO

Tap **PSO** in the bottom bar to plan a pedicle subtraction osteotomy on the photo.

1. Tap the **hinge**: the front of the vertebral body, where the wedge comes to a point.
2. Tap the two **back points**, where the upper and lower cuts meet the back wall of the body, in either order. Both cuts carry on straight through the posterior elements, so everything inside the wedge is taken out. The wedge angle is shown at the hinge. Drag any of the three points to adjust them.
3. Drag the **slider** to close the wedge. Everything above it turns about the hinge; the pelvis and everything below stay where they are.
4. Tap **Done**. The landmarks come back, those above the wedge moved with it, and **Results** shows the *Plan* section: the wedge, and LL, L4–S1, PI−LL, L1PA, T4PA and TPA (and anything else the plan changes) before and after. Its **Clear** removes the plan; **✕** beside a step removes that step.

### Planning an interbody cage

Tap **Cage** in the bottom bar to change the lordosis of a disc space, as an interbody cage would. A plan can have several cages.

1. Tap the **front and back corners of the upper endplate** of the disc, then the **front and back corners of the lower endplate**. The disc's lordosis is shown in front of it.
2. Drag the **slider**, or tap **−** and **+** for one degree at a time, to set the angle the disc should have. Everything above the disc turns about the back of the disc, so the disc opens in front; the pelvis and everything below stay where they are. Posterior elements that would then overlap are drawn with the upper one on top.
3. Tap **Add** for another cage at another disc, and tap its four corners the same way. Cages cannot overlap: a corner inside another cage, or a disc that would run into one, is refused with a message.
4. To change a cage, tap its disc on the photo (or its row in Results): its slider comes back, and its corners can be dragged, even with the plan shown; a corner moved keeps the cage's change of angle. **Delete** takes out the cage being changed; the others stay. Cages are numbered in the order they were made.
5. Tap **Done**. Results shows each cage in the *Plan* section with the change it makes; tap a row to change that step, or its ✕ to take it out.

A PSO and cages can be planned on the same film: each piece of the spine turns with every cut below it, and Results shows the whole plan before and after. Once the points of a new step are placed, the plan is shown again as it was.

While the PSO or Cage tool is out, the landmarks and measurements are hidden so that only the photo and the plan are on screen. The photo itself is never changed. Because the pelvis is held still, PI, PT and SS do not change; in a patient, PT would usually fall after the correction. **Share** saves the view as it is, with a line saying what the plan shows. Choosing another tool puts the picture back as it was first, so new points land where they look. Place S1 and L1 (and the femoral heads for PI−LL and the pelvic angles) to see the numbers; the automatic guess places them for you.

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

### Automatic guess

The app finds the main landmarks itself and leaves the checking and correcting to you. About a second after you open a photo (a few seconds in a browser without WebGPU, see below), the femoral heads, the S1 endplate, the L4 and L1 endplates and the L1 body are placed as ordinary landmarks, and PI, PT, SS, LL, L4–S1, PI−LL and the L1 pelvic angle are shown from them.

- **Every guessed landmark is unchecked** until you move it or keep it. It carries a question mark (`S1?`) until then.
- Drag any of them into place, or tap one and choose **Delete** if it is wrong (a femoral head drawn where there is none, say) or **Keep** if it is right. Moving or keeping a landmark removes its question mark, and the angles follow. **Undo** takes back the whole guess.
- **Auto** (top bar) guesses again and replaces only the guesses you have not touched.
- In **Save labels**, a landmark left exactly where the guess put it is recorded with `"annotator": "auto"`; everything you placed, moved or kept has `null`.

**How it works.** The guess is worked out on your phone; the photo is sent nowhere. The landmark detector it needs (about 13 MB) is downloaded once, the first time the app opens, and kept on the phone; after that it is read from the phone, so the guess also works with no signal. The start screen says when it is downloading and when it is ready. A new version of the detector is downloaded once in the same way. If you open a photo before the detector is ready, a line at the top of the photo says how far the download is and the landmarks appear when it is done; if the download stops, the line says so and offers **Try again**.

**Fast with WebGPU, slower without.** With WebGPU, a graphics feature of recent browsers, the guess runs on the phone's graphics chip and takes about a second. Without it, the app runs the same network on the phone's processor: the guess is the same, it takes a few seconds (the start screen says about how many), and the first time the app also downloads what that needs, about 4 MB more, kept on the phone like the detector. On an iPhone, Safari has WebGPU from iOS 26; on iOS 17.4 to 18 it can be switched on (Settings, Apps, Safari, Advanced, Feature Flags, WebGPU). Elsewhere a current Chrome, Edge or Safari has it. The start screen's **Make it faster** says the same. Where neither way can run, the start screen says so in one line and everything else works as usual.

**Turning it off.** On the start screen, **Turn off** stops the automatic guess, stops a download in progress and removes what it had downloaded from the phone. **Turn on** downloads it again.

**Its limits.** The landmark network was trained on lateral radiographs of the lumbar spine and pelvis, and on copies of them altered to look like phone photographs of a screen (see Acknowledgements). It is meant for lateral films of a standing patient. It can be wrong, and on some photos it finds nothing. It has not been validated and is not for diagnosis: check every landmark before you use a value.

**Other detectors.** On the start screen, **Use a different detector file** lets you add a detector file of your own; it is kept on the phone and used instead of the built-in one until you remove it. A detector service that you run yourself is used only when the phone cannot run a detector: the app looks for one at the address it was loaded from, or at `?detector=http://host:port/` added to the page address (remembered; `?detector=` forgets it). It is any service that answers `GET health` with `{"service": "spine-guess"}` and `POST guess` (the photo as JPEG) with a record in the Save labels format, and each photo you open is sent to it.

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

The on-device detector's code (a small WebGPU engine and the landmark path that reads the network's answers) lives in `src/detector/`. It is written and tested in the detector's own repository; `python3 scripts/sync_detector.py` copies it again and lists any file that has changed (`--check` only lists). The detector file's format is described in `src/detector/file.ts`.

The built-in detector is the one file `public/detector/spine-detector-STAMP.bin` (the trained network, 12.7 MB), named by its content stamp, with `public/detector/index.json` naming it, and beside it the network's graph for the slower way (`spine-detector-STAMP.graph.onnx`, 34 kB, no weights in it: on the device the weights are unpacked from the detector file). `python3 scripts/publish_detector.py FILE` puts a new detector file (and its graph) there and removes the old one; the app then downloads the new one once. No other trained numbers are in this repository; the tests use a tiny made-up detector file.

The slower way runs ONNX Runtime Web's processor-only build (the exact version in `package.json`), copied from `node_modules` into `public/ort/` by `scripts/copy_runtime.mjs` before every build (not tracked), with its wasm also compressed. The app fetches it, and its own worker (`src/detector/cpu-worker.ts`), only on a device that cannot run the WebGPU engine, and keeps them on the device. The service worker's offline copy leaves `detector/`, `ort/` and that worker out: the app keeps them itself.

`SPINE_ANGLES_TEST_BUILD=1 npm run build` makes a build with no offline mode and no install prompt, for a host that serves the detector in pieces (`detector/index.json` can name pieces instead of one file).

## Licence

Copyright (C) 2026 Wolfray Applied Technologies, LLC.

Spine Angles is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

The "Spine Angles" name and icon are not covered by that licence.

## Contributing

Bug reports and suggestions are welcome as issues. Code contributions are not accepted without a contributor agreement in place first; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

The landmark network behind the automatic guess was trained on two sets of radiographs, and we thank their authors for making them available:

- **Burapha Spine Dataset (BUU-LSPINE)**, Faculty of Informatics, Burapha University, Thailand: https://services.informatics.buu.ac.th/spine/ (its lateral lumbar spine films and vertebral edge annotations). Please cite: Klinwichit P. et al., "BUU-LSPINE: A Thai Open Lumbar Spine Dataset for Spondylolisthesis Detection", *Applied Sciences* 2023, 13(15), 8646. https://doi.org/10.3390/app13158646
- **Sagittal pelvic radiographs of Chai et al.** (femoral head and sacral plate landmarks): the images, "Sagittal Pelvic Radiographs: A Dataset for Clinical Quantification of Radiographic Annotation Accuracy", figshare, https://doi.org/10.6084/m9.figshare.23820879.v1 ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), and the annotations, "Data records for Clinical Quantification of Radiographic Annotation Accuracy", figshare, https://doi.org/10.6084/m9.figshare.23831553.v1 (CC0). Described in: Chai Y., Boudali A.M., Maes V., Walter W.L., "Clinical benchmark dataset for AI accuracy analysis: quantifying radiographic annotation of pelvic tilt", *Scientific Data* 2024, 11, 1162. https://doi.org/10.1038/s41597-024-04003-7

The network's backbone started from ImageNet-pretrained ResNet-18 weights (torchvision's ResNet-18, as provided by [segmentation_models_pytorch](https://github.com/qubvel-org/segmentation_models.pytorch)). None of these images are part of this app or repository; only the trained network is.

In a browser without WebGPU the network runs on [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (version 1.31.1, processor-only build), Copyright (c) Microsoft Corporation, under the MIT License; its licence text is served with it (`ort/LICENSE.txt`) and at the top of its main file.

**Burapha University and the datasets' authors have not reviewed or endorsed this app.**

Inspired by [SpineForgePlanner](https://github.com/AkbulutBB/SpineForgePlanner) by Dr. Bahadır Akbulut. This project was written independently and shares no code with it.
