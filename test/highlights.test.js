import test from "node:test";
import assert from "node:assert/strict";
import { findHighlights, guessContent } from "../moments.js";

const HOP = 0.1;

// A long talk: steady speech at -30 dB with small wobbles, plus features we can place.
function talk(duration, { laughs = [], lively = [], silences = [] } = {}) {
  const n = Math.round(duration / HOP);
  const rms = [];
  for (let f = 0; f < n; f++) {
    const t = f * HOP;
    let v = -30 + 1.5 * Math.sin(t * 3);
    if (lively.some(([a, b]) => t >= a && t < b)) v = -30 + 9 * Math.sin(t * 5); // animated delivery
    if (silences.some(([a, b]) => t >= a && t < b)) v = -80;
    // Short pauses between sentences every 4 s.
    if (t % 4 < 0.3) v = -55;
    rms.push(v);
  }
  const windows = [];
  for (let t = 0; t < duration; t += 0.975) {
    const laugh = laughs.some(([a, b]) => t >= a && t < b) ? 0.8 : 0;
    const quiet = silences.some(([a, b]) => t >= a && t < b);
    windows.push({ t, vocal: 0, speech: quiet ? 0 : 0.8, music: 0.02, crowd: 0, laugh, excited: 0 });
  }
  return { features: { hop: HOP, rms }, windows, duration };
}

test("guessContent tells talks, songs and other videos apart", () => {
  const speech = Array.from({ length: 100 }, (_, i) => ({ t: i, speech: 0.8, music: 0.05 }));
  assert.equal(guessContent(speech, []), "talk");
  const song = Array.from({ length: 100 }, (_, i) => ({ t: i, speech: 0.1, music: 0.8 }));
  assert.equal(guessContent(song, song.map(() => true)), "singing");
  const game = Array.from({ length: 100 }, (_, i) => ({ t: i, speech: 0.1, music: 0.1 }));
  assert.equal(guessContent(game, []), "any");
});

test("a laugh and lively stretches win in a long talk", () => {
  const v = talk(900, { laughs: [[400, 403]], lively: [[620, 650]] });
  const m = findHighlights({ ...v, length: 30, count: 3, talk: true });
  assert.equal(m.length, 3);
  assert.ok(m.some((c) => c.start <= 400 && c.end >= 401), `laugh at 400 s in ${JSON.stringify(m.map((c) => [c.start, c.end]))}`);
  assert.ok(m.some((c) => c.start < 645 && c.end > 625), "lively part picked");
  const funny = m.find((c) => c.start <= 400 && c.end >= 401);
  assert.ok(funny.reasons.includes("laughter, applause or cheering"));
  assert.ok(400 - funny.start >= 3, `the setup before the laugh is kept (starts ${funny.start})`);
});

test("clips are spread out, about the asked length, and avoid the intro and outro", () => {
  const v = talk(900, { laughs: [[5, 8], [893, 896], [300, 302]] });
  const m = findHighlights({ ...v, length: 30, count: 5, talk: true });
  assert.equal(m.length, 5);
  for (const c of m) {
    assert.ok(c.end - c.start > 24 && c.end - c.start < 36, `length ${c.end - c.start}`);
    assert.ok(c.start >= 15 && c.end <= 885, `inside the video body: ${c.start}-${c.end}`);
  }
  const sorted = m.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end + 7, "a gap between clips");
});

test("clips start and end in a pause, and dead air is avoided", () => {
  const v = talk(600, { silences: [[100, 160]] });
  const m = findHighlights({ ...v, length: 20, count: 4, talk: true });
  for (const c of m) {
    assert.ok(c.end <= 100 || c.start >= 160, `no clip in the silence: ${c.start}-${c.end}`);
    // Pauses are at multiples of 4 s; edges land within one.
    for (const t of [c.start, c.end]) assert.ok(t % 4 < 0.45 || t % 4 > 3.9, `edge ${t} in a pause`);
  }
});

test("a short video gives the whole thing", () => {
  const v = talk(20);
  const m = findHighlights({ ...v, length: 30, count: 3 });
  assert.equal(m.length, 1);
  assert.equal(m[0].start, 0);
});
