import { test } from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope, estimateTempo, beatGrid, cutPlan, synthDrums, encodeWav } from "../beats.js";

const SR = 16000;

// A click track: a short 800 Hz ping on every beat, louder on beat 1 of each bar, with light noise.
function clicks({ bpm, seconds, offset = 0, swing = 0, seed = 1 }) {
  const x = new Float32Array(seconds * SR);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let k = 0; offset + (k * 60) / bpm < seconds; k++) {
    const t = offset + (k * 60) / bpm + (k % 2 ? swing : 0);
    const s0 = Math.round(t * SR);
    const amp = k % 4 === 0 ? 0.8 : 0.4;
    for (let i = 0; i < 1600 && s0 + i < x.length; i++) x[s0 + i] += amp * Math.sin((2 * Math.PI * 800 * i) / SR) * Math.exp(-i / 300);
  }
  for (let i = 0; i < x.length; i++) x[i] += rnd() * 0.02;
  return x;
}

for (const bpm of [72, 100, 128, 150]) {
  test(`beatGrid finds a ${bpm} BPM click track, its beats within 25 ms, and beat 1`, () => {
    const offset = 0.37;
    const g = beatGrid(clicks({ bpm, seconds: 24, offset }), SR);
    assert.ok(Math.abs(g.bpm - bpm) <= 1.5, `bpm ${g.bpm}`);
    const period = 60 / bpm;
    for (const b of g.beats) {
      const k = Math.round((b - offset) / period);
      assert.ok(Math.abs(b - (offset + k * period)) < 0.025, `beat at ${b}`);
    }
    // Accented clicks are every 4th from the first: the downbeats should be those.
    for (const d of g.downbeats) {
      const k = Math.round((d - offset) / period);
      assert.equal(((k % 4) + 4) % 4, 0, `downbeat at ${d}`);
    }
    assert.ok(g.confidence > 0.5);
  });
}

test("estimateTempo prefers the real pulse over a 3-against-4 coincidence", () => {
  // Accents every 3 beats over a 90 BPM pulse create a periodicity at 120 BPM-ish lags; 90 should win.
  const x = clicks({ bpm: 90, seconds: 20, offset: 0.2 });
  const { hop, env } = onsetEnvelope(x, SR);
  const { bpm } = estimateTempo(env, hop);
  assert.ok(Math.abs(bpm - 90) <= 1.5 || Math.abs(bpm - 180) <= 2, String(bpm));
});

test("beatGrid on silence has no confidence", () => {
  const g = beatGrid(new Float32Array(SR * 10), SR);
  assert.ok(g.confidence < 0.15, String(g.confidence));
});

test("cutPlan alternates on bar lines, keeps the first and last shots wide, shots 1.5-5 s", () => {
  const g = beatGrid(clicks({ bpm: 100, seconds: 30, offset: 0.37 }), SR);
  const close = cutPlan(g, 30);
  assert.ok(close.length >= 4, JSON.stringify(close));
  const onDownbeat = (t) => g.downbeats.some((d) => Math.abs(d - t) < 0.01);
  for (const c of close) {
    assert.ok(onDownbeat(c.a) && onDownbeat(c.b), JSON.stringify(c));
    assert.ok(c.b - c.a >= 1.5 && c.b - c.a <= 5, JSON.stringify(c));
    assert.ok(c.a > 0 && c.b < 30);
  }
  for (let i = 1; i < close.length; i++) assert.ok(close[i].a > close[i - 1].b, "a wide shot between close-ups");
});

test("cutPlan without a clear beat cuts every ~3 s", () => {
  const close = cutPlan({ beats: [], downbeats: [], confidence: 0 }, 20);
  assert.deepEqual(close, [{ a: 3, b: 6 }, { a: 9, b: 12 }, { a: 15, b: 18 }]);
});

