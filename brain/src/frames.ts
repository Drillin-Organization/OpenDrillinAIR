// Camera memory: the phone sends a plain camera frame every second or so
// (Settings › Camera memory) with where the camera was, its lens and a small
// depth image. They're kept here on the computer so the mind can look back
// at what happened (recall_frames), find things in old pictures
// (note_from_frame), fill in the room map (roommap.ts) and study the place
// while dreaming.
//
// Layout: frames/<day>/<t>.jpg, <t>.depth (UInt16 mm, sensor orientation),
// index.jsonl (one FrameMeta per line). Everything from the last
// BRAIN_FRAMES_FULL_MIN minutes (30) is kept; after that only key frames (the
// camera moved, turned, or a minute passed); the oldest go first when the
// store passes BRAIN_FRAMES_GB (2).
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";

export type FrameMeta = {
  t: number;
  day: string;
  mapId: string | null;
  /// Connection the frame came from (unsaved rooms are adopted per session).
  session: number;
  /// Camera transform, column-major 4×4.
  pose: number[];
  /// fx, fy, cx, cy in sensor pixels (landscape).
  intrinsics: number[];
  sensor: [number, number];
  depth: { w: number; h: number } | null;
  /// Without LiDAR: [u, v, x, y, z] points found at capture time.
  points?: number[][];
  user?: Record<string, number>;
  characters?: Array<{ id: string; name: string; x: number; z: number }>;
  key: boolean;
  bytes: number;
  studied?: boolean;
  fused?: boolean;
};

export const DIR = path.join(DATA, "frames");
const FULL_MS = Number(process.env.BRAIN_FRAMES_FULL_MIN ?? 30) * 60_000;
const CAP_BYTES = Number(process.env.BRAIN_FRAMES_GB ?? 2) * 1024 ** 3;

let index: FrameMeta[] = [];
let loaded = false;
const dirtyDays = new Set<string>();

function dayOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const fileOf = (m: FrameMeta, ext: "jpg" | "depth") => path.join(DIR, m.day, `${m.t}.${ext}`);

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(DIR)) return;
  for (const day of fs.readdirSync(DIR).sort()) {
    const f = path.join(DIR, day, "index.jsonl");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { index.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
  }
  index.sort((a, b) => a.t - b.t);
}

