# Vendored libraries

Copies of the ESM builds (`dist/esm/*.js`) of:

- `@ffmpeg/ffmpeg` 0.12.10 → `vendor/ffmpeg/` (MIT license, https://github.com/ffmpegwasm/ffmpeg.wasm)
- `@ffmpeg/util` 0.12.1 → `vendor/ffmpeg-util/` (MIT license, same repository)

Two small patches, marked `[Reel Maker patch]`:

- `vendor/ffmpeg/worker.js` reports each loading step ("worker started", "importing the engine
  script", "compiling and starting the engine", …) and any error to the page's log, including
  what the engine prints while starting.
- `vendor/ffmpeg/classes.js` reports worker load errors and crashes and rejects pending calls.
  Upstream leaves them waiting forever, which is how a failed load looked like a hang.

They live here rather than on a CDN because `@ffmpeg/ffmpeg` starts a Web Worker from its own
folder, and browsers only allow workers from the page's own site. The large ffmpeg core
(`@ffmpeg/core`, about 30 MB) still loads from unpkg as a blob URL, which is allowed.

To update, run `npm pack @ffmpeg/ffmpeg@<version> @ffmpeg/util@<version>`, extract, and copy
`package/dist/esm/*.js` into these folders.
