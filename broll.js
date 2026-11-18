// Where to put b-roll (cutaway clips and photos) in the reel. Pure functions, no browser code.
//
// The reel is split into equal sections, one b-roll shot each, so they're spread out. In each section
// the shot goes where there's the least singing (instrumental breaks are natural moments to cut away),
// starting on a bar line when the beat is known, and never in the first or last couple of seconds
// (the title and the fade-out).

export const BROLL_LENGTH = 2.5; // seconds on screen, including the fades
export const BROLL_FADE = 0.3;

// singing: [{ a, b }] stretches with singing, in reel time. downbeats: bar lines in reel time.
// clips: [{ duration }] (Infinity for photos). Returns [{ at, len, clip, offset }] in time order:
//   at = reel time it appears, len = how long, clip = index into clips, offset = where in the clip to start.
export function brollPlan({ duration, clips, singing = [], downbeats = [], every = 8, length = BROLL_LENGTH, margin = 2 }) {
  if (!clips.length) return [];
  const lo = margin;
  const hi = duration - margin - length;
  if (hi <= lo) return [];
  const count = Math.max(1, Math.floor((duration - 2 * margin) / every));

  // Candidate start times: bar lines if known, otherwise every half second.
  let slots = downbeats.filter((d) => d >= lo && d <= hi);
  if (slots.length < count) {
    slots = [];
    for (let t = lo; t <= hi + 1e-9; t += 0.5) slots.push(Math.round(t * 100) / 100);
  }

  const sungWithin = (a, b) =>
    singing.reduce((sum, s) => sum + Math.max(0, Math.min(b, s.b) - Math.max(a, s.a)), 0) / (b - a);

  const section = (hi - lo) / count;
  const picks = [];
  for (let k = 0; k < count; k++) {
    const from = lo + k * section;
    const to = from + section;
    const centre = (from + to) / 2;
    // Candidates in this section, leaving a gap of at least a second after the previous shot.
    const prev = picks[picks.length - 1];
    const earliest = prev ? prev.at + prev.len + 1 : -Infinity;
    const options = slots.filter((s) => s >= from - 1e-9 && s < to + (k === count - 1 ? 1e-9 : 0) && s >= earliest);
    if (!options.length) continue;
    // Least singing first; then nearest the middle of the section (keeps the shots evenly spread).
    const best = options.reduce((a, b) => {
      const ca = sungWithin(a, a + length);
      const cb = sungWithin(b, b + length);
      if (Math.abs(ca - cb) > 0.05) return cb < ca ? b : a;
      return Math.abs(b - centre) < Math.abs(a - centre) ? b : a;
    });
    picks.push({ at: best, len: length });
  }

  // Clips in turn; a clip used again shows a different part of itself.
  const uses = clips.map(() => 0);
  const totalUses = clips.map((_, i) => picks.filter((_, j) => j % clips.length === i).length);
  return picks.map((p, j) => {
    const clip = j % clips.length;
    const d = clips[clip].duration;
    const spare = Number.isFinite(d) ? Math.max(0, d - p.len) : 0;
    const offset = spare * ((uses[clip] + 1) / (totalUses[clip] + 1));
    uses[clip]++;
    return { at: Math.round(p.at * 100) / 100, len: p.len, clip, offset: Math.round(offset * 100) / 100 };
  });
}

// Stretches with singing, in reel time, from the sound analysis windows (t in video time).
export function singingStretches(windows, sings, start, duration, hop = 0.975) {
  const out = [];
  windows.forEach((w, i) => {
    if (!sings[i]) return;
    const a = w.t - start;
    const b = a + hop;
    if (b <= 0 || a >= duration) return;
    const last = out[out.length - 1];
    if (last && a <= last.b + 0.05) last.b = Math.min(duration, b);
    else out.push({ a: Math.max(0, a), b: Math.min(duration, b) });
  });
  return out;
}
