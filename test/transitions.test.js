import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionMotion, buildCommand, cropGeometry, TRANSITIONS } from "../editor.js";

// Evaluate an ffmpeg expression in JS at a time (it for zoompan, t for eq).
function evaluate(expr, time) {
  const js = expr.replace(/\bif\(/g, "iff(");
  const fn = Function("it", "t", "clip", "gte", "exp", "pow", "iff", `return ${js};`);
  return fn(time, time, (x, lo, hi) => Math.min(hi, Math.max(lo, x)), (a, b) => (a >= b ? 1 : 0), Math.exp, Math.pow, (c, a, b) => (c ? a : b));
}

const closeups = [{ a: 4, b: 8 }, { a: 12, b: 16 }];
const beats = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.6);
const downbeats = beats.filter((_, i) => i % 4 === 0);
const motion = (style) => transitionMotion(style, { closeups, beats, downbeats, duration: 20 });
const zoomAt = (style, t) => evaluate(motion(style).zoom, t);

// The largest change in zoom between two frames at 30 fps.
function maxStep(style, from = 0, to = 20) {
  let worst = 0;
  let last = zoomAt(style, from);
  for (let t = from; t <= to; t += 1 / 30) {
    const z = zoomAt(style, t);
    worst = Math.max(worst, Math.abs(z - last));
    last = z;
  }
  return worst;
}

test("there are five styles", () => {
  assert.deepEqual(TRANSITIONS, ["smooth", "punch", "bounce", "drift", "flash"]);
});

test("smooth: eased 0.6 s zoom, halfway on the change", () => {
  assert.equal(zoomAt("smooth", 3.6), 1);
  assert.ok(Math.abs(zoomAt("smooth", 4) - 1.125) < 1e-9);
  assert.ok(Math.abs(zoomAt("smooth", 6) - 1.25) < 1e-9);
  assert.ok(maxStep("smooth") < 0.025);
});

test("punch: starts on the change, mostly there in 2 frames, done in 0.15 s, holds, snaps back", () => {
  assert.equal(zoomAt("punch", 3.99), 1);
  assert.ok(zoomAt("punch", 4 + 2 / 30) > 1.24, String(zoomAt("punch", 4 + 2 / 30))); // 80%+ of the way
  assert.ok(Math.abs(zoomAt("punch", 4.15) - 1.3) < 1e-9);
  assert.ok(Math.abs(zoomAt("punch", 7.9) - 1.3) < 1e-9);
  assert.ok(Math.abs(zoomAt("punch", 8.2) - 1) < 1e-9);
});

test("bounce: a pulse on every beat, bigger on beat 1, gone between beats", () => {
  assert.equal(zoomAt("bounce", 0.4), 1);
  assert.ok(Math.abs(zoomAt("bounce", 0.5) - 1.08) < 1e-9); // beat 1 of a bar
  assert.ok(Math.abs(zoomAt("bounce", 1.1) - (1 + 0.035 + 0.08 * Math.exp(-0.6 / 0.18))) < 1e-9); // beat 2
  assert.ok(zoomAt("bounce", 1.05) - 1 < 0.01); // almost settled just before the next beat
  // Bounce doesn't need close-ups.
  const alone = transitionMotion("bounce", { closeups: [], beats, downbeats, duration: 20 });
  assert.ok(Math.abs(evaluate(alone.zoom, 0.5) - 1.08) < 1e-9);
});

test("drift: always moving gently, in through one shot and out through the next, never jumping", () => {
  // Shots: 0-4 in, 4-8 out, 8-12 in, 12-16 out, 16-20 in.
  assert.equal(zoomAt("drift", 0), 1);
  assert.ok(Math.abs(zoomAt("drift", 4) - 1.15) < 1e-9);
  assert.ok(Math.abs(zoomAt("drift", 8) - 1) < 1e-9);
  assert.ok(Math.abs(zoomAt("drift", 12) - 1.15) < 1e-9);
  assert.ok(zoomAt("drift", 2) > 1 && zoomAt("drift", 2) < 1.15);
  assert.ok(maxStep("drift") < 0.0065, String(maxStep("drift")));
});

test("flash: the smooth zoom plus a brightness flash peaking on each change", () => {
  const { zoom, flash } = motion("flash");
  assert.equal(zoom, motion("smooth").zoom);
  assert.equal(evaluate(flash, 3.99), 0);
  assert.ok(Math.abs(evaluate(flash, 4) - 0.45) < 1e-9);
  assert.ok(evaluate(flash, 4.3) < 0.02);
  assert.ok(Math.abs(evaluate(flash, 8) - 0.45) < 1e-9);
  assert.equal(motion("smooth").flash, null);
});

const base = {
  inputName: "input.mp4", start: 0, duration: 20, geometry: cropGeometry(1920, 1080), staticOffset: 600,
  hasTrack: false, captions: [], title: "", grade: false,
};
const vf = (o) => {
  const { args } = buildCommand({ ...base, ...o });
  return args[args.indexOf("-vf") + 1];
};

test("buildCommand: each style becomes a zoompan; flash adds an eq flash; nothing without cuts or beats", () => {
  for (const style of TRANSITIONS) assert.match(vf({ closeups, beats, downbeats, transition: style }), /zoompan=z='1\+/, style);
  assert.match(vf({ closeups, transition: "flash" }), /setsar=1,eq=eval=frame:brightness='if\(gte\(t,4\.000\),0\.45\*exp/);
  assert.doesNotMatch(vf({ closeups, transition: "smooth" }), /eq=eval/);
  assert.match(vf({ closeups: [], beats, downbeats, transition: "bounce" }), /zoompan/);
  assert.doesNotMatch(vf({ closeups: [], beats: [], transition: "bounce" }), /zoompan/);
  assert.doesNotMatch(vf({ closeups: [], transition: "smooth" }), /zoompan/);
});
