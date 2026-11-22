// Finding rooms that are really the same room: every saved map's walls and
// furniture (LiDAR scan + camera memory) are matched against every other's,
// trying every turn and shift on the floor. A good match (most obstacles land
// on obstacles) makes the pair a candidate; a helper then compares pictures
// and decides (join_rooms / keep_rooms_apart). Decisions are kept.
import fs from "node:fs";
import path from "node:path";
import * as groups from "./groups.js";
import * as roommap from "./roommap.js";
import { DATA } from "./store.js";
import * as world from "./world.js";

export type Pair = { a: string; b: string; score: number; xf: groups.Xf; cells: [number, number]; at: number; status: "candidate" | "joined" | "apart" | "asked"; why?: string };
const file = () => path.join(DATA, "roomjoin.json");
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function readPairs(): Record<string, Pair> {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; }
}
function writePairs(p: Record<string, Pair>): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(p, null, 1));
}

/// Obstacle (and floor) cell centres of a map, at most n of each.
function points(mapId: string, n = 380): { blocked: Array<[number, number]>; free: Set<string>; total: number } {
  const g = roommap.combined(mapId);
  const blocked: Array<[number, number]> = [];
  const free = new Set<string>();
  if (!g) return { blocked, free, total: 0 };
  for (let r = 0; r < g.rows.length; r++) for (let q = 0; q < g.rows[r].length; q++) {
    const ch = g.rows[r][q];
    const x = g.originX + (q + 0.5) * g.cell, z = g.originZ + (r + 0.5) * g.cell;
    if (ch === "#" || ch === "b") blocked.push([x, z]);
    else if (ch === "." || ch === "f") free.add(`${Math.floor(x / 0.2)},${Math.floor(z / 0.2)}`);
  }
  const total = blocked.length;
  const step = Math.max(1, Math.floor(blocked.length / n));
  return { blocked: blocked.filter((_, i) => i % step === 0), free, total };
}

/// The best way to lay b's map onto a's: score is the share of b's obstacles
/// that land on a's obstacles (minus those landing on a's open floor).
export function align(a: string, b: string): { score: number; xf: groups.Xf; cells: [number, number] } | null {
  const A = points(a), B = points(b);
  if (A.blocked.length < 25 || B.blocked.length < 25) return null;
  const aSet = new Set(A.blocked.map(([x, z]) => `${Math.floor(x / 0.2)},${Math.floor(z / 0.2)}`));
  const near = (x: number, z: number) => {
    const gx = Math.floor(x / 0.2), gz = Math.floor(z / 0.2);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (aSet.has(`${gx + dx},${gz + dz}`)) return true;
    return false;
  };
  const BIN = 0.2, R = 120; // translation votes on 20 cm bins, ±12 m
  const votes = new Int32Array((2 * R + 1) * (2 * R + 1));
  let best = { score: -1, xf: groups.IDENTITY };
  for (let deg = 0; deg < 360; deg += 4) {
    const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    votes.fill(0);
    const rb = B.blocked.map(([x, z]) => [c * x - s * z, s * x + c * z]);
    let top = 0, ti = 0;
    for (const [ax, az] of A.blocked) for (const [bx, bz] of rb) {
      const ix = Math.round((ax - bx) / BIN) + R, iz = Math.round((az - bz) / BIN) + R;
      if (ix < 0 || iz < 0 || ix > 2 * R || iz > 2 * R) continue;
      const k = iz * (2 * R + 1) + ix;
      if (++votes[k] > top) { top = votes[k]; ti = k; }
    }
    const tx = ((ti % (2 * R + 1)) - R) * BIN, tz = (Math.floor(ti / (2 * R + 1)) - R) * BIN;
    // Score this pose properly: obstacles on obstacles, minus obstacles on open floor.
    let hit = 0, clash = 0;
    for (const [x, z] of rb) {
      const px = x + tx, pz = z + tz;
      if (near(px, pz)) hit++;
      else if (A.free.has(`${Math.floor(px / 0.2)},${Math.floor(pz / 0.2)}`)) clash++;
    }
    const score = (hit - clash * 0.5) / rb.length;
    if (score > best.score) best = { score, xf: { theta: th, tx, tz } };
  }
  // Both ways, above chance: B's obstacles land on A's, and A's obstacles
  // (where B's map reaches) land on B's. A small map fitting somewhere inside
  // a big cluttered one by luck fails the second check.
  const ab = agreement(A.blocked, B.blocked, best.xf);
  const ba = agreement(B.blocked, A.blocked, groups.inverse(best.xf));
  const score = ab === null || ba === null ? (ab ?? 0) * 0.5 : Math.min(ab, ba);
  return { score: Math.round(score * 100) / 100, xf: best.xf, cells: [A.total, B.total] };
}

