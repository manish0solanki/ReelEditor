// Pure editing logic: no DOM, no ffmpeg. Shared by the browser app and by tests.

export const SAMPLE_STEP = 0.5; // seconds between face-detection samples
export const FONT_FILE = "font.ttf"; // name the font is written to inside ffmpeg's file system

const TARGET = 9 / 16; // reel shape: width / height

// "1:23.5" -> 83.5, "83.5" -> 83.5, anything else -> NaN
export function parseTime(text) {
  const s = String(text).trim();
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : NaN;
}

// One lyric per line: "0:12 first line of the song". Returns valid items and bad line numbers.
export function parseLyrics(text) {
  const items = [];
  const bad = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^(\S+)\s+(.+)$/);
    const time = m ? parseTime(m[1]) : NaN;
    if (Number.isNaN(time)) bad.push(i + 1);
    else items.push({ time, text: m[2].trim() });
  });
  items.sort((a, b) => a.time - b.time);
  return { items, bad };
}

// Each lyric stays on screen until the next lyric starts (or the clip ends).
export function captionWindows(items, start, duration) {
  const out = [];
  items.forEach((item, i) => {
    const a = Math.max(0, item.time - start);
    const next = i + 1 < items.length ? items[i + 1].time - start : duration;
    const b = Math.min(duration, next);
    if (b > a && a < duration) out.push({ text: item.text, a, b });
  });
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (v) => Math.round(v / 2) * 2;

// Works out how to turn any source into a 9:16 window.
//   source wider than 9:16 (landscape, 4:3, 4:5 ...) -> crop a 9:16 strip across the full height, slide horizontally ("x")
//   source narrower than 9:16 (very tall phone video) -> crop a 9:16 strip across the full width, slide vertically ("y")
//   source already 9:16                              -> no crop needed ("none")
export function cropGeometry(srcW, srcH) {
  const ratio = srcW / srcH;
  if (ratio > TARGET + 0.001) {
    const cropW = Math.min(even(srcH * TARGET), srcW);
    return { axis: "x", srcW, srcH, cropW, cropH: srcH, size: srcW, window: cropW, maxOffset: srcW - cropW };
  }
  if (ratio < TARGET - 0.001) {
    const cropH = Math.min(even(srcW / TARGET), srcH);
    return { axis: "y", srcW, srcH, cropW: srcW, cropH, size: srcH, window: cropH, maxOffset: srcH - cropH };
  }
  return { axis: "none", srcW, srcH, cropW: srcW, cropH: srcH, size: srcW, window: srcW, maxOffset: 0 };
}

// Offset (in pixels) of the crop window for a fraction f (0 = start edge, 1 = end edge) of the frame.
export function offsetFromFraction(geometry, fraction) {
  const maxEven = Math.floor(geometry.maxOffset / 2) * 2;
  return clamp(even(geometry.maxOffset * fraction), 0, maxEven);
}

// samples: [{ t, c }] where c is the subject centre along the crop axis as a 0..1 fraction (or null).
// Returns [{ t, x }] crop offsets in pixels, or null if the subject was never found.
export function cropPath(samples, geometry) {
  const { size, window, maxOffset } = geometry;
  const maxEven = Math.floor(maxOffset / 2) * 2;
  const raw = samples.map((s) => (s.c == null ? null : clamp(s.c * size - window / 2, 0, maxOffset)));

  const firstFound = raw.find((v) => v != null);
  if (firstFound == null) return null;

  // Fill gaps: hold the last known position, starting from the first subject seen.
  let last = firstFound;
  const filled = raw.map((v) => {
    if (v == null) return last;
    last = v;
    return v;
  });

  const smoothed = smooth(filled, 2);
  return samples.map((s, i) => ({ t: s.t, x: clamp(even(smoothed[i]), 0, maxEven) }));
}

function smooth(values, radius = 2) {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j];
        n++;
      }
    }
    return sum / n;
  });
}

// Text for ffmpeg's sendcmd filter. At each key the crop offset becomes an expression of time that
// moves in a straight line to the next key, so the crop glides instead of jumping every sample.
// The last key holds still. Expressions avoid commas and spaces, which sendcmd treats as separators.
export function trackFileText(keys, axis) {
  const param = axis === "y" ? "y" : "x";
  return (
    keys
      .map((k, i) => {
        const next = keys[i + 1];
        const t0 = k.t.toFixed(2);
        if (!next || next.x === k.x || next.t <= k.t) return `${t0} crop ${param} ${k.x};`;
        const span = (next.t - k.t).toFixed(2);
        return `${t0} crop ${param} ${k.x}+(${next.x - k.x})*(t-${t0})/${span};`;
      })
      .join("\n") + "\n"
  );
}

// ---- Text layout -------------------------------------------------------------------------------
// ffmpeg's drawtext never wraps, so lines are measured and broken here. Widths are estimates for
// Poppins Bold in ems (measured with ffmpeg), slightly generous so text never touches the edge.

export const FRAME_W = 1080;
export const FRAME_H = 1920;
const TEXT_MARGIN = 70; // px kept clear on each side
const BORDER = 5;

const NARROW = new Set("iIjlt.,:;'!|`()[]{}");
const SEMI = new Set("frJ\"-1/");
const WIDE = new Set("mwMW@%");