function saveDays(): void {
  for (const day of dirtyDays) {
    const rows = index.filter((m) => m.day === day);
    const f = path.join(DIR, day, "index.jsonl");
    if (!rows.length) { fs.rmSync(path.join(DIR, day), { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rows.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }
  dirtyDays.clear();
}

export function all(): FrameMeta[] {
  load();
  return index;
}

export function get(id: string | number): FrameMeta | undefined {
  load();
  const t = Number(String(id).replace(/^f/, ""));
  return index.find((m) => m.t === t);
}

/// Where the camera was and which way it looked (yaw: 0 = +z, like the scene).
export function camera(m: FrameMeta): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const p = m.pose;
  const f = [-p[8], -p[9], -p[10]];
  return { x: p[12], y: p[13], z: p[14], yaw: Math.atan2(f[0], f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
}

function isKey(m: Omit<FrameMeta, "key">, last: FrameMeta | undefined): boolean {
  if (!last || last.mapId !== m.mapId || last.session !== m.session) return true;
  if (m.t - last.t > 60_000) return true;
  const a = camera(m as FrameMeta), b = camera(last);
  if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.3) return true;
  const fa = [-m.pose[8], -m.pose[9], -m.pose[10]], fb = [-last.pose[8], -last.pose[9], -last.pose[10]];
  const dot = fa[0] * fb[0] + fa[1] * fb[1] + fa[2] * fb[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) > (15 * Math.PI) / 180;
}

let lastKey: FrameMeta | undefined;

/// Stores one frame from the phone; returns its meta (null if unusable).
export function add(data: Record<string, any>, session: number): FrameMeta | null {
  load();
  if (typeof data.jpeg !== "string" || !Array.isArray(data.pose) || data.pose.length !== 16) return null;
  const t = Math.round(Number(data.t) || Date.now());
  const jpg = Buffer.from(data.jpeg, "base64");
  const depthBuf = data.depth?.mm ? Buffer.from(String(data.depth.mm), "base64") : null;
  const base: Omit<FrameMeta, "key"> = {
    t, day: dayOf(t), mapId: (data.mapId as string) || null, session,
    pose: (data.pose as number[]).map(Number),
    intrinsics: (data.intrinsics as number[] ?? []).map(Number),
    sensor: (data.sensor as [number, number]) ?? [1920, 1440],
    depth: depthBuf ? { w: Number(data.depth.w), h: Number(data.depth.h) } : null,
    points: Array.isArray(data.points) && data.points.length ? data.points : undefined,
    user: data.user, characters: data.characters,
    bytes: jpg.length + (depthBuf?.length ?? 0),
  };
  const meta: FrameMeta = { ...base, key: isKey(base, lastKey) };
  if (meta.key) lastKey = meta;
  fs.mkdirSync(path.join(DIR, meta.day), { recursive: true });
  fs.writeFileSync(fileOf(meta, "jpg"), jpg);
  if (depthBuf) fs.writeFileSync(fileOf(meta, "depth"), depthBuf);
  fs.appendFileSync(path.join(DIR, meta.day, "index.jsonl"), JSON.stringify(meta) + "\n");
  index.push(meta);
  return meta;
}

function drop(m: FrameMeta): void {
  fs.rmSync(fileOf(m, "jpg"), { force: true });
  fs.rmSync(fileOf(m, "depth"), { force: true });
  dirtyDays.add(m.day);
}

/// Keeps everything recent, only key frames after that, and the store under its cap.
export function thin(now = Date.now()): { removed: number; frames: number; bytes: number } {
  load();
  let removed = 0;
  index = index.filter((m) => {
    if (m.key || now - m.t < FULL_MS) return true;
    drop(m); removed++;
    return false;
  });
  let bytes = index.reduce((s, m) => s + m.bytes, 0);
  while (bytes > CAP_BYTES && index.length) {
    const m = index.shift()!;
    bytes -= m.bytes; drop(m); removed++;
  }
  saveDays();
  return { removed, frames: index.length, bytes };
}

/// The room was saved: frames of this connection taken before it had a map
/// id belong to it (same coordinates). Returns the adopted frames.
export function adopt(mapId: string, session: number): FrameMeta[] {
  load();
  const got = index.filter((m) => !m.mapId && m.session === session);
  for (const m of got) { m.mapId = mapId; dirtyDays.add(m.day); }
  saveDays();
  return got;
}

export function mark(ms: FrameMeta[], field: "studied" | "fused"): void {
  for (const m of ms) { m[field] = true; dirtyDays.add(m.day); }
  saveDays();
}

export function jpeg(m: FrameMeta): string | null {
  try { return fs.readFileSync(fileOf(m, "jpg")).toString("base64"); } catch { return null; }
}

export function depthGrid(m: FrameMeta): Uint16Array | null {
  return depthOf(m);
}

function depthOf(m: FrameMeta): Uint16Array | null {
  if (!m.depth) return null;
  try {
    const b = fs.readFileSync(fileOf(m, "depth"));
    return new Uint16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  } catch { return null; }
}

/// Camera-space point (sensor pixel, depth in metres) → world.
function toWorld(m: FrameMeta, sx: number, sy: number, d: number): [number, number, number] {
  const [fx, fy, cx, cy] = m.intrinsics;
  const c = [((sx - cx) / fx) * d, (-(sy - cy) / fy) * d, -d];
  const p = m.pose;
  return [
    p[0] * c[0] + p[4] * c[1] + p[8] * c[2] + p[12],
    p[1] * c[0] + p[5] * c[1] + p[9] * c[2] + p[13],
    p[2] * c[0] + p[6] * c[1] + p[10] * c[2] + p[14],
  ];
}

/// Every point the frame saw, in the room: from its depth image, or the
/// points found by rays at capture time.
export function worldPoints(m: FrameMeta): Array<[number, number, number]> {
  const depth = depthOf(m);
  if (depth && m.depth) {
    const { w, h } = m.depth, [W, H] = m.sensor;
    const out: Array<[number, number, number]> = [];
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const mm = depth[gy * w + gx];
        if (mm) out.push(toWorld(m, ((gx + 0.5) * W) / w, ((gy + 0.5) * H) / h, mm / 1000));
      }
    }
    return out;
  }
  return (m.points ?? []).map((p) => [p[2], p[3], p[4]]);
}

/// A point in the stored (portrait) picture, u from the left and v from the
/// top (0–1), found in the room from the frame's own depth. Null when
/// nothing measured is close enough.
export function locate(m: FrameMeta, u: number, v: number): { x: number; y: number; z: number } | null {
  const [W, H] = m.sensor;
  // Portrait picture (turned 90° clockwise) → sensor.
  const sx = v * W, sy = (1 - u) * H;
  const depth = depthOf(m);
  if (depth && m.depth) {
    const { w, h } = m.depth;
    const gx0 = Math.min(w - 1, Math.floor((sx / W) * w)), gy0 = Math.min(h - 1, Math.floor((sy / H) * h));
    for (let r = 0; r <= 2; r++) {
      let best: number | null = null;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const gx = gx0 + dx, gy = gy0 + dy;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const mm = depth[gy * w + gx];
        if (mm && (best === null || mm < best)) best = mm;
      }
      if (best !== null) {
        const [x, y, z] = toWorld(m, sx, sy, best / 1000);
        return { x, y, z };
      }
    }
    return null;
  }
  let near: number[] | null = null, nd = 0.09;
  for (const p of m.points ?? []) {
    const d = Math.hypot(p[0] - u, p[1] - v);
    if (d < nd) { nd = d; near = p; }
  }
  return near ? { x: near[2], y: near[3], z: near[4] } : null;
}

/// Spread picks: `n` frames from a list, evenly over it.
export function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i / (n - 1)) * (list.length - 1))]);
}

/// Varied picks for study: far apart in place and direction.
export function varied(list: FrameMeta[], n: number): FrameMeta[] {
  if (list.length <= n) return list;
  const picked: FrameMeta[] = [list[0]];
  const dist = (a: FrameMeta, b: FrameMeta) => {
    const ca = camera(a), cb = camera(b);
    let dy = Math.abs(ca.yaw - cb.yaw); if (dy > Math.PI) dy = 2 * Math.PI - dy;
    return Math.hypot(ca.x - cb.x, ca.z - cb.z) + dy * 1.5;
  };
  while (picked.length < n) {
    let best = list[0], bd = -1;
    for (const m of list) {
      if (picked.includes(m)) continue;
      const d = Math.min(...picked.map((p) => dist(m, p)));
      if (d > bd) { bd = d; best = m; }
    }
    picked.push(best);
  }
  return picked.sort((a, b) => a.t - b.t);
}

/// For tests: forget the in-memory index.
export function reset(): void {
  index = []; loaded = false; lastKey = undefined; dirtyDays.clear();
}
