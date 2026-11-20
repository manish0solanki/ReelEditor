import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand, cropGeometry, FONT_DIR, FONT_FILE } from "../editor.js";

const base = {
  inputName: "input.mp4", start: 0, duration: 10, geometry: cropGeometry(1280, 720), staticOffset: 400,
  hasTrack: false, captions: [], title: "", grade: false,
};
const arg = (args, flag) => args[args.indexOf(flag) + 1];

test("buildCommand: default fades are unchanged; a hook clip fades in fast and out short", () => {
  const def = buildCommand(base).args;
  assert.match(arg(def, "-vf"), /fade=t=in:st=0:d=0\.6,fade=t=out:st=9\.00:d=1$/);
  assert.match(arg(def, "-af"), /^afade=t=in:st=0:d=0\.6,afade=t=out:st=9\.00:d=1,/);
  const hook = buildCommand({ ...base, fadeIn: 0.15, fadeOut: 0.3 }).args;
  assert.match(arg(hook, "-vf"), /fade=t=in:st=0:d=0\.15,fade=t=out:st=9\.70:d=0\.3$/);
  assert.match(arg(hook, "-af"), /^afade=t=in:st=0:d=0\.15,afade=t=out:st=9\.70:d=0\.3,/);
  const none = buildCommand({ ...base, fadeIn: 0, fadeOut: 0 }).args;
  assert.doesNotMatch(arg(none, "-vf"), /fade=/);
  assert.match(arg(none, "-af"), /^afade=t=in:st=0:d=0\.05,acompressor/); // a 50 ms ramp avoids a click
});

test("buildCommand: the progress bar is a sliding strip over a faint track, before the fades", () => {
  const vf = arg(buildCommand({ ...base, progressBar: true }).args, "-vf");
  assert.match(vf, /drawbox=x=0:y=ih-14:w=iw:h=14:color=white@0\.28:t=fill,null\[pbin\];color=c=white:s=1080x14:r=30:d=10\.00\[pbar\];\[pbin\]\[pbar\]overlay=x='-w\+W\*t\/10\.000':y=H-h:eof_action=pass,fade=t=in/);
  assert.doesNotMatch(arg(buildCommand(base).args, "-vf"), /pbar/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const withBroll of [false, true]) {
  test(`rendered: the progress bar fills across the reel${withBroll ? " (with b-roll)" : ""}`, { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-clip-"));
    try {
      const run = (cmd, a) => execFileSync(cmd, a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1e9 });
      run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=1280x720:r=30:d=10", "-f", "lavfi", "-i", "sine=d=10", "-shortest", "-pix_fmt", "yuv420p", "input.mp4"]);
      run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=5", "-pix_fmt", "yuv420p", "b.mp4"]);
      mkdirSync(join(dir, FONT_DIR));
      copyFileSync(join(root, "fonts/Poppins-Bold.ttf"), join(dir, FONT_FILE));
      const { args, textFiles } = buildCommand({
        ...base, progressBar: true, fadeIn: 0, fadeOut: 0, title: "Hook text",
        broll: withBroll ? [{ name: "b.mp4", at: 4, len: 2.5, offset: 0, image: false }] : [],
      });
      for (const f of textFiles) writeFileSync(join(dir, f.name), f.text);
      const res = spawnSync("ffmpeg", ["-v", "warning", "-y", ...args], { cwd: dir });
      assert.equal(res.status, 0, res.stderr.toString());
      // Fraction of the bottom row that's bright, at a few moments.
      const filled = (t) => {
        const b = run("ffmpeg", ["-v", "error", "-ss", String(t), "-i", "output.mp4", "-frames:v", "1", "-vf", "crop=1080:2:0:1912,format=gray", "-f", "rawvideo", "-"]);
        let bright = 0;
        for (let x = 0; x < 1080; x++) if (b[x] > 200) bright++;
        return bright / 1080;
      };
      for (const t of [2, 5, 8]) assert.ok(Math.abs(filled(t) - t / 10) < 0.06, `at ${t} s: ${filled(t)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
