import { FFmpeg } from "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js";
import { FaceDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";
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
} from "./editor.js";

// Single-threaded ffmpeg core: works on GitHub Pages without special server headers.
const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
const FONT_URL = "fonts/Poppins-Bold.ttf";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MIN_DURATION = 3;

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"),
  preview: $("preview"),
  duration: $("duration"),
  start: $("start"),
  end: $("end"),
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

ffmpeg.on("progress", ({ progress }) => {
  els.progress.value = Math.min(1, Math.max(0, progress));
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
  return fontBytes;
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

els.file.addEventListener("change", () => {
  const file = els.file.files[0];
  if (!file) return;

  inputFile = file;
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  inputName = `input.${ext}`;

  els.preview.src = URL.createObjectURL(file);
  els.preview.onloadedmetadata = () => {
    const d = els.preview.duration;
    els.duration.textContent = d.toFixed(1);
    els.start.value = "0";
    els.end.value = String(Math.min(d, 45).toFixed(1));
  };
  setStatus("");
  els.output.hidden = true;
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
      await ffmpeg.writeFile(f.name, new TextEncoder().encode(f.text + "\n"));
    }

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

    const notes = [];
    if (bad.length) notes.push(`${bad.length} lyric line(s) were skipped.`);
    setStatus(`Done! Preview below, then download and upload to Instagram. ${notes.join(" ")}`.trim());
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}. Try a shorter clip or a smaller file.`);
  } finally {
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
