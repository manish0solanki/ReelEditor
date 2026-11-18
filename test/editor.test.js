import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTime,
  parseLyrics,
  captionWindows,
  cropGeometry,
  offsetFromFraction,
  cropPath,
  trackFileText,
  textWidth,
  wrapText,
  fitText,
  buildCommand,
  CAPTION_FIT,
  FRAME_W,
} from "../editor.js";

const MAX_TEXT_W = FRAME_W - 2 * 70;

test("parseTime accepts m:ss and seconds", () => {
  assert.equal(parseTime("1:23"), 83);
  assert.equal(parseTime("1:23.5"), 83.5);
  assert.equal(parseTime(" 12.5 "), 12.5);
  assert.equal(parseTime("0"), 0);
  assert.ok(Number.isNaN(parseTime("")));
  assert.ok(Number.isNaN(parseTime("abc")));
  assert.ok(Number.isNaN(parseTime("1:2:3")));
});

test("parseLyrics sorts lines and reports bad line numbers", () => {
  const { items, bad } = parseLyrics("0:17 second\n\nnope\n0:12 first\n0:20");
  assert.deepEqual(items, [
    { time: 12, text: "first" },
    { time: 17, text: "second" },
  ]);
  assert.deepEqual(bad, [3, 5]);
});

test("captionWindows times lines relative to the trim and clips to the clip", () => {
  const items = [
    { time: 5, text: "before start" },
    { time: 12, text: "a" },
    { time: 20, text: "b" },
    { time: 99, text: "after end" },
  ];
  assert.deepEqual(captionWindows(items, 10, 15), [
    { text: "before start", a: 0, b: 2 },
    { text: "a", a: 2, b: 10 },
    { text: "b", a: 10, b: 15 },
  ]);
});

test("cropGeometry picks the axis from the source shape", () => {
  const land = cropGeometry(1920, 1080);
  assert.equal(land.axis, "x");
  assert.equal(land.cropH, 1080);
  assert.equal(land.cropW % 2, 0);
  assert.equal(land.maxOffset, 1920 - land.cropW);

  const tall = cropGeometry(1080, 2400);
  assert.equal(tall.axis, "y");
  assert.equal(tall.cropW, 1080);
  assert.equal(tall.cropH % 2, 0);

  assert.equal(cropGeometry(1080, 1920).axis, "none");
});

test("offsetFromFraction is even and stays in range", () => {
  const g = cropGeometry(1921, 1080);
  for (const f of [0, 0.25, 0.5, 1, -1, 2]) {
    const x = offsetFromFraction(g, f);
    assert.equal(x % 2, 0);
    assert.ok(x >= 0 && x <= g.maxOffset);
  }
});

test("cropPath returns null when no face is ever found", () => {
  const g = cropGeometry(1920, 1080);
  assert.equal(cropPath([{ t: 0, c: null }, { t: 0.5, c: null }], g), null);
});

test("cropPath fills gaps, stays even and in range", () => {
  const g = cropGeometry(1920, 1080);
  const samples = [
    { t: 0, c: null },
    { t: 0.5, c: 0.0 },
    { t: 1, c: null },
    { t: 1.5, c: 1.0 },
    { t: 2, c: 0.5 },
  ];
  const keys = cropPath(samples, g);
  assert.equal(keys.length, samples.length);
  for (const k of keys) {
    assert.equal(k.x % 2, 0);
    assert.ok(k.x >= 0 && k.x <= g.maxOffset);
  }
});

test("trackFileText glides between keys and holds the last one", () => {
  const text = trackFileText(
    [
      { t: 0, x: 0 },
      { t: 0.5, x: 100 },
      { t: 1, x: 100 },
      { t: 1.5, x: 40 },
    ],
    "x"
  );
  assert.equal(
    text,
    "0.00 crop x 0+(100)*(t-0.00)/0.50;\n" +
      "0.50 crop x 100;\n" +
      "1.00 crop x 100+(-60)*(t-1.00)/0.50;\n" +
      "1.50 crop x 40;\n"
  );
  // sendcmd splits commands on commas and arguments on whitespace: the expression must have neither.
  for (const line of text.trim().split("\n")) {
    const arg = line.split(" ").slice(3).join(" ").replace(/;$/, "");
    assert.doesNotMatch(arg, /[,\s]/);
  }
  assert.match(trackFileText([{ t: 0, x: 2 }], "y"), /^0\.00 crop y 2;\n$/);
});

