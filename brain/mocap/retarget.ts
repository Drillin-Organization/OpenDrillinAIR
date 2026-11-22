// CMU motion capture (ASF skeleton + AMC motion) → the characters' skeleton
// (SMPL-X joint names, rest T-pose, local Euler degrees R = Rz·Ry·Rx, the
// format PoseComponent / poseWorld use). Each source bone's rotation from its
// rest orientation is applied to the matching target bone, after a one-off
// correction that lines the target's rest bone up with the source's (CMU's
// rest legs are splayed ~20°, the characters' are straight).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type V3 = [number, number, number];
export type M3 = number[]; // row-major 3x3

// MARK: Maths

export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mul = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
export const T = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export const apply = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scl(a, 1 / (len(a) || 1));
const axisAngle = (axis: V3, angle: number): M3 => {
  const [x, y, z] = norm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
};
const rx = (d: number) => axisAngle([1, 0, 0], (d * Math.PI) / 180);
const ry = (d: number) => axisAngle([0, 1, 0], (d * Math.PI) / 180);
const rz = (d: number) => axisAngle([0, 0, 1], (d * Math.PI) / 180);
export const fromTo = (a: V3, b: V3): M3 => {
  const u = norm(a), v = norm(b);
  const c = Math.max(-1, Math.min(1, dot(u, v)));
  const ax = cross(u, v);
  if (len(ax) < 1e-6) return c > 0 ? I3 : axisAngle(Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]), Math.PI);
  return axisAngle(ax, Math.acos(c));
};
/// R = Rz(c)·Ry(b)·Rx(a) → [a, b, c] degrees.
export function toEuler(m: M3): V3 {
  const d = 180 / Math.PI;
  const sb = Math.max(-1, Math.min(1, -m[6]));
  const b = Math.asin(sb);
  if (Math.abs(sb) < 0.9999) return [Math.atan2(m[7], m[8]) * d, b * d, Math.atan2(m[3], m[0]) * d];
  return [Math.atan2(-m[5], m[4]) * d, b * d, 0];
}
export const euler = (e: V3): M3 => mul(rz(e[2]), mul(ry(e[1]), rx(e[0])));

// MARK: ASF / AMC

type Bone = { name: string; dir: V3; length: number; axis: M3; dofs: string[]; parent: string | null; children: string[] };
export type Asf = { bones: Map<string, Bone>; rootOrder: string[]; rootAxis: M3; scale: number };

function axisMatrix(angles: V3, order: string): M3 {
  // ASF "axis X Y Z XYZ": rotate about X first, then Y, then Z → C = Rz·Ry·Rx.
  const m: Record<string, M3> = { X: rx(angles[0]), Y: ry(angles[1]), Z: rz(angles[2]) };
  return order.split("").reverse().reduce((acc, a) => mul(acc, m[a]), I3);
}

export function parseAsf(text: string): Asf {
  const bones = new Map<string, Bone>();
  let rootOrder: string[] = [], rootAxis: M3 = I3, scale = 1;
  const sections = text.split(/^:/m);
  for (const sec of sections) {
    const head = sec.split(/\s+/)[0];
    if (head === "units") {
      const m = /length\s+([\d.]+)/.exec(sec);
      if (m) scale = Number(m[1]);
    } else if (head === "root") {
      const o = /order\s+([^\n]+)/.exec(sec);
      rootOrder = o ? o[1].trim().split(/\s+/) : ["TX", "TY", "TZ", "RX", "RY", "RZ"];
      const a = /axis\s+(\w+)/.exec(sec);
      rootAxis = I3; // CMU roots use axis XYZ with zero orientation
      void a;
    } else if (head === "bonedata") {
      for (const block of sec.split(/\bbegin\b/).slice(1)) {
        const body = block.split(/\bend\b/)[0];
        const name = /name\s+(\S+)/.exec(body)![1];
        const dir = /direction\s+(\S+)\s+(\S+)\s+(\S+)/.exec(body)!.slice(1, 4).map(Number) as V3;
        const length = Number(/length\s+(\S+)/.exec(body)![1]);
        const ax = /axis\s+(\S+)\s+(\S+)\s+(\S+)\s+(\w+)/.exec(body)!;
        const dofM = /dof\s+([^\n]+)/.exec(body);
        bones.set(name, { name, dir, length, axis: axisMatrix([+ax[1], +ax[2], +ax[3]], ax[4]), dofs: dofM ? dofM[1].trim().split(/\s+/) : [], parent: null, children: [] });
      }
    } else if (head === "hierarchy") {
      const body = sec.split(/\bbegin\b/)[1]?.split(/\bend\b/)[0] ?? "";
      for (const line of body.split("\n")) {
        const parts = line.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) continue;
        const [p, ...kids] = parts;
        for (const k of kids) {
          const b = bones.get(k);
          if (b) b.parent = p;
          const pb = bones.get(p);
          if (pb) pb.children.push(k);
        }
      }
    }
  }
  return { bones, rootOrder, rootAxis, scale };
}

