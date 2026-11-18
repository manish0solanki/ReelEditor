// ffmpeg.wasm's wrapper starts a Web Worker from its own folder, and browsers only allow workers
// from the page's own site, so these two packages are served from vendor/ instead of a CDN.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "./vendor/ffmpeg-util/index.js";
import {
  SAMPLE_STEP,
  FONT_FILE,
  parseTime,
  parseLyrics,
  captionWindows,
  cropGeometry,
  offsetFromFraction,
  cropPath,
  trackFileText,
  buildCommand,
  AUDIO_LABELS,
  summarizeScores,
  findSongBounds,
  formatTime,
  parseEncodedTime,
  estimateRemaining,
} from "./editor.js";

// Single-threaded ffmpeg core: works on GitHub Pages without special server headers.
const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
const FONT_URL = "fonts/Poppins-Bold.ttf";
// Face tracking is loaded only when it's used, so if this CDN is unreachable the rest of the app
// still works and the crop falls back to the position slider.
const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
// Song detection (YAMNet sound classifier), also loaded only when used.
const AUDIO_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.14/+esm";
const AUDIO_WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.14/wasm";
const AUDIO_MODEL = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite";
const LEAD_IN = 2; // seconds kept before the singing starts
const MIN_DURATION = 3;

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"),
  preview: $("preview"),
  duration: $("duration"),
  start: $("start"),
  end: $("end"),
  autotrim: $("autotrim"),
  trimNote: $("trimNote"),
  track: $("track"),
  pos: $("pos"),
  posLabel: $("posLabel"),
  grade: $("grade"),
  title: $("title"),
  lyrics: $("lyrics"),
  lyricsWarn: $("lyricsWarn"),
  go: $("go"),
  output: $("output"),
  progress: $("progress"),
  timer: $("timer"),
  status: $("status"),
  result: $("result"),
  download: $("download"),
};

const ffmpeg = new FFmpeg();
let engineReady = false;
let fontBytes = null;
let inputFile = null;
let inputName = "input.mp4";
let downloadUrl = null;

// ---- Timer shown while a reel is being built ----
// Progress comes from ffmpeg's "time=" log lines, which are steadier than its progress event.
const RATE_KEY = "reelmaker.encodeRate"; // wall-clock seconds per reel second, from the last reel
const PAGE_TITLE = document.title;
const timer = { id: null, t0: 0, encodeT0: 0, total: 0, encoded: 0, encoding: false };

function readSavedRate() {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

const clock = (seconds) => formatTime(Math.max(0, Math.round(seconds)));

function renderTimer() {
  const elapsed = (performance.now() - timer.t0) / 1000;
  const left = timer.encoding
    ? estimateRemaining({
        total: timer.total,
        encoded: timer.encoded,
        encodeElapsed: (performance.now() - timer.encodeT0) / 1000,
        savedRate: readSavedRate(),
      })
    : (() => {
        const rate = readSavedRate();
        return rate ? rate * timer.total : null;
      })();
  let text = `Elapsed ${clock(elapsed)}`;
  // Under 5 s left is shown as "almost done" rather than a countdown that might stall at 0:01.
  if (left != null) text += left < 5 ? " · almost done" : ` · about ${clock(left)} left`;
  els.timer.textContent = text;
  const pct = timer.encoding && timer.total ? Math.floor((100 * timer.encoded) / timer.total) : null;
  document.title = pct != null ? `${pct}% · ${PAGE_TITLE}` : `Working… · ${PAGE_TITLE}`;
}

function startTimer(total) {
  Object.assign(timer, { t0: performance.now(), total, encoded: 0, encoding: false });
  els.timer.hidden = false;
  renderTimer();
  clearInterval(timer.id);
  timer.id = setInterval(renderTimer, 1000);
}

function startEncodingTimer() {
  timer.encoding = true;
  timer.encodeT0 = performance.now();
  timer.encoded = 0;
  renderTimer();
}

function stopTimer(ok) {
  clearInterval(timer.id);
  timer.id = null;
  const elapsed = (performance.now() - timer.t0) / 1000;
  if (ok && timer.encoding && timer.total > 0) {
    const rate = (performance.now() - timer.encodeT0) / 1000 / timer.total;
    try {
      localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // storage unavailable: the next estimate just starts later
    }
  }
  timer.encoding = false;
  els.timer.textContent = ok ? `Finished in ${clock(elapsed)}` : `Stopped after ${clock(elapsed)}`;
  document.title = ok ? `Done · ${PAGE_TITLE}` : PAGE_TITLE;
}

ffmpeg.on("log", ({ message }) => {
  if (!timer.encoding) return;
  const t = parseEncodedTime(message);
  if (t == null) return;
  timer.encoded = Math.min(timer.total, t);
  els.progress.value = timer.total ? timer.encoded / timer.total : 0;
});

function setStatus(text) {
  els.status.textContent = text;
}

async function loadEngine() {
  if (engineReady) return;
  setStatus("Loading video engine (first time only, a few seconds)…");
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });
  engineReady = true;
}