test("wrapText keeps every word and fits each line", () => {
  const text = "All of my heart belongs to you forever and ever my love, yes it does";
  const lines = wrapText(text, 60);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), text);
  for (const l of lines) assert.ok(textWidth(l, 60) <= MAX_TEXT_W, l);
});

test("wrapText hard-splits a word too long for one line", () => {
  const word = "W".repeat(40);
  const lines = wrapText(word, 60);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(""), word);
  for (const l of lines) assert.ok(textWidth(l, 60) <= MAX_TEXT_W);
});

test("fitText keeps short text at full size and shrinks long text", () => {
  assert.deepEqual(fitText("Short line", CAPTION_FIT), { size: 60, lines: ["Short line"] });
  const long = fitText("Mera dil bhi kitna pagal hai jo pyaar ye tumse karta hai yaar sun", CAPTION_FIT);
  assert.ok(long.size < 60 && long.size >= CAPTION_FIT.minSize, String(long.size));
  assert.equal(long.lines.length, CAPTION_FIT.maxLines);
});

test("fitText stops at the minimum size and adds lines for very long text", () => {
  const text = "Mera dil bhi kitna pagal hai jo pyaar ye tumse karta hai par saamne jab tum aate ho";
  const { size, lines } = fitText(text, CAPTION_FIT);
  assert.equal(size, CAPTION_FIT.minSize);
  assert.ok(lines.length > CAPTION_FIT.maxLines);
  assert.equal(lines.join(" "), text);
});

function build(overrides = {}) {
  return buildCommand({
    inputName: "input.mp4",
    start: 5,
    duration: 20,
    geometry: cropGeometry(1920, 1080),
    staticOffset: 100,
    hasTrack: true,
    captions: [],
    title: "",
    grade: true,
    ...overrides,
  });
}

const filters = (args) => args[args.indexOf("-vf") + 1];

test("buildCommand: every drawtext disables % expansion and has a matching text file", () => {
  const { args, textFiles } = build({
    title: "A rather long song title that needs two lines",
    captions: [
      { text: "100% of my heart belongs to you forever and ever my love", a: 0, b: 5 },
      { text: "Short", a: 5, b: 9 },
    ],
  });
  const vf = filters(args);
  const draws = vf.split(",drawtext=").slice(1);
  assert.equal(draws.length, textFiles.length);
  assert.ok(textFiles.length >= 5); // 2 title lines + 2 caption lines + 1
  for (const d of draws) assert.match(d, /expansion=none/);
  for (const f of textFiles) {
    assert.ok(vf.includes(`textfile=${f.name}:`), f.name);
    assert.ok(!f.text.includes("\n"));
  }
  assert.ok(textFiles.some((f) => f.text.includes("100%")));
});

test("buildCommand: audio is resampled to 48 kHz after loudnorm", () => {
  const { args } = build();
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
  assert.match(args[args.indexOf("-af") + 1], /loudnorm/);
});

test("buildCommand: crop and track only when the source needs cropping", () => {
  assert.match(filters(build({ grade: false }).args), /^sendcmd=f=track\.txt,crop=w=\d+:h=1080:x=100:y=0,scale=1080:1920/);
  assert.match(filters(build({ hasTrack: false }).args), /^crop=/);
  assert.match(filters(build({ geometry: cropGeometry(1080, 1920), grade: false }).args), /^scale=1080:1920/);
  assert.match(filters(build({ geometry: cropGeometry(1080, 2400) }).args), /crop=w=1080:h=\d+:x=0:y=100/);
});

test("buildCommand: the colour boost runs on the crop, before the upscale (much cheaper)", () => {
  const vf = filters(build().args);
  assert.ok(vf.indexOf("eq=") < vf.indexOf("scale=") && vf.indexOf("unsharp=") < vf.indexOf("scale="), vf);
  assert.ok(vf.indexOf("crop=") < vf.indexOf("eq="), vf);
  const { args } = build();
  assert.equal(args[args.indexOf("-preset") + 1], "ultrafast");
});

test("buildCommand: fades only on clips longer than 2 seconds", () => {
  assert.match(filters(build().args), /fade=t=out:st=19\.00:d=1/);
  assert.doesNotMatch(filters(build({ duration: 2 }).args), /fade=/);
});