export type AmcFrame = Map<string, number[]>;
export function parseAmc(text: string): AmcFrame[] {
  const frames: AmcFrame[] = [];
  let cur: AmcFrame | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(":")) continue;
    if (/^\d+$/.test(line)) { cur = new Map(); frames.push(cur); continue; }
    if (!cur) continue;
    const [name, ...vals] = line.split(/\s+/);
    cur.set(name, vals.map(Number));
  }
  return frames;
}

/// World rotation and start position of every source bone for one frame
/// (positions in metres, y up, the subject's left = +x, forward = +z).
export function fk(asf: Asf, frame: AmcFrame): { rot: Map<string, M3>; start: Map<string, V3>; end: Map<string, V3>; rootPos: V3; rootRot: M3 } {
  const unit = (1 / asf.scale) * 0.0254; // ASF units → metres
  const rv = frame.get("root") ?? [0, 0, 0, 0, 0, 0];
  const val = (k: string) => rv[asf.rootOrder.indexOf(k)] ?? 0;
  const rootPos: V3 = [val("TX") * unit, val("TY") * unit, val("TZ") * unit];
  // Root rotation, order XYZ: R = Rz·Ry·Rx applied as X first.
  const rootRot = mul(rz(val("RZ")), mul(ry(val("RY")), rx(val("RX"))));
  const rot = new Map<string, M3>(), start = new Map<string, V3>(), end = new Map<string, V3>();
  const visit = (name: string, parentRot: M3, at: V3) => {
    const b = asf.bones.get(name)!;
    const d = frame.get(name) ?? [];
    // CMU convention: L = C · M · C⁻¹ with M = Rz·Ry·Rx for "dof rx ry rz".
    const M = reorder(b.dofs, d);
    const L = mul(b.axis, mul(M, T(b.axis)));
    const R = mul(parentRot, L);
    rot.set(name, R);
    start.set(name, at);
    const e = add(at, apply(R, scl(b.dir, b.length * unit)));
    end.set(name, e);
    for (const c of b.children) visit(c, R, e);
  };
  const root = asf.bones.get("root") ? "root" : null;
  for (const [name, b] of asf.bones) if (b.parent === "root" || (!b.parent && name !== root)) visit(name, rootRot, rootPos);
  return { rot, start, end, rootPos, rootRot };
}

function reorder(dofs: string[], vals: number[]): M3 {
  const get = (k: string) => { const i = dofs.indexOf(k); return i < 0 ? 0 : vals[i] ?? 0; };
  return mul(rz(get("rz")), mul(ry(get("ry")), rx(get("rx"))));
}

// MARK: Target skeleton

const skeleton = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../prompts/skeleton.json"), "utf8")) as { names: string[]; parents: number[]; rest: V3[] };
export const TARGET = skeleton;

/// Target joint ← source bone, and the target bone used for direction.
const MAP: Array<{ joint: string; bone: string; child: string | V3 }> = [
  { joint: "left_hip", bone: "lfemur", child: "left_knee" },
  { joint: "left_knee", bone: "ltibia", child: "left_ankle" },
  { joint: "left_ankle", bone: "lfoot", child: "left_foot" },
  { joint: "right_hip", bone: "rfemur", child: "right_knee" },
  { joint: "right_knee", bone: "rtibia", child: "right_ankle" },
  { joint: "right_ankle", bone: "rfoot", child: "right_foot" },
  { joint: "spine1", bone: "lowerback", child: "spine2" },
  { joint: "spine2", bone: "upperback", child: "spine3" },
  { joint: "spine3", bone: "thorax", child: "neck" },
  { joint: "neck", bone: "upperneck", child: "head" },
  { joint: "head", bone: "head", child: [0, 1, 0] },
  { joint: "left_collar", bone: "lclavicle", child: "left_shoulder" },
  { joint: "left_shoulder", bone: "lhumerus", child: "left_elbow" },
  { joint: "left_elbow", bone: "lradius", child: "left_wrist" },
  { joint: "left_wrist", bone: "lhand", child: [1, 0, 0] },
  { joint: "right_collar", bone: "rclavicle", child: "right_shoulder" },
  { joint: "right_shoulder", bone: "rhumerus", child: "right_elbow" },
  { joint: "right_elbow", bone: "rradius", child: "right_wrist" },
  { joint: "right_wrist", bone: "rhand", child: [-1, 0, 0] },
];
export const BODY_JOINTS = ["pelvis", ...MAP.map((m) => m.joint)];

