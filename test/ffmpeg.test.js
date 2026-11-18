// Runs the real command through a native ffmpeg, if one is installed. Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cropGeometry, trackFileText, buildCommand, FONT_FILE, FONT_DIR } from "../editor.js";
import { beatGrid, cutPlan, synthDrums, encodeWav } from "../beats.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const captionStyle of ["classic", "karaoke", "pop"])
test(`the generated command renders a 1080x1920 reel with 48 kHz audio (${captionStyle} captions)`, { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-test-"));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:d=5", "-shortest", "-pix_fmt", "yuv420p", "input.mp4",
    ]);
    mkdirSync(join(dir, FONT_DIR));
    copyFileSync(join(root, "fonts/Poppins-Bold.ttf"), join(dir, FONT_FILE));

    const geometry = cropGeometry(1280, 720);
    const keys = [{ t: 0, x: 0 }, { t: 2, x: 400 }, { t: 3, x: 200 }];
    writeFileSync(join(dir, "track.txt"), trackFileText(keys, geometry.axis));
    const { args, textFiles } = buildCommand({
      inputName: "input.mp4",
      start: 0.5,
      duration: 4,
      geometry,
      staticOffset: 0,
      hasTrack: true,
      captions: [{ text: "100% of my heart belongs to you forever and ever my love", a: 0, b: 4 }],
      title: "Test Title",
      grade: true,
      captionStyle,
    });
    for (const f of textFiles) writeFileSync(join(dir, f.name), f.text);

    const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
    const log = res.stderr.toString();
    assert.equal(res.status, 0, log);
    assert.doesNotMatch(log, /Stray %|fontselect|[Nn]o usable fontconfig|Glyph 0x|font provider/);

    const probe = run("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,sample_rate", "-of", "csv=p=0", "output.mp4",
    ]);
    assert.match(probe, /^video,1080,1920$/m);
    assert.match(probe, /^audio,48000$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noise reduction, generated drums ducked under the voice, and beat cuts render together", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-test-"));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1e9 });
    // A 100 BPM pulse (so there's a beat to find) plus noise, under a test picture.
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12",
      "-f", "lavfi", "-i", "sine=f=220:d=12,volume='0.6*(lt(mod(t,0.6),0.08))':eval=frame",
      "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.01:d=12",
      "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0[a]", "-map", "0:v", "-map", "[a]",
      "-shortest", "-pix_fmt", "yuv420p", "input.mp4",
    ]);
    mkdirSync(join(dir, FONT_DIR));
    copyFileSync(join(root, "fonts/Poppins-Bold.ttf"), join(dir, FONT_FILE));
    const pcm = run("ffmpeg", ["-v", "error", "-i", "input.mp4", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
    const grid = beatGrid(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), 16000);
    assert.ok(Math.abs(grid.bpm - 100) <= 2, `tempo ${grid.bpm}`);
    const closeups = cutPlan(grid, 12);
    assert.ok(closeups.length >= 1);
    writeFileSync(join(dir, "music.wav"), encodeWav(synthDrums(grid.beats, grid.phase, 12), 44100));

    const geometry = cropGeometry(1280, 720);
    writeFileSync(join(dir, "track.txt"), trackFileText([{ t: 0, x: 100 }, { t: 6, x: 500 }], geometry.axis));
    const { args, textFiles } = buildCommand({
      inputName: "input.mp4", start: 0, duration: 12, geometry, staticOffset: 100, hasTrack: true,
      captions: [{ text: "hello there", a: 1, b: 5 }], title: "Test", grade: true, captionStyle: "pop",
      noise: "strong", noiseFloorDb: -45, voiceVolume: 0.9, music: { name: "music.wav", volume: 0.35, duck: "light" }, closeups,
    });
    for (const f of textFiles) writeFileSync(join(dir, f.name), f.text);
    const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
    assert.equal(res.status, 0, res.stderr.toString());
    const probe = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,sample_rate:format=duration", "-of", "csv=p=0", "output.mp4"]).toString();
    assert.match(probe, /^video,1080,1920$/m);
    assert.match(probe, /^audio,48000$/m);
    assert.ok(Math.abs(parseFloat(probe.trim().split("\n").pop()) - 12) < 0.1, probe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
