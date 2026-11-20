// Finding the best moment in a song: pure audio analysis, no browser code, so it can be tested.
//
// A "best moment" is a stretch of the target length that scores well on:
//   chorus  - how strongly the passage repeats elsewhere in the song (a song's hook usually does),
//             found by comparing pitch-class fingerprints ("chroma") of every quarter second
//   vocals  - how much of it has singing (from the YAMNet windows the app already computes)
//   energy  - how loud and full it is compared with the rest of the song
//   crowd   - applause or cheering during or just after it
// The start and end are then moved to nearby quiet points so the clip doesn't cut mid-phrase.

export const HOP = 0.25; // seconds between analysis frames
const FRAME = 4096; // samples per FFT frame (at 16 kHz: 0.256 s)
const MIN_FREQ = 80;
const MAX_FREQ = 2000;

// ---- Signal features ---------------------------------------------------------------------------

// In-place radix-2 FFT. re/im are Float64Arrays of a power-of-two length.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// samples: mono Float32Array. Returns { hop, rms: number[] (dB), chroma: Float64Array[12][] }.
export function audioFeatures(samples, sampleRate) {
  const hopN = Math.round(HOP * sampleRate);
  const count = Math.max(0, Math.floor((samples.length - 1) / hopN) + 1);
  const window = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  // Pitch class of each FFT bin in the useful range (-1 = ignore).
  const binClass = new Int8Array(FRAME / 2).fill(-1);
  for (let k = 1; k < FRAME / 2; k++) {
    const f = (k * sampleRate) / FRAME;
    if (f < MIN_FREQ || f > MAX_FREQ) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    binClass[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const rms = new Array(count);
  const chroma = new Array(count);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < count; f++) {
    const start = f * hopN - FRAME / 2 + hopN / 2;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      re[i] = v * window[i];
      im[i] = 0;
      if (i >= FRAME / 2 - hopN / 2 && i < FRAME / 2 + hopN / 2) sum += v * v;
    }
    rms[f] = 10 * Math.log10(sum / hopN + 1e-10);
    fft(re, im);
    const c = new Float64Array(12);
    for (let k = 1; k < FRAME / 2; k++) {
      if (binClass[k] >= 0) c[binClass[k]] += Math.hypot(re[k], im[k]);
    }
    const norm = Math.hypot(...c);
    chroma[f] = norm > 1e-6 ? c.map((x) => x / norm) : c;
  }
  return { hop: HOP, rms, chroma };
}

// ---- Repetition (chorus) -----------------------------------------------------------------------

// For each frame, how strongly the passage around it (±smooth/2) repeats somewhere else in the song,
// at least minLag seconds away. The two strongest repeats are added up, so a chorus heard three times
// outscores a verse heard twice. Each lag's similarity is compared with that lag's average, because
// everything in one song shares a key and so looks broadly similar. Returns values scaled to 0..1.
export function repetitionCurve(chroma, hop = HOP, { minLag = 6, smooth = 4 } = {}) {
  const n = chroma.length;
  const out = new Float64Array(n);
  const minL = Math.round(minLag / hop);
  const w = Math.max(1, Math.round(smooth / hop));
  if (n <= minL + w) return Array.from(out);
  const best = new Float64Array(n).fill(-Infinity);
  const second = new Float64Array(n).fill(-Infinity);
  const offer = (i, v) => {
    if (v > best[i]) {
      second[i] = best[i];
      best[i] = v;
    } else if (v > second[i]) second[i] = v;
  };
  const dots = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let lag = minL; lag < n; lag++) {
    const len = n - lag;
    let mean = 0;
    for (let i = 0; i < len; i++) {
      const a = chroma[i];
      const b = chroma[i + lag];
      let d = 0;
      for (let k = 0; k < 12; k++) d += a[k] * b[k];
      dots[i] = d;
      mean += d;
    }
    mean /= len;
    prefix[0] = 0;
    for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + dots[i];
    for (let i = 0; i < len; i++) {
      const lo = Math.max(0, i - (w >> 1));
      const hi = Math.min(len, lo + w);
      const v = (prefix[hi] - prefix[lo]) / (hi - lo) - mean;
      offer(i, v); // this frame repeats later...
      offer(i + lag, v); // ...and the later frame repeats this one
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    best[i] = (Number.isFinite(best[i]) ? Math.max(0, best[i]) : 0) + (Number.isFinite(second[i]) ? Math.max(0, second[i]) : 0);
    lo = Math.min(lo, best[i]);
    hi = Math.max(hi, best[i]);
  }
  for (let i = 0; i < n; i++) out[i] = hi > lo ? (best[i] - lo) / (hi - lo) : 0;
  return Array.from(out);
}