const tIdx = (n: string) => skeleton.names.indexOf(n);

export type Pose = { joints: Record<string, V3>; root: V3 };

/// Retargets every frame (already resampled) to the characters' skeleton.
export function retarget(asf: Asf, frames: AmcFrame[]): Pose[] {
  // Rest corrections: target rest bone direction → source rest bone direction.
  const corr = new Map<string, M3>();
  for (const m of MAP) {
    const b = asf.bones.get(m.bone);
    if (!b) continue;
    const tj = tIdx(m.joint);
    const tDir: V3 = typeof m.child === "string" ? sub(skeleton.rest[tIdx(m.child)], skeleton.rest[tj]) : m.child;
    corr.set(m.joint, fromTo(tDir, b.dir));
  }
  // Target leg length vs source, for root height.
  const tLeg = skeleton.rest[tIdx("pelvis")][1] - skeleton.rest[tIdx("left_ankle")][1];
  const zero = new Map<string, number[]>();
  const restFk = fk(asf, zero);
  const sLeg = (restFk.rootPos[1] - (restFk.end.get("ltibia")?.[1] ?? 0)) || 1;
  const ratio = tLeg / Math.abs(sLeg);

  // Facing: turn the clip so the subject starts facing +z.
  const f0 = fk(asf, frames[0]);
  const fwd = apply(f0.rootRot, [0, 0, 1]);
  const yaw0 = Math.atan2(fwd[0], fwd[2]);
  const unYaw = axisAngle([0, 1, 0], -yaw0);

  const out: Pose[] = [];
  const raw: Array<{ g: Map<string, M3>; root: V3; footY: number }> = [];
  for (const fr of frames) {
    const s = fk(asf, fr);
    const g = new Map<string, M3>();
    g.set("pelvis", mul(unYaw, s.rootRot));
    for (const m of MAP) {
      const R = s.rot.get(m.bone);
      const C = corr.get(m.joint);
      if (R && C) g.set(m.joint, mul(unYaw, mul(R, C)));
    }
    const footY = Math.min(...["lfoot", "ltoes", "rfoot", "rtoes"].map((b) => s.end.get(b)?.[1] ?? Infinity));
    raw.push({ g, root: apply(unYaw, s.rootPos), footY });
  }
  // Ground: the lowest the feet get in the clip is the floor.
  const floor = Math.min(...raw.map((r) => r.footY));
  const restPelvisY = skeleton.rest[tIdx("pelvis")][1];
  const restFootY = Math.min(skeleton.rest[tIdx("left_foot")][1], skeleton.rest[tIdx("right_foot")][1]);
  for (const r of raw) {
    const joints: Record<string, V3> = {};
    for (const name of BODY_JOINTS) {
      const G = r.g.get(name);
      if (!G) continue;
      const p = skeleton.parents[tIdx(name)];
      const P = p >= 0 ? r.g.get(skeleton.names[p]) ?? I3 : I3;
      joints[name] = toEuler(mul(T(P), G)).map((v) => Math.round(v * 100) / 100) as V3;
    }
    // Height: pelvis height above the floor, scaled to her legs.
    const h = (r.root[1] - floor) * ratio;
    out.push({ joints, root: [r.root[0] * ratio, h - (restPelvisY - restFootY), r.root[2] * ratio] });
  }
  return out;
}

/// Resamples AMC frames (fps in) to fps out by picking the nearest frame.
export function resample<T>(frames: T[], fpsIn: number, fpsOut: number): T[] {
  const n = Math.floor(((frames.length - 1) * fpsOut) / fpsIn) + 1;
  return Array.from({ length: n }, (_, i) => frames[Math.min(frames.length - 1, Math.round((i * fpsIn) / fpsOut))]);
}
