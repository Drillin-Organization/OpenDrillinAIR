// Builds the characters' move library from the CMU motion capture database:
// retargets every suitable recording to their skeleton, cuts long ones into
// moves at natural pauses, drops ones that mostly travel (she has her own
// walk), labels each from CMU's descriptions, and writes
//   Soul/Moves/moves.json  index: [{name, desc, tags, fps, frames, offset, source}]
//   Soul/Moves/moves.bin   frames: int16 LE, per frame root xyz (mm) then each
//                          body joint's local Euler xyz (centidegrees, R = Rz·Ry·Rx)
// Data: mocap.cs.cmu.edu ("may be copied, modified, or redistributed without permission").
//
// Usage: tsx mocap/build-pack.ts <dir with all subjects' .asf/.amc> [maxMoves]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_JOINTS, parseAmc, parseAsf, resample, retarget, type Pose } from "./retarget.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../Drillin AIR/Drillin AIR/Soul/Moves");
const FPS = 15;
const src = process.argv[2];
const MAX = Number(process.argv[3] ?? 1500);
const index = JSON.parse(fs.readFileSync(path.join(HERE, "../.mocap/index.json"), "utf8")) as Record<string, { desc: string; fps: number; subject: string }>;

/// Recordings that are about getting somewhere, need props or a partner's body to make sense.
const SKIP = /\b(walk|walking|run|running|jog|runjog|climb|ladder|playground|swing|monkey bars|motorcycle|bicycle|bike|skateboard|stairs?|steps? (up|down)|navigate|treadmill|hop forward|hopscotch|swim|breast stroke|crawl|marching|stumble|limping|sneak)/i;
/// Categories for search, from words in the description.
const CATEGORIES: Array<[string, RegExp]> = [
  ["dance", /danc|salsa|charleston|lambada|waltz|tango|swing dance|cha-cha|twist|disco|ballet|hip hop|breakdanc|moonwalk|jive|samba|indian|rumba/i],
  ["sit", /\bsit|seat|chair|stool|bench|squat|kneel|crouch|lie|lying|lay down|get up|stand up|rise/i],
  ["exercise", /stretch|yoga|exercise|push ?up|sit ?up|squat|lunge|jumping jack|calisthen|warm ?up|tai chi|martial|karate|kick|punch|box|range of motion|balance|toe touch|bend/i],
  ["emotion", /laugh|cry|sad|happy|angry|frustrat|excit|scared|fear|surpris|shy|bored|tired|sigh|nervous|depress|joy|celebrat|cheer|disgust|proud|sexy|flirt/i],
  ["gesture", /wave|point|shrug|nod|beckon|clap|salute|bow|gestur|talk|conversation|explain|story|argue|hand|thumbs|shake head|come here|no no|yes|hello|bye|high-five|hug|comfort|greet/i],
  ["everyday", /drink|eat|wash|brush|comb|phone|read|write|type|sweep|clean|cook|pour|wipe|open|close|pick|put|carry|lift|reach|look|search|dress|button|tie|fold|stir|sip|yawn|scratch|fix|hair|mirror|window/i],
  ["play", /play|game|ball|throw|catch|jump|hop|spin|twirl|cartwheel|flip|acrobat|kick|golf|tennis|baseball|soccer|basketball|frisbee|boxing|fencing|charades|mime|pantomime|animal|chicken|cat|dog|bear|dinosaur|monkey|elephant|snake|bird|hummingbird|mickey|robot|zombie|superhero|airplane/i],
  ["idle", /stand|idle|wait|rest|pose|still|look around|shift|fidget/i],
];

const clean = (s: string) => s.replace(/\((2 subjects|subject [ab])[^)]*\)/gi, "").replace(/\s+/g, " ").trim();
const slug = (s: string) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "move";

type Move = { name: string; desc: string; tags: string[]; poses: Pose[]; source: string };

function motionEnergy(poses: Pose[]): number[] {
  // Per frame: how much the body is moving (sum of joint angle changes).
  return poses.map((p, i) => {
    if (i === 0) return 0;
    let e = 0;
    for (const j of BODY_JOINTS) {
      const a = p.joints[j], b = poses[i - 1].joints[j];
      if (a && b) e += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    }
    return e;
  });
}

/// In place: remove travel (a slow-moving average of the root) but keep sway and bounce.
function inPlace(poses: Pose[]): { poses: Pose[]; speed: number } {
  const n = poses.length, w = Math.round(FPS * 0.8);
  const avg = poses.map((_, i) => {
    let x = 0, z = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { x += poses[k].root[0]; z += poses[k].root[2]; c++; }
    return [x / c, z / c];
  });
  let travel = 0;
  for (let i = 1; i < n; i++) travel += Math.hypot(avg[i][0] - avg[i - 1][0], avg[i][1] - avg[i - 1][1]);
  const out = poses.map((p, i) => ({ joints: p.joints, root: [p.root[0] - avg[i][0], p.root[1], p.root[2] - avg[i][1]] as Pose["root"] }));
  return { poses: out, speed: travel / Math.max(0.1, n / FPS) };
}

