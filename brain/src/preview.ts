// Offline preview of an animation: samples it with the exact animation
// script the phone runs (behaviours/anim.js, in a sandbox), poses a reference
// skeleton with the same maths as the native pose layer (MotionStyle.poseWorld
// incl. leg IK), draws a contact sheet (front and side views over time) and
// critiques it, so the mind can see and refine a move before playing it.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { APP_SOUL, BRAIN_ROOT, readBehavior } from "./store.js";

type V3 = [number, number, number];
type M3 = number[]; // row-major 3x3
type Pose = { joints: Record<string, V3>; root: V3 };
export type Clip = { duration: number; loop?: boolean; plantFeet?: boolean; keys: Array<{ t: number; joints?: Record<string, V3>; root?: V3; ease?: string }> };

const skeleton = JSON.parse(fs.readFileSync(path.join(BRAIN_ROOT, "prompts/skeleton.json"), "utf8")) as {
  names: string[];
  parents: number[];
  rest: V3[];
};
const N = skeleton.names.length;
const idx = (n: string) => skeleton.names.indexOf(n);
const subtree: number[][] = skeleton.names.map(() => []);
skeleton.parents.forEach((_, j) => {
  for (let a = j; a >= 0; a = skeleton.parents[a]) subtree[a].push(j);
});
const legs = ["left", "right"].map((s) => ({ hip: idx(`${s}_hip`), knee: idx(`${s}_knee`), ankle: idx(`${s}_ankle`) }));

// MARK: Maths

const mul = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
const apply = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const T = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const axisAngle = (axis: V3, angle: number): M3 => {
  const [x, y, z] = norm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
};
const euler = (e: V3): M3 => {
  const r = (d: number) => (d * Math.PI) / 180;
  return mul(axisAngle([0, 0, 1], r(e[2])), mul(axisAngle([0, 1, 0], r(e[1])), axisAngle([1, 0, 0], r(e[0]))));
};
const fromTo = (a: V3, b: V3): M3 => {
  const u = norm(a), v = norm(b);
  const c = Math.max(-1, Math.min(1, dot(u, v)));
  const ax = cross(u, v);
  if (len(ax) < 1e-6) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : axisAngle(Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]), Math.PI);
  return axisAngle(ax, Math.acos(c));
};

