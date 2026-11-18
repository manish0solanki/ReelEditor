// ffmpeg.wasm's wrapper starts a Web Worker from its own folder, and browsers only allow workers
// from the page's own site, so these two packages are served from vendor/ instead of a CDN.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { dlog, openPanel } from "./debug.js";
import { audioFeatures, repetitionCurve, findBestMoments } from "./moments.js";
import { fetchFile, toBlobURL } from "./vendor/ffmpeg-util/index.js";
import {
  SAMPLE_STEP,
  FONT_FILE,
  FONT_DIR,
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
  singingFlags,
  formatTime,
  parseEncodedTime,
  estimateRemaining,
} from "./editor.js";

// The multi-threaded ffmpeg core is several times faster but needs SharedArrayBuffer, which browsers
// only allow on "cross-origin isolated" pages (vercel.json sends the headers for that). Anywhere
// else, such as GitHub Pages or Safari, the single-threaded core is used.
// ffmpeg.wasm's multi-threaded build can hang on some devices (it has on an Android phone, while
// starting up), so it gets a time limit to start and a watchdog while it works. If either trips, the
// app switches to the single-threaded core, and this device remembers to use that from then on.
const MULTI_THREAD_SUPPORTED = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
const CORES = {
  multi: "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm",
  single: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
};
const MT_FAILED_KEY = "reelmaker.multiThreadFailedAt";
const MT_RETRY_AFTER_MS = 30 * 24 * 3600 * 1000; // try the fast engine again after 30 days
const MT_START_TIMEOUT_MS = 20000;
const STALL_TIMEOUT_MS = 45000; // no output from the fast engine for this long = stalled
const SINGLE_START_TIMEOUT_MS = 60000; // the standard engine normally starts in a few seconds
const ENGINE_KEY = "reelmaker.engine"; // "auto", "multi" or "single", from the debug panel
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
  best: $("best"),
  bestLength: $("bestLength"),
  bestOptions: $("bestOptions"),
  moments: $("moments"),
  trimNote: $("trimNote"),
  track: $("track"),
  pos: $("pos"),
  posLabel: $("posLabel"),
  grade: $("grade"),
  title: $("title"),
  lyrics: $("lyrics"),
  lyricsWarn: $("lyricsWarn"),
  captionStyle: $("captionStyle"),
  go: $("go"),
  output: $("output"),
  progress: $("progress"),
  timer: $("timer"),
  status: $("status"),
  result: $("result"),
  download: $("download"),
};

let ffmpeg = null; // the loaded engine, or null
let engineMode = null; // "multi" or "single", once loaded
let attemptMode = null; // the engine last being loaded or used
let lastLogAt = 0;
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

function onEngineLog({ message }) {
  lastLogAt = performance.now();
  dlog("ffmpeg", message);
  if (!timer.encoding) return;
  const t = parseEncodedTime(message);
  if (t == null) return;
  timer.encoded = Math.min(timer.total, t);
  els.progress.value = timer.total ? timer.encoded / timer.total : 0;
}

function setStatus(text) {
  if (text && text !== els.status.textContent) dlog("step", text);
  els.status.textContent = text;
}

class EngineStalled extends Error {}