async function loadFont() {
  if (!fontBytes) {
    const res = await fetch(FONT_URL);
    fontBytes = new Uint8Array(await res.arrayBuffer());
  }
  // ffmpeg.writeFile hands the buffer over to its worker, which empties it on this side.
  // Return a copy so the cached font is still there for the next reel.
  return fontBytes.slice();
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.01) return resolve();
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };
    const timer = setTimeout(done, 1500);
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });
}

// Samples the video every SAMPLE_STEP seconds and finds the face in each frame.
// Returns [{ t, c }] where c is the face centre along the crop axis (0..1), or null.
async function trackSinger(video, startT, duration, geometry, srcW, srcH) {
  const { FaceDetector, FilesetResolver } = await import(VISION_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
    runningMode: "IMAGE",
  });

  const scale = Math.min(1, 480 / Math.max(srcW, srcH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const count = Math.floor(duration / SAMPLE_STEP) + 1;
  const samples = [];
  video.pause();
  try {
    for (let i = 0; i < count; i++) {
      const t = i * SAMPLE_STEP;
      await seekTo(video, startT + t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { detections = [] } = detector.detect(canvas);
      const area = (d) => d.boundingBox.width * d.boundingBox.height;
      const best = detections.reduce((a, d) => (!a || area(d) > area(a) ? d : a), null);
      let c = null;
      if (best) {
        const bb = best.boundingBox;
        const cx = (bb.originX + bb.width / 2) / canvas.width;
        const cy = (bb.originY + bb.height / 2) / canvas.height;
        c = geometry.axis === "y" ? cy : cx;
      }
      samples.push({ t, c });
      if (i % 10 === 0) setStatus(`Finding the singer… ${Math.round((100 * i) / count)}%`);
    }
  } finally {
    detector.close();
  }
  return samples;
}

els.pos.addEventListener("input", () => {
  els.posLabel.textContent = els.pos.value;
});

let audioClassifier = null;
let trimJob = null; // promise of the running song detection, so "Make reel" can wait for it
let trimToken = 0;

function setTrimNote(text) {
  els.trimNote.hidden = !text;
  els.trimNote.textContent = text;
}

// Decodes the video's sound to 16 kHz mono and scores each ~1 s window with YAMNet.
async function classifyAudio(file) {
  const bytes = await file.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }

  if (!audioClassifier) {
    const { AudioClassifier, FilesetResolver } = await import(AUDIO_URL);
    const fileset = await FilesetResolver.forAudioTasks(AUDIO_WASM_ROOT);
    audioClassifier = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: AUDIO_MODEL },
      maxResults: -1,
      categoryAllowlist: AUDIO_LABELS,
    });
  }
  const results = audioClassifier.classify(mono, decoded.sampleRate);
  return results.map((r) => {
    const scores = {};
    for (const c of r.classifications[0]?.categories || []) scores[c.categoryName] = c.score;
    return { t: r.timestampMs / 1000, ...summarizeScores(scores) };
  });
}

// Fills Start and End with the song's bounds. Leaves them alone if detection fails.
async function autoTrim(file, duration) {
  const token = ++trimToken;
  setTrimNote("Listening for where the singing starts and the song ends…");
  try {
    const windows = await classifyAudio(file);
    if (token !== trimToken) return; // a different video was picked meanwhile
    const b = findSongBounds(windows, duration, { leadIn: LEAD_IN });
    if (!b.found) {
      setTrimNote("Couldn't find a song in this video's sound. Set Start and End yourself.");
      return;
    }
    els.start.value = formatTime(b.start);
    els.end.value = formatTime(b.end);
    const length = b.end - b.start;
    const parts = [
      b.found === "singing"
        ? `Singing starts at ${formatTime(b.singStart)} and the song ends at ${formatTime(b.songEnd)}.`
        : `Couldn't pick out the singing, so this is trimmed to the music (${formatTime(b.singStart)} to ${formatTime(b.songEnd)}).`,
      `Reel length ${formatTime(length)}. Adjust Start or End if needed.`,
    ];
    if (length > 180) parts.push("Instagram reels can be at most 3 minutes, so you may need to shorten it.");
    else if (length > 90) parts.push("Long reels take several minutes to build on a phone.");
    setTrimNote(parts.join(" "));
  } catch (err) {
    console.warn("Song detection failed", err);
    if (token === trimToken) setTrimNote("Couldn't analyse the sound on this device. Set Start and End yourself.");
  }
}

function startAutoTrim() {
  const d = els.preview.duration;
  if (!inputFile || !Number.isFinite(d)) return;
  trimJob = autoTrim(inputFile, d);
}

