// Beats, bars, beat-synced cuts and a generated drum track. Pure functions, no browser code.
//
// Beat tracking follows the classic approach (Ellis 2007): an onset-strength envelope from spectral
// flux, a tempo from its autocorrelation (with a preference for 80-160 BPM), then dynamic programming
// to place beats that line up with onsets while keeping a steady spacing.

import { fft } from "./moments.js";

const FRAME = 1024;
const HOP_N = 256; // at 16 kHz: 16 ms per onset frame

// ---- Onsets, tempo, beats ----------------------------------------------------------------------

// samples: mono Float32Array at sampleRate. Returns { hop (s), env: Float64Array } (normalised to max 1).
export function onsetEnvelope(samples, sampleRate) {
  const hopN = Math.round((HOP_N * sampleRate) / 16000);
  const frame = hopN * 4;
  const size = 1 << Math.ceil(Math.log2(frame));
  const count = Math.max(0, Math.floor((samples.length - frame) / hopN) + 1);
  const win = new Float64Array(frame).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1)));
  const bins = size / 2;
  let prev = new Float64Array(bins);
  const env = new Float64Array(count);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let f = 0; f < count; f++) {
    re.fill(0);
    im.fill(0);
    const off = f * hopN;
    for (let i = 0; i < frame; i++) re[i] = samples[off + i] * win[i];
    fft(re, im);
    const cur = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // Remove the slow-moving average (so steady loudness doesn't count) and keep the positive part.
  const w = Math.round(1 / (hopN / sampleRate)); // ~1 s
  const out = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += env[i];
    if (i >= w) sum -= env[i - w];
    const avg = sum / Math.min(i + 1, w);
    out[i] = Math.max(0, env[i] - avg);
  }
  let max = 1e-9;
  for (let i = 0; i < count; i++) if (out[i] > max) max = out[i];
  for (let i = 0; i < count; i++) out[i] /= max;
  // Frame f covers samples [f*hop, f*hop + frame): an onset shows up as the window reaches it, so
  // frame times run early by about half a window. `offset` corrects for that.
  return { hop: hopN / sampleRate, env: out, offset: frame / 2 / sampleRate };
}

// Tempo in BPM from the onset envelope's autocorrelation, weighted towards ~120 BPM.
export function estimateTempo(env, hop, { min = 60, max = 190, centre = 120 } = {}) {
  const n = env.length;
  let best = centre;
  let bestScore = -Infinity;
  let total = 0;
  const scores = [];
  // Autocorrelation at a (fractional) lag, averaged over the overlap.
  const acAt = (lag) => {
    const l0 = Math.floor(lag);
    const frac = lag - l0;
    if (l0 + 1 >= n) return 0;
    let ac = 0;
    for (let i = 0; i + l0 + 1 < n; i++) ac += env[i] * ((1 - frac) * env[i + l0] + frac * env[i + l0 + 1]);
    return ac / (n - l0 - 1);
  };
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = 60 / bpm / hop;
    // A real pulse also repeats 2, 3 and 4 beats later; a coincidental 3-against-4 pattern doesn't.
    const ac = acAt(lag) + acAt(2 * lag) / 2 + acAt(3 * lag) / 3 + acAt(4 * lag) / 4;
    // Log-normal preference around the centre tempo (one octave = one standard deviation).
    const weight = Math.exp(-0.5 * Math.log2(bpm / centre) ** 2);
    const score = ac * weight;
    scores.push(score);
    total += score;
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  const mean = total / scores.length;
  return { bpm: best, strength: mean > 0 ? bestScore / mean : 0 };
}

// Beat times (seconds) by dynamic programming over the onset envelope.
export function trackBeats(env, hop, bpm, { tightness = 100 } = {}) {
  const n = env.length;
  if (!n) return [];
  const period = 60 / bpm / hop; // frames per beat
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = 0;
    const lo = Math.max(0, Math.round(t - 2 * period));
    const hi = Math.round(t - period / 2);
    for (let p = lo; p <= hi; p++) {
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (bestPrev < 0 || v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = env[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestPrev >= 0 && bestVal > 0 ? bestPrev : -1;
  }
  // Start from the best-scoring frame within the last beat period.
  let t = n - 1;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i] > score[t]) t = i;
  const beats = [];
  while (t >= 0) {
    beats.push(t * hop);
    t = back[t];
  }
  beats.reverse();
  // Fill a missing start: extend backwards at the beat period while still inside the clip.
  const step = period * hop;
  while (beats.length && beats[0] - step >= -0.05) beats.unshift(Math.max(0, beats[0] - step));
  return beats;
}