function multiThreadFailedRecently() {
  try {
    const at = Number(localStorage.getItem(MT_FAILED_KEY));
    return at > 0 && Date.now() - at < MT_RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

function giveUpOnMultiThread(reason) {
  console.warn("Fast (multi-threaded) video engine failed; using the standard one.", reason);
  try {
    localStorage.setItem(MT_FAILED_KEY, String(Date.now()));
  } catch {
    // storage unavailable: this page load still switches
  }
  if (ffmpeg) ffmpeg.terminate();
  ffmpeg = null;
  engineMode = null;
}

const withTimeout = (promise, ms, message) => {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new EngineStalled(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
};

async function download(url, type, showProgress) {
  const name = url.split("/").slice(-4).join("/");
  const started = performance.now();
  let size = 0;
  dlog("info", `Downloading ${name}`);
  const blobUrl = await toBlobURL(url, type, true, ({ total, received }) => {
    size = received;
    if (showProgress && total > 0) {
      setStatus(`Downloading video engine (first time only)… ${Math.round((100 * received) / total)}%`);
    }
  });
  dlog("info", `Downloaded ${name}: ${(size / 1048576).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return blobUrl;
}

function engineChoice() {
  try {
    return localStorage.getItem(ENGINE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

async function loadCore(mode) {
  const base = CORES[mode];
  setStatus("Downloading video engine (first time only)…");
  const config = {
    coreURL: await download(`${base}/ffmpeg-core.js`, "text/javascript", false),
    wasmURL: await download(`${base}/ffmpeg-core.wasm`, "application/wasm", true),
  };
  if (mode === "multi") config.workerURL = await download(`${base}/ffmpeg-core.worker.js`, "text/javascript", false);
  attemptMode = mode;
  const label = mode === "multi" ? "fast (multi-threaded)" : "standard (single-threaded)";
  setStatus(`Starting video engine (${mode === "multi" ? "fast" : "standard"})…`);
  const engine = new FFmpeg();
  engine.on("log", onEngineLog);
  ffmpeg = engine;
  const started = performance.now();
  // A line every 5 s while waiting, so a hang is obvious in the debug log.
  const heartbeat = setInterval(() => {
    dlog("info", `…still waiting for the ${label} engine to start (${Math.round((performance.now() - started) / 1000)} s)`);
  }, 5000);
  try {
    await withTimeout(
      engine.load(config),
      mode === "multi" ? MT_START_TIMEOUT_MS : SINGLE_START_TIMEOUT_MS,
      `The ${label} video engine didn't start within ${(mode === "multi" ? MT_START_TIMEOUT_MS : SINGLE_START_TIMEOUT_MS) / 1000} s`
    );
  } catch (err) {
    // A failed engine can't answer any more calls: drop it so nothing waits on it.
    engine.terminate();
    if (ffmpeg === engine) ffmpeg = null;
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
  engineMode = mode;
  console.info(`Video engine loaded: ${label}, in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
}

async function loadEngine() {
  if (ffmpeg && engineMode) return;
  const choice = engineChoice();
  const failedBefore = multiThreadFailedRecently();
  dlog(
    "info",
    `Engine choice: ${choice} · fast engine possible here: ${MULTI_THREAD_SUPPORTED} · fast engine failed recently: ${failedBefore}`
  );
  if (choice === "multi" && !MULTI_THREAD_SUPPORTED) {
    dlog("warn", "The fast engine can't run on this page (not cross-origin isolated), so using the standard one.");
  }
  // On the /fast test page, always try the fast engine (unless Standard is forced).
  const onFastPage = location.pathname.replace(/\/$/, "") === "/fast";
  const tryMulti =
    MULTI_THREAD_SUPPORTED && (choice === "multi" || (choice === "auto" && (!failedBefore || onFastPage)));
  if (tryMulti && choice !== "single") {
    try {
      await loadCore("multi");
      return;
    } catch (err) {
      giveUpOnMultiThread(err);
      if (choice === "multi") throw err;
    }
  }
  await loadCore("single");
}

// Runs ffmpeg. With the fast engine, a watchdog rejects if ffmpeg goes quiet for too long.
async function execWatched(args) {
  dlog("info", `ffmpeg ${args.join(" ")}`);
  if (engineMode !== "multi") return ffmpeg.exec(args);
  lastLogAt = performance.now();
  let id;
  const stalled = new Promise((_, reject) => {
    id = setInterval(() => {
      if (performance.now() - lastLogAt > STALL_TIMEOUT_MS) reject(new EngineStalled("The fast video engine stalled"));
    }, 2000);
  });
  try {
    return await Promise.race([ffmpeg.exec(args), stalled]);
  } finally {
    clearInterval(id);
  }
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
let trimJob = null; // promise of the running sound analysis, so "Make reel" can wait for it
let trimToken = 0;
let analysis = null; // { file, duration, windows, features } for the current video
let moments = [];
const BEST_KEY = "reelmaker.best"; // remembers the "best moment" checkbox and length

function setTrimNote(text) {
  els.trimNote.hidden = !text;
  els.trimNote.textContent = text;
}

// Decodes the video's sound to 16 kHz mono, scores each ~1 s window with YAMNet, and measures
// loudness and pitch fingerprints (for finding the chorus). Done once per video.
async function analyzeAudio(file) {
  const t0 = performance.now();
  const bytes = await file.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  dlog("info", `Sound decoded: ${(decoded.duration).toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  if (!audioClassifier) {
    const { AudioClassifier, FilesetResolver } = await import(AUDIO_URL);
    const fileset = await FilesetResolver.forAudioTasks(AUDIO_WASM_ROOT);
    audioClassifier = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: AUDIO_MODEL },
      maxResults: -1,
      categoryAllowlist: AUDIO_LABELS,
    });
  }
  const t1 = performance.now();
  const windows = audioClassifier.classify(mono, decoded.sampleRate).map((r) => {
    const scores = {};
    for (const c of r.classifications[0]?.categories || []) scores[c.categoryName] = c.score;
    return { t: r.timestampMs / 1000, ...summarizeScores(scores) };
  });
  const t2 = performance.now();
  const features = audioFeatures(mono, decoded.sampleRate);
  features.repetition = repetitionCurve(features.chroma, features.hop);
  dlog(
    "info",
    `Sound analysed: classifier ${((t2 - t1) / 1000).toFixed(1)} s, loudness and chorus ${((performance.now() - t2) / 1000).toFixed(1)} s`
  );
  return { windows, features };
}

function saveBestChoice() {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify({ on: els.best.checked, length: els.bestLength.value }));
  } catch {
    // ignore
  }
}

