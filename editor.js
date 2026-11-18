// Pure editing logic: no DOM, no ffmpeg. Shared by the browser app and by tests.

export const SAMPLE_STEP = 0.5; // seconds between face-detection samples
// The font lives in its own folder inside ffmpeg's file system: the subtitle renderer loads every
// file in its fonts folder, and the root also holds the (large) input video.
export const FONT_DIR = "fonts";
export const FONT_FILE = `${FONT_DIR}/font.ttf`;

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
    // "0:12 text", or "0:12-0:16 text" to say when the line's singing ends (for word timing).
    const m = line.match(/^([^\s-]+)(?:-([^\s-]+))?\s+(.+)$/);
    const time = m ? parseTime(m[1]) : NaN;
    const end = m && m[2] !== undefined ? parseTime(m[2]) : undefined;
    if (Number.isNaN(time) || Number.isNaN(end) || (end !== undefined && end <= time)) bad.push(i + 1);
    else items.push(end === undefined ? { time, text: m[3].trim() } : { time, end, text: m[3].trim() });
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
    if (!(b > a && a < duration)) return;
    const c = { text: item.text, a, b };
    if (item.end !== undefined) c.sungEnd = Math.min(b, Math.max(a, item.end - start));
    out.push(c);
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

// Background noise reduction for the performance's sound. afftdn removes steady noise (fan, hum,
// hiss, room rumble); the high-pass takes out low rumble below the voice. Neither can remove other
// people talking, which would also damage the singing.
// afftdn only works well when its noise floor (nf) is set from the recording, so the app measures the
// clip's quietest moments (floorDb, mean loudness in dBFS). Measured with pink noise at -60, -48 and
// -39 dB under speech: nf = floor + 16 removes about 7 dB of noise, floor + 22 about 13-16 dB, and the
// speech level stays within 0.2 dB. afftdn accepts nf from -80 to -20.
const NOISE = {
  light: { highpass: 70, above: 16, nr: 10 },
  strong: { highpass: 90, above: 22, nr: 24 },
};

// The floor estimate is capped at -50 dB: in a recording with no quiet moments at all (continuous
// music) the "floor" is really the music, and treating that as noise dulls it (on a clean song,
// nf -20 took 8 dB off everything above 4 kHz). With the cap, the worst case is about 3 dB (strong).
const MAX_FLOOR = -50;

export function noiseFilters(level, floorDb = -60) {
  const n = NOISE[level];
  if (!n) return [];
  const nf = Math.max(-80, Math.min(-20, Math.round(Math.min(floorDb, MAX_FLOOR) + n.above)));
  return [`highpass=f=${n.highpass}`, `afftdn=nr=${n.nr}:nf=${nf}`];
}

// Loudness (mean square, dBFS) of each `hop`-second frame of mono samples.
export function loudnessDb(samples, sampleRate, hop = 0.25) {
  const n = Math.round(hop * sampleRate);
  const out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += samples[j] * samples[j];
    out.push(10 * Math.log10(sum / n + 1e-10));
  }
  return out;
}

// The quiet floor of a clip from its loudness frames (dB): the 5th percentile.
export function noiseFloor(rmsDb) {
  const v = rmsDb.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(0.05 * (v.length - 1))] : -60;
}

const CLOSEUP_ZOOM = 1.3;

// The close-up window for beat cuts: 1/1.3 the size of the wide crop, centred on the same point along
// the tracking axis, and nearer the top across it (faces are usually in the upper part of the frame).
// dx/dy are offsets from the wide window's position.
export function closeupGeometry(geometry) {
  const w = even(geometry.cropW / CLOSEUP_ZOOM);
  const h = even(geometry.cropH / CLOSEUP_ZOOM);
  const spareX = geometry.cropW - w;
  const spareY = geometry.cropH - h;
  const along = 0.5; // centred on the tracked face
  const across = 0.3; // a little headroom above the face
  return {
    w,
    h,
    dx: even(spareX * (geometry.axis === "x" ? along : 0.5)),
    dy: even(spareY * (geometry.axis === "y" ? along : across)),
  };
}

