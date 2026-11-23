import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// A test build (SPINE_ANGLES_TEST_BUILD=1) looks for a detector file served beside the app (detector/index.json) and has
// no offline mode: no service worker and no web app manifest, so no install prompt. The normal build is unchanged.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const testBuild = env.SPINE_ANGLES_TEST_BUILD === '1'

export default defineConfig({
  // Relative paths so the build works from any sub-path (e.g. GitHub Pages).
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __DETECTOR_BESIDE__: JSON.stringify(testBuild) },
  plugins: [
    VitePWA({
      disable: testBuild,
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: 'Spine Angles',
        short_name: 'Spine Angles',
        description: 'Quick angular spine measurements on photos. Nothing leaves your device.',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Each release gets a new precache; caches from older releases are deleted.
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'] },
})
