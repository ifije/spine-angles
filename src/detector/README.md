# The on-device detector

The code that works out the automatic guess on the device: a small WebGPU engine written for one family of networks
(`hand/engine.mjs`, `hand/backend-hand.mjs`), the path that turns a photo into landmarks (`combo.mjs`, with `decode.mjs`,
`order.mjs` and `img.mjs`), and the app's own front for them (`index.ts`, `file.ts`, `record.ts`, `store.ts`).

The `.mjs` files are copied from the detector's own repository by `scripts/sync_detector.py` and kept as they are there.
Their comments mention experiments and result files by name; those notes are kept with that repository, not here.

The trained network is not in this repository. It comes in a detector file (see the README, "Automatic guess").
