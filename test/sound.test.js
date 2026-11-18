import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommand, cropGeometry, noiseFilters, noiseFloor, loudnessDb, zoomExpression, zoomFocus, CLOSEUP_ZOOM,
} from "../editor.js";

const base = {
  inputName: "input.mp4", start: 5, duration: 20, geometry: cropGeometry(1920, 1080), staticOffset: 600,
  hasTrack: true, captions: [], title: "", grade: true,
};
const arg = (args, flag) => args[args.indexOf(flag) + 1];

test("noiseFilters: tuned from the clip's noise floor, clamped to afftdn's range", () => {
  assert.deepEqual(noiseFilters("off", -50), []);
  assert.deepEqual(noiseFilters("light", -60), ["highpass=f=70", "afftdn=nr=10:nf=-44"]);
  assert.deepEqual(noiseFilters("strong", -52.4), ["highpass=f=90", "afftdn=nr=24:nf=-30"]);
  // A "floor" this loud is really continuous music: the estimate is capped at -50 dB.
  assert.match(noiseFilters("strong", -23.5)[1], /nf=-28$/);
  assert.match(noiseFilters("light", -23.5)[1], /nf=-34$/);
  assert.match(noiseFilters("light", -120)[1], /nf=-80$/);
});

test("noiseFloor and loudnessDb", () => {
  const sr = 1000;
  const x = new Float32Array(sr * 4);
  for (let i = 0; i < x.length; i++) x[i] = i < sr ? 0.001 : 0.5 * Math.sin(i); // 1 s quiet, 3 s loud
  const db = loudnessDb(x, sr);
  assert.equal(db.length, 16);
  assert.ok(Math.abs(db[0] - -60) < 0.1, String(db[0]));
  assert.ok(db[8] > -10);
  assert.ok(Math.abs(noiseFloor(db) - -60) < 0.1);
});

test("buildCommand: no sound options = the plain -vf/-af command as before", () => {
  const { args } = buildCommand(base);
  assert.equal(args.filter((a) => a === "-i").length, 1);
  assert.ok(args.includes("-af") && !args.includes("-filter_complex"));
  assert.doesNotMatch(arg(args, "-af"), /afftdn|highpass/);
  assert.match(arg(args, "-vf"), /^sendcmd=f=track\.txt,crop=/);
});

test("buildCommand: noise reduction goes first in the performance's sound", () => {
  const { args } = buildCommand({ ...base, noise: "strong", noiseFloorDb: -55 });
  assert.match(arg(args, "-af"), /^highpass=f=90,afftdn=nr=24:nf=-33,afade=t=in/);
});

test("buildCommand: music is a second, looped input, ducked under the performance and mixed", () => {
  const { args } = buildCommand({ ...base, noise: "light", voiceVolume: 0.8, music: { name: "music.mp3", volume: 0.35, duck: "strong" } });
  assert.deepEqual(args.slice(0, 8), ["-ss", "5", "-i", "input.mp4", "-stream_loop", "-1", "-i", "music.mp3"]);
  const graph = arg(args, "-filter_complex");
  assert.match(graph, /^\[0:a\]highpass=f=70,afftdn=[^;]*volume=0\.8,asplit\[voice\]\[key\];/);
  assert.match(graph, /\[1:a\]aresample=48000,volume=0\.35,afade=t=in:st=0:d=1,afade=t=out:st=18\.50:d=1\.5\[music\];/);
  assert.match(graph, /\[music\]\[key\]sidechaincompress=threshold=0\.03:ratio=8/);
  assert.match(graph, /\[voice\]\[ducked\]amix=inputs=2:duration=first:normalize=0,loudnorm=[^;]*\[aout\]$/);
  assert.ok(!args.includes("-af"));
  assert.equal(arg(args, "-map"), "0:v:0");
  assert.equal(args[args.lastIndexOf("-map") + 1], "[aout]");
  assert.equal(arg(args, "-t"), "20"); // the reel stops at its length even though the music loops
});

test("zoomExpression: eases to the close-up and back, each move centred on its change", () => {
  const expr = zoomExpression([{ a: 4, b: 8 }]);
  // Evaluate the ffmpeg expression in JS (clip -> clamp) to check its shape.
  const at = (t) => Function("it", "clip", `return ${expr};`)(t, (x, lo, hi) => Math.min(hi, Math.max(lo, x)));
  assert.equal(at(0), 1);
  assert.equal(at(3.6), 1); // the move starts 0.3 s before the bar line...
  assert.ok(Math.abs(at(4) - (1 + (CLOSEUP_ZOOM - 1) / 2)) < 1e-9); // ...is halfway on it...
  assert.ok(Math.abs(at(4.3) - CLOSEUP_ZOOM) < 1e-9); // ...and done 0.3 s after
  assert.ok(Math.abs(at(6) - CLOSEUP_ZOOM) < 1e-9);
  assert.equal(at(8.4), 1);
  // Smooth: no step bigger than the steepest point of the ease over one 30 fps frame.
  let last = at(3);
  for (let t = 3; t < 9; t += 1 / 30) {
    const z = at(t);
    assert.ok(Math.abs(z - last) <= 0.25 * 1.5 / 0.6 / 30 + 1e-9, `jump at ${t}`);
    last = z;
  }
  assert.equal(zoomExpression([]), "1+0.250*(0)");
});

test("buildCommand: beat cuts are one tracked crop and a smooth zoompan at 30 fps", () => {
  const closeups = [{ a: 2.4, b: 4.8 }, { a: 7.2, b: 9.6 }];
  const vf = arg(buildCommand({ ...base, closeups }).args, "-vf");
  assert.match(vf, /^sendcmd=f=track\.txt,crop=w=608:h=1080:x=600:y=0,eq=[^,]*,unsharp=[^,]*,fps=30,zoompan=z='1\+0\.250\*\(/);
  assert.match(vf, /:x='\(iw-iw\/zoom\)\*0\.5':y='\(ih-ih\/zoom\)\*0\.3':d=1:s=1080x1920:fps=30,setsar=1/);
  assert.doesNotMatch(vf, /overlay|split|scale=/);
  assert.match(vf, /setsar=1,fade=t=in/); // the rest of the chain continues after the zoom
  assert.deepEqual(zoomFocus(cropGeometry(1080, 2400)), { fx: 0.5, fy: 0.5 });
});

test("clip volume: without music it's applied after loudnorm, so it isn't normalised away", () => {
  const af = arg(buildCommand({ ...base, voiceVolume: 0.5 }).args, "-af");
  assert.match(af, /loudnorm=[^,]*,volume=0\.5$/);
  assert.match(arg(buildCommand({ ...base, voiceVolume: 0 }).args, "-af"), /,volume=0$/);
  assert.doesNotMatch(arg(buildCommand(base).args, "-af"), /volume=/);
});

test("clip volume: with music it sets the balance before the mix", () => {
  const graph = arg(buildCommand({ ...base, voiceVolume: 0.25, music: { name: "m.wav", volume: 0.35, duck: "light" } }).args, "-filter_complex");
  assert.match(graph, /^\[0:a\][^;]*volume=0\.25,asplit\[voice\]\[key\];/);
  assert.match(graph, /loudnorm=[^;]*\[aout\]$/);
});
