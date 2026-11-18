import { test } from "node:test";
import assert from "node:assert/strict";
import { audioFeatures, repetitionCurve, findBestMoments, HOP } from "../moments.js";

const SR = 16000;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Sum of sines for the given MIDI notes, `seconds` long.
function tone(notes, seconds, amp = 0.2) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (const m of notes) v += Math.sin((2 * Math.PI * midiHz(m) * i) / SR);
    x[i] = amp * v * Math.min(1, i / 400, (x.length - i) / 400);
  }
  return x;
}

const concat = (parts) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

test("audioFeatures: an A (440 Hz) lights up pitch class A, and louder is louder", () => {
  const f = audioFeatures(concat([tone([69], 2, 0.05), tone([69], 2, 0.4)]), SR);
  assert.equal(f.hop, HOP);
  assert.equal(f.rms.length, Math.floor((4 * SR - 1) / (HOP * SR)) + 1);
  const mid = f.chroma[4];
  const top = mid.indexOf(Math.max(...mid));
  assert.equal(top, 9); // C=0 ... A=9
  assert.ok(f.rms[12] > f.rms[4] + 10, `${f.rms[4]} vs ${f.rms[12]}`); // 8x amplitude = +18 dB
});

test("audioFeatures: silence gives a zero fingerprint, not NaN", () => {
  const f = audioFeatures(new Float32Array(SR), SR);
  for (const c of f.chroma) for (const v of c) assert.equal(v, 0);
});

// Chord progressions: 1 s per chord, 4 chords per bar.
const C = (root, minor = false) => [root, root + (minor ? 3 : 4), root + 7];
const PROG = {
  intro: [C(57, true), C(53), C(57, true), C(53)],
  verse: [C(60), C(64, true), C(65), C(67)],
  chorus: [C(65), C(67), C(64, true), C(57, true)],
  bridge: [C(62, true), C(67), C(60), C(62, true)],
};
function song(plan) {
  const parts = [];
  for (const [name, seconds, amp] of plan) {
    for (let s = 0; s < seconds; s++) parts.push(tone(PROG[name][s % 4], 1, amp));
  }
  return concat(parts);
}
const PLAN = [
  ["intro", 8, 0.06], ["verse", 16, 0.1], ["chorus", 16, 0.16], ["verse", 16, 0.1],
  ["chorus", 16, 0.16], ["bridge", 8, 0.1], ["chorus", 16, 0.18], ["intro", 8, 0.06],
];
const sections = [];
{
  let t = 0;
  for (const [name, seconds] of PLAN) {
    sections.push({ name, a: t, b: t + seconds });
    t += seconds;
  }
}
const features = audioFeatures(song(PLAN), SR);
features.repetition = repetitionCurve(features.chroma, features.hop);
const avg = (a, b) => {
  const r = features.repetition.slice(a / HOP, b / HOP);
  return r.reduce((x, y) => x + y, 0) / r.length;
};

test("repetitionCurve: the chorus (3 times) repeats more than the verse (twice), intro and bridge", () => {
  const by = (name) => sections.filter((s) => s.name === name).map((s) => avg(s.a, s.b));
  const chorus = Math.min(...by("chorus"));
  for (const other of ["verse", "intro", "bridge"]) {
    assert.ok(chorus > Math.max(...by(other)), `${other}: ${by(other)} vs chorus ${by("chorus")}`);
  }
});

test("findBestMoments: on the test song the picks are the choruses, best first, not overlapping", () => {
  const picks = findBestMoments({ features, duration: 104, length: 15, count: 3 });
  assert.equal(picks.length, 3);
  const choruses = sections.filter((s) => s.name === "chorus");
  for (const p of picks) {
    const mid = (p.start + p.end) / 2;
    assert.ok(choruses.some((c) => mid >= c.a && mid <= c.b), `pick ${p.start}-${p.end} is not in a chorus`);
    assert.ok(Math.abs(p.end - p.start - 15) <= 3, `length ${p.end - p.start}`);
    assert.ok(p.score >= 0 && p.score <= 100);
  }
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i].score <= picks[i - 1].score);
  const [a, b] = [picks[0], picks[1]];
  assert.ok(Math.min(a.end, b.end) - Math.max(a.start, b.start) < 0.15 * 15 + 3);
});

// Hand-made features, for the scoring rules.
function flat(n, v) {
  return new Array(n).fill(v);
}
function fake({ seconds = 120, rep = () => 0.5, rms = () => -20 } = {}) {
  const n = seconds / HOP;
  return {
    hop: HOP,
    rms: Array.from({ length: n }, (_, i) => rms(i * HOP)),
    repetition: Array.from({ length: n }, (_, i) => rep(i * HOP)),
    chroma: flat(n, new Float64Array(12)),
  };
}
const yam = (seconds, singing) =>
  Array.from({ length: Math.floor(seconds / 0.975) }, (_, i) => {
    const t = i * 0.975;
    return { t, vocal: singing(t) ? 0.05 : 0, music: 0.95, speech: 0, crowd: 0 };
  });

test("findBestMoments: prefers singing over an equally repeated instrumental passage", () => {
  const features = fake({ rep: (t) => (t >= 20 && t < 50) || (t >= 70 && t < 100) ? 1 : 0.2 });
  const windows = yam(120, (t) => t >= 70 && t < 100);
  const sings = windows.map((w) => w.vocal > 0);
  const [best] = findBestMoments({ features, windows, sings, duration: 120, length: 20 });
  assert.ok(best.start >= 68 && best.end <= 102, `${best.start}-${best.end}`);
  assert.ok(best.reasons.includes("strong vocals"));
});

test("findBestMoments: applause right after a moment counts for it", () => {
  const features = fake();
  const windows = yam(120, () => true).map((w) => ({ ...w, crowd: w.t >= 62 && w.t < 66 ? 0.9 : 0 }));
  const sings = windows.map(() => true);
  const [best] = findBestMoments({ features, windows, sings, duration: 120, length: 20 });
  assert.ok(best.end >= 55 && best.end <= 68, `${best.start}-${best.end}`);
  assert.ok(best.reasons.includes("applause"));
});

test("findBestMoments: stays inside the song, and a short song is used whole", () => {
  const features = fake({ rep: (t) => (t < 15 ? 1 : 0.3) }); // the repeated bit is before the song starts
  const picks = findBestMoments({ features, duration: 120, length: 20, song: { start: 20, end: 110 } });
  for (const p of picks) assert.ok(p.start >= 20 && p.end <= 110, `${p.start}-${p.end}`);
  const whole = findBestMoments({ features, duration: 120, length: 30, song: { start: 40, end: 65 } });
  assert.deepEqual(whole.map((p) => [p.start, p.end]), [[40, 65]]);
});

test("findBestMoments: edges move to a nearby quiet point", () => {
  // Loud everywhere except short dips every 10 s (phrase gaps).
  const features = fake({ rms: (t) => (t % 10 < 0.5 ? -50 : -15), rep: (t) => (t >= 40 && t < 62 ? 1 : 0.2) });
  const [best] = findBestMoments({ features, duration: 120, length: 20 });
  assert.ok(best.start % 10 < 0.75 || best.start % 10 > 9.5, `start ${best.start}`);
  assert.ok(best.end % 10 < 0.75 || best.end % 10 > 9.5, `end ${best.end}`);
});
