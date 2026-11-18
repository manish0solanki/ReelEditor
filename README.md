# Reel Maker

A webpage that turns a landscape performance video into a polished vertical 1080×1920 reel for Instagram. Everything runs in the browser, so the video is never uploaded anywhere.

## What it does

- **Any orientation:** landscape, portrait, and tall phone videos all work.
- **Trims to the song automatically:** listens to the video's sound, starts the reel 2 seconds before the singing begins, keeps any instrumental ending, and cuts the talking or silence after the song. The Start and End boxes are filled in so you can adjust them, or untick the option and set them yourself (accepts `1:23` or `83`).
- **Keeps the singer centered** by detecting the face in frames sampled every half second, then smoothing the crop path so it doesn't jitter. If no face is found, it uses the fallback position slider.
- **Animated lyric captions** timed to the original video, in three styles: **Bold pop** (2–3 big words at a time, the current word highlighted, each group popping in), **Karaoke** (the whole line, each word lighting up as it's sung), or **Classic** (the whole line). Long lines wrap automatically.
- **Title** shown over the first few seconds.
- **Color and sharpness boost** (optional).
- **Fades** in from and out to black.
- **Timer while it builds:** shows time elapsed and about how long is left, then the total when it's done. It remembers how fast your device was, so later reels get an estimate straight away.
- **Vocal-friendly audio**: fades, light compression, and loudness normalization to about −14 LUFS, the level most platforms expect.

## Run it locally

From this folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Put it online (free) with GitHub Pages

1. Create a new repository on GitHub and push this folder to it.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
4. Open the address GitHub shows, on your phone or computer.

## Tests

The editing logic in `editor.js` has tests that run with Node 18 or newer:

```bash
npm test
```

If a native `ffmpeg` is installed, one extra test renders a short reel with the real command and checks the output size and audio rate. Without ffmpeg that test is skipped.

## Lyrics format

One line per lyric, starting with the time in the original video:

```
0:12 First line of the song
0:17 Second line
0:22 Third line
```

Times are measured from the start of the original video, not from the trimmed clip.

Word-by-word timing is estimated by spreading each line's words over its singing time, giving longer words more time. For a tighter fit, add when the line's singing ends:

```
0:12-0:16 First line of the song
```

Long lines wrap onto two lines automatically, and shrink a little if they still don't fit. The song title wraps the same way.

## Limits and notes

- **Language:** captions use the bundled Poppins font, which covers the Latin alphabet. Hindi and other scripts need a font file that includes them, placed in `fonts/` and named in `app.js`. Romanized lyrics work now.
- **Song detection** uses Google's YAMNet sound classifier (through MediaPipe), loaded from the internet the first time. It scores each second of sound for singing, music, speech, and applause. It skips an instrumental intro and stops when the music stops. If it can't pick out the singing, it trims to the music instead. If it finds no music, it leaves Start and End for you to set. A phone recording where the voice is clear works best.
- **Face tracking** uses MediaPipe's face detector, loaded from the internet the first time. It works best when the singer's face is clearly visible and reasonably large.
- **Speed:** the multi-threaded video engine is used where the browser allows it, which needs the page to be "cross-origin isolated". `vercel.json` sends the two headers for that on Vercel. On hosts that can't set headers (such as GitHub Pages), and in Safari, the slower single-threaded engine is used. In a headless-Chrome test on 4 cores, a 20-second reel took 34 s multi-threaded, 60 s single-threaded, and 118 s with the old settings. Even so, building a reel takes a while on a phone, and very long clips can run out of memory. Instagram reels can be at most 3 minutes.
- **Any orientation:** landscape, square, portrait, and tall phone videos are all accepted. Wider sources crop sideways and taller ones crop up and down, and face tracking follows the singer on that axis.
- **Audio required:** videos with no audio track will fail at the audio step.
- **Testing:** the caption, crop, and fade logic are covered by `npm test`. The full app has been run end to end in headless Chromium, but face tracking has only been tried on test footage without faces, so bug reports are welcome.
- **Music rights:** covers of copyrighted songs can be muted or taken down on Instagram. Use Instagram's licensed music, original arrangements, or royalty-free tracks for the audio.

## Files

- `index.html`: the page layout.
- `style.css`: styling.
- `editor.js`: pure editing logic (crop path, captions, ffmpeg command). No browser code, so it can be tested separately.
- `app.js`: browser glue: file input, face tracking, the ffmpeg engine, and the download.
- `fonts/Poppins-Bold.ttf`: caption font (SIL Open Font License).
- `test/`: tests for `editor.js`.
- `vercel.json`: the headers that let the faster multi-threaded engine run on Vercel.
- `vendor/`: the ffmpeg.wasm wrapper, served from this site because browsers won't start its worker from a CDN. See `vendor/README.md`.
