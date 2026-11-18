import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLyrics, captionWindows, wordTimings, assTime, buildAss, buildCommand, cropGeometry } from "../editor.js";

test("parseLyrics accepts an optional end time: 0:12-0:16", () => {
  const { items, bad } = parseLyrics("0:12-0:16 first line\n0:20 second\n0:30-0:25 ends before it starts\n0:40-x bad end");
  assert.deepEqual(items, [
    { time: 12, end: 16, text: "first line" },
    { time: 20, text: "second" },
  ]);
  assert.deepEqual(bad, [3, 4]);
});

test("captionWindows passes the end time on as sungEnd, relative to the clip", () => {
  const items = [{ time: 12, end: 15, text: "a" }, { time: 20, text: "b" }];
  assert.deepEqual(captionWindows(items, 10, 30), [
    { text: "a", a: 2, b: 10, sungEnd: 5 },
    { text: "b", a: 10, b: 30 },
  ]);
});

test("wordTimings spreads words over the sung time, weighted by syllables, in order", () => {
  const w = wordTimings({ text: "ab zindagi ho", a: 2, b: 10, sungEnd: 6 });
  assert.deepEqual(w.map((x) => x.word), ["ab", "zindagi", "ho"]);
  assert.equal(w[0].s, 2);
  assert.equal(w[2].e, 6);
  for (let i = 1; i < w.length; i++) assert.ok(Math.abs(w[i].s - w[i - 1].e) < 1e-9);
  // "zindagi" (3 syllables) gets 3x the time of "ab" (1).
  assert.ok(Math.abs((w[1].e - w[1].s) / (w[0].e - w[0].s) - 3) < 1e-9);
});

test("wordTimings without an end time: ~0.8 s a word, never past 90% of the gap", () => {
  const four = wordTimings({ text: "one two three four", a: 0, b: 20 });
  assert.ok(Math.abs(four[3].e - 3.2) < 1e-9);
  const crowded = wordTimings({ text: "one two three four five six", a: 0, b: 2 });
  assert.ok(Math.abs(crowded[5].e - 1.8) < 1e-9);
  assert.deepEqual(wordTimings({ text: "  ", a: 0, b: 2 }), []);
});

test("assTime formats h:mm:ss.cc", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(83.456), "0:01:23.46");
  assert.equal(assTime(3725.5), "1:02:05.50");
});

const events = (ass) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

test("karaoke: one event per line, a \\kf tag per word, braces escaped", () => {
  const ass = buildAss([{ text: "Tum hi ho {x}", a: 1, b: 5 }], "karaoke");
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  const ev = events(ass);
  assert.equal(ev.length, 1);
  assert.match(ev[0], /^Dialogue: 0,0:00:01\.00,0:00:05\.00,Karaoke,/);
  assert.equal((ev[0].match(/\\kf\d+/g) || []).length, 4);
  assert.match(ev[0], /\(x\)/);
  assert.doesNotMatch(ev[0].split(",,").pop().replace(/\{\\[^}]*\}/g, ""), /[{}]/);
});

test("karaoke: long lines are broken with \\N where fitText wraps them", () => {
  const ev = events(buildAss([{ text: "All of my heart belongs to you forever and ever my love", a: 0, b: 6 }], "karaoke"));
  assert.match(ev[0], /\\N/);
});

test("pop: groups of up to 3 words, one event per word, the current word highlighted", () => {
  const ev = events(buildAss([{ text: "tum hi ho ab tum hi ho", a: 0, b: 10 }], "pop"));
  assert.equal(ev.length, 7);
  ev.forEach((e) => assert.equal((e.match(/\\c&H0000E5FF&/g) || []).length, 1));
  assert.match(ev[0], /\\c&H0000E5FF&\}TUM\{/);
  assert.match(ev[1], /\\c&H0000E5FF&\}HI\{/);
  // A new group pops in; the next words of the same group don't.
  assert.match(ev[0], /\\fscx80/);
  assert.doesNotMatch(ev[1], /\\fscx80/);
  assert.match(ev[3], /\\fscx80/);
  // Events follow on with no gaps or overlaps.
  const times = ev.map((e) => e.split(",").slice(1, 3));
  for (let i = 1; i < times.length; i++) assert.equal(times[i][0], times[i - 1][1]);
});

test("pop: the last group stays a moment after the last word, but not past the next line", () => {
  const [last] = events(buildAss([{ text: "hello", a: 0, b: 1.5, sungEnd: 1 }], "pop")).slice(-1);
  assert.match(last, /,0:00:01\.50,Pop,/);
});

test("buildCommand: animated styles use the subtitles filter with the fonts folder", () => {
  const base = {
    inputName: "input.mp4", start: 0, duration: 10, geometry: cropGeometry(1920, 1080), staticOffset: 0,
    hasTrack: false, captions: [{ text: "hello there", a: 0, b: 3 }], title: "", grade: false,
  };
  for (const captionStyle of ["pop", "karaoke"]) {
    const { args, textFiles } = buildCommand({ ...base, captionStyle });
    const vf = args[args.indexOf("-vf") + 1];
    assert.match(vf, /subtitles=filename=captions\.ass:fontsdir=fonts/);
    assert.doesNotMatch(vf, /drawtext/);
    assert.deepEqual(textFiles.map((f) => f.name), ["captions.ass"]);
  }
  const classic = buildCommand({ ...base, captionStyle: "classic" });
  assert.doesNotMatch(classic.args[classic.args.indexOf("-vf") + 1], /subtitles=/);
  const none = buildCommand({ ...base, captions: [], captionStyle: "pop" });
  assert.doesNotMatch(none.args[none.args.indexOf("-vf") + 1], /subtitles=/);
});