function renderMoments(selected) {
  els.moments.textContent = "";
  moments.forEach((m, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "moment";
    b.setAttribute("aria-pressed", String(i === selected));
    const when = document.createElement("strong");
    when.textContent = `${i + 1}. ${formatTime(m.start)} – ${formatTime(m.end)}`;
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = m.parts ? `score ${m.score}` : "";
    const why = document.createElement("small");
    why.textContent = m.reasons.join(" · ");
    b.append(when, score, why);
    b.addEventListener("click", () => useMoment(i));
    els.moments.append(b);
  });
}

function useMoment(i) {
  const m = moments[i];
  if (!m) return;
  els.start.value = formatTime(m.start);
  els.end.value = formatTime(m.end);
  renderMoments(i);
  setTrimNote(
    `Using moment ${i + 1}: ${formatTime(m.start)} to ${formatTime(m.end)} (${formatTime(m.end - m.start)} long). ` +
      (moments.length > 1 ? "Tap another one above to use it instead, or adjust Start and End." : "Adjust Start and End if needed.")
  );
}

// Sets Start and End from the analysis: the best moment, or the whole song.
function applyTrim() {
  if (!analysis || analysis.file !== inputFile) return;
  const { windows, features, duration } = analysis;
  const b = findSongBounds(windows, duration, { leadIn: LEAD_IN });

  if (els.best.checked) {
    moments = findBestMoments({
      features,
      windows,
      sings: singingFlags(windows),
      duration,
      length: Number(els.bestLength.value),
      song: b.found ? { start: b.start, end: b.end } : null,
    });
    dlog("info", `Best moments: ${moments.map((m) => `${formatTime(m.start)}-${formatTime(m.end)} (${m.score})`).join(", ")}`);
    if (moments.length) useMoment(0);
    else setTrimNote("Couldn't pick a best moment in this video. Set Start and End yourself.");
    return;
  }

  moments = [];
  els.moments.textContent = "";
  if (!els.autotrim.checked) {
    setTrimNote("");
    return;
  }
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
}

async function runAnalysis(file, duration) {
  const token = ++trimToken;
  setTrimNote(
    els.best.checked
      ? "Listening for the best moment (chorus, strongest vocals, most energy)…"
      : "Listening for where the singing starts and the song ends…"
  );
  try {
    const result = await analyzeAudio(file);
    if (token !== trimToken) return; // a different video was picked meanwhile
    analysis = { file, duration, ...result };
    applyTrim();
  } catch (err) {
    console.warn("Sound analysis failed", err);
    if (token === trimToken) setTrimNote("Couldn't analyse the sound on this device. Set Start and End yourself.");
  }
}

// Called when a video is picked or an option changes: analyse once, then reuse the results.
function updateTrim() {
  els.bestOptions.hidden = !els.best.checked;
  const d = els.preview.duration;
  if (!inputFile || !Number.isFinite(d)) return;
  if (!els.autotrim.checked && !els.best.checked) {
    trimToken++;
    moments = [];
    els.moments.textContent = "";
    setTrimNote("");
    return;
  }
  if (analysis && analysis.file === inputFile) applyTrim();
  else trimJob = runAnalysis(inputFile, d);
}

els.file.addEventListener("change", () => {
  const file = els.file.files[0];
  if (!file) return;

  inputFile = file;
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  inputName = `input.${ext}`;
  trimToken++; // cancel any analysis still running for the previous video
  trimJob = null;
  analysis = null;
  moments = [];
  els.moments.textContent = "";
  setTrimNote("");

  els.preview.src = URL.createObjectURL(file);
  els.preview.onloadedmetadata = () => {
    const d = els.preview.duration;
    els.duration.textContent = d.toFixed(1);
    els.start.value = "0";
    els.end.value = String(Math.min(d, 45).toFixed(1));
    updateTrim();
  };
  setStatus("");
  els.output.hidden = true;
});

