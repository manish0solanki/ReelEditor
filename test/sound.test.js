import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommand, cropGeometry, noiseFilters, noiseFloor, loudnessDb, closeupGeometry, cutTrackTargets, trackFileText,
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

test("closeupGeometry: 1/1.3 of the crop, centred along the tracking axis, headroom across it", () => {
  const g = cropGeometry(1920, 1080); // crop 608x1080, tracking along x
  const c = closeupGeometry(g);
  assert.equal(c.w, 468);
  assert.equal(c.h, 830);
  assert.equal(c.dx, 70); // (608 - 468) / 2
  assert.equal(c.dy, 76); // (1080 - 830) * 0.3, even
  const tall = closeupGeometry(cropGeometry(1080, 2400)); // tracking along y
  assert.equal(tall.dy, (1920 - tall.h) / 2);
  for (const v of Object.values(c)) assert.equal(v % 2, 0);
});

test("buildCommand: beat cuts split into a wide and a close-up shot, switched at the given times", () => {
  const closeups = [{ a: 2.4, b: 4.8 }, { a: 7.2, b: 9.6 }];
  const vf = arg(buildCommand({ ...base, closeups }).args, "-vf");
  assert.match(vf, /^sendcmd=f=track\.txt,split\[wide\]\[close\];\[wide\]crop@wide=w=608:h=1080:x=600:y=0,eq=/);
  assert.match(vf, /\[close\]crop@close=w=468:h=830:x=670:y=76,eq=[^;]*scale=1080:1920,setsar=1\[cv\];/);
  assert.match(vf, /\[wv\]\[cv\]overlay=enable='between\(t,2\.40,4\.80\)\+between\(t,7\.20,9\.60\)'/);
  assert.match(vf, /9\.60\)',fade=t=in/); // the rest of the chain continues after the switch
});

test("cutTrackTargets: face tracking moves both crops, the close-up keeping its offset", () => {
  const g = cropGeometry(1920, 1080);
  const text = trackFileText([{ t: 0, x: 100 }, { t: 1, x: 200 }], g.axis, cutTrackTargets(g));
  assert.equal(text.split("\n")[0], "0.00 crop@wide x 100+(100)*(t-0.00)/1.00, crop@close x 170+(100)*(t-0.00)/1.00;");
  assert.equal(text.split("\n")[1], "1.00 crop@wide x 200, crop@close x 270;");
});
