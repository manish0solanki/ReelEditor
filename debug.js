// On-page debug log: everything the app does, its errors, and ffmpeg's output, with timestamps,
// so problems on a phone (where there's no developer console) can be seen and copied.
// Loaded before app.js so it also catches errors while the app starts.

const MAX_LINES = 1500;
const OPEN_KEY = "reelmaker.debugOpen";
const t0 = performance.now();
const lines = [];
let progressLine = -1; // index of the last ffmpeg "frame=" line, which is updated in place
let scheduled = false;

const $ = (id) => document.getElementById(id);

function stamp() {
  return `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
}

function show(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function render() {
  scheduled = false;
  const pre = $("debugLog");
  if (!pre) return;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.textContent = lines.join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function schedule() {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(render);
  }
}

// level: "info", "warn", "error", "step", "ffmpeg"
export function dlog(level, ...args) {
  const text = args.map(show).join(" ");
  const line = `${stamp()} ${level.padEnd(6)} ${text}`;
  // ffmpeg prints a progress line many times a second: keep only the latest one.
  const isProgress = level === "ffmpeg" && /^\s*frame=|^\s*size=/.test(text);
  if (isProgress && progressLine === lines.length - 1 && progressLine >= 0) lines[progressLine] = line;
  else {
    lines.push(line);
    progressLine = isProgress ? lines.length - 1 : -1;
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
      progressLine = -1;
    }
  }
  if (level === "error") openPanel();
  schedule();
}

export function openPanel() {
  const panel = $("debug");
  if (panel && !panel.open) panel.open = true;
}

// Mirror the browser console. MediaPipe's graphics chatter is left out.
const NOISE = /GL Driver|gl_context|OpenGL error checking|XNNPACK|inference_feedback_manager|Graph (successfully started|finished closing)/;
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const text = args.map(show).join(" ");
    if (!NOISE.test(text)) dlog(level === "log" ? "info" : level, text);
  };
}

window.addEventListener("error", (e) => {
  dlog("error", `${e.message || e.error || "Script error"}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`);
});
window.addEventListener("unhandledrejection", (e) => dlog("error", "Unhandled:", e.reason));

function environment() {
  const n = navigator;
  dlog("info", `Page: ${location.href}`);
  dlog("info", `Browser: ${n.userAgent}`);
  dlog(
    "info",
    `CPU cores: ${n.hardwareConcurrency ?? "?"} · memory: ${n.deviceMemory ? `${n.deviceMemory} GB` : "?"} · ` +
      `cross-origin isolated: ${globalThis.crossOriginIsolated === true} · ` +
      `SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined"}`
  );
}

function setUp() {
  const panel = $("debug");
  if (!panel) return;
  try {
    if (localStorage.getItem(OPEN_KEY) === "1") panel.open = true;
  } catch {
    // ignore
  }
  panel.addEventListener("toggle", () => {
    try {
      localStorage.setItem(OPEN_KEY, panel.open ? "1" : "0");
    } catch {
      // ignore
    }
    if (panel.open) render();
  });

  $("debugCopy").addEventListener("click", async () => {
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      $("debugCopy").textContent = "Copied!";
    } catch {
      // Clipboard blocked: select the text so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents($("debugLog"));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      $("debugCopy").textContent = "Selected: long-press to copy";
    }
    setTimeout(() => ($("debugCopy").textContent = "Copy log"), 2500);
  });

  $("debugClear").addEventListener("click", () => {
    lines.length = 0;
    progressLine = -1;
    environment();
  });

  environment();
  render();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setUp);
else setUp();
