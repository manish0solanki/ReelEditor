// Telling people apart and following one of them. Pure functions, no browser code.
//
// A detection is { cx, cy, w, h, hist }: the face box's centre and size as fractions of the frame,
// and a colour histogram of the box (skin, hair, glasses, lighting all make it distinctive).

const H_BINS = 8;
const S_BINS = 3;
const V_BINS = 3;
export const HIST_SIZE = H_BINS * S_BINS * V_BINS;

// Normalised hue/saturation/brightness histogram of a box in an RGBA image.
// rgba: Uint8ClampedArray of width x height pixels; box: { x, y, w, h } in pixels.
export function colorHistogram(rgba, width, height, box) {
  const hist = new Float64Array(HIST_SIZE);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w));
  const y1 = Math.min(height, Math.ceil(box.y + box.h));
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i] / 255;
      const g = rgba[i + 1] / 255;
      const b = rgba[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d > 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
      }
      const s = max > 0 ? d / max : 0;
      const hb = Math.min(H_BINS - 1, Math.floor((h / 6) * H_BINS));
      const sb = Math.min(S_BINS - 1, Math.floor(s * S_BINS));
      const vb = Math.min(V_BINS - 1, Math.floor(max * V_BINS));
      hist[(hb * S_BINS + sb) * V_BINS + vb]++;
      n++;
    }
  }
  if (n) for (let k = 0; k < HIST_SIZE; k++) hist[k] /= n;
  return hist;
}

// 0 = identical colour make-up, 1 = nothing in common (1 - Bhattacharyya coefficient).
export function histDistance(a, b) {
  if (!a || !b) return 1;
  let bc = 0;
  for (let k = 0; k < a.length; k++) bc += Math.sqrt(a[k] * b[k]);
  return Math.max(0, 1 - bc);
}

const spot = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
const sizeGap = (a, b) => Math.abs(Math.log(Math.max(1e-6, a.w) / Math.max(1e-6, b.w)));

// Groups detections from a few frames across the video into people.
// frames: [{ t, dets: [detection] }]. Returns people sorted left to right:
//   [{ cx, cy, w, h, hist, count, best: { t, det } }]   (best = the largest sighting, for a thumbnail)
export function groupFaces(frames, { maxDistance = 0.15, maxLook = 0.25 } = {}) {
  const people = [];
  for (const frame of frames) {
    const taken = new Set();
    for (const det of frame.dets) {
      let match = null;
      let matchCost = Infinity;
      for (const p of people) {
        if (taken.has(p)) continue; // one face per person per frame
        // Same person if they look alike (wherever they've moved to: the scan frames are far apart),
        // or if they're in about the same place and don't look clearly different.
        const look = histDistance(p.hist, det.hist);
        const near = spot(p.last, det);
        if (!(look <= maxLook || (near <= maxDistance && look <= 0.6))) continue;
        const cost = look + 0.5 * near + 0.1 * sizeGap(p, det);
        if (cost < matchCost) {
          match = p;
          matchCost = cost;
        }
      }
      if (match) {
        const k = match.count;
        match.cx = (match.cx * k + det.cx) / (k + 1);
        match.cy = (match.cy * k + det.cy) / (k + 1);
        match.w = (match.w * k + det.w) / (k + 1);
        match.h = (match.h * k + det.h) / (k + 1);
        match.hist = match.hist.map((v, i) => (v * k + det.hist[i]) / (k + 1));
        match.count = k + 1;
        match.last = det;
        if (det.w > match.best.det.w) match.best = { t: frame.t, det };
        taken.add(match);
      } else {
        const p = { cx: det.cx, cy: det.cy, w: det.w, h: det.h, hist: Float64Array.from(det.hist), count: 1, best: { t: frame.t, det }, last: det };
        people.push(p);
        taken.add(p);
      }
    }
  }
  // Someone seen in only one frame out of many is usually a false detection.
  const minCount = frames.length >= 4 ? 2 : 1;
  return people.filter((p) => p.count >= minCount).sort((a, b) => a.cx - b.cx);
}

// Follows one person through the samples: [{ t, dets }] -> [{ t, det | null }].
// A best-path (Viterbi) search over all samples at once: each step either picks one of the faces or
// "not visible". A face costs more the less it looks like the target (colours, size); moving between
// samples costs by distance; "not visible" has a fixed cost, so a stranger is only picked when they
// really look like the target and are where the target was.
export function followFace(samples, target, { lookCost = 1.2, sizeCost = 0.3, moveCost = 2.5, hiddenCost = 0.55 } = {}) {
  const T = samples.length;
  if (!T) return [];
  const emit = (det) => (det ? lookCost * histDistance(det.hist, target.hist) + sizeCost * sizeGap(det, target) : hiddenCost);
  // Option lists: every detection plus null.
  const options = samples.map((s) => [...s.dets, null]);
  let cost = options[0].map((det) => emit(det) + (det ? 0.5 * moveCost * spot(det, target) : 0));
  const back = [];
  // Where the target was last seen, for each option (so "not visible" remembers the position).
  let lastSeen = options[0].map((det) => det || target);
  for (let t = 1; t < T; t++) {
    const opts = options[t];
    const prev = options[t - 1];
    const nextCost = new Array(opts.length);
    const nextBack = new Array(opts.length);
    const nextSeen = new Array(opts.length);
    opts.forEach((det, j) => {
      let best = Infinity;
      let arg = 0;
      prev.forEach((_, i) => {
        const move = det ? moveCost * spot(det, lastSeen[i]) : 0;
        const c = cost[i] + move;
        if (c < best) {
          best = c;
          arg = i;
        }
      });
      nextCost[j] = best + emit(det);
      nextBack[j] = arg;
      nextSeen[j] = det || lastSeen[arg];
    });
    cost = nextCost;
    back.push(nextBack);
    lastSeen = nextSeen;
  }
  let j = cost.indexOf(Math.min(...cost));
  const path = new Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = { t: samples[t].t, det: options[t][j] };
    if (t > 0) j = back[t - 1][j];
  }
  return path;
}

// ---- Finding small faces ----------------------------------------------------------------------
// The face model is made for close-ups: a singer filmed from a few metres away is too small in a
// whole landscape frame (in a test, faces 1/8 of the frame width weren't found at all). Running it on
// overlapping square tiles makes each face about 3x larger; the whole frame is still checked too,
// for big close-ups that don't fit in one tile.

// Square regions (in source pixels) to run the detector on: along the long side of the frame.
export function tileRegions(srcW, srcH) {
  const regions = [{ x: 0, y: 0, w: srcW, h: srcH, whole: true }];
  const long = Math.max(srcW, srcH);
  const short = Math.min(srcW, srcH);
  if (long / short < 1.2) return regions;
  const n = Math.ceil(long / short) + 1; // e.g. 16:9 -> 3 squares, each overlapping the next by half
  for (let k = 0; k < n; k++) {
    const offset = Math.round(((long - short) * k) / (n - 1));
    regions.push(srcW >= srcH ? { x: offset, y: 0, w: short, h: short } : { x: 0, y: offset, w: short, h: short });
  }
  return regions;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2));
  const iy = Math.max(0, Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

// The same face found in two overlapping tiles: keep one (the one with the higher score).
export function mergeDetections(dets, threshold = 0.3) {
  const sorted = [...dets].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.w * b.h - a.w * a.h);
  const kept = [];
  for (const d of sorted) if (!kept.some((k) => iou(k, d) > threshold)) kept.push(d);
  return kept;
}
