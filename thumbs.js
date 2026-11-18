// Choosing cover-image frames. Pure functions, no browser code.
//
// Each sampled frame gets a score from:
//   sharpness - variance of the Laplacian (edges): low for motion blur or soft focus
//   face      - a clear face, big enough and well placed (or the chosen person's)
//   exposure  - not too dark, not blown out
//   colour    - a little preference for vivid frames (Hasler and Suesstrunk's colourfulness)
// and the best few are picked from different moments.

// Greyscale (0-255) from RGBA.
export function gray(rgba) {
  const g = new Float32Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}

// Variance of the 4-neighbour Laplacian: sharp edges give large values, blur small ones.
export function sharpness(g, w, h) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// 1 for a well-exposed frame, down to 0 for one that's very dark, very bright or mostly clipped.
export function exposure(g) {
  let sum = 0;
  let clipped = 0;
  for (const v of g) {
    sum += v;
    if (v < 8 || v > 247) clipped++;
  }
  const mean = sum / g.length / 255;
  const level = Math.max(0, 1 - Math.abs(mean - 0.5) / 0.4); // best around mid-grey
  return level * Math.max(0, 1 - (2 * clipped) / g.length);
}

// Colourfulness (Hasler & Suesstrunk 2003), roughly 0 (grey) to 100+ (very vivid).
export function colourfulness(rgba) {
  let sRg = 0, sYb = 0, sRg2 = 0, sYb2 = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const rg = rgba[i] - rgba[i + 1];
    const yb = 0.5 * (rgba[i] + rgba[i + 1]) - rgba[i + 2];
    sRg += rg; sYb += yb; sRg2 += rg * rg; sYb2 += yb * yb;
  }
  const mRg = sRg / n, mYb = sYb / n;
  const sdRg = Math.sqrt(Math.max(0, sRg2 / n - mRg * mRg));
  const sdYb = Math.sqrt(Math.max(0, sYb2 / n - mYb * mYb));
  return Math.hypot(sdRg, sdYb) + 0.3 * Math.hypot(mRg, mYb);
}

// 0-1: how good the face is for a cover. face: { cx, cy, w, h } as fractions of the frame, or null.
// Best when it's between ~8% and 35% of the frame's width and not at the very edge.
export function faceQuality(face) {
  if (!face) return 0;
  const size = face.w;
  const sizeScore = size < 0.03 ? 0 : size < 0.08 ? (size - 0.03) / 0.05 : size <= 0.35 ? 1 : Math.max(0.4, 1 - (size - 0.35) / 0.4);
  const edge = Math.min(face.cx, 1 - face.cx, face.cy, 1 - face.cy);
  const placeScore = Math.min(1, edge / 0.15);
  return sizeScore * (0.5 + 0.5 * placeScore);
}

// frames: [{ t, sharp, exposure, colour, face }] (face as above, or null).
// Returns them with a `score` (0-100) and `parts`, best first. Sharpness and colour are compared
// within this video (its own best frame = 1), since their raw values depend on the footage.
export function scoreFrames(frames) {
  const maxSharp = Math.max(1e-9, ...frames.map((f) => f.sharp));
  const maxColour = Math.max(1e-9, ...frames.map((f) => f.colour));
  const anyFace = frames.some((f) => f.face);
  return frames
    .map((f) => {
      const parts = {
        sharp: Math.sqrt(f.sharp / maxSharp), // square root: halving sharpness isn't half as bad
        face: faceQuality(f.face),
        exposure: f.exposure,
        colour: f.colour / maxColour,
      };
      // Without any faces in the video, the face weight goes to sharpness instead.
      const w = anyFace ? { sharp: 0.35, face: 0.35, exposure: 0.15, colour: 0.15 } : { sharp: 0.6, face: 0, exposure: 0.2, colour: 0.2 };
      const score = Object.keys(w).reduce((s, k) => s + w[k] * parts[k], 0);
      return { ...f, parts, score: Math.round(score * 100) };
    })
    .sort((a, b) => b.score - a.score);
}

// A tiny greyscale picture of a frame (16 x 9), to tell whether two frames look alike.
export function signature(g, w, h, sw = 16, sh = 9) {
  const sig = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0;
      let n = 0;
      for (let yy = Math.floor((y * h) / sh); yy < Math.floor(((y + 1) * h) / sh); yy++) {
        for (let xx = Math.floor((x * w) / sw); xx < Math.floor(((x + 1) * w) / sw); xx++) {
          sum += g[yy * w + xx];
          n++;
        }
      }
      sig[y * sw + x] = n ? sum / n : 0;
    }
  }
  return sig;
}

// Mean absolute difference between two signatures (0-255).
export function lookDifference(a, b) {
  if (!a || !b) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// The best `count` frames at least `gap` seconds apart that also look different from each other
// (signatures differ by at least `minLook`: repeats of the same shot differ by ~0-1); if there
// aren't enough, any frames `gap` apart.
export function pickCovers(scored, count = 3, gap = 2, minLook = 4) {
  const out = [];
  const apart = (f) => out.every((o) => Math.abs(o.t - f.t) >= gap);
  const differs = (f) => out.every((o) => lookDifference(o.sig, f.sig) >= minLook);
  for (const f of scored) if (out.length < count && apart(f) && differs(f)) out.push(f);
  for (const f of scored) if (out.length < count && !out.includes(f) && apart(f)) out.push(f);
  return out.sort((a, b) => b.score - a.score);
}

// How to place a video frame (vw x vh) in a W x H cover so the face sits in the upper middle:
// returns the source rectangle { sx, sy, sw, sh } to draw into the whole cover.
export function coverCrop(vw, vh, face, W = 1080, H = 1920) {
  const target = W / H;
  let sw = vw;
  let sh = vw / target;
  if (sh > vh) {
    sh = vh;
    sw = vh * target;
  }
  // Zoom in a little if the face is small, so it reads well as a cover (at most 1.6x).
  if (face && face.w * vw < 0.22 * sw) {
    const z = Math.min(1.6, (0.22 * sw) / Math.max(1, face.w * vw));
    sw /= z;
    sh /= z;
  }
  const fx = face ? face.cx * vw : vw / 2;
  const fy = face ? face.cy * vh : vh / 2;
  const sx = Math.max(0, Math.min(vw - sw, fx - sw / 2));
  const sy = Math.max(0, Math.min(vh - sh, fy - 0.36 * sh)); // face a little above the middle
  return { sx, sy, sw, sh };
}
