import { test } from "node:test";
import assert from "node:assert/strict";
import { gray, sharpness, exposure, colourfulness, faceQuality, scoreFrames, pickCovers, coverCrop, signature, lookDifference } from "../thumbs.js";

// A w x h RGBA image from a function (x, y) -> [r, g, b].
function image(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...fn(x, y), 255], (y * w + x) * 4);
  return px;
}
const W = 64, H = 64;
const checker = image(W, H, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [220, 220, 220] : [30, 30, 30]));
// The same pattern, box-blurred.
const blurred = (() => {
  const g = gray(checker);
  return image(W, H, (x, y) => {
    let s = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
      s += g[yy * W + xx]; n++;
    }
    return [s / n, s / n, s / n];
  });
})();

test("sharpness: a crisp pattern beats the same pattern blurred, and flat grey is 0", () => {
  const crisp = sharpness(gray(checker), W, H);
  const soft = sharpness(gray(blurred), W, H);
  assert.ok(crisp > 5 * soft, `${crisp} vs ${soft}`);
  assert.equal(sharpness(gray(image(W, H, () => [128, 128, 128])), W, H), 0);
});

test("exposure: mid-grey is best; black, white and clipped frames score low", () => {
  assert.ok(exposure(gray(image(W, H, () => [128, 128, 128]))) > 0.95);
  assert.ok(exposure(gray(image(W, H, () => [10, 10, 10]))) < 0.1);
  assert.ok(exposure(gray(image(W, H, () => [250, 250, 250]))) < 0.1);
  assert.ok(exposure(gray(checker)) > exposure(gray(image(W, H, () => [40, 40, 40]))));
});

test("colourfulness: grey is 0, vivid colours score high", () => {
  assert.equal(colourfulness(image(W, H, () => [128, 128, 128])), 0);
  const vivid = colourfulness(image(W, H, (x) => (x < 32 ? [230, 30, 60] : [30, 90, 230])));
  assert.ok(vivid > 50, String(vivid));
});

test("faceQuality: a clear face in place scores 1; tiny, edge or missing faces less", () => {
  assert.equal(faceQuality({ cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 }), 1);
  assert.equal(faceQuality(null), 0);
  assert.equal(faceQuality({ cx: 0.5, cy: 0.4, w: 0.02, h: 0.03 }), 0);
  assert.ok(faceQuality({ cx: 0.03, cy: 0.4, w: 0.2, h: 0.3 }) < 0.7);
  assert.ok(faceQuality({ cx: 0.5, cy: 0.4, w: 0.8, h: 0.9 }) < 1);
});

test("scoreFrames + pickCovers: sharp, well-lit frames with a face win, from different moments", () => {
  const face = { cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 };
  const frames = [
    { t: 1, sharp: 900, exposure: 0.9, colour: 40, face }, // great
    { t: 1.5, sharp: 880, exposure: 0.9, colour: 40, face }, // great, but too close to t=1
    { t: 4, sharp: 120, exposure: 0.9, colour: 40, face }, // blurred
    { t: 7, sharp: 900, exposure: 0.15, colour: 40, face }, // dark
    { t: 10, sharp: 900, exposure: 0.9, colour: 40, face: null }, // nobody
    { t: 13, sharp: 850, exposure: 0.85, colour: 45, face }, // great
    { t: 16, sharp: 700, exposure: 0.8, colour: 30, face }, // good
  ];
  const picks = pickCovers(scoreFrames(frames), 3, 2);
  assert.deepEqual(picks.map((p) => p.t).sort((a, b) => a - b), [1, 13, 16]);
  for (const p of picks) assert.ok(p.score > 0 && p.score <= 100);
  assert.ok(picks[0].score >= picks[1].score && picks[1].score >= picks[2].score);
});

test("scoreFrames: with no faces at all, sharpness decides", () => {
  const frames = [{ t: 1, sharp: 100, exposure: 0.9, colour: 40, face: null }, { t: 5, sharp: 900, exposure: 0.9, colour: 40, face: null }];
  assert.equal(scoreFrames(frames)[0].t, 5);
});

test("coverCrop: a 9:16 window from a landscape frame, the face a little above the middle", () => {
  const c = coverCrop(1920, 1080, { cx: 0.7, cy: 0.4, w: 0.15, h: 0.27 });
  assert.ok(Math.abs(c.sw / c.sh - 1080 / 1920) < 1e-9);
  assert.ok(c.sx >= 0 && c.sx + c.sw <= 1920 && c.sy >= 0 && c.sy + c.sh <= 1080);
  assert.ok(Math.abs(c.sx + c.sw / 2 - 0.7 * 1920) < 1); // centred on the face
  // A small face gets a gentle zoom (a smaller source window), up to 1.6x.
  const small = coverCrop(1920, 1080, { cx: 0.5, cy: 0.4, w: 0.04, h: 0.07 });
  assert.ok(small.sh < 1080 && small.sh >= 1080 / 1.6 - 1e-9);
  // No face: the middle.
  const none = coverCrop(1920, 1080, null);
  assert.ok(Math.abs(none.sx + none.sw / 2 - 960) < 1);
});

test("pickCovers: skips a frame that looks the same as one already picked, if there are alternatives", () => {
  const face = { cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 };
  const sigA = signature(gray(checker), W, H);
  const sigB = signature(gray(image(W, H, () => [128, 128, 128])), W, H);
  const sigC = signature(gray(image(W, H, (x) => [x * 4, x * 4, x * 4])), W, H);
  assert.equal(lookDifference(sigA, sigA), 0);
  assert.ok(lookDifference(sigA, sigB) > 10);
  const frames = [
    { t: 1, sharp: 900, exposure: 0.9, colour: 40, face, sig: sigA },
    { t: 5, sharp: 900, exposure: 0.9, colour: 40, face, sig: sigA }, // looks just like t=1
    { t: 9, sharp: 800, exposure: 0.9, colour: 40, face, sig: sigB },
    { t: 13, sharp: 700, exposure: 0.9, colour: 40, face, sig: sigC },
  ];
  assert.deepEqual(pickCovers(scoreFrames(frames), 3, 2).map((p) => p.t), [1, 9, 13]);
  // With only look-alikes available, it still returns three frames.
  const same = frames.map((f) => ({ ...f, sig: sigA }));
  assert.equal(pickCovers(scoreFrames(same), 3, 2).length, 3);
});