// Which beat in each bar of 4 is beat 1: the phase whose beats carry the most onset strength.
export function downbeatPhase(beats, env, hop) {
  const sums = [0, 0, 0, 0];
  beats.forEach((b, i) => {
    const f = Math.round(b / hop);
    let peak = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < env.length) peak = Math.max(peak, env[k]);
    sums[i % 4] += peak;
  });
  return sums.indexOf(Math.max(...sums));
}

// Everything at once. Returns { bpm, beats, downbeats, phase, confidence (0-1) }.
export function beatGrid(samples, sampleRate) {
  const { hop, env, offset } = onsetEnvelope(samples, sampleRate);
  if (env.length < 20) return { bpm: 0, beats: [], downbeats: [], phase: 0, confidence: 0 };
  const { bpm, strength } = estimateTempo(env, hop);
  const duration = samples.length / sampleRate;
  const beats = trackBeats(env, hop, bpm)
    .map((b) => Math.round((b + offset) * 1000) / 1000)
    .filter((b) => b < duration);
  const phase = downbeatPhase(beats.map((b) => b - offset), env, hop);
  const downbeats = beats.filter((_, i) => i % 4 === phase);
  // Strength is how far the chosen tempo stands out from the average; ~1 means no clear pulse.
  const confidence = Math.max(0, Math.min(1, (strength - 1) / 1.5));
  return { bpm, beats, downbeats, phase, confidence };
}

// ---- Beat-synced cuts --------------------------------------------------------------------------

// Alternates wide and close-up shots, changing on bar lines. Each shot lasts a whole number of bars,
// about 4 s (at least 2 s; shorter in a short clip, so it still gets a close-up). Without a usable
// beat it changes every 4 s instead.
// Returns the close-up stretches: [{ a, b }] in seconds.
export function cutPlan({ beats = [], downbeats = [], confidence = 0 }, duration, { target = 4, minShot = 2 } = {}) {
  let marks;
  if (confidence >= 0.15 && downbeats.length >= 2) {
    const bar = (downbeats[downbeats.length - 1] - downbeats[0]) / (downbeats.length - 1);
    let barsPerShot = Math.max(1, Math.round(target / bar));
    // A short clip needs at least 3 shots (wide, close, wide) for a close-up to happen at all.
    while (barsPerShot > 1 && duration / (bar * barsPerShot) < 3) barsPerShot--;
    marks = downbeats.filter((_, i) => i % barsPerShot === 0);
  } else if (confidence >= 0.15 && beats.length >= 8) {
    const beat = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    const beatsPerShot = Math.max(2, Math.round(target / beat));
    marks = beats.filter((_, i) => i % beatsPerShot === 0);
  } else {
    marks = [];
    for (let t = target; t < duration; t += target) marks.push(t);
  }
  // Shots: [0, m1), [m1, m2), ... ; the first and last stay wide (title and fade).
  const edges = [0, ...marks.filter((m) => m > minShot && m < duration - minShot), duration];
  const shots = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i + 1] - edges[i] >= minShot || !shots.length) shots.push({ a: edges[i], b: edges[i + 1] });
    else shots[shots.length - 1].b = edges[i + 1];
  }
  const close = [];
  shots.forEach((s, i) => {
    if (i % 2 === 1 && i < shots.length - 1) close.push({ a: round2(s.a), b: round2(s.b) });
  });
  return close;
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---- Generated drums ---------------------------------------------------------------------------