function charEm(ch) {
  if (ch === " ") return 0.26;
  if (NARROW.has(ch)) return 0.32;
  if (SEMI.has(ch)) return 0.45;
  if (WIDE.has(ch)) return 1.05;
  if (ch >= "A" && ch <= "Z") return 0.74;
  if (ch >= "0" && ch <= "9") return 0.64;
  return 0.62;
}

export function textWidth(text, size) {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size + 2 * BORDER;
}

// Greedy word wrap to maxWidth pixels. A single word too long for a line is split by characters.
export function wrapText(text, size, maxWidth = FRAME_W - 2 * TEXT_MARGIN) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const pushWord = (word) => {
    if (textWidth(word, size) <= maxWidth) return word;
    // Hard-split a word that can't fit on its own.
    let chunk = "";
    for (const ch of word) {
      if (chunk && textWidth(chunk + ch, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth) line = candidate;
    else {
      if (line) lines.push(line);
      line = pushWord(word);
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Picks the largest font size (stepping down from `size`) at which the text fits in maxLines lines.
// Below minSize it stops shrinking and allows extra lines instead.
export function fitText(text, { size, minSize, maxLines }) {
  for (let s = size; s >= minSize; s -= 4) {
    const lines = wrapText(text, s);
    if (lines.length <= maxLines) return { size: s, lines };
  }
  return { size: minSize, lines: wrapText(text, minSize) };
}

// Lines are drawn one drawtext each so every line is centered on its own.
// expansion=none stops ffmpeg from treating "%" in lyrics as a format code (which blanks the text).
function drawText({ textFile, size, y, a, b }) {
  return (
    `drawtext=fontfile=${FONT_FILE}:textfile=${textFile}:expansion=none:fontsize=${size}` +
    `:fontcolor=white:borderw=${BORDER}:bordercolor=black:x=(w-text_w)/2:y=${y}` +
    `:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`
  );
}

// Adds one text block (title or caption) as drawtext filters plus the text files they read.
// anchor "top": first line starts at y. anchor "bottom": last line ends at y.
function addTextBlock({ v, textFiles, prefix, text, fit, y, anchor, a, b }) {
  const { size, lines } = fitText(text, fit);
  const lineH = Math.round(size * 1.3);
  const top = anchor === "bottom" ? Math.round(y - lines.length * lineH) : Math.round(y);
  lines.forEach((line, i) => {
    const name = lines.length === 1 ? `${prefix}.txt` : `${prefix}_${i}.txt`;
    textFiles.push({ name, text: line });
    v.push(drawText({ textFile: name, size, y: top + i * lineH, a, b }));
  });
}

export const TITLE_FIT = { size: 80, minSize: 56, maxLines: 2 };
export const CAPTION_FIT = { size: 60, minSize: 44, maxLines: 2 };
const TITLE_TOP = Math.round(FRAME_H * 0.12);
// Bottom of the caption block. A single 60px line lands where it always did (top at 74% of height).
const CAPTION_BOTTOM = Math.round(FRAME_H * 0.74 + 60 * 1.3);

// Builds the full ffmpeg argument list plus the text files it needs written into its file system.
export function buildCommand({
  inputName,
  start,
  duration,
  geometry,
  staticOffset,
  hasTrack,
  captions,
  title,
  grade,
}) {
  const textFiles = [];
  const v = [];

  if (geometry.axis !== "none") {
    if (hasTrack) v.push("sendcmd=f=track.txt");
    const { cropW, cropH } = geometry;
    v.push(
      geometry.axis === "x"
        ? `crop=w=${cropW}:h=${cropH}:x=${staticOffset}:y=0`
        : `crop=w=${cropW}:h=${cropH}:x=0:y=${staticOffset}`
    );
  }
  v.push(`scale=${FRAME_W}:${FRAME_H}`);

  if (grade) {
    v.push("eq=contrast=1.08:saturation=1.12:brightness=0.02");
    v.push("unsharp=5:5:0.6:5:5:0.0");
  }

  if (title) {
    addTextBlock({
      v, textFiles, prefix: "title", text: title, fit: TITLE_FIT,
      y: TITLE_TOP, anchor: "top", a: 0, b: Math.min(3.5, duration),
    });
  }

  captions.forEach((c, i) => {
    addTextBlock({
      v, textFiles, prefix: `caption${i}`, text: c.text, fit: CAPTION_FIT,
      y: CAPTION_BOTTOM, anchor: "bottom", a: c.a, b: c.b,
    });
  });

  const fadeOutAt = (duration - 1).toFixed(2);
  if (duration > 2) {
    v.push("fade=t=in:st=0:d=0.6", `fade=t=out:st=${fadeOutAt}:d=1`);
  }

  const a = ["afade=t=in:st=0:d=0.6"];
  if (duration > 2) a.push(`afade=t=out:st=${fadeOutAt}:d=1`);
  a.push("acompressor=threshold=0.125:ratio=3:attack=20:release=250", "loudnorm=I=-14:TP=-1.5:LRA=11");

  const args = [
    "-ss", String(start),
    "-i", inputName,
    "-t", String(duration),
    "-vf", v.join(","),
    "-af", a.join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    // loudnorm works at 192 kHz internally; without this the reel's audio comes out at 96 kHz.
    "-ar", "48000",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "output.mp4",
  ];

  return { args, textFiles };
}