/// Share (above chance) of `from`'s points that, carried by xf, land near
/// `onto`'s points; only points within onto's area count. Null if too few.
function agreement(onto: Array<[number, number]>, from: Array<[number, number]>, xf: groups.Xf): number | null {
  const cellKey = (x: number, z: number) => `${Math.floor(x / 0.2)},${Math.floor(z / 0.2)}`;
  const set = new Set(onto.map(([x, z]) => cellKey(x, z)));
  const near = (x: number, z: number) => {
    const gx = Math.floor(x / 0.2), gz = Math.floor(z / 0.2);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (set.has(`${gx + dx},${gz + dz}`)) return true;
    return false;
  };
  const xs = onto.map((p) => p[0]), zs = onto.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs) - 0.3, Math.max(...xs) + 0.3, Math.min(...zs) - 0.3, Math.max(...zs) + 0.3];
  let n = 0, hit = 0;
  for (const p of from) {
    const q = groups.apply(xf, { x: p[0], z: p[1] });
    if (q.x < x0 || q.x > x1 || q.z < z0 || q.z > z1) continue;
    n++; if (near(q.x, q.z)) hit++;
  }
  if (n < 15) return null;
  let tries = 0, lucky = 0;
  for (let x = x0; x <= x1; x += 0.2) for (let z = z0; z <= z1; z += 0.2) { tries++; if (near(x, z)) lucky++; }
  const chance = tries ? lucky / tries : 0;
  return Math.max(0, (hit / n - chance) / Math.max(0.05, 1 - chance));
}

/// Re-scores every pair of rooms that changed (new scans or camera memory)
/// and returns the pairs worth a helper's look.
export function refresh(maxNew = 3): Pair[] {
  let budget = maxNew;
  const pairs = readPairs();
  const rooms = world.readRooms();
  const ids = [...new Set([...roommap.ids(), ...Object.keys(rooms)])].filter((id) => groups.isCanonical(id));
  const size = new Map(ids.map((id) => [id, points(id, 1).total]));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j], k = key(a, b), old = pairs[k];
    if (old && (old.status === "joined" || old.status === "apart")) continue;
    const sa = size.get(a)!, sb = size.get(b)!;
    if (old && Math.abs(old.cells[0] - sa) < sa * 0.2 && Math.abs(old.cells[1] - sb) < sb * 0.2) continue;
    if (budget-- <= 0) continue; // the rest next time (each comparison takes a moment)
    // Older map is "a" (the room keeps its first map).
    const [first, second] = (rooms[a]?.firstSeen ?? 0) <= (rooms[b]?.firstSeen ?? 0) ? [a, b] : [b, a];
    const r = align(first, second);
    // Maps too small to compare: only a same name makes them worth a look.
    pairs[k] = r
      ? { a: first, b: second, score: r.score, xf: r.xf, cells: r.cells, at: Date.now(), status: old?.status === "asked" ? "asked" : "candidate" }
      : { a: first, b: second, score: -1, xf: groups.IDENTITY, cells: [sa, sb], at: Date.now(), status: old?.status === "asked" ? "asked" : "candidate" };
  }
  writePairs(pairs);
  const named = (id: string) => (rooms[id]?.name ?? "").trim().toLowerCase();
  const now = Date.now();
  return Object.values(pairs).filter((p) => (p.status === "candidate" || (p.status === "asked" && now - p.at > 2 * 3_600_000)) && groups.isCanonical(p.a) && groups.isCanonical(p.b)
    && (p.score >= 0.35 || ((p.score >= 0.2 || p.score < 0) && named(p.a) && named(p.a) === named(p.b))))
    .sort((x, y) => y.score - x.score);
}

export function mark(a: string, b: string, status: Pair["status"], why?: string): Pair | undefined {
  const pairs = readPairs();
  const p = pairs[key(a, b)];
  if (!p) return undefined;
  p.status = status;
  if (why) p.why = why;
  writePairs(pairs);
  return p;
}

export function pair(a: string, b: string): Pair | undefined {
  return readPairs()[key(a, b)];
}

/// Joins two rooms (the helper confirmed it): b's room into a's, using the
/// alignment found (or none, if the maps don't line up well enough).
export function joinRooms(a: string, b: string, why: string): { joined: boolean; aligned: boolean; score?: number; text: string } {
  const ca = groups.canonical(a).id, cb = groups.canonical(b).id;
  if (ca === cb) return { joined: false, aligned: true, text: "They are already the same room." };
  let p = pair(ca, cb);
  if (!p) { const r = align(ca, cb); if (r) p = { a: ca, b: cb, ...r, at: Date.now(), status: "candidate" }; }
  // The pair's xf carries p.b onto p.a.
  const aligned = !!p && p.score >= 0.45;
  const [keep, into] = p && p.a === cb ? [cb, ca] : [ca, cb];
  groups.join(keep, into, aligned ? p!.xf : null, why, p?.score);
  if (p) mark(p.a, p.b, "joined", why);
  else { const pairs = readPairs(); pairs[key(ca, cb)] = { a: keep, b: into, score: 0, xf: groups.IDENTITY, cells: [0, 0], at: Date.now(), status: "joined", why }; writePairs(pairs); }
  // The room keeps its name (the first one's, else the other's).
  const rooms = world.readRooms();
  if (!rooms[keep]?.name && rooms[into]?.name) { rooms[keep] = { ...(rooms[keep] ?? { firstSeen: Date.now(), lastSeen: Date.now(), visits: 0 }), name: rooms[into].name }; world.writeRooms(rooms); }
  return { joined: true, aligned, score: p?.score, text: aligned
    ? `Joined: map ${into.slice(0, 8)} is now part of ${rooms[keep]?.name || keep.slice(0, 8)} (maps line up, score ${p!.score}); things and places are shared.`
    : `Joined as the same room, but the maps don't line up well enough (score ${p?.score ?? "n/a"}) to share positions; they're grouped by name only.` };
}
