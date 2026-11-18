# Reel Maker

A webpage that turns a landscape performance video into a polished vertical 1080×1920 reel for Instagram. Everything runs in the browser, so the video is never uploaded anywhere.

## What it does

- **Any orientation:** landscape, portrait, and tall phone videos all work.
- **Trims to the song automatically:** listens to the video's sound, starts the reel 2 seconds before the singing begins, keeps any instrumental ending, and cuts the talking or silence after the song. The Start and End boxes are filled in so you can adjust them, or untick the option and set them yourself (accepts `1:23` or `83`).
- **Best moment (optional):** tick "Find the best moment" and choose 15, 30, 45 or 60 seconds. The app suggests the top 3 moments with a score and the reasons, and uses the best one. You can tap another to use it instead. Moments score higher for being the part that repeats most (usually the chorus, found by comparing the song's pitch patterns), for continuous singing, for loudness and energy, and for applause during or just after them. The start and end are moved to nearby quiet points so the clip doesn't cut mid-phrase. Untick it for the normal edit of the whole song.
- **Keeps the singer centered** by detecting faces in frames sampled every half second, then smoothing the crop path so it doesn't jitter. The detector also runs on overlapping square tiles of the frame, so a singer filmed from a few metres away is found too. If no face is found, it uses the fallback position slider.
- **Choose who to follow:** when you pick a video, the app looks at 8 frames across it. If there's more than one person, it shows each face so you can tap who the camera should follow ("Largest face" is the default). The chosen person is followed by their look (face and hair colours) and position together, so it keeps the right person when people move or cross, and it holds still rather than jump to someone else while they're hidden.
- **Write lyrics from the singing:** listens to the clip between Start and End with OpenAI's Whisper speech recognition (through Hugging Face's transformers.js, on the device: the model downloads once, 40 or 80 MB) and fills the lyrics box with timed lines (`m:ss-m:ss text`) to check and correct. Hindi is converted from Devanagari to everyday romanized Hindi ("tum hi ho"), since the caption font is Latin-only. Music tags, invented "thank you" lines and runaway repeats are removed. Speech recognition is made for talking, so sung words are often misheard: treat it as a draft.
- **Animated lyric captions** timed to the original video, in three styles: **Bold pop** (2–3 big words at a time, the current word highlighted, each group popping in), **Karaoke** (the whole line, each word lighting up as it's sung), or **Classic** (the whole line). Long lines wrap automatically.
- **Title** shown over the first few seconds.
- **Color and sharpness boost** (optional).
- **Fades** in from and out to black.
- **Timer while it builds:** shows time elapsed and about how long is left, then the total when it's done. It remembers how fast your device was, so later reels get an estimate straight away.
- **B-roll (optional):** add up to 8 of your own clips or photos (crowd, venue, band, instrument). The app places about 2.5-second cutaways every ~12, 8 or 5 seconds, where there's least singing, on the bar lines, and never over the opening title or the ending. Each fades in and out over the performance, filled to 9:16, while the performance's sound continues and the captions stay on top. Clips play from their middle (a different part each time one is reused); photos slowly zoom.
- **Background noise reduction (optional):** *Reduce* or *Remove more* takes out steady noise such as fans, AC hum, hiss and room rumble. The app measures the video's own noise floor from its quietest moments and tunes ffmpeg's `afftdn` filter to it. In tests with noise under speech, *Reduce* removed about 12 dB and *Remove more* about 26 dB of noise, with the speech level within about 1 dB. It can't remove other people talking.
- **Background music (optional):** either a **generated beat** (kick, snare and hi-hats synthesised in the browser, placed on your performance's own detected beats, so it follows your tempo and has no copyright issue), or **your own music file**, looped if it's short. The music fades in and out and is turned down automatically while you sing (side-chain ducking). Separate volume sliders for the music and the performance.
- **Match your music to the video (optional, with your own music file):** speeds the music up or down to the video's tempo (at most 10%, keeping its pitch; half and double tempo count as the same beat) and starts it where its bars line up with the video's, so steps and moves land on the music's beats. The video's beat comes from its sound, or from the people's **movement** (steps, claps, arm hits). *Automatic* uses the sound if it has a clear beat, otherwise the movement. To read the movement, the app plays the clip silently at double speed and measures how much each frame changes, so it takes about half the clip's length. In tests, 94 BPM music matched to a 100 BPM video landed every beat within 10 ms (from the sound) and within 25 ms of a figure's hops (from movement, in a video whose sound had no beat). The app says what it did, or why it couldn't.
- **Generated beat and beat cuts follow movement too:** when the performance's sound has no clear beat, the drums and cuts follow the people's movement instead.
- **Cut to the beat (optional):** finds the beats and bars (from your music file, or from the performance), then moves between a wide shot and a close-up of the singer on the bar lines, about every 4 s, with face tracking throughout. Five transitions:
  - **Smooth zoom:** eases in to a 1.25x close-up and back out over 0.6 s, centred on the bar line.
  - **Punch zoom:** snaps in to 1.3x in 0.15 s starting right on the bar line, and back out.
  - **Beat bounce:** no shot changes; a small zoom pulse on every beat and a bigger one on beat 1.
  - **Slow drift:** zooms slowly in through one shot and out through the next (Ken Burns style).
  - **Zoom + flash:** the smooth zoom with a quick white flash at each change.

  Without a clear beat, shots change every 4 s (and the bounce keeps a steady 100 BPM).
- **Clip volume:** a 0-100% slider for the video's own sound. 0% mutes it, for example to keep only the music.
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

## Debug log

If something gets stuck, open **Debug log** at the bottom of the page. It shows every step with a timestamp: downloads, which video engine is starting (with a line every 5 seconds while it waits), errors, and ffmpeg's own output. **Copy log** copies it to share. The **Video engine** switch there can force the fast (multi-threaded) or standard (single-threaded) engine.

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
- **Speed:** the normal page uses ffmpeg.wasm's single-threaded engine. The multi-threaded engine is several times faster but needs a "cross-origin isolated" page, and the headers for that stopped the video engine from starting at all on an Android phone. So only the test page `/fast` sends them (see `vercel.json`); try it there and check the Debug log. In a headless-Chrome test on 4 cores, a 20-second reel took 34 s multi-threaded, 60 s single-threaded, and 118 s with the old encoder settings. Even so, building a reel takes a while on a phone, and very long clips can run out of memory. Instagram reels can be at most 3 minutes.
- **Any orientation:** landscape, square, portrait, and tall phone videos are all accepted. Wider sources crop sideways and taller ones crop up and down, and face tracking follows the singer on that axis.
- **Audio required:** videos with no audio track will fail at the audio step.
- **Testing:** the caption, crop, and fade logic are covered by `npm test`. The full app has been run end to end in headless Chromium, but face tracking has only been tried on test footage without faces, so bug reports are welcome.
- **Music rights:** covers of copyrighted songs can be muted or taken down on Instagram. Use Instagram's licensed music, original arrangements, or royalty-free tracks for the audio.

## Files

- `index.html`: the page layout.
- `style.css`: styling.
- `broll.js`: where the b-roll shots go. No browser code.
- `faces.js`: telling people apart (colour fingerprints, grouping), following one person, tiles for small faces. No browser code.
- `lyrics.js`, `translit.js`, `lyrics-worker.js`: writing lyrics from the singing (tidying Whisper's output, Devanagari to romanized Hindi, and the worker that runs Whisper).
- `beats.js`: beat and bar detection, beat-synced cut plan, the generated drum track and WAV writing. No browser code.
- `moments.js`: finding the best moment (chorus detection, scoring). No browser code.
- `editor.js`: pure editing logic (crop path, captions, ffmpeg command). No browser code, so it can be tested separately.
- `debug.js`: the on-page debug log.
- `app.js`: browser glue: file input, face tracking, the ffmpeg engine, and the download.
- `fonts/Poppins-Bold.ttf`: caption font (SIL Open Font License).
- `test/`: tests for `editor.js`.
- `vercel.json`: serves the `/fast` test page with the headers the multi-threaded engine needs.
- `vendor/`: the ffmpeg.wasm wrapper, served from this site because browsers won't start its worker from a CDN. See `vendor/README.md`.
