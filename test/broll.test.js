import { test } from "node:test";
import assert from "node:assert/strict";
import { brollPlan, singingStretches, BROLL_LENGTH } from "../broll.js";

const clips2 = [{ duration: 10 }, { duration: Infinity }];

test("brollPlan: spread out, away from the start and end, clips in turn", () => {
  const plan = brollPlan({ duration: 40, clips: clips2, every: 8 });
  assert.equal(plan.length, 4); // (40 - 4) / 8
  for (const p of plan) {
    assert.ok(p.at >= 2 && p.at + p.len <= 38, JSON.stringify(p));
    assert.equal(p.len, BROLL_LENGTH);
  }
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at >= plan[i - 1].at + plan[i - 1].len + 1, "a gap between shots");
  assert.deepEqual(plan.map((p) => p.clip), [0, 1, 0, 1]);
});

test("brollPlan: prefers the moments without singing", () => {
  // Singing everywhere except 13-17 s and 30-34 s.
  const singing = [{ a: 0, b: 13 }, { a: 17, b: 30 }, { a: 34, b: 40 }];
  const plan = brollPlan({ duration: 40, clips: clips2, singing, every: 18 });
  assert.equal(plan.length, 2);
  assert.ok(plan[0].at >= 13 && plan[0].at + plan[0].len <= 17, JSON.stringify(plan[0]));
  assert.ok(plan[1].at >= 30 && plan[1].at + plan[1].len <= 34, JSON.stringify(plan[1]));
});

test("brollPlan: a shot pushed late in its section doesn't cost the next section its shot", () => {
  // No singing only at the end of the first section, so its shot goes late; the next ones still fit.
  const singing = [{ a: 0, b: 8.5 }, { a: 11.5, b: 29 }];
  const downbeats = Array.from({ length: 12 }, (_, i) => 0.3 + i * 2.7);
  const plan = brollPlan({ duration: 29, clips: clips2, singing, downbeats, every: 8 });
  assert.equal(plan.length, 3, JSON.stringify(plan));
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at >= plan[i - 1].at + plan[i - 1].len + 1);
});

test("brollPlan: starts on bar lines when the beat is known", () => {
  const downbeats = Array.from({ length: 20 }, (_, i) => 0.37 + i * 2.4);
  const plan = brollPlan({ duration: 40, clips: clips2, downbeats, every: 8 });
  for (const p of plan) assert.ok(downbeats.some((d) => Math.abs(d - p.at) < 0.01), `at ${p.at}`);
});

test("brollPlan: a clip used twice shows different parts; photos start at 0", () => {
  const plan = brollPlan({ duration: 40, clips: [{ duration: 10 }], every: 8 });
  const offsets = plan.map((p) => p.offset);
  assert.equal(new Set(offsets).size, offsets.length);
  for (const o of offsets) assert.ok(o >= 0 && o <= 10 - BROLL_LENGTH);
  const photo = brollPlan({ duration: 20, clips: [{ duration: Infinity }], every: 8 });
  assert.ok(photo.every((p) => p.offset === 0));
});

test("brollPlan: nothing without clips, or when the reel is too short", () => {
  assert.deepEqual(brollPlan({ duration: 40, clips: [] }), []);
  assert.deepEqual(brollPlan({ duration: 5, clips: clips2 }), []);
  assert.equal(brollPlan({ duration: 8, clips: clips2, every: 8 }).length, 1);
});

test("singingStretches: windows with singing become joined stretches in reel time", () => {
  const windows = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ t: 10 + i * 0.975 }));
  const sings = [false, true, true, false, false, true, true];
  const s = singingStretches(windows, sings, 10, 10);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].a - 0.975) < 1e-9 && Math.abs(s[0].b - 2.925) < 1e-9);
  assert.ok(Math.abs(s[1].a - 4.875) < 1e-9);
});

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand, cropGeometry, FONT_DIR, FONT_FILE } from "../editor.js";
import { encodeWav, synthDrums } from "../beats.js";

const base = {
  inputName: "input.mp4", start: 0, duration: 12, geometry: cropGeometry(1280, 720), staticOffset: 400,
  hasTrack: false, captions: [{ text: "hello there", a: 1, b: 5 }], title: "Title", grade: false, captionStyle: "pop",
};
const brollShots = [
  { name: "broll0.mp4", at: 3, len: 2.5, offset: 1.5, image: false },
  { name: "broll1.png", at: 7.5, len: 2.5, offset: 0, image: true },
];
const arg = (args, flag) => args[args.indexOf(flag) + 1];