// With beat cuts, the face tracking moves both crops: the close-up keeps its offset from the wide shot.
export function cutTrackTargets(geometry) {
  const c = closeupGeometry(geometry);
  return [
    { name: "crop@wide", offset: 0 },
    { name: "crop@close", offset: geometry.axis === "y" ? c.dy : c.dx },
  ];
}

// Text for ffmpeg's sendcmd filter. At each key the crop offset becomes an expression of time that
// moves in a straight line to the next key, so the crop glides instead of jumping every sample.
// The last key holds still. Expressions avoid commas and spaces, which sendcmd treats as separators.
// targets: the crop filters to move, with an offset added to each ([{ name, offset }]); by default
// the single "crop". With beat cuts the wide and close-up crops both follow the singer.
export function trackFileText(keys, axis, targets = [{ name: "crop", offset: 0 }]) {
  const param = axis === "y" ? "y" : "x";
  return (
    keys
      .map((k, i) => {
        const next = keys[i + 1];
        const t0 = k.t.toFixed(2);
        const moving = next && next.x !== k.x && next.t > k.t;
        const span = moving ? (next.t - k.t).toFixed(2) : "";
        const commands = targets.map(({ name, offset }) => {
          const base = k.x + offset;
          return moving
            ? `${name} ${param} ${base}+(${next.x - k.x})*(t-${t0})/${span}`
            : `${name} ${param} ${base}`;
        });
        return `${t0} ${commands.join(", ")};`;
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
  captionStyle = "classic",
  noise = "off", // "off", "light" or "strong"
  noiseFloorDb = -60, // the clip's quiet floor, for tuning the noise reduction
  voiceVolume = 1, // the clip's own sound, 0 (muted) to 1
  music = null, // { name, volume (0-1), duck: "strong" | "light" } to mix in a music file
  closeups = [], // [{ a, b }]: stretches shown as a close-up (beat cuts)
}) {
  const textFiles = [];
  const v = [];
  const gradeFilters = grade
    ? ["eq=contrast=1.08:saturation=1.12:brightness=0.02", "unsharp=3:3:0.8:3:3:0.0"]
    : [];
  // setsar=1: the crop is only approximately 9:16, so mark the pixels square rather than let players
  // stretch the picture by the tiny difference.
  const toFrame = [`scale=${FRAME_W}:${FRAME_H}`, "setsar=1"];

  if (closeups.length) {
    // Beat cuts: the picture is split into a wide shot and a close-up of the singer, each cropped,
    // graded and scaled on its own; the close-up is shown over the wide shot during its stretches.
    const close = closeupGeometry(geometry);
    const wideX = geometry.axis === "x" ? staticOffset : 0;
    const wideY = geometry.axis === "y" ? staticOffset : 0;
    const enable = closeups.map((c) => `between(t,${c.a.toFixed(2)},${c.b.toFixed(2)})`).join("+");
    v.push(
      (hasTrack ? "sendcmd=f=track.txt," : "") +
        "split[wide][close];" +
        [`[wide]crop@wide=w=${geometry.cropW}:h=${geometry.cropH}:x=${wideX}:y=${wideY}`, ...gradeFilters, ...toFrame].join(",") +
        "[wv];" +
        [`[close]crop@close=w=${close.w}:h=${close.h}:x=${wideX + close.dx}:y=${wideY + close.dy}`, ...gradeFilters, ...toFrame].join(",") +
        "[cv];" +
        `[wv][cv]overlay=enable='${enable}'`
    );
  } else {
    if (geometry.axis !== "none") {
      if (hasTrack) v.push("sendcmd=f=track.txt");
      const { cropW, cropH } = geometry;
      v.push(
        geometry.axis === "x"
          ? `crop=w=${cropW}:h=${cropH}:x=${staticOffset}:y=0`
          : `crop=w=${cropW}:h=${cropH}:x=0:y=${staticOffset}`
      );
    }
    // Grade before upscaling: the cropped frame has about a third of the pixels of 1080x1920,
    // so the colour and sharpening filters cost a third as much. (Sharpening the source detail
    // before the upscale also looks at least as good as sharpening the upscaled result.)
    v.push(...gradeFilters, ...toFrame);
  }

  if (title) {
    addTextBlock({
      v, textFiles, prefix: "title", text: title, fit: TITLE_FIT,
      y: TITLE_TOP, anchor: "top", a: 0, b: Math.min(3.5, duration),
    });
  }

  if (captionStyle !== "classic" && captions.length) {
    textFiles.push({ name: "captions.ass", text: buildAss(captions, captionStyle) });
    v.push(`subtitles=filename=captions.ass:fontsdir=${FONT_DIR}`);
  } else {
    captions.forEach((c, i) => {
      addTextBlock({
        v, textFiles, prefix: `caption${i}`, text: c.text, fit: CAPTION_FIT,
        y: CAPTION_BOTTOM, anchor: "bottom", a: c.a, b: c.b,
      });
    });
  }

  const fadeOutAt = (duration - 1).toFixed(2);
  if (duration > 2) {
    v.push("fade=t=in:st=0:d=0.6", `fade=t=out:st=${fadeOutAt}:d=1`);
  }

  // The performance's own sound: noise reduction first, then fades and gentle compression.
  const voice = [...noiseFilters(noise, noiseFloorDb), "afade=t=in:st=0:d=0.6"];
  if (duration > 2) voice.push(`afade=t=out:st=${fadeOutAt}:d=1`);
  voice.push("acompressor=threshold=0.125:ratio=3:attack=20:release=250");
  const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";

  const inputs = ["-ss", String(start), "-i", inputName];
  let audioArgs;
  if (music) {
    // Music: looped if it's shorter than the reel, faded in and out, and "ducked" (turned down)
    // while the performance is loud, so the singing stays on top.
    inputs.push("-stream_loop", "-1", "-i", music.name);
    const fadeOut = Math.max(0, duration - 1.5).toFixed(2);
    const duck = music.duck === "light" ? "threshold=0.06:ratio=3" : "threshold=0.03:ratio=8";
    const graph =
      // With music, the clip's volume sets the balance before the mix (and the ducking follows it).
      `[0:a]${[...voice, ...(voiceVolume !== 1 ? [`volume=${voiceVolume}`] : [])].join(",")},asplit[voice][key];` +
      `[1:a]aresample=48000,volume=${music.volume},afade=t=in:st=0:d=1,afade=t=out:st=${fadeOut}:d=1.5[music];` +
      `[music][key]sidechaincompress=${duck}:attack=15:release=350[ducked];` +
      `[voice][ducked]amix=inputs=2:duration=first:normalize=0,${LOUDNORM}[aout]`;
    audioArgs = ["-filter_complex", graph, "-map", "0:v:0", "-map", "[aout]"];
  } else {
    // Without music, the clip's volume goes after loudnorm, which would otherwise undo it.
    audioArgs = ["-af", [...voice, LOUDNORM, ...(voiceVolume !== 1 ? [`volume=${voiceVolume}`] : [])].join(",")];
  }

  const args = [
    ...inputs,
    "-t", String(duration),
    "-vf", v.join(","),
    ...audioArgs,
    "-c:v", "libx264",
    // ultrafast is about 2x quicker than veryfast in the browser. Its files are larger, so the quality
    // setting is nudged up (lower crf) to compensate; Instagram re-encodes uploads anyway.
    "-preset", "ultrafast",
    "-crf", "21",
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

// ---- Finding the song --------------------------------------------------------------------------
// The browser runs Google's YAMNet sound classifier over the audio in ~1 second windows. These
// functions turn its scores into a trim: start a little before the singing, end when the music does.
//
// In a full mix YAMNet's singing scores are small (often 0.01-0.05) because "Music" dominates, but
// instrumental passages score essentially 0, so the threshold is relative to the loudest vocals in
// the clip. Speech is excluded by requiring music to outweigh speech.

export const VOCAL_LABELS = [
  "Singing", "Male singing", "Female singing", "Child singing", "Synthetic singing", "Choir",
  "Vocal music", "A capella", "Humming", "Rapping", "Chant", "Mantra", "Yodeling",
];
export const AUDIO_LABELS = [...VOCAL_LABELS, "Speech", "Music", "Applause", "Cheering", "Crowd", "Silence"];

// { categoryName: score } for one window -> the four numbers the trim logic uses.
export function summarizeScores(scores) {
  const get = (k) => scores[k] || 0;
  return {
    vocal: VOCAL_LABELS.reduce((sum, k) => sum + get(k), 0),
    speech: get("Speech"),
    music: get("Music"),
    crowd: get("Applause") + get("Cheering") + get("Crowd"),
  };
}

const MIN_VOCAL = 0.008; // below this a window never counts as singing
const VOCAL_FRACTION = 0.1; // ...and it must reach this share of the clip's typical strong vocals
const MUSIC_MIN = 0.3; // a window counts as music (for the outro) above this

// Which windows have singing: vocal score above a threshold relative to the clip's typical strong
// vocals, and music outweighing speech (so talking never counts).
export function singingFlags(windows) {
  // "Typical strong vocals" = 90th percentile of windows with any vocal score at all. Using the
  // single loudest window instead lets one spike raise the bar above the quieter opening lines.
  const voiced = windows.map((w) => w.vocal).filter((v) => v >= 0.004).sort((a, b) => a - b);
  const strong = voiced.length ? voiced[Math.floor(0.9 * (voiced.length - 1))] : 0;
  const vocalThr = Math.max(MIN_VOCAL, VOCAL_FRACTION * strong);
  return windows.map((w) => w.vocal >= vocalThr && w.music + w.vocal > w.speech);
}

// windows: [{ t, vocal, speech, music, crowd }] in time order, t = window start in seconds.
// Returns { start, end, singStart, songEnd, found } where found is "singing", "music" or null.
export function findSongBounds(windows, duration, { leadIn = 2, tail = 0.5 } = {}) {
  const none = { start: 0, end: duration, singStart: null, songEnd: null, found: null };
  if (!windows.length) return none;
  const hop = windows.length > 1 ? windows[1].t - windows[0].t : 0.975;

  const sings = singingFlags(windows);
  const musical = windows.map(
    (w, i) => sings[i] || (w.music >= MUSIC_MIN && w.music > w.speech && w.music > w.crowd)
  );

  // Sustained: the window and at least one more within the next (or previous) 3 windows.
  const sustained = (i, dir) => {
    for (let k = 1; k <= 3; k++) if (sings[i + dir * k]) return true;
    return false;
  };

  let first = sings.findIndex((s, i) => s && sustained(i, +1));
  let last = -1;
  for (let i = sings.length - 1; i >= 0; i--) if (sings[i] && sustained(i, -1)) { last = i; break; }
  let found = "singing";

  if (first < 0) {
    // No clear singing (an instrumental, or vocals the classifier can't hear): trim to the music.
    first = musical.findIndex((m, i) => m && musical[i + 1]);
    last = -1;
    for (let i = musical.length - 1; i > 0; i--) if (musical[i] && musical[i - 1]) { last = i; break; }
    if (first < 0 || last < first) return none;
    found = "music";
  }

  // Carry on past the last singing through the outro while it's still music (bridging 1-window gaps).
  let endIdx = last;
  for (let i = last + 1; i < windows.length; i++) {
    if (musical[i]) endIdx = i;
    else if (!musical[i + 1]) break;
  }

  const singStart = windows[first].t;
  const songEnd = Math.min(duration, windows[endIdx].t + hop);
  const start = Math.max(0, singStart - (found === "singing" ? leadIn : 0.5));
  const end = Math.min(duration, songEnd + tail);
  const round = (v) => Math.round(v * 10) / 10;
  return { start: round(start), end: round(end), singStart: round(singStart), songEnd: round(songEnd), found };
}

// 83.4 -> "1:23.4"
export function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  const text = s.toFixed(1).replace(/\.0$/, "");
  return `${m}:${s < 10 ? "0" : ""}${text}`;
}

// ---- Render timer ------------------------------------------------------------------------------

// ffmpeg's log line "frame=  120 fps= 12 ... time=00:00:05.12 ..." -> 5.12 (seconds of reel encoded).
export function parseEncodedTime(line) {
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// Seconds left to encode, or null when there's nothing to go on yet.
//   total, encoded: seconds of reel; encodeElapsed: wall-clock seconds spent encoding so far;
//   savedRate: wall-clock seconds per reel second from the last reel on this device (optional).
// The live rate takes over from the saved one as encoding gets going (fully by a quarter of the way).
export function estimateRemaining({ total, encoded, encodeElapsed, savedRate = null }) {
  const left = Math.max(0, total - encoded);
  let rate = encoded >= 0.5 && encodeElapsed >= 3 ? encodeElapsed / encoded : null;
  if (savedRate > 0) {
    if (rate == null) rate = savedRate;
    else {
      const w = Math.min(1, encoded / (0.25 * total));
      rate = w * rate + (1 - w) * savedRate;
    }
  }
  return rate == null ? null : left * rate;
}

// ---- Animated captions (ASS subtitles, drawn by ffmpeg's libass) -------------------------------
// "karaoke": the whole line, each word filling with colour as it's sung.
// "pop": 2-3 big uppercase words at a time; the word being sung is highlighted and each group pops in.
// Word times are estimated by spreading the line's words over its singing time, weighted by syllables.

export const CAPTION_STYLES = ["pop", "karaoke", "classic"];
const HIGHLIGHT = "&H0000E5FF&"; // ASS colours are &HBBGGRR: this is #FFE500
const WHITE = "&H00FFFFFF&";
const POP_FIT = { size: 100, minSize: 64, maxLines: 2 };
// libass sizes text by the font's full line height, which for Poppins draws glyphs smaller than
// drawtext does at the same size (capital M: 40 px vs 70 px at size 100, measured with ffmpeg).
// Sizes here are in drawtext terms, so the wrapping maths stays the same, and are scaled for libass.
const ASS_FONT_SCALE = 1.75;
const assSize = (size) => Math.round(size * ASS_FONT_SCALE);
const POP_MAX_WORDS = 3;
const POP_MAX_CHARS = 16;
const SECONDS_PER_WORD = 0.8; // typical sung pace, used when a line has no end time
const POP_HOLD = 1.2; // how long the last group stays after its last word (if the next line isn't sooner)

function syllables(word) {
  return Math.max(1, (word.toLowerCase().match(/[aeiouy]+/g) || []).length);
}

// [{ word, s, e }] for a caption window { text, a, b, sungEnd? }.
export function wordTimings({ text, a, b, sungEnd }) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const span =
    sungEnd !== undefined
      ? Math.max(0.2, sungEnd - a)
      : Math.min(0.9 * (b - a), Math.max(1, words.length * SECONDS_PER_WORD));
  const weights = words.map(syllables);
  const total = weights.reduce((x, y) => x + y, 0);
  let t = a;
  return words.map((word, i) => {
    const s = t;
    t += (span * weights[i]) / total;
    return { word, s, e: i === words.length - 1 ? a + span : t };
  });
}

// Braces and backslashes start ASS override codes, so they can't appear literally in lyrics.
const assText = (t) => t.replace(/\\/g, "/").replace(/{/g, "(").replace(/}/g, ")");

// 83.456 -> "0:01:23.46"
export function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = (cs % 6000) / 100;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

// Puts "\N" line breaks into a list of word strings where fitText wrapped them.
function joinWrapped(words, lines) {
  const counts = lines.map((l) => l.split(" ").length);
  if (counts.reduce((x, y) => x + y, 0) !== words.length) return words.join(" "); // a word was hard-split
  const out = [];
  let i = 0;
  counts.forEach((n, li) => {
    out.push(words.slice(i, i + n).join(" "));
    i += n;
    if (li < counts.length - 1) out.push("\\N");
  });
  return out.join(" ").replace(/ \\N /g, "\\N");
}

function dialogue(start, end, style, text) {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function karaokeEvents(c) {
  const timed = wordTimings(c);
  if (!timed.length) return [];
  const { size, lines } = fitText(c.text, CAPTION_FIT);
  // \kf<centiseconds> fills a word over that time; a word's tag also covers any gap before the next.
  const words = timed.map((w, i) => {
    const until = i + 1 < timed.length ? timed[i + 1].s : w.e;
    const cs = Math.max(1, Math.round((until - w.s) * 100));
    return `{\\kf${cs}}${assText(w.word)}`;
  });
  return [dialogue(c.a, c.b, "Karaoke", `{\\fs${assSize(size)}}` + joinWrapped(words, lines))];
}

// Groups words into chunks of up to POP_MAX_WORDS, keeping each chunk short enough to read at a glance.
function popChunks(timed) {
  const chunks = [];
  let cur = [];
  for (const w of timed) {
    const chars = cur.map((x) => x.word).join(" ").length + (cur.length ? 1 : 0) + w.word.length;
    if (cur.length && (cur.length >= POP_MAX_WORDS || chars > POP_MAX_CHARS)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function popEvents(c) {
  const timed = wordTimings(c);
  const chunks = popChunks(timed);
  const events = [];
  chunks.forEach((chunk, ci) => {
    const upper = chunk.map((w) => assText(w.word.toUpperCase()));
    const { size, lines } = fitText(upper.join(" "), POP_FIT);
    const chunkEnd =
      ci + 1 < chunks.length ? chunks[ci + 1][0].s : Math.min(c.b, chunk[chunk.length - 1].e + POP_HOLD);
    chunk.forEach((w, wi) => {
      const start = w.s;
      const end = wi + 1 < chunk.length ? chunk[wi + 1].s : chunkEnd;
      if (end <= start) return;
      const words = upper.map((u, k) => (k === wi ? `{\\c${HIGHLIGHT}}${u}{\\c${WHITE}}` : u));
      // The group pops in (80% -> 100% size) when it first appears.
      const pop = wi === 0 ? "\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)" : "";
      events.push(dialogue(start, end, "Pop", `{\\fs${assSize(size)}${pop}}` + joinWrapped(words, lines)));
    });
  });
  return events;
}

export function buildAss(captions, style) {
  const karaokeMarginV = FRAME_H - CAPTION_BOTTOM;
  const popMarginV = Math.round(FRAME_H * 0.3);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${FRAME_W}`,
    `PlayResY: ${FRAME_H}`,
    "WrapStyle: 2", // no automatic wrapping: lines are broken by fitText, the same as everywhere else
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Karaoke fills from SecondaryColour (white, not yet sung) to PrimaryColour (highlight).
    `Style: Karaoke,Poppins,${assSize(CAPTION_FIT.size)},${HIGHLIGHT},${WHITE},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,5,2,2,${TEXT_MARGIN},${TEXT_MARGIN},${karaokeMarginV},1`,
    `Style: Pop,Poppins,${assSize(POP_FIT.size)},${WHITE},${WHITE},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,7,3,2,${TEXT_MARGIN},${TEXT_MARGIN},${popMarginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = captions.flatMap((c) => (style === "karaoke" ? karaokeEvents(c) : popEvents(c)));
  return header.concat(events).join("\n") + "\n";
}
