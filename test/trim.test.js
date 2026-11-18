import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeScores, findSongBounds, formatTime } from "../editor.js";

// Real YAMNet window scores (from headless Chromium) for a 153 s test video:
// 0-6 s talking, 6-9 s room noise, 9-142 s "Let's Go Fishin'" by Karissa Hobbs (CC-BY; guitar intro,
// singing from about 19.7 s, guitar outro), 142-150 s talking, 150-153 s room noise.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/yamnet-talk-song-talk.json", import.meta.url)));

test("real scores: starts 2 s before the singing and ends when the music stops", () => {
  const b = findSongBounds(fixture, 152.99);
  assert.equal(b.found, "singing");
  assert.ok(b.singStart >= 19 && b.singStart <= 20.5, `singStart ${b.singStart}`);
  assert.equal(b.start, Math.round((b.singStart - 2) * 10) / 10);
  assert.ok(b.songEnd >= 140.4 && b.songEnd <= 142.3, `songEnd ${b.songEnd}`);
  assert.ok(b.end <= 142.5, "talking after the song is cut");
});

const W = (vocal, music = 0.95, speech = 0, crowd = 0) => ({ vocal, music, speech, crowd });
const timeline = (...ws) => ws.map((w, i) => ({ t: i, ...w }));

test("instrumental intro is skipped; one loud spike doesn't hide quieter opening lines", () => {
  const w = timeline(W(0), W(0), W(0), W(0), W(0), W(0.012), W(0.01), W(0.004), W(0.012), W(0.6), W(0.02), W(0.02), W(0));
  const b = findSongBounds(w, 13);
  assert.equal(b.singStart, 5);
  assert.equal(b.start, 3);
});

test("talking before the song never counts as singing", () => {
  const talk = W(0.03, 0.01, 0.98);
  const w = timeline(talk, talk, talk, talk, W(0), W(0.05), W(0.05), W(0.05), W(0));
  assert.equal(findSongBounds(w, 9).singStart, 5);
});

test("an isolated vocal blip doesn't start the song", () => {
  const w = timeline(W(0.05), W(0), W(0), W(0), W(0), W(0), W(0.05), W(0.05), W(0.05));
  assert.equal(findSongBounds(w, 9).singStart, 6);
});

test("the end keeps the instrumental outro, then stops at applause or talking", () => {
  const sing = W(0.05);
  const outro = W(0);
  const w = timeline(sing, sing, sing, outro, outro, W(0, 0.2), outro, W(0, 0.3, 0, 0.9), W(0, 0, 0.99), W(0, 0, 0.99));
  const b = findSongBounds(w, 10, { tail: 0 });
  assert.equal(b.songEnd, 7); // outro windows 3-6 kept (one quiet window bridged), applause at 7 cut
  assert.equal(b.end, 7);
});

test("lead-in is clamped to the start of the video and the end to its length", () => {
  const w = timeline(W(0.05), W(0.05), W(0.05));
  const b = findSongBounds(w, 2.5);
  assert.equal(b.start, 0);
  assert.equal(b.end, 2.5);
});

test("no singing: trims to the music instead", () => {
  const w = timeline(W(0, 0, 0.99), W(0, 0, 0.99), W(0), W(0), W(0), W(0, 0, 0.99));
  const b = findSongBounds(w, 6);
  assert.equal(b.found, "music");
  assert.equal(b.singStart, 2);
  assert.equal(b.songEnd, 5);
});

test("nothing musical: leaves the whole video", () => {
  const w = timeline(W(0, 0, 0.99), W(0, 0, 0.99), W(0, 0.01, 0.5));
  assert.deepEqual(findSongBounds(w, 3), { start: 0, end: 3, singStart: null, songEnd: null, found: null });
  assert.equal(findSongBounds([], 5).found, null);
});

test("summarizeScores adds up the vocal labels", () => {
  const s = summarizeScores({ Singing: 0.02, "Female singing": 0.01, Music: 0.9, Speech: 0.1, Applause: 0.2, Cheering: 0.1 });
  assert.ok(Math.abs(s.vocal - 0.03) < 1e-9);
  assert.equal(s.music, 0.9);
  assert.equal(s.speech, 0.1);
  assert.ok(Math.abs(s.crowd - 0.3) < 1e-9);
});

test("formatTime", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(9.5), "0:09.5");
  assert.equal(formatTime(59.96), "1:00");
  assert.equal(formatTime(83.4), "1:23.4");
  assert.equal(formatTime(141.9), "2:21.9");
});
