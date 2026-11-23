// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Wolfray Applied Technologies, LLC

// The processor-only build of ONNX Runtime Web (MIT licence, Copyright (c) Microsoft Corporation), copied from
// node_modules/onnxruntime-web into public/ort/ before every build and dev run, with public/ort/index.json naming the files,
// their sizes and the runtime's version. public/ort/ is not tracked: the files come from the exact version in package.json.
// The app fetches them only on a device that cannot run its own WebGPU engine (the slower way), keeps them on the device,
// and never otherwise. Their copyright and licence notice is at the top of ort.wasm.min.mjs and in LICENSE.txt beside them.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(app, 'node_modules', 'onnxruntime-web')
const out = join(app, 'public', 'ort')
const FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version
mkdirSync(out, { recursive: true })
const files = FILES.map((name) => {
  copyFileSync(join(src, 'dist', name), join(out, name))
  const f = { name, bytes: statSync(join(out, name)).size }
  if (name.endsWith('.wasm')) {
    // Also compressed (15 MB becomes 4 MB): a browser that can unpack it itself (DecompressionStream) fetches this one.
    const gz = gzipSync(readFileSync(join(out, name)), { level: 9 })
    writeFileSync(join(out, name + '.gz'), gz)
    f.gz = { name: name + '.gz', bytes: gz.length }
  }
  return f
})
writeFileSync(join(out, 'LICENSE.txt'), `ONNX Runtime Web ${version} (https://github.com/microsoft/onnxruntime)

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`)
writeFileSync(join(out, 'index.json'), JSON.stringify({ format: 'spine-runtime-index/1', runtime: 'onnxruntime-web', version, files }, null, 1) + '\n')
console.log(`public/ort/: ONNX Runtime Web ${version}, ${files.map((f) => `${f.name} ${(f.bytes / 1e6).toFixed(2)} MB${f.gz ? ` (${(f.gz.bytes / 1e6).toFixed(2)} MB compressed)` : ''}`).join(', ')}`)