// ---- Picking moments ---------------------------------------------------------------------------

const WEIGHTS = { chorus: 0.4, vocals: 0.25, energy: 0.25, crowd: 0.1 };

function mean(values, a, b) {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, a); i < Math.min(values.length, b); i++) {
    s += values[i];
    n++;
  }
  return n ? s / n : 0;
}

// Index of the quietest frame (smoothed) in [a, b).
function quietest(rms, a, b) {
  let best = -1;
  let bestV = Infinity;
  for (let i = Math.max(1, a); i < Math.min(rms.length - 1, b); i++) {
    const v = (rms[i - 1] + 2 * rms[i] + rms[i + 1]) / 4;
    if (v < bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

// features: { hop, rms, repetition } (per frame); windows: YAMNet windows [{ t, vocal, music, speech, crowd }]
// with sings: boolean per window (from singingFlags); song: { start, end } to stay within (optional).
// Returns up to `count` non-overlapping moments, best first:
//   [{ start, end, score (0-100), parts: { chorus, vocals, energy, crowd } (0-1), reasons: string[] }]
export function findBestMoments({ features, windows = [], sings = [], duration, length = 30, count = 3, song = null }) {
  const { hop, rms, repetition } = features;
  const n = rms.length;
  const lo = song ? Math.max(0, song.start) : 0;
  const hi = song ? Math.min(duration, song.end) : duration;
  if (hi - lo <= length + 1) {
    return [{ start: round(lo), end: round(hi), score: 100, parts: null, reasons: ["the whole song fits"] }];
  }

  // Per-frame vocals (0/1) and crowd score, spread from the ~1 s YAMNet windows.
  const vocals = new Float64Array(n);
  const crowd = new Float64Array(n);
  windows.forEach((w, i) => {
    const next = windows[i + 1] ? windows[i + 1].t : w.t + 0.975;
    for (let f = Math.floor(w.t / hop); f < Math.min(n, Math.ceil(next / hop)); f++) {
      if (f < 0) continue;
      vocals[f] = sings[i] ? 1 : 0;
      crowd[f] = Math.min(1, w.crowd || 0);
    }
  });

  // Loudness scaled to 0..1 within the song (5th to 95th percentile, so silence and spikes don't dominate).
  const inSong = rms.slice(Math.floor(lo / hop), Math.ceil(hi / hop)).sort((a, b) => a - b);
  const p = (q) => inSong[Math.min(inSong.length - 1, Math.floor(q * (inSong.length - 1)))];
  const quiet = p(0.05);
  const loud = p(0.95);
  const energy = rms.map((v) => (loud > quiet ? Math.min(1, Math.max(0, (v - quiet) / (loud - quiet))) : 0.5));

  const L = Math.round(length / hop);
  const step = Math.max(1, Math.round(0.5 / hop));
  const candidates = [];
  for (let s = Math.ceil(lo / hop); s + L <= Math.floor(hi / hop); s += step) {
    const e = s + L;
    const parts = {
      chorus: mean(repetition, s, e),
      vocals: mean(vocals, s, e),
      energy: mean(energy, s, e),
      // Applause during the moment or within 4 s after it.
      crowd: Math.max(0, ...Array.from(crowd.slice(s, Math.min(n, e + Math.round(4 / hop))))),
    };
    let score = Object.entries(WEIGHTS).reduce((sum, [k, wgt]) => sum + wgt * parts[k], 0);
    if (windows.length && parts.vocals < 0.25) score *= 0.6; // mostly instrumental: rarely the highlight
    candidates.push({ s, e, score, parts });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Move a candidate's edges to the quietest point within about 1.5 s, so cuts land between phrases
  // while the length stays within about 3 s of the one asked for.
  const reach = Math.round(1.5 / hop);
  const snap = (c) => {
    const s2 = quietest(rms, c.s - reach, c.s + reach + 1);
    const e2 = quietest(rms, c.e - reach, c.e + reach + 1);
    return {
      start: Math.max(lo, (s2 >= 0 ? s2 : c.s) * hop),
      end: Math.min(hi, (e2 >= 0 ? e2 : c.e) * hop),
    };
  };

  // Keep the best few that share at most 15% (after the edges move), so they're different moments.
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    const edges = snap(c);
    const overlaps = picked.some((p2) => Math.min(p2.end, edges.end) - Math.max(p2.start, edges.start) > 0.15 * length);
    if (!overlaps) picked.push({ ...c, ...edges });
  }

  return picked.map((c) => ({
    start: round(c.start),
    end: round(c.end),
    score: Math.round(100 * c.score),
    parts: c.parts,
    reasons: reasonsFor(c.parts),
  }));
}

function reasonsFor(parts) {
  const r = [];
  if (parts.chorus >= 0.55) r.push("repeated part (likely the chorus)");
  if (parts.vocals >= 0.7) r.push("strong vocals");
  if (parts.energy >= 0.6) r.push("high energy");
  if (parts.crowd >= 0.3) r.push("applause");
  if (!r.length) r.push("best balance of vocals and energy");
  return r;
}

const round = (v) => Math.round(v * 10) / 10;

// The pause nearest `target` in [a, b): among frames within 3 dB of the quietest (smoothed), the
// closest one. Returns -1 if the range is empty.
function nearestPause(rms, target, a, b) {
  const sm = (i) => (rms[i - 1] + 2 * rms[i] + rms[i + 1]) / 4;
  const q = quietest(rms, a, b);
  if (q < 0) return -1;
  const limit = sm(q) + 3;
  let best = q;
  for (let i = Math.max(1, a); i < Math.min(rms.length - 1, b); i++) {
    if (sm(i) <= limit && Math.abs(i - target) < Math.abs(best - target)) best = i;
  }
  return best;
}

// ---- Highlights in any video (talks, podcasts, reviews, vlogs, sport, gaming) -----------------

const HIGHLIGHT_WEIGHTS = { reaction: 0.3, lively: 0.2, energy: 0.15, busy: 0.15, hook: 0.2 };

// What kind of video this is, from the sound classifier: "singing" when singing or music fills a good
// part of it, otherwise "talk" when there's mostly speech, else "any".
export function guessContent(windows, sings = []) {
  if (!windows.length) return "any";
  const n = windows.length;
  const sung = sings.filter(Boolean).length / n;
  const musical = windows.filter((w) => w.music > 0.4 && w.music > w.speech).length / n;
  const talking = windows.filter((w) => w.speech > 0.3 && w.speech >= w.music).length / n;
  if (sung >= 0.25 || (musical >= 0.5 && talking < 0.3)) return "singing";
  if (talking >= 0.4) return "talk";
  return "any";
}

// Best moments for short clips in any video. Looks for what keeps people watching: reactions
// (laughter, applause, cheering, shouting), lively speech (the voice rising and falling rather than a
// monotone), loudness, little dead air, and a strong first few seconds. Clips start and end in pauses
// so they don't cut mid-sentence, and the opening and closing of the video (intros, outros, "like and
// subscribe") are avoided. talk: speech counts towards "busy" (otherwise any sound does).
// Returns the same shape as findBestMoments.
export function findHighlights({ features, windows = [], duration, length = 30, count = 3, talk = false }) {
  const { hop, rms } = features;
  const n = rms.length;
  // Skip the first and last few percent (at most 20 s each) when the video is long enough.
  const edge = Math.min(20, 0.03 * duration);
  let lo = duration > length * 3 ? edge : 0;
  let hi = duration > length * 3 ? duration - edge : duration;
  if (hi - lo <= length + 1) {
    lo = 0;
    hi = duration;
    if (hi <= length + 1) return [{ start: 0, end: round(duration), score: 100, parts: null, reasons: ["the whole video fits"] }];
  }

  // Loudness scaled to 0..1 across the video (5th to 95th percentile).
  const sorted = rms.slice().sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
  const quiet = p(0.05);
  const loud = p(0.95);
  const energy = rms.map((v) => (loud > quiet ? Math.min(1, Math.max(0, (v - quiet) / (loud - quiet))) : 0.5));
  // Dead air: frames well below the video's typical level.
  const silentDb = Math.max(quiet + 3, p(0.5) - 25);
  const silent = rms.map((v) => (v < silentDb ? 1 : 0));

  // Liveliness: how much the loudness moves over about a second (speech with emphasis, a game's
  // action). Measured as the spread of the frame loudness, scaled against the video's own range.
  const span = Math.max(1, Math.round(1 / hop));
  const spread = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    let s2 = 0;
    let k = 0;
    for (let i = Math.max(0, f - span); i < Math.min(n, f + span); i++) {
      s += energy[i];
      s2 += energy[i] * energy[i];
      k++;
    }
    spread[f] = Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2));
  }
  const spreadSorted = Array.from(spread).sort((a, b) => a - b);
  const spreadTop = spreadSorted[Math.floor(0.95 * (n - 1))] || 1;
  const lively = Array.from(spread, (v) => Math.min(1, v / spreadTop));

  // Per-frame speech, reactions and "something happening", spread from the ~1 s classifier windows.
  const speech = new Float64Array(n);
  const reaction = new Float64Array(n);
  windows.forEach((w, i) => {
    const next = windows[i + 1] ? windows[i + 1].t : w.t + 0.975;
    const r = Math.min(1, 1.5 * (w.laugh || 0) + (w.crowd || 0) + (w.excited || 0));
    for (let f = Math.max(0, Math.floor(w.t / hop)); f < Math.min(n, Math.ceil(next / hop)); f++) {
      speech[f] = w.speech > 0.3 ? 1 : 0;
      reaction[f] = r;
    }
  });
  // Where each reaction starts (how much it rose), so it's counted where it begins, not its tail.
  const onset = Array.from(reaction, (r, f) => Math.max(0, r - (f ? reaction[f - 1] : 0)));
  const busy = Array.from(silent, (s, f) => (talk && windows.length ? speech[f] : 1 - s));

  const L = Math.round(length / hop);
  const H = Math.min(L, Math.round(3 / hop)); // the hook: the first 3 seconds
  const after = Math.round(3 / hop); // a laugh or applause just after a line belongs to it
  const step = Math.max(1, Math.round(0.5 / hop));
  const candidates = [];
  for (let s = Math.ceil(lo / hop); s + L <= Math.floor(hi / hop); s += step) {
    const e = s + L;
    let peak = 0;
    // A reaction counts from 3 s in, so the clip includes what caused it (the joke before the laugh).
    for (let f = s + after; f < Math.min(n, e + after); f++) peak = Math.max(peak, onset[f]);
    const parts = {
      // The strongest reaction, plus a little for reactions all through it.
      reaction: Math.min(1, 0.75 * peak + mean(reaction, s + after, e)),
      lively: mean(lively, s, e),
      energy: mean(energy, s, e),
      busy: mean(busy, s, e),
      hook: 0.5 * mean(energy, s + Math.round(0.3 / hop), s + H) + 0.5 * mean(busy, s, s + H),
    };
    let score = Object.entries(HIGHLIGHT_WEIGHTS).reduce((sum, [k, wgt]) => sum + wgt * parts[k], 0);
    score -= 0.6 * Math.max(0, mean(silent, s, e) - 0.15); // more than a little dead air
    candidates.push({ s, e, score, parts });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Start and end in a pause: the quietest point nearby (mostly earlier for the start, later for the
  // end, up to 4 s or 15% of the clip), so a sentence isn't cut.
  const reach = Math.round(Math.min(4, 0.15 * length) / hop);
  const back = Math.round(1 / hop);
  const snap = (c) => {
    const s2 = nearestPause(rms, c.s, c.s - reach, c.s + back);
    const e2 = nearestPause(rms, c.e, c.e - back, c.e + reach + 1);
    return {
      start: Math.max(0, (s2 >= 0 ? s2 : c.s) * hop),
      end: Math.min(duration, (e2 >= 0 ? e2 : c.e) * hop),
    };
  };

  // Different moments, spread out: no overlap, and a gap of at least a quarter clip between them
  // while there's room (relaxed if the video is too short for that).
  const pick = (gap) => {
    const out = [];
    for (const c of candidates) {
      if (out.length >= count) break;
      const edges = snap(c);
      const clash = out.some((o) => edges.start < o.end + gap && o.start < edges.end + gap);
      if (!clash) out.push({ ...c, ...edges });
    }
    return out;
  };
  let picked = pick(0.25 * length);
  if (picked.length < count) picked = pick(0);

  return picked.map((c) => ({
    start: round(c.start),
    end: round(c.end),
    score: Math.round(100 * Math.max(0, c.score)),
    parts: c.parts,
    reasons: highlightReasons(c.parts),
  }));
}

function highlightReasons(parts) {
  const r = [];
  if (parts.reaction >= 0.4) r.push("laughter, applause or cheering");
  if (parts.lively >= 0.55) r.push("lively delivery");
  if (parts.hook >= 0.7) r.push("strong opening");
  if (parts.energy >= 0.6) r.push("high energy");
  if (!r.length) r.push("the most going on");
  return r;
}