/// Model-space joint positions/rotations for a pose (mirrors MotionStyle.poseWorld).
export function poseWorld(pose: Pose, plantFeet: boolean): { p: V3[]; r: M3[] } {
  const { parents, rest } = skeleton;
  const p: V3[] = new Array(N), r: M3[] = new Array(N);
  const local: (M3 | null)[] = skeleton.names.map((n) => (pose.joints[n] ? euler(pose.joints[n]) : null));
  for (let j = 0; j < N; j++) {
    const l = local[j] ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const par = parents[j];
    if (par < 0) {
      r[j] = l;
      p[j] = add(rest[j], pose.root);
    } else {
      r[j] = mul(r[par], l);
      p[j] = add(p[par], apply(r[par], sub(rest[j], rest[par])));
    }
  }
  if (plantFeet) {
    const turn = (j: number, rot: M3, c: V3) => {
      for (const k of subtree[j]) {
        p[k] = add(c, apply(rot, sub(p[k], c)));
        r[k] = mul(rot, r[k]);
      }
    };
    for (const leg of legs) {
      if (local[leg.hip] || local[leg.knee]) continue;
      const target = rest[leg.ankle];
      const h = p[leg.hip], k = p[leg.knee], a = p[leg.ankle];
      const l1 = len(sub(k, h)), l2 = len(sub(a, k));
      let d = sub(target, h);
      const dl = Math.min(Math.max(len(d), Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-4);
      d = norm(d);
      const f: V3 = [0, 0, 1];
      let pole = sub(f, scale(d, dot(f, d)));
      if (len(pole) < 1e-3) pole = sub([0, 0, 1], scale(d, d[2]));
      pole = norm(pole);
      const cosA = Math.max(-1, Math.min(1, (l1 * l1 + dl * dl - l2 * l2) / (2 * l1 * dl)));
      const k2 = add(add(h, scale(d, l1 * cosA)), scale(pole, l1 * Math.sqrt(1 - cosA * cosA)));
      const a2 = add(h, scale(d, dl));
      turn(leg.hip, fromTo(sub(k, h), sub(k2, h)), h);
      turn(leg.knee, fromTo(sub(p[leg.ankle], k2), sub(a2, k2)), k2);
      const footRot = local[leg.ankle] ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      turn(leg.ankle, mul(footRot, T(r[leg.ankle])), p[leg.ankle]);
    }
  }
  return { p, r };
}

// MARK: Sampling with the phone's own animation script

function sampler(name: string, clip: Clip): (t: number) => Pose {
  const runtime = fs.readFileSync(path.join(APP_SOUL, "Behaviors", "soul-runtime.js"), "utf8");
  const anim = readBehavior("anim") ?? "";
  const ctx = vm.createContext({ body: { characters: () => [], emit: () => {}, log: () => {} }, Math });
  vm.runInContext(`${runtime}\n${anim}\nanimation(${JSON.stringify(name)}, ${JSON.stringify(clip)});\nthis.__sample = function(t){ return soul.sample(__clips[${JSON.stringify(name)}], t); };`, ctx, { timeout: 2000 });
  return (t) => JSON.parse(JSON.stringify((ctx as any).__sample(t))) as Pose;
}

// MARK: Critique

const MAJOR = ["pelvis", "spine1", "spine2", "spine3", "neck", "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee"];

export type Review = { errors: string[]; notes: string[]; animatedJoints: string[]; frames: { t: number; world: { p: V3[]; r: M3[] } }[] };

export function review(name: string, clip: Clip): Review {
  const sample = sampler(name, clip);
  const plant = clip.plantFeet !== false;
  const steps = Math.max(24, Math.round(clip.duration * 30));
  const frames: Review["frames"] = [];
  const range: Record<string, [V3, V3]> = {};
  let lowest = { y: Infinity, t: 0, joint: "" };
  let fastest = { v: 0, t: 0, joint: "" };
  let prev: Pose | null = null;
  const footIdx = ["left_foot", "right_foot", "left_ankle", "right_ankle"].map(idx);
  const hand = ["left_wrist", "right_wrist"].map(idx);
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * clip.duration;
    const pose = sample(t);
    const world = poseWorld(pose, plant);
    frames.push({ t, world });
    for (const [j, v] of Object.entries(pose.joints)) {
      const rr = (range[j] ??= [[...v] as V3, [...v] as V3]);
      for (let c = 0; c < 3; c++) {
        rr[0][c] = Math.min(rr[0][c], v[c]);
        rr[1][c] = Math.max(rr[1][c], v[c]);
      }
      if (prev?.joints[j]) {
        const speed = Math.max(...v.map((x, c) => Math.abs(x - prev!.joints[j][c]))) / (clip.duration / steps);
        if (speed > fastest.v) fastest = { v: speed, t, joint: j };
      }
    }
    world.p.forEach((q, j) => {
      // Soles sit ~0.07 m under the ankle; other joints shouldn't go under the floor.
      const floor = footIdx.includes(j) ? -0.03 : hand.includes(j) ? -0.02 : 0.02;
      if (q[1] - floor < lowest.y) lowest = { y: q[1] - floor, t, joint: skeleton.names[j] };
    });
    prev = pose;
  }
  const moved = Object.entries(range)
    .filter(([, [lo, hi]]) => Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > 4)
    .map(([j]) => j);
  const rootMoves = clip.keys.some((k) => k.root && Math.max(...k.root.map(Math.abs)) > 0.02);
  const errors: string[] = [];
  const notes: string[] = [];
  if (lowest.y < -0.04)
    errors.push(`${lowest.joint} goes ${Math.round(-lowest.y * 100)} cm under the floor at ${lowest.t.toFixed(2)} s (lift the root or change the leg angles; with plant_feet, legs you don't set stay planted)`);
  const minJoints = clip.duration >= 1.5 ? 10 : 6;
  if (moved.length < minJoints)
    errors.push(`only ${moved.length} joints move (${moved.join(", ") || "none"}); a believable ${clip.duration >= 1.5 ? "move" : "gesture"} needs at least ${minJoints}: the whole body takes part (pelvis and spine shift weight, head leads or follows, both arms balance, hands and fingers stay alive)`);
  const keysTimes = new Set(clip.keys.map((k) => k.t));
  if (keysTimes.size < 4) errors.push(`only ${keysTimes.size} key times; block it with anticipation → main action → settle/hold → recovery (4+), then add breakdowns`);
  // With planted feet the leg IK moves the legs; don't count them as dead.
  const still = MAJOR.filter((j) => !moved.includes(j) && !(plant && /_(hip|knee)$/.test(j)));
  if (still.length) notes.push(`never move: ${still.join(", ")}`);
  if (!rootMoves) notes.push("the root never moves: real moves shift the weight (root x/z) and dip/rise (root y)");
  if (!clip.keys.some((k) => Object.keys(k.joints ?? {}).some((j) => /index|middle|ring|pinky|thumb/.test(j))))
    notes.push("hands are frozen: curl the fingers (index1..3, middle1..3, … about z) in relaxed or expressive shapes");
  const perJointTimes = new Set(clip.keys.map((k) => Object.keys(k.joints ?? {}).sort().join(",")));
  if (perJointTimes.size <= 1 && clip.keys.length > 2)
    notes.push("every key sets the same joints at the same times: offset some joints' keys (head leads, arms trail by 0.1–0.2 s) for overlap and follow-through");
  if (fastest.v > 600) notes.push(`${fastest.joint} moves ${Math.round(fastest.v)}°/s at ${fastest.t.toFixed(2)} s: snappy; add a breakdown key or ease`);
  return { errors, notes, animatedJoints: moved, frames };
}