test("synthDrums: hits land on the beats, kick on 1 and 3", () => {
  const sr = 44100;
  const beats = [0.5, 1.1, 1.7, 2.3, 2.9, 3.5, 4.1, 4.7];
  const d = synthDrums(beats, 0, 5.5, sr);
  assert.equal(d.length, Math.ceil(5.5 * sr));
  let peak = 0;
  for (const v of d) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.71 && peak > 0.3, String(peak));
  // Energy in the 60 ms after each beat is far above the energy just before it.
  const energy = (a, b) => {
    let e = 0;
    for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) e += d[i] * d[i];
    return e;
  };
  for (const b of beats.slice(1, -1)) assert.ok(energy(b, b + 0.06) > 5 * energy(b - 0.08, b - 0.02), `beat ${b}`);
  // Kick (low, long) on beat 1: more energy 0.1-0.3 s after it than after beat 2 (snare, short).
  assert.ok(energy(beats[4] + 0.1, beats[4] + 0.3) > energy(beats[5] + 0.1, beats[5] + 0.3));
});

test("encodeWav writes a valid 16-bit mono WAV", () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 8000);
  const v = new DataView(wav.buffer);
  const str = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
  assert.equal(str(0, 4), "RIFF");
  assert.equal(str(8, 4), "WAVE");
  assert.equal(v.getUint32(24, true), 8000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 12);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true)), [16384, -16383, 32767, -32767, 32767]);
});

import { toGray, frameMotion, movementGrid } from "../beats.js";

test("toGray and frameMotion: movement counts, an overall brightness change doesn't", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const g = toGray(rgba);
  assert.deepEqual(Array.from(g, (v) => Math.round(v)), [76, 150, 29, 255]);
  const a = new Float32Array([10, 10, 200, 200]);
  assert.equal(frameMotion(a, a), 0);
  assert.equal(frameMotion(a, new Float32Array([40, 40, 230, 230])), 0); // lights up evenly
  assert.equal(frameMotion(a, new Float32Array([200, 200, 10, 10])), 190); // something moved
});

// Motion samples at an uneven ~30 fps: bursts on each beat (beat 1 of the bar stronger) over swaying.
function moving({ bpm, seconds = 20, offset = 0.37, seed = 3 }) {
  let r = seed;
  const rnd = () => (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let t = 0; t < seconds; t += 1 / 30 + (rnd() - 0.5) * 0.01) {
    let m = 2 + 1.5 * Math.sin(t * 0.7) + rnd() * 1.5;
    if (bpm) {
      const p = 60 / bpm;
      const ph = (((t - offset) % p) + p) % p;
      m += 12 * Math.exp(-((ph / 0.04) ** 2)) * (Math.round((t - offset) / p) % 4 === 0 ? 1.5 : 1);
    } else if (rnd() < 0.05) m += 10 * rnd();
    out.push({ t, motion: m });
  }
  return out;
}

for (const bpm of [90, 100, 128]) {
  test(`movementGrid: steps at ${bpm} BPM give that tempo and beats within 35 ms`, () => {
    const g = movementGrid(moving({ bpm }), 20);
    assert.ok(Math.abs(g.bpm - bpm) <= 1.5, `bpm ${g.bpm}`);
    assert.ok(g.confidence > 0.5, String(g.confidence));
    const p = 60 / bpm;
    for (const b of g.beats.filter((x) => x > 0.5 && x < 19.5)) {
      const k = Math.round((b - 0.37) / p);
      assert.ok(Math.abs(b - (0.37 + k * p)) < 0.035, `beat ${b}`);
    }
  });
}

test("movementGrid: random fidgeting has no confidence; too little data gives nothing", () => {
  for (const seed of [1, 2, 3, 4, 5]) assert.ok(movementGrid(moving({ bpm: 0, seed }), 20).confidence < 0.15, `seed ${seed}`);
  assert.equal(movementGrid([{ t: 0, motion: 1 }], 20).beats.length, 0);
});

test("matchMusic works the same with a beat from movement", async () => {
  const { matchMusic } = await import("../beats.js");
  const video = movementGrid(moving({ bpm: 100 }), 20);
  const music = movementGrid(moving({ bpm: 94, seconds: 60, offset: 1.1, seed: 9 }), 60);
  const m = matchMusic(video, music, 20);
  assert.ok(m.ok, m.reason);
  assert.ok(Math.abs(m.tempo - 100 / 94) < 0.02, String(m.tempo));
  assert.ok(m.fraction > 0.8, String(m.fraction));
});
