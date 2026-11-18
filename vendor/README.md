# Vendored libraries

Unmodified copies of the ESM builds (`dist/esm/*.js`) of:

- `@ffmpeg/ffmpeg` 0.12.10 → `vendor/ffmpeg/` (MIT license, https://github.com/ffmpegwasm/ffmpeg.wasm)
- `@ffmpeg/util` 0.12.1 → `vendor/ffmpeg-util/` (MIT license, same repository)

They live here rather than on a CDN because `@ffmpeg/ffmpeg` starts a Web Worker from its own
folder, and browsers only allow workers from the page's own site. The large ffmpeg core
(`@ffmpeg/core`, about 30 MB) still loads from unpkg as a blob URL, which is allowed.

To update, run `npm pack @ffmpeg/ffmpeg@<version> @ffmpeg/util@<version>`, extract, and copy
`package/dist/esm/*.js` into these folders.
