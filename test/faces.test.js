import { test } from "node:test";
import assert from "node:assert/strict";
import { colorHistogram, histDistance, groupFaces, followFace, HIST_SIZE } from "../faces.js";

// An RGBA image filled with one colour, with an optional rectangle of another.
function image(w, h, fill, rect) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inside ? rect.color : fill;
      px.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return px;
}

const SKIN_A = [224, 172, 140]; // light skin
const SKIN_B = [120, 72, 48]; // darker skin
const BLUE = [40, 60, 200];

const histOf = (color) => colorHistogram(image(10, 10, color), 10, 10, { x: 0, y: 0, w: 10, h: 10 });
const A = histOf(SKIN_A);
const B = histOf(SKIN_B);
const C = histOf(BLUE);

test("colorHistogram: sums to 1, only counts the box, and tells colours apart", () => {
  assert.equal(A.length, HIST_SIZE);
  assert.ok(Math.abs(A.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  const px = image(20, 20, BLUE, { x: 5, y: 5, w: 5, h: 5, color: SKIN_A });
  const inBox = colorHistogram(px, 20, 20, { x: 5, y: 5, w: 5, h: 5 });
  assert.ok(histDistance(inBox, A) < 1e-9);
  assert.ok(histDistance(A, A) < 1e-9);
  assert.ok(histDistance(A, C) > 0.9);
  assert.ok(histDistance(A, B) > 0.5);
  assert.equal(histDistance(null, A), 1);
});

const det = (cx, hist, w = 0.08) => ({ cx, cy: 0.35, w, h: w * 1.2, hist });

test("groupFaces: two people seen across frames, left to right; a one-off detection is dropped", () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({
    t: i * 10,
    dets: [det(0.7 + 0.01 * Math.sin(i), B), det(0.3 - 0.01 * Math.cos(i), A), ...(i === 2 ? [det(0.5, C, 0.03)] : [])],
  }));
  const people = groupFaces(frames);
  assert.equal(people.length, 2);
  assert.ok(Math.abs(people[0].cx - 0.3) < 0.02 && Math.abs(people[1].cx - 0.7) < 0.02);
  assert.ok(histDistance(people[0].hist, A) < 0.01 && histDistance(people[1].hist, B) < 0.01);
  assert.equal(people[0].count, 6);
  assert.ok(people[1].best.det.cx > 0.6);
});

const follow = (samples, target) => followFace(samples, target).map((p) => (p.det ? Math.round(p.det.cx * 100) / 100 : null));

test("followFace: follows the chosen person, not the bigger face next to them", () => {
  const target = det(0.7, B);
  const samples = Array.from({ length: 10 }, (_, i) => ({ t: i / 2, dets: [det(0.3, A, 0.15), det(0.7, B)] }));
  assert.deepEqual(follow(samples, target), new Array(10).fill(0.7));
});

test("followFace: while the chosen person is hidden it holds, instead of jumping to someone else", () => {
  const target = det(0.7, B);
  const samples = Array.from({ length: 10 }, (_, i) => ({
    t: i / 2,
    dets: i >= 4 && i <= 6 ? [det(0.3, A)] : [det(0.3, A), det(0.7, B)],
  }));
  assert.deepEqual(follow(samples, target), [0.7, 0.7, 0.7, 0.7, null, null, null, 0.7, 0.7, 0.7]);
});

test("followFace: when two people cross, it keeps the same person (by their look)", () => {
  const target = det(0.2, A);
  const samples = Array.from({ length: 11 }, (_, i) => {
    const x = 0.2 + 0.06 * i; // A walks right, B walks left
    return { t: i / 2, dets: [det(x, A), det(1 - x, B)] };
  });
  const path = follow(samples, target);
  path.forEach((cx, i) => assert.ok(Math.abs(cx - (0.2 + 0.06 * i)) < 0.011, `sample ${i}: ${cx}`));
});

test("followFace: a stranger stepping into the chosen person's spot isn't followed", () => {
  const target = det(0.5, A);
  const samples = Array.from({ length: 8 }, (_, i) => ({ t: i / 2, dets: [i < 4 ? det(0.5, A) : det(0.5, C)] }));
  assert.deepEqual(follow(samples, target), [0.5, 0.5, 0.5, 0.5, null, null, null, null]);
});

test("followFace: no samples, and nobody visible", () => {
  assert.deepEqual(followFace([], det(0.5, A)), []);
  assert.deepEqual(follow([{ t: 0, dets: [] }, { t: 0.5, dets: [] }], det(0.5, A)), [null, null]);
});

import { tileRegions, mergeDetections } from "../faces.js";

test("tileRegions: the whole frame plus overlapping squares along the long side", () => {
  const land = tileRegions(1920, 1080);
  assert.deepEqual(land[0], { x: 0, y: 0, w: 1920, h: 1080, whole: true });
  assert.deepEqual(land.slice(1).map((r) => [r.x, r.w, r.h]), [[0, 1080, 1080], [420, 1080, 1080], [840, 1080, 1080]]);
  const tall = tileRegions(720, 1600);
  assert.equal(tall.length, 5); // whole + 4 squares
  assert.deepEqual(tall.slice(1).map((r) => r.y), [0, 293, 587, 880]);
  assert.ok(tall.slice(1).every((r) => r.x === 0 && r.w === 720 && r.y + r.h <= 1600));
  assert.equal(tileRegions(1000, 1000).length, 1);
});

test("mergeDetections: one face seen in two tiles counts once; separate faces stay", () => {
  const a1 = { cx: 0.40, cy: 0.4, w: 0.10, h: 0.18, score: 0.9 };
  const a2 = { cx: 0.405, cy: 0.41, w: 0.11, h: 0.19, score: 0.8 };
  const b = { cx: 0.70, cy: 0.4, w: 0.10, h: 0.18, score: 0.85 };
  const merged = mergeDetections([a2, b, a1]);
  assert.equal(merged.length, 2);
  assert.ok(merged.includes(a1) && merged.includes(b));
});

test("groupFaces: two people who cross the frame are still two people", () => {
  const frames = Array.from({ length: 8 }, (_, i) => {
    const x = 0.15 + 0.1 * i; // A walks right, B walks left; at i = 3-4 one hides the other
    const dets = [];
    if (i !== 4) dets.push(det(x, A));
    if (i !== 3) dets.push(det(1 - x, B));
    return { t: i * 1.5, dets };
  });
  const people = groupFaces(frames);
  assert.equal(people.length, 2, JSON.stringify(people.map((p) => [p.cx, p.count])));
  assert.deepEqual(people.map((p) => p.count).sort(), [7, 7]);
});
