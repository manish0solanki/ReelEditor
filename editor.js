// Pure editing logic: no DOM, no ffmpeg. Shared by the browser app and by tests.

export const SAMPLE_STEP = 0.5; // seconds between face-detection samples
export const FONT_FILE = "font.ttf"; // name the font is written to inside ffmpeg's file system

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

// samples: [{ t, cx }] where cx is the face centre as a 0..1 fraction of frame width (or null).
// Returns [{ t, x }] crop offsets in pixels, or null if no face was ever found.
export function cropPath(samples, { srcW, cropW }) {
  const maxLeft = srcW - cropW;
  const maxEven = Math.floor(maxLeft / 2) * 2;
  const raw = samples.map((s) => (s.cx == null ? null : clamp(s.cx * srcW - cropW / 2, 0, maxLeft)));

  const firstFound = raw.find((v) => v != null);
  if (firstFound == null) return null;

  // Fill gaps: hold the last known position, starting from the first face seen.
  let last = firstFound;
  const filled = raw.map((v) => {
    if (v == null) return last;
    last = v;
    return v;
  });

  const smoothed = smooth(filled, 2);
  return samples.map((s, i) => ({ t: s.t, x: clamp(even(smoothed[i]), 0, maxEven) }));
}

// Text for ffmpeg's sendcmd filter: "time crop x value;" per line.
export function trackFileText(keys) {
  return keys.map((k) => `${k.t.toFixed(2)} crop x ${k.x};`).join("\n") + "\n";
}

function drawText({ textFile, size, y, a, b }) {
  return (
    `drawtext=fontfile=${FONT_FILE}:textfile=${textFile}:fontsize=${size}` +
    `:fontcolor=white:borderw=5:bordercolor=black:x=(w-text_w)/2:y=${y}` +
    `:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`
  );
}

// Builds the full ffmpeg argument list plus the text files it needs written into its file system.
export function buildCommand({
  inputName,
  start,
  duration,
  cropW,
  staticX,
  hasTrack,
  captions,
  title,
  grade,
}) {
  const textFiles = [];
  const v = [];

  if (hasTrack) v.push("sendcmd=f=track.txt");
  v.push(`crop=w=${cropW}:h=ih:x=${staticX}:y=0`);
  v.push("scale=1080:1920");

  if (grade) {
    v.push("eq=contrast=1.08:saturation=1.12:brightness=0.02");
    v.push("unsharp=5:5:0.6:5:5:0.0");
  }

  if (title) {
    textFiles.push({ name: "title.txt", text: title });
    v.push(drawText({ textFile: "title.txt", size: 80, y: "h*0.12", a: 0, b: Math.min(3.5, duration) }));
  }

  captions.forEach((c, i) => {
    const name = `caption${i}.txt`;
    textFiles.push({ name, text: c.text });
    v.push(drawText({ textFile: name, size: 60, y: "h*0.74", a: c.a, b: c.b }));
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
    "-b:a", "160k",
    "-movflags", "+faststart",
    "output.mp4",
  ];

  return { args, textFiles };
}
