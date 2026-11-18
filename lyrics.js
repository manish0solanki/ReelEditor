// Turning speech-recognition output (Whisper's timed phrases) into the lyrics box's format:
// "m:ss-m:ss text" per line, with times in the original video. Pure functions, no browser code.

import { formatTime } from "./editor.js";
import { transliterate, hasDevanagari } from "./translit.js";

// Things Whisper writes for music or silence, or invents at the end of a recording.
const TAGS = /\[[^\]]*\]|\([^)]*\)|[♪♫🎵🎶*]+/g;
const INVENTED = [
  /^thank(s| you)( so much)?( for watching)?[.!]*$/i,
  /^(please )?subscribe/i,
  /^subtitles? (by|provided)/i,
  /^(music|instrumental|applause|silence)[.!]*$/i,
  /^\.+$/,
];

// One phrase's text, tidied up and romanized if it's in Devanagari.
export function cleanLine(text) {
  let t = String(text).replace(TAGS, " ");
  if (hasDevanagari(t)) t = transliterate(t);
  t = t.replace(/\s+/g, " ").replace(/^[\s,.\-–—:;]+|[\s,\-–—:;]+$/g, "").trim();
  if (!t || INVENTED.some((re) => re.test(t))) return "";
  if (!/[\p{L}\p{N}]/u.test(t)) return ""; // punctuation only
  return t;
}

// chunks: [{ timestamp: [start, end | null], text }] relative to the analysed audio.
// offset: where that audio starts in the original video (seconds).
// Returns the lines as strings, in order.
export function chunksToLyrics(chunks, offset = 0) {
  const lines = [];
  let previous = "";
  let repeats = 0;
  chunks.forEach((c, i) => {
    const text = cleanLine(c.text);
    if (!text) return;
    // Whisper sometimes gets stuck repeating a line; a chorus can repeat, but not 3+ times in a row.
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    repeats = key === previous ? repeats + 1 : 0;
    previous = key;
    if (repeats >= 2) return;

    const [s, e] = c.timestamp || [];
    if (!Number.isFinite(s)) return;
    const next = chunks[i + 1]?.timestamp?.[0];
    const end = Number.isFinite(e) && e > s ? e : Number.isFinite(next) && next > s ? next : s + 4;
    lines.push(`${formatTime(offset + s)}-${formatTime(offset + end)} ${text}`);
  });
  return lines;
}
