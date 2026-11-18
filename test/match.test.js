import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beatGrid, matchMusic, encodeWav } from "../beats.js";
import { buildCommand, cropGeometry, FONT_DIR, FONT_FILE } from "../editor.js";

const SR = 16000;

// Clicks at `bpm` from `offset`, `freq` Hz, beat 1 of each bar louder.
function clicks({ bpm, seconds, offset, freq = 800, sr = SR }) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let k = 0; offset + (k * 60) / bpm < seconds; k++) {
    const s0 = Math.round((offset + (k * 60) / bpm) * sr);
    const amp = k % 4 === 0 ? 0.8 : 0.4;
    for (let i = 0; i < sr / 10 && s0 + i < x.length; i++) x[s0 + i] += amp * Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (sr / 50));
  }
  return x;
}

const grid = (bpm, seconds, offset) => beatGrid(clicks({ bpm, seconds, offset }), SR);

// Music beats in reel time vs the video's true beats: worst gap.
function worstGap(m, bpm, offset, duration) {
  let worst = 0;
  for (let t = offset; t < duration - 0.5; t += 60 / bpm) {
    const d = Math.min(...m.beats.map((b) => Math.abs(b - t)));
    worst = Math.max(worst, d);
  }
  return worst;
}

test("matchMusic: 94 BPM music is sped up to a 100 BPM video and its beats line up", () => {
  const video = grid(100, 20, 0.37);
  const music = grid(94, 60, 1.13);
  const m = matchMusic(video, music, 20);
  assert.ok(m.ok, m.reason);
  assert.ok(Math.abs(m.tempo - video.bpm / music.bpm) < 1e-3, String(m.tempo));
  assert.ok(Math.abs(m.tempo - 100 / 94) < 0.02);
  assert.ok(m.fraction > 0.9, String(m.fraction));
  assert.ok(worstGap(m, 100, 0.37, 20) < 0.04, String(worstGap(m, 100, 0.37, 20)));
  // Bar lines line up too: every music downbeat is on a video downbeat.
  for (const d of m.downbeats) assert.ok(video.downbeats.some((v) => Math.abs(v - d) < 0.04), `music bar line at ${d}`);
});

test("matchMusic: double or half tempo counts as the same beat", () => {
  const video = grid(100, 20, 0.2);
  const fastMusic = grid(196, 40, 0.5);
  const m = matchMusic(video, fastMusic, 20);
  assert.ok(m.ok, m.reason);
  assert.ok(Math.abs(m.tempo - 1) < 0.05, String(m.tempo)); // ~1.02, not ~0.51
});

test("matchMusic: refuses tempos more than 10% apart, or no beat", () => {
  const video = grid(100, 20, 0.2);
  const slow = matchMusic(video, grid(76, 40, 0.5), 20);
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /too different/);
  const silent = beatGrid(new Float32Array(SR * 10), SR);
  assert.match(matchMusic(silent, grid(100, 20, 0.2), 10).reason, /video/);
  assert.match(matchMusic(video, silent, 20).reason, /music/);
});

test("buildCommand: matched music is sped up with atempo and starts at the matched point", () => {
  const { args } = buildCommand({
    inputName: "input.mp4", start: 0, duration: 20, geometry: cropGeometry(1920, 1080), staticOffset: 0, hasTrack: false,
    captions: [], title: "", grade: false, music: { name: "m.mp3", volume: 0.4, duck: "strong", tempo: 1.0638, start: 2.5 },
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[1:a\]atempo=1\.0638,atrim=start=2\.500,asetpts=PTS-STARTPTS,aresample=48000,volume=0\.4,/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("rendered reel: the music's clicks land on the video's beats", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-match-"));
  try {
    const run = (cmd, a) => execFileSync(cmd, a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1e9 });
    const duration = 16;
    // The video: 100 BPM clicks at 800 Hz from 0.37 s. The music: 94 BPM clicks at 2000 Hz from 1.13 s.
    writeFileSync(join(dir, "video.wav"), encodeWav(clicks({ bpm: 100, seconds: duration, offset: 0.37, sr: 44100 }), 44100));
    writeFileSync(join(dir, "music.wav"), encodeWav(clicks({ bpm: 94, seconds: 60, offset: 1.13, freq: 2000, sr: 44100 }), 44100));
    run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${duration}`, "-i", "video.wav", "-shortest", "-pix_fmt", "yuv420p", "input.mp4"]);
    mkdirSync(join(dir, FONT_DIR));
    copyFileSync(join(root, "fonts/Poppins-Bold.ttf"), join(dir, FONT_FILE));

    const pcm = (file) => {
      const b = run("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
      return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    };
    const m = matchMusic(beatGrid(pcm("input.mp4"), SR), beatGrid(pcm("music.wav"), SR), duration);
    assert.ok(m.ok, m.reason);

    const { args } = buildCommand({
      inputName: "input.mp4", start: 0, duration, geometry: cropGeometry(640, 360), staticOffset: 0, hasTrack: false,
      captions: [], title: "", grade: false, voiceVolume: 0, // music only, so its clicks can be found
      music: { name: "music.wav", volume: 0.8, duck: "light", tempo: m.tempo, start: m.start },
    });
    const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
    assert.equal(res.status, 0, res.stderr.toString());

    // Find the music's clicks in the finished reel: energy around 2 kHz, peaks at least 0.3 s apart.
    const b = run("ffmpeg", ["-v", "error", "-i", "output.mp4", "-af", "bandpass=f=2000:w=400", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"]);
    const y = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    const hop = 40; // 5 ms
    const env = [];
    for (let i = 0; i + hop <= y.length; i += hop) {
      let e = 0;
      for (let j = i; j < i + hop; j++) e += y[j] * y[j];
      env.push(e);
    }
    const max = Math.max(...env);
    const onsets = [];
    for (let i = 1; i < env.length; i++) {
      if (env[i] > 0.1 * max && env[i - 1] <= 0.1 * max && (!onsets.length || i * 0.005 - onsets[onsets.length - 1] > 0.3)) onsets.push(i * 0.005);
    }
    // Each of the video's beats (away from the fades) should have a music click within 35 ms.
    const gaps = [];
    for (let t = 0.37; t < duration - 2; t += 0.6) if (t > 1.2) gaps.push(Math.min(...onsets.map((o) => Math.abs(o - t))));
    const close = gaps.filter((g) => g < 0.035).length;
    assert.ok(close / gaps.length >= 0.9, `only ${close} of ${gaps.length} beats matched; gaps ${gaps.map((g) => g.toFixed(3)).join(" ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
