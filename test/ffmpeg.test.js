// Runs the real command through a native ffmpeg, if one is installed. Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cropGeometry, trackFileText, buildCommand, FONT_FILE } from "../editor.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the generated command renders a 1080x1920 reel with 48 kHz audio", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-test-"));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:d=5", "-shortest", "-pix_fmt", "yuv420p", "input.mp4",
    ]);
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
    });
    for (const f of textFiles) writeFileSync(join(dir, f.name), f.text);

    const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
    const log = res.stderr.toString();
    assert.equal(res.status, 0, log);
    assert.doesNotMatch(log, /Stray %/);

    const probe = run("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,sample_rate", "-of", "csv=p=0", "output.mp4",
    ]);
    assert.match(probe, /^video,1080,1920$/m);
    assert.match(probe, /^audio,48000$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