// Typing a time yourself takes over from analysis that's still running.
for (const input of [els.start, els.end]) {
  input.addEventListener("input", () => {
    if (els.trimNote.textContent.startsWith("Listening")) {
      trimToken++;
      setTrimNote("");
    }
    if (moments.length) renderMoments(-1); // no moment is selected any more
  });
}

els.autotrim.addEventListener("change", updateTrim);
els.best.addEventListener("change", () => {
  saveBestChoice();
  updateTrim();
});
els.bestLength.addEventListener("change", () => {
  saveBestChoice();
  updateTrim();
});
try {
  const saved = JSON.parse(localStorage.getItem(BEST_KEY) || "null");
  if (saved) {
    els.best.checked = !!saved.on;
    if (saved.length) els.bestLength.value = saved.length;
  }
} catch {
  // ignore
}
els.bestOptions.hidden = !els.best.checked;

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
      captionStyle: els.captionStyle.value,
    });
    for (const f of textFiles) usedFiles.push(f.name);

    const encode = async () => {
      await loadEngine();
      setStatus("Building your reel… keep this tab open and the screen on.");
      await ffmpeg.writeFile(inputName, await fetchFile(inputFile));
      try {
        await ffmpeg.createDir(FONT_DIR);
      } catch {
        // already there from an earlier reel
      }
      await ffmpeg.writeFile(FONT_FILE, await loadFont());
      if (keys) await ffmpeg.writeFile("track.txt", new TextEncoder().encode(trackFileText(keys, geometry.axis)));
      for (const f of textFiles) await ffmpeg.writeFile(f.name, new TextEncoder().encode(f.text));

      startEncodingTimer();
      const exitCode = await execWatched(args);
      if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);
      return ffmpeg.readFile("output.mp4");
    };

    let data;
    try {
      data = await encode();
    } catch (err) {
      // Retry only when it was the fast engine that failed (not when the user forced it).
      if (attemptMode !== "multi" || engineChoice() === "multi") throw err;
      // The fast engine hung or failed: start this reel again on the standard engine.
      giveUpOnMultiThread(err);
      setStatus("The fast engine didn't work on this device, so switching to the standard one…");
      timer.encoding = false;
      data = await encode();
    }
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
    openPanel();
    const msg = String(err?.message || err).replace(/\.+$/, "");
    const memory = /memory|out of bounds|abort|exited with code/i.test(msg);
    setStatus(
      `Something went wrong: ${msg}.${memory ? " Try a shorter clip or a smaller file." : ""} ` +
        "The Debug log at the bottom shows the details; tap Copy log to share them."
    );
  } finally {
    stopTimer(ok);
    // Tidy up through a working engine only (a dead one would never answer).
    if (ffmpeg && engineMode) {
      for (const name of usedFiles) {
        try {
          await withTimeout(ffmpeg.deleteFile(name), 5000, "delete timed out");
        } catch {
          // file was never written
        }
      }
    }
    els.go.disabled = false;
  }
});

// ---- Debug panel: engine choice ----
const engineSelect = document.getElementById("engineChoice");
engineSelect.value = engineChoice();
engineSelect.addEventListener("change", () => {
  try {
    localStorage.setItem(ENGINE_KEY, engineSelect.value);
    // Picking Auto again gives the fast engine a fresh chance.
    if (engineSelect.value === "auto") localStorage.removeItem(MT_FAILED_KEY);
  } catch {
    // ignore
  }
  if (ffmpeg) ffmpeg.terminate();
  ffmpeg = null;
  engineMode = null;
  dlog("info", `Engine choice set to ${engineSelect.value}; it applies to the next reel.`);
});
const fastLink = document.getElementById("fastLink");
if (MULTI_THREAD_SUPPORTED) {
  fastLink.innerHTML = 'This is the fast-engine test page. <a href="/">Back to the normal page</a>.';
} else {
  fastLink.innerHTML =
    'The fast (multi-threaded) engine only runs on the <a href="/fast">fast-engine test page</a>.';
}
dlog("info", `App ready · engine choice: ${engineChoice()} · fast engine failed recently: ${multiThreadFailedRecently()}`);