// A simple pop groove on the given beats: kick on 1 and 3, snare on 2 and 4, hi-hats on every
// beat and half beat. Every hit is synthesised (no samples), so there's nothing to license.
// beats: seconds, relative to the start of the reel. Returns a mono Float32Array at sampleRate.
export function synthDrums(beats, phase, duration, sampleRate = 44100) {
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  const add = (t, len, fn) => {
    const s0 = Math.round(t * sampleRate);
    const n = Math.round(len * sampleRate);
    for (let i = 0; i < n && s0 + i < out.length; i++) if (s0 + i >= 0) out[s0 + i] += fn(i / sampleRate);
  };
  const kick = (t) =>
    // A sine sweeping from 155 Hz down to 45 Hz (phase = integral of the frequency), decaying fast.
    add(t, 0.35, (x) => 0.9 * Math.sin(2 * Math.PI * (45 * x + (110 / 30) * (1 - Math.exp(-x * 30)))) * Math.exp(-x * 9));
  const snare = (t) => {
    let lp = 0;
    add(t, 0.22, (x) => {
      const n = noise();
      lp += 0.6 * (n - lp); // soften the noise a little
      return (0.45 * (n - lp) + 0.25 * Math.sin(2 * Math.PI * 190 * x)) * Math.exp(-x * 18);
    });
  };
  const hat = (t, level) => {
    let prev = 0;
    add(t, 0.05, (x) => {
      const n = noise();
      const hp = n - prev; // crude high-pass for a bright, short "tss"
      prev = n;
      return level * hp * Math.exp(-x * 90);
    });
  };

  beats.forEach((b, i) => {
    if (b >= duration) return;
    const pos = (((i - phase) % 4) + 4) % 4; // 0 = beat 1 of the bar
    if (pos === 0 || pos === 2) kick(b);
    if (pos === 1 || pos === 3) snare(b);
    hat(b, 0.16);
    const next = beats[i + 1] ?? b + (i > 0 ? b - beats[i - 1] : 0.5);
    hat((b + next) / 2, 0.1);
  });

  // Fade in and out, and keep peaks below full scale.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 0.7 / peak : 1;
  const fade = Math.round(0.5 * sampleRate);
  for (let i = 0; i < out.length; i++) {
    const edge = Math.min(1, i / fade, (out.length - 1 - i) / fade);
    out[i] *= gain * edge;
  }
  return out;
}

// 16-bit PCM WAV file bytes for mono samples.
export function encodeWav(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  }
  return bytes;
}

// ---- Matching a music file to the video's beat -------------------------------------------------
// If the people in the video move to the sound in the original recording, their steps follow its
// beat. To make new music land on those steps, the music is sped up or slowed down to the video's
// tempo (ffmpeg's atempo, which keeps the pitch) and started at the point where its beats line up
// with the video's beats, bar lines included.

const MAX_STRETCH = 0.1; // more than ±10% speed change sounds wrong

// How many of the video's beats have a music beat close by (within `tol` seconds), weighted so
// closer is better. musicBeats must already be in reel time. Returns { score, fraction }.
function alignment(videoBeats, musicBeats, tol = 0.07) {
  if (!videoBeats.length || !musicBeats.length) return { score: 0, fraction: 0 };
  let score = 0;
  let hits = 0;
  let j = 0;
  for (const v of videoBeats) {
    while (j + 1 < musicBeats.length && musicBeats[j + 1] <= v) j++;
    const d = Math.min(Math.abs(musicBeats[j] - v), j + 1 < musicBeats.length ? Math.abs(musicBeats[j + 1] - v) : Infinity);
    score += Math.exp(-((d / 0.03) ** 2) / 2);
    if (d <= tol) hits++;
  }
  return { score, fraction: hits / videoBeats.length };
}

// video: beat grid of the reel's own sound (times from the reel start). music: beat grid of the
// whole music file (times from the file start). duration: reel length.
// Returns { ok, reason?, tempo (atempo factor), start (seconds into the sped-up music to begin at),
//   videoBpm, musicBpm, fraction (share of the video's beats that line up), beats, downbeats, phase }
// with beats/downbeats being the music's beats in reel time after matching.
export function matchMusic(video, music, duration, { minConfidence = 0.15 } = {}) {
  const fail = (reason) => ({ ok: false, reason, tempo: 1, start: 0, videoBpm: video.bpm, musicBpm: music.bpm, fraction: 0 });
  if (video.confidence < minConfidence || video.beats.length < 4) return fail("no clear beat in the video's sound");
  if (music.confidence < minConfidence || music.beats.length < 4) return fail("no clear beat in the music");

  // Half and double tempo are the same pulse: pick whichever needs the smallest speed change.
  const options = [1, 2, 0.5].map((k) => video.bpm / (music.bpm * k)).filter((r) => Math.abs(r - 1) <= MAX_STRETCH);
  if (!options.length) return fail(`the tempos are too different (${music.bpm} vs ${video.bpm} BPM)`);
  const tempo = options.reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));

  // Music beats after the speed change, in sped-up music time.
  const fast = music.beats.map((b) => b / tempo);
  const fastDown = new Set(music.downbeats.map((b) => b / tempo));
  const vBeats = video.beats;
  const vDown = video.downbeats.length ? video.downbeats : vBeats;

  // Try starting points that put a music bar line on one of the video's first few bar lines.
  const firstBars = vDown.slice(0, 4);
  const musicBars = fast.filter((b) => fastDown.has(b) || !fastDown.size);
  const tried = [];
  for (const mb of musicBars) {
    for (const vb of firstBars) {
      const start = mb - vb;
      if (start < 0) continue;
      const shifted = fast.map((b) => b - start).filter((b) => b > -1 && b < duration + 1);
      tried.push({ start, ...alignment(vBeats, shifted) });
    }
  }
  if (!tried.length) return fail("the music is too short to line up");
  // Many starting points fit about equally well; use the earliest that's within 3% of the best,
  // so the song plays from near its beginning.
  const top = Math.max(...tried.map((c) => c.score));
  const best = tried.filter((c) => c.score >= 0.97 * top).reduce((a, b) => (b.start < a.start ? b : a));

  const beats = fast.map((b) => b - best.start).filter((b) => b >= 0 && b < duration);
  const downbeats = fast.filter((b) => fastDown.has(b)).map((b) => b - best.start).filter((b) => b >= 0 && b < duration);
  return {
    ok: true,
    tempo: Math.round(tempo * 10000) / 10000,
    start: Math.round(best.start * 1000) / 1000,
    videoBpm: video.bpm,
    musicBpm: music.bpm,
    fraction: best.fraction,
    beats,
    downbeats,
    phase: 0,
    confidence: music.confidence,
  };
}

