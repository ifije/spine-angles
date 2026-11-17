# Spine Angles

A phone-first web app for quick angular spine measurements on ordinary photos of radiographs.
Take a picture of the screen, tap a few landmarks, read the angles.

- **Free tools:** Cobb angle, three-point angle, slope to horizontal or vertical.
- **Guided sagittal workflow:** PI, PT, SS, LL, L4–S1, PI−LL, TK, T1 slope, C2–C7 lordosis,
  T1S−CL, T1 pelvic angle, L1 pelvic angle and global tilt, with Schwab modifiers and
  age-adjusted targets.
- **Guided coronal workflow:** Cobb angle per curve (proximal thoracic, main thoracic,
  thoracolumbar/lumbar, lumbosacral fractional), pelvic obliquity and T1 tilt.
- **Private:** everything runs in the browser. Photos are never uploaded or stored.
- **Installable:** add it to the iPhone home screen from Safari's share menu; it then works offline.

Angles only. A photo has no reliable scale, so distances such as SVA are not offered.
Measurements are approximate and not for diagnostic use.

## Using it well

- Shoot square-on to the monitor, or use a screenshot. An off-axis photo skews angles.
- Use **Adjust → Level** if the film is tilted in the photo. PT, SS and T1 slope depend on true vertical.
- Drag any point to refine it; a magnifier appears while you drag. Pinch to zoom, drag to pan.
- **Share** exports exactly what is on screen, so pan or zoom to leave patient identifiers out of frame.

## Development

```
npm install
npm run dev      # dev server, reachable from a phone on the same Wi-Fi
npm test         # measurement unit tests
npm run build    # type-check and build to dist/
npm run clean    # remove build output and caches
```

Pushing to `main` runs the tests and deploys to GitHub Pages.
`python3 scripts/make_icons.py` regenerates the app icons.

See [PLAN.md](PLAN.md) for design notes and [TODO.md](TODO.md) for what is left.

Inspired by [SpineForgePlanner](https://github.com/AkbulutBB/SpineForgePlanner); written independently and shares no code with it.