// MARK: Contact sheet

const BONE_COLOR: Record<string, [number, number, number]> = { left: [90, 160, 255], right: [255, 150, 60], mid: [235, 235, 235] };

function side(name: string): keyof typeof BONE_COLOR {
  return name.startsWith("left_") ? "left" : name.startsWith("right_") ? "right" : "mid";
}

export function contactSheet(rev: Review, cols = 8): Buffer {
  const cellW = 150, cellH = 230, rows = 2;
  const W = cellW * cols, H = cellH * rows;
  const img = Buffer.alloc(W * H * 3, 28);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
  };
  const disc = (cx: number, cy: number, r: number, c: [number, number, number]) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(Math.round(cx + x), Math.round(cy + y), c);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, w: number, c: [number, number, number]) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let i = 0; i <= n; i++) disc(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, w, c);
  };
  const picks = Array.from({ length: cols }, (_, i) => rev.frames[Math.round((i / (cols - 1)) * (rev.frames.length - 1))]);
  const total = rev.frames[rev.frames.length - 1].t || 1;
  picks.forEach((f, ci) => {
    for (let row = 0; row < rows; row++) {
      const ox = ci * cellW, oy = row * cellH;
      const s = 115; // px per metre
      const floorY = oy + cellH - 22;
      // Project: row 0 front view (her left on the right), row 1 side view from her left (she faces left).
      const proj = (q: V3): [number, number] => [ox + cellW / 2 + (row === 0 ? q[0] : -q[2]) * s, floorY - q[1] * s];
      line(ox + 6, floorY, ox + cellW - 6, floorY, 0, [90, 90, 90]);
      // Time bar.
      line(ox + 6, oy + 6, ox + 6 + (cellW - 12) * (f.t / total), oy + 6, 1, [120, 220, 140]);
      skeleton.parents.forEach((par, j) => {
        if (par < 0) return;
        const name = skeleton.names[j];
        const fine = /index|middle|ring|pinky|thumb|eye|jaw/.test(name);
        const [x0, y0] = proj(f.world.p[par]);
        const [x1, y1] = proj(f.world.p[j]);
        line(x0, y0, x1, y1, fine ? 0 : 2, BONE_COLOR[side(name)]);
      });
      const [hx, hy] = proj(f.world.p[idx("head")]);
      disc(hx, hy - 0.09 * s, Math.round(0.1 * s), [235, 235, 235]);
      // Nose, so the facing reads in both views.
      const nose = apply(f.world.r[idx("head")], [0, 0.03, 0.11]);
      const [nx, ny] = proj(add(f.world.p[idx("head")], nose));
      disc(nx, ny - 0.06 * s, 3, [255, 80, 80]);
      f.world.p.forEach((q, j) => {
        if (q[1] < -0.04) {
          const [x, y] = proj(q);
          disc(x, y, 3, [255, 40, 40]);
        }
        void j;
      });
    }
  });
  return png(W, H, img);
}

export function png(w: number, h: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii");
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/// For tests: positions of named joints for a pose (same maths as the phone).
export function debugPose(pose: Pose, plantFeet: boolean, joints: string[]): Record<string, V3> {
  const w = poseWorld(pose, plantFeet);
  return Object.fromEntries(joints.map((n) => [n, w.p[idx(n)].map((v) => Math.round(v * 100) / 100) as V3]));
}
