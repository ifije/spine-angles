# The on-device detector

The code that works out the automatic guess on the device: a small WebGPU engine written for one family of networks
(`hand/engine.mjs`, `hand/backend-hand.mjs`), the path that turns a photo into landmarks (`combo.mjs`, with `decode.mjs`,
`order.mjs` and `img.mjs`), and the app's own front for them (`index.ts`, `file.ts`, `record.ts`, `download.ts`, `store.ts`).

The `.mjs` files are copied from the detector's own repository by `scripts/sync_detector.py` and kept as they are there.
Their comments mention experiments and result files by name; those notes are kept with that repository, not here.

The trained network is not in this code. It comes in one detector file, published beside the app in `public/detector/` (see the README, "Automatic guess" and "Acknowledgements"); `download.ts` fetches it once and `store.ts` keeps it on the device.