/// Cuts long recordings into 4–10 s moves at the calmest moments.
function segments(poses: Pose[]): Array<[number, number]> {
  const n = poses.length, min = 4 * FPS, max = 10 * FPS;
  if (n <= 12 * FPS) return [[0, n]];
  const e = motionEnergy(poses);
  const smooth = e.map((_, i) => { let s = 0, c = 0; for (let k = i - 4; k <= i + 4; k++) if (k >= 0 && k < n) { s += e[k]; c++; } return s / c; });
  const cuts: Array<[number, number]> = [];
  let start = 0;
  while (n - start > max) {
    let best = start + min, bestE = Infinity;
    for (let k = start + min; k < Math.min(n - min, start + max); k++) if (smooth[k] < bestE) { bestE = smooth[k]; best = k; }
    cuts.push([start, best]);
    start = best;
  }
  if (n - start >= min) cuts.push([start, n]);
  else if (cuts.length) cuts[cuts.length - 1][1] = n;
  return cuts;
}

const moves: Move[] = [];
const used = new Map<string, number>();
const perDesc = new Map<string, number>();
const ids = Object.keys(index).sort();
let skipped = 0, travelling = 0, failed = 0, still = 0;
for (const id of ids) {
  const meta = index[id];
  const desc = clean(meta.desc);
  if (!desc || SKIP.test(desc)) { skipped++; continue; }
  const subj = id.split("_")[0];
  const amcPath = path.join(src, subj, `${id}.amc`), asfPath = path.join(src, subj, `${subj}.asf`);
  if (!fs.existsSync(amcPath) || !fs.existsSync(asfPath)) { failed++; continue; }
  let poses: Pose[];
  try {
    const asf = parseAsf(fs.readFileSync(asfPath, "utf8"));
    poses = retarget(asf, resample(parseAmc(fs.readFileSync(amcPath, "utf8")), meta.fps, FPS));
  } catch (e) {
    failed++;
    continue;
  }
  const tags = CATEGORIES.filter(([, re]) => re.test(desc) || re.test(meta.subject)).map(([t]) => t);
  const parts = segments(poses);
  for (const [pi, [a, b]] of parts.entries()) {
    // Variety over volume: at most a few dozen takes of the same thing.
    const key = desc.toLowerCase();
    if ((perDesc.get(key) ?? 0) >= (tags.includes("dance") ? 30 : 20)) break;
    const part = inPlace(poses.slice(a, b));
    // Mostly getting somewhere (and not dancing): she has her own walk for that.
    if (part.speed > 0.45 && !tags.includes("dance")) { travelling++; continue; }
    const energy = motionEnergy(part.poses);
    if (energy.reduce((s, v) => s + v, 0) / energy.length < 1.5) { still++; continue; }
    const base = slug(desc);
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    perDesc.set(key, (perDesc.get(key) ?? 0) + 1);
    // A piece of a long recording holds only some of what the description lists.
    const label = parts.length > 1 ? `${desc} (part ${pi + 1} of ${parts.length})` : desc;
    moves.push({ name: k === 1 ? base : `${base}_${k}`, desc: label, tags: tags.length ? tags : ["other"], poses: part.poses, source: `cmu ${id}${a ? ` @${(a / FPS).toFixed(1)}s` : ""}` });
  }
  if (moves.length >= MAX) break;
}

// Write the pack.
fs.mkdirSync(OUT, { recursive: true });
const values = 3 + BODY_JOINTS.length * 3;
const total = moves.reduce((s, m) => s + m.poses.length, 0);
const bin = Buffer.alloc(total * values * 2);
let off = 0;
const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const entries = moves.map((m) => {
  const start = off / (values * 2);
  for (const p of m.poses) {
    for (const v of p.root) { bin.writeInt16LE(clamp(v * 1000), off); off += 2; }
    for (const j of BODY_JOINTS) {
      const e = p.joints[j] ?? [0, 0, 0];
      for (const v of e) { bin.writeInt16LE(clamp(v * 100), off); off += 2; }
    }
  }
  return { name: m.name, desc: m.desc, tags: m.tags, frames: m.poses.length, offset: start, source: m.source };
});
fs.writeFileSync(path.join(OUT, "moves.bin"), bin);
fs.writeFileSync(path.join(OUT, "moves.json"), JSON.stringify({
  fps: FPS, joints: BODY_JOINTS, values,
  credit: "Motion data from the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu).",
  moves: entries,
}));
const byTag = new Map<string, number>();
for (const m of moves) for (const t of m.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
console.log(`${moves.length} moves, ${(total / FPS / 60).toFixed(1)} min, ${(bin.length / 1e6).toFixed(1)} MB; skipped ${skipped} (travel/props by name), ${travelling} travelling parts, ${still} too still, ${failed} unreadable`);
console.log([...byTag].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", "));