test("buildCommand: b-roll shots are extra inputs, faded and laid over the performance, under the text", () => {
  const { args } = buildCommand({ ...base, broll: brollShots });
  assert.ok(!args.includes("-vf"));
  assert.deepEqual(args.slice(4, 10), ["-ss", "1.50", "-t", "2.50", "-i", "broll0.mp4"]);
  assert.deepEqual(args.slice(10, 18), ["-loop", "1", "-framerate", "30", "-t", "2.50", "-i", "broll1.png"]);
  const g = arg(args, "-filter_complex");
  assert.match(g, /^\[0:v\]crop=[^;]*\[base\];/);
  assert.match(g, /\[1:v\]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuva420p,fade=t=in:st=0:d=0\.3:alpha=1,fade=t=out:st=2\.20:d=0\.3:alpha=1,setpts=PTS-STARTPTS\+3\.000\/TB\[b0\]/);
  assert.match(g, /\[2:v\][^;]*zoompan[^;]*setpts=PTS-STARTPTS\+7\.500\/TB\[b1\]/);
  assert.match(g, /\[base\]\[b0\]overlay=eof_action=pass:format=auto\[o0\];[^;]*\[b1\];\[o0\]\[b1\]overlay/);
  assert.match(g, /\[o1\]drawtext=[^;]*subtitles=[^;]*fade=t=out[^;]*format=yuv420p\[vout\]$/); // text on top
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[vout]", "-map", "0:a:0"]);
  assert.ok(args.includes("-af"));
});

test("buildCommand: b-roll with music puts both in one filter graph; music stays input 1", () => {
  const { args } = buildCommand({ ...base, broll: brollShots, music: { name: "m.wav", volume: 0.3, duck: "light" } });
  assert.equal(args[args.indexOf("-stream_loop") + 3], "m.wav");
  const g = arg(args, "-filter_complex");
  assert.match(g, /\[2:v\]fps=30[^;]*\[b0\]/);
  assert.match(g, /\[3:v\][^;]*\[b1\]/);
  assert.match(g, /\[1:a\]aresample/);
  assert.equal(args.filter((a) => a === "-filter_complex").length, 1);
  const maps = args.flatMap((a, i) => (a === "-map" ? [args[i + 1]] : []));
  assert.deepEqual(maps, ["[vout]", "[aout]"]);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("rendered: b-roll clip and photo appear at their moments, with music and beat cuts", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-broll-"));
  try {
    const run = (cmd, a) => execFileSync(cmd, a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1e9 });
    // A grey performance, a pure blue b-roll clip and a pure red photo, so each is easy to recognise.
    run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=gray:s=1280x720:r=30:d=12", "-f", "lavfi", "-i", "sine=f=330:d=12", "-shortest", "-pix_fmt", "yuv420p", "input.mp4"]);
    run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=1920x1080:r=25:d=8", "-pix_fmt", "yuv420p", "broll0.mp4"]);
    run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=800x600:d=1", "-frames:v", "1", "broll1.png"]);
    writeFileSync(join(dir, "music.wav"), encodeWav(synthDrums([0.5, 1.1, 1.7, 2.3], 0, 12), 44100));
    mkdirSync(join(dir, FONT_DIR));
    copyFileSync(join(root, "fonts/Poppins-Bold.ttf"), join(dir, FONT_FILE));
    const { args, textFiles } = buildCommand({
      ...base, broll: brollShots, closeups: [{ a: 4, b: 8 }], transition: "smooth",
      music: { name: "music.wav", volume: 0.3, duck: "light" },
    });
    for (const f of textFiles) writeFileSync(join(dir, f.name), f.text);
    const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
    assert.equal(res.status, 0, res.stderr.toString());
    const probe = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "csv=p=0", "output.mp4"]).toString();
    assert.match(probe, /^video,1080,1920$/m);
    assert.ok(Math.abs(parseFloat(probe.trim().split("\n").pop()) - 12) < 0.1, probe);
    // The colour in the middle of the picture at a few moments.
    const colour = (t) => {
      const b = run("ffmpeg", ["-v", "error", "-ss", String(t), "-i", "output.mp4", "-frames:v", "1", "-vf", "crop=100:100:490:700,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      const [r, g, bl] = b;
      return r > 150 && g < 80 && bl < 80 ? "red" : bl > 150 && r < 80 && g < 80 ? "blue" : Math.abs(r - g) < 20 && Math.abs(g - bl) < 20 ? "grey" : `rgb(${r},${g},${bl})`;
    };
    assert.equal(colour(2), "grey");
    assert.equal(colour(4.2), "blue");
    assert.equal(colour(6.2), "grey");
    assert.equal(colour(8.8), "red");
    assert.equal(colour(10.5), "grey");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