els.file.addEventListener("change", () => {
  const file = els.file.files[0];
  if (!file) return;

  inputFile = file;
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  inputName = `input.${ext}`;
  trimToken++; // cancel any detection still running for the previous video
  trimJob = null;
  setTrimNote("");

  els.preview.src = URL.createObjectURL(file);
  els.preview.onloadedmetadata = () => {
    const d = els.preview.duration;
    els.duration.textContent = d.toFixed(1);
    els.start.value = "0";
    els.end.value = String(Math.min(d, 45).toFixed(1));
    if (els.autotrim.checked) startAutoTrim();
  };
  setStatus("");
  els.output.hidden = true;
});

// Typing a time yourself takes over from detection that's still running.
for (const input of [els.start, els.end]) {
  input.addEventListener("input", () => {
    if (els.trimNote.textContent.startsWith("Listening")) {
      trimToken++;
      setTrimNote("");
    }
  });
}

els.autotrim.addEventListener("change", () => {
  if (els.autotrim.checked) startAutoTrim();
  else {
    trimToken++;
    setTrimNote("");
  }
});

els.lyrics.addEventListener("input", () => {
  const { bad } = parseLyrics(els.lyrics.value);
  els.lyricsWarn.hidden = bad.length === 0;
  els.lyricsWarn.textContent = bad.length
    ? `These lines need a time and text, like "0:12 lyric": line${bad.length > 1 ? "s" : ""} ${bad.join(", ")}`
    : "";
});

els.go.addEventListener("click", async () => {
  const showError = (msg) => {
    els.output.hidden = false;
    setStatus(msg);
  };

  if (!inputFile) return showError("Choose a video first.");
  if (trimJob) {
    els.go.disabled = true;
    els.output.hidden = false;
    setStatus("Finishing finding the song…");
    await trimJob;
    els.go.disabled = false;
  }

  const videoDuration = els.preview.duration;
  const srcW = els.preview.videoWidth;
  const srcH = els.preview.videoHeight;
  if (!srcW || !srcH) return showError("Couldn't read this video's size. Try a different file.");
  const geometry = cropGeometry(srcW, srcH);

  const startT = parseTime(els.start.value);
  let endT = parseTime(els.end.value);
  if (Number.isNaN(startT) || Number.isNaN(endT)) return showError("Start and end must be times like 0:12 or 12.5.");
  endT = Math.min(endT, videoDuration);
  const duration = endT - startT;
  if (startT < 0 || duration < MIN_DURATION) {
    return showError(`End must be after start, with at least ${MIN_DURATION} seconds between them.`);
  }

  const fallbackOffset = offsetFromFraction(geometry, Number(els.pos.value) / 100);

  const { items, bad } = parseLyrics(els.lyrics.value);
  const captions = captionWindows(items, startT, duration);

  els.go.disabled = true;
  els.output.hidden = false;
  els.result.hidden = true;
  els.download.hidden = true;
  els.progress.value = 0;
  startTimer(duration);
  let ok = false;

  const usedFiles = [inputName, FONT_FILE, "track.txt", "output.mp4"];

  try {
    let keys = null;
    if (els.track.checked && geometry.axis !== "none") {
      try {
        setStatus("Finding the singer…");
        const samples = await trackSinger(els.preview, startT, duration, geometry, srcW, srcH);
        keys = cropPath(samples, geometry);
        if (!keys) setStatus("No face found, so the crop uses the fallback position.");
      } catch (err) {
        console.warn("Face tracking failed", err);
        setStatus("Face tracking didn't work on this device, so the crop uses the fallback position.");
      }
    }

    await loadEngine();
    setStatus("Building your reel… keep this tab open.");

    const { args, textFiles } = buildCommand({
      inputName,
      start: startT,
      duration,
      geometry,
      staticOffset: keys ? keys[0].x : fallbackOffset,
      hasTrack: !!keys,
      captions,
      title: els.title.value.trim(),
      grade: els.grade.checked,
    });

    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));
    await ffmpeg.writeFile(FONT_FILE, await loadFont());
    if (keys) await ffmpeg.writeFile("track.txt", new TextEncoder().encode(trackFileText(keys, geometry.axis)));
    for (const f of textFiles) {
      usedFiles.push(f.name);
      await ffmpeg.writeFile(f.name, new TextEncoder().encode(f.text));
    }

    startEncodingTimer();
    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);

    const data = await ffmpeg.readFile("output.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);

    els.result.src = downloadUrl;
    els.result.hidden = false;
    els.download.href = downloadUrl;
    els.download.hidden = false;
    els.progress.value = 1;
    ok = true;

    const notes = [];
    if (bad.length) notes.push(`${bad.length} lyric line(s) were skipped.`);
    setStatus(`Done! Preview below, then download and upload to Instagram. ${notes.join(" ")}`.trim());
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || err).replace(/\.+$/, "");
    const memory = /memory|out of bounds|abort|exited with code/i.test(msg);
    setStatus(`Something went wrong: ${msg}.${memory ? " Try a shorter clip or a smaller file." : ""}`);
  } finally {
    stopTimer(ok);
    for (const name of usedFiles) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // file was never written
      }
    }
    els.go.disabled = false;
  }
});
