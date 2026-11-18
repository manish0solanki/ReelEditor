import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEncodedTime, estimateRemaining } from "../editor.js";

test("parseEncodedTime reads ffmpeg's progress lines", () => {
  assert.equal(parseEncodedTime("frame=  120 fps= 12 q=28.0 size=  512kB time=00:00:05.12 bitrate= 819.2kbits/s"), 5.12);
  assert.equal(parseEncodedTime("size=    2048kB time=01:02:03.50 bitrate=..."), 3723.5);
  assert.equal(parseEncodedTime("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':"), null);
  assert.equal(parseEncodedTime("  Duration: 00:02:32.99, start: 0.000000"), null);
});

test("estimateRemaining waits for enough data when there's no saved rate", () => {
  assert.equal(estimateRemaining({ total: 60, encoded: 0, encodeElapsed: 0 }), null);
  assert.equal(estimateRemaining({ total: 60, encoded: 2, encodeElapsed: 1 }), null); // under 3 s in
});

test("estimateRemaining uses the live encoding speed", () => {
  // 10 s of reel took 40 s, so 50 s of reel left takes 200 s.
  assert.equal(estimateRemaining({ total: 60, encoded: 10, encodeElapsed: 40 }), 200);
  assert.equal(estimateRemaining({ total: 60, encoded: 60, encodeElapsed: 240 }), 0);
});

test("estimateRemaining starts from the saved speed and hands over to the live one", () => {
  assert.equal(estimateRemaining({ total: 60, encoded: 0, encodeElapsed: 0, savedRate: 5 }), 300);
  // A quarter of the way in, only the live rate counts.
  assert.equal(estimateRemaining({ total: 100, encoded: 25, encodeElapsed: 50, savedRate: 9 }), 150);
  // Halfway to the hand-over, a 50/50 blend: (2 + 4) / 2 = 3 s per reel second, 87.5 s of reel left.
  const left = estimateRemaining({ total: 100, encoded: 12.5, encodeElapsed: 25, savedRate: 4 });
  assert.ok(Math.abs(left - 262.5) < 1e-9, String(left));
});