// ---- Beats from movement -----------------------------------------------------------------------
// When the video's sound has no clear beat (dancing in silence, talk over the top), the beat can come
// from the picture: steps, claps and arm hits are bursts of change between frames. The app grabs
// frames as tiny greyscale thumbnails with their exact times; these functions turn that into the same
// kind of beat grid as the sound gives, so tempo, bars, matching and cuts all work the same way.

// RGBA pixels -> greyscale (0-255) Float32Array.
export function toGray(rgba) {
  const g = new Float32Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}

// How much the picture changed between two greyscale thumbnails: mean absolute difference, minus the
// part explained by an overall brightness change (lights, auto-exposure), so only movement counts.
export function frameMotion(prev, cur) {
  let meanDiff = 0;
  for (let i = 0; i < cur.length; i++) meanDiff += cur[i] - prev[i];
  meanDiff /= cur.length;
  let m = 0;
  for (let i = 0; i < cur.length; i++) m += Math.abs(cur[i] - prev[i] - meanDiff);
  return m / cur.length;
}

const MOTION_HOP = 0.02; // seconds per envelope step

// samples: [{ t, motion }] in time order (irregular times are fine), t from the reel start.
// Returns a beat grid like beatGrid(): { bpm, beats, downbeats, phase, confidence }.
export function movementGrid(samples, duration) {
  const none = { bpm: 0, beats: [], downbeats: [], phase: 0, confidence: 0 };
  if (samples.length < 20 || duration < 3) return none;
  // Resample onto an even time grid (linear between samples).
  const n = Math.floor(duration / MOTION_HOP);
  const raw = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * MOTION_HOP;
    while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
    const a = samples[j];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    raw[i] = b.t > a.t ? a.motion + ((b.motion - a.motion) * Math.min(1, Math.max(0, t - a.t))) / (b.t - a.t) : a.motion;
  }
  // Like the sound's onsets: rises in movement above the recent average (so steady swaying or camera
  // shake doesn't count), normalised.
  const w = Math.round(1 / MOTION_HOP);
  const env = new Float64Array(n);
  let sum = 0;
  let max = 1e-9;
  for (let i = 0; i < n; i++) {
    sum += raw[i];
    if (i >= w) sum -= raw[i - w];
    const rise = i > 0 ? raw[i] - raw[i - 1] : 0;
    env[i] = Math.max(0, raw[i] - sum / Math.min(i + 1, w)) + Math.max(0, rise);
    if (env[i] > max) max = env[i];
  }
  for (let i = 0; i < n; i++) env[i] /= max;

  const { bpm, strength } = estimateTempo(env, MOTION_HOP);
  const beats = trackBeats(env, MOTION_HOP, bpm).filter((b) => b < duration);
  const phase = downbeatPhase(beats, env, MOTION_HOP);
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === phase),
    phase,
    // Movement is noisier than sound: random fidgeting scored 1.3-1.35 in tests and rhythmic steps
    // 2.5 or more, so the scale starts higher than for sound (where ~1 means no pulse).
    confidence: Math.max(0, Math.min(1, (strength - 1.5) / 1.0)),
  };
}
