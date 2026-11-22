// Instant new moves: built from the recorded library (motion capture) in
// milliseconds instead of a helper writing an animation. A move is a
// sequence of library clips (each can be cut, sped up, mirrored, repeated),
// crossfaded together, optionally with another move's upper body layered on
// top (wave while walking, clap while dancing). Saved in data/moves and sent
// to the phone, where it plays like any library move.
import fs from "node:fs";
import path from "node:path";
import { APP_SOUL, DATA } from "./store.js";

const LIB = path.join(APP_SOUL, "Moves");
const DIR = path.join(DATA, "moves");

type Index = { fps: number; joints: string[]; values: number; moves: Array<{ name: string; desc: string; tags: string[]; frames: number; offset: number }> };
let lib: { index: Index; bin: Buffer; byName: Map<string, Index["moves"][number]> } | null = null;
function library() {
  if (!lib) {
    const index = JSON.parse(fs.readFileSync(path.join(LIB, "moves.json"), "utf8")) as Index;
    lib = { index, bin: fs.readFileSync(path.join(LIB, "moves.bin")), byName: new Map(index.moves.map((m) => [m.name, m])) };
  }
  return lib;
}

export type Composed = { name: string; desc: string; tags: string[]; fps: number; frames: number; data: string };

const UPPER = new Set(["spine1", "spine2", "spine3", "neck", "head", "left_collar", "left_shoulder", "left_elbow", "left_wrist", "right_collar", "right_shoulder", "right_elbow", "right_wrist"]);

/// One frame: [rootX, rootY, rootZ (mm), then rx, ry, rz per joint (centidegrees)].
function frameOf(name: string, i: number): number[] {
  const composedMove = readComposed(name);
  const { index, bin, byName } = library();
  if (composedMove) {
    const raw = Buffer.from(composedMove.data, "base64");
    const at = Math.max(0, Math.min(composedMove.frames - 1, i)) * index.values * 2;
    return Array.from({ length: index.values }, (_, k) => raw.readInt16LE(at + k * 2));
  }
  const m = byName.get(name)!;
  const at = (m.offset + Math.max(0, Math.min(m.frames - 1, i))) * index.values * 2;
  return Array.from({ length: index.values }, (_, k) => bin.readInt16LE(at + k * 2));
}
function framesOf(name: string): number {
  return readComposed(name)?.frames ?? library().byName.get(name)?.frames ?? 0;
}
export function known(name: string): boolean {
  return library().byName.has(name) || !!readComposed(name);
}

/// Angle-aware mix of two frames (centidegrees wrap at ±18000).
function mix(a: number[], b: number[], t: number): number[] {
  return a.map((v, k) => {
    if (k < 3) return v + (b[k] - v) * t;
    let d = b[k] - v;
    while (d > 18000) d -= 36000;
    while (d < -18000) d += 36000;
    return v + d * t;
  });
}

function mirror(f: number[], joints: string[]): number[] {
  const out = [...f];
  out[0] = -f[0];
  joints.forEach((j, k) => {
    const other = j.startsWith("left_") ? `right_${j.slice(5)}` : j.startsWith("right_") ? `left_${j.slice(6)}` : j;
    const src = joints.indexOf(other);
    out[3 + k * 3] = f[3 + src * 3];
    out[4 + k * 3] = -f[4 + src * 3];
    out[5 + k * 3] = -f[5 + src * 3];
  });
  return out;
}

export type Segment = { move: string; from?: number; to?: number; speed?: number; mirror?: boolean; times?: number };

export function compose(name: string, desc: string, segments: Segment[], upper?: { move: string; mirror?: boolean; speed?: number }, tags: string[] = []): Composed {
  const { index } = library();
  const fps = index.fps, joints = index.joints;
  for (const s of [...segments, ...(upper ? [upper] : [])]) if (!known(s.move)) throw new Error(`no move "${s.move}" in the library (find_moves)`);
  let out: number[][] = [];
  const fade = Math.round(0.3 * fps);
  for (const s of segments) {
    const total = framesOf(s.move);
    const a = Math.max(0, Math.round((s.from ?? 0) * fps)), b = Math.min(total - 1, s.to !== undefined ? Math.round(s.to * fps) : total - 1);
    if (b <= a) throw new Error(`${s.move}: empty range`);
    const speed = Math.max(0.25, Math.min(4, s.speed ?? 1));
    let clip: number[][] = [];
    for (let r = 0; r < Math.max(1, Math.min(20, s.times ?? 1)); r++) {
      for (let t = a; t <= b; t += speed) {
        const i = Math.floor(t);
        const f = mix(frameOf(s.move, i), frameOf(s.move, Math.min(b, i + 1)), t - i);
        clip.push(s.mirror ? mirror(f, joints) : f);
      }
    }
    if (out.length) {
      // Continue from where the last clip ended (no jump in place), then crossfade.
      const last = out[out.length - 1], first = clip[0];
      const dx = last[0] - first[0], dz = last[2] - first[2];
      clip = clip.map((f) => { const g = [...f]; g[0] += dx; g[2] += dz; return g; });
      const n = Math.min(fade, out.length, clip.length);
      for (let k = 0; k < n; k++) out[out.length - n + k] = mix(out[out.length - n + k], clip[k], (k + 1) / (n + 1));
      clip = clip.slice(n);
    }
    out = out.concat(clip);
  }
  if (upper) {
    const total = framesOf(upper.move), speed = upper.speed ?? 1;
    out = out.map((f, i) => {
      const t = (i * speed) % Math.max(1, total - 1), k = Math.floor(t);
      let u = mix(frameOf(upper.move, k), frameOf(upper.move, Math.min(total - 1, k + 1)), t - k);
      if (upper.mirror) u = mirror(u, joints);
      const g = [...f];
      joints.forEach((j, n) => { if (UPPER.has(j)) for (let c = 0; c < 3; c++) g[3 + n * 3 + c] = u[3 + n * 3 + c]; });
      return g;
    });
  }
  if (out.length > fps * 60) out = out.slice(0, fps * 60);
  const buf = Buffer.alloc(out.length * index.values * 2);
  out.forEach((f, i) => f.forEach((v, k) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), (i * index.values + k) * 2)));
  const move: Composed = { name, desc, tags: tags.length ? tags : ["made"], fps, frames: out.length, data: buf.toString("base64") };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(move));
  return move;
}

export function readComposed(name: string): Composed | null {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${name.replace(/[^a-z0-9_]/g, "")}.json`), "utf8")); } catch { return null; }
}

export function allComposed(): Composed[] {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))); } catch { return []; }
}
