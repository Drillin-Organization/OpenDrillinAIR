// Rooms that are really one room. The phone sometimes saves the same room as
// several maps (when it fails to recognise it), each with its own coordinates.
// Once a helper confirms two maps are the same room, they're joined: the
// later map points at the first ("canonical") one with the transform that
// carries its coordinates onto it, and things and places are shared across
// the group (each read in the coordinates of the map the phone is in).
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";

/// A 2D rigid transform on the floor: x' = c·x − s·z + tx, z' = s·x + c·z + tz.
export type Xf = { theta: number; tx: number; tz: number };
export type Join = { canon: string; xf: Xf | null; at: number; why: string; score?: number };

export const IDENTITY: Xf = { theta: 0, tx: 0, tz: 0 };
const file = () => path.join(DATA, "roomgroups.json");

export function apply(xf: Xf, p: { x: number; z: number }): { x: number; z: number } {
  const c = Math.cos(xf.theta), s = Math.sin(xf.theta);
  return { x: c * p.x - s * p.z + xf.tx, z: s * p.x + c * p.z + xf.tz };
}
/// A heading (yaw: 0 = +z, like the scene) carried through the transform.
export function applyYaw(xf: Xf, yaw: number): number {
  const c = Math.cos(xf.theta), s = Math.sin(xf.theta);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return Math.atan2(c * fx - s * fz, s * fx + c * fz);
}
export function inverse(xf: Xf): Xf {
  const c = Math.cos(-xf.theta), s = Math.sin(-xf.theta);
  return { theta: -xf.theta, tx: -(c * xf.tx - s * xf.tz), tz: -(s * xf.tx + c * xf.tz) };
}
/// First a, then b.
export function compose(a: Xf, b: Xf): Xf {
  const t = apply(b, { x: a.tx, z: a.tz });
  return { theta: a.theta + b.theta, tx: t.x, tz: t.z };
}

export function readJoins(): Record<string, Join> {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; }
}
function writeJoins(j: Record<string, Join>): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(j, null, 1));
}

/// The room a map belongs to, and the transform from its coordinates onto
/// that room's (null when joined without an alignment).
export function canonical(mapId: string): { id: string; xf: Xf | null } {
  const joins = readJoins();
  let id = mapId, xf: Xf | null = IDENTITY;
  for (let i = 0; i < 20 && joins[id]; i++) {
    const j = joins[id];
    xf = xf && j.xf ? compose(xf, j.xf) : null;
    id = j.canon;
  }
  return { id, xf };
}

/// Every map in the room (the canonical one first), with its transform onto it.
export function members(mapId: string): Array<{ mapId: string; xf: Xf | null }> {
  const canon = canonical(mapId).id;
  const joins = readJoins();
  const out: Array<{ mapId: string; xf: Xf | null }> = [{ mapId: canon, xf: IDENTITY }];
  for (const id of Object.keys(joins)) if (id !== canon && canonical(id).id === canon) out.push({ mapId: id, xf: canonical(id).xf });
  return out;
}

/// Carries coordinates of one map into another of the same room (null if
/// they're not joined, or not aligned).
export function between(from: string, to: string): Xf | null {
  if (from === to) return IDENTITY;
  const a = canonical(from), b = canonical(to);
  if (a.id !== b.id || !a.xf || !b.xf) return null;
  return compose(a.xf, inverse(b.xf));
}

/// Joins map b's room into map a's room; xf carries b's coordinates onto a's.
export function join(a: string, b: string, xf: Xf | null, why: string, score?: number): void {
  const ca = canonical(a), cb = canonical(b);
  if (ca.id === cb.id) return;
  const joins = readJoins();
  // b's room → a's map → a's room.
  const toA = xf && ca.xf ? compose(xf, ca.xf) : null;
  const bToCanonB = cb.xf;
  // The canonical map of b's room points at a's room: canonB → b → a's room.
  const canonBToA = toA && bToCanonB ? compose(inverse(bToCanonB), toA) : null;
  joins[cb.id] = { canon: ca.id, xf: canonBToA, at: Date.now(), why, ...(score !== undefined ? { score } : {}) };
  writeJoins(joins);
}

/// Every map id that is the canonical map of its room.
export function isCanonical(mapId: string): boolean {
  return !readJoins()[mapId];
}
