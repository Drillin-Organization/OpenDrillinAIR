// Her world, for curiosity: things she has noticed in the room (marked in
// camera pictures, located by the phone, remembered with this room map),
// where she has been, and reachable spots she hasn't explored yet.
import fs from "node:fs";
import path from "node:path";
import type { Body } from "./body.js";
import { DATA } from "./store.js";

export type Thing = { x: number; y: number; z: number; kind: string; note: string; at: number; visits: number };

const DIR = path.join(DATA, "things");
const file = (mapId: string | null | undefined) => path.join(DIR, `${(mapId || "unsaved").replace(/[^A-Za-z0-9_-]/g, "")}.json`);

export function readThings(mapId: string | null | undefined): Record<string, Thing> {
  try { return JSON.parse(fs.readFileSync(file(mapId), "utf8")); } catch { return {}; }
}

export function writeThings(mapId: string | null | undefined, things: Record<string, Thing>): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(mapId), JSON.stringify(things, null, 1));
}

/// She went close to a thing: count the visit (curiosity fades a little).
export function visitedNear(mapId: string | null | undefined, x: number, z: number): string | null {
  const things = readThings(mapId);
  for (const [name, t] of Object.entries(things)) {
    if (Math.hypot(t.x - x, t.z - z) < 1.0) {
      t.visits++;
      writeThings(mapId, things);
      return name;
    }
  }
  return null;
}

// MARK: Exploration

const trail = new Map<string, Array<{ x: number; z: number }>>();

/// Remember where she has been (from scene updates).
export function track(id: string, x: number, z: number): void {
  const t = trail.get(id) ?? [];
  const last = t[t.length - 1];
  if (!last || Math.hypot(last.x - x, last.z - z) > 0.5) {
    t.push({ x, z });
    if (t.length > 400) t.shift();
    trail.set(id, t);
  }
}

let mapCache: { at: number; map: any } | null = null;

/// Reachable-looking floor she hasn't been near yet, a few spread-out spots.
export async function unexplored(body: Body, id: string, from: { x: number; z: number; yaw: number }): Promise<string[]> {
  if (!mapCache || Date.now() - mapCache.at > 45_000) {
    const r = await body.command("map", {}, 4000);
    if (!r.ok || !r.data?.rows) return [];
    mapCache = { at: Date.now(), map: r.data };
  }
  const m = mapCache.map as { originX: number; originZ: number; cell: number; rows: string[] };
  const been = trail.get(id) ?? [];
  const spots: Array<{ x: number; z: number; d: number }> = [];
  for (let r = 0; r < m.rows.length; r += 3) {
    const row = m.rows[r];
    for (let c = 0; c < row.length; c += 3) {
      if (row[c] !== ".") continue;
      // Not right next to a wall (needs floor around it).
      let open = true;
      for (let dr = -2; dr <= 2 && open; dr++) for (let dc = -2; dc <= 2; dc++) if ((m.rows[r + dr]?.[c + dc] ?? "#") === "#") { open = false; break; }
      if (!open) continue;
      const x = m.originX + (c + 0.5) * m.cell, z = m.originZ + (r + 0.5) * m.cell;
      const d = Math.hypot(x - from.x, z - from.z);
      if (d < 1.2 || d > 7) continue;
      if (been.some((b) => Math.hypot(b.x - x, b.z - z) < 1.3)) continue;
      spots.push({ x, z, d });
    }
  }
  // Spread out: greedily take spots at least 1.5 m apart, farther first.
  spots.sort((a, b) => b.d - a.d);
  const chosen: typeof spots = [];
  for (const s of spots) if (chosen.every((c) => Math.hypot(c.x - s.x, c.z - s.z) > 1.5)) { chosen.push(s); if (chosen.length >= 3) break; }
  return chosen.map((s) => `(x ${s.x.toFixed(1)}, z ${s.z.toFixed(1)}) ${s.d.toFixed(1)} m ${towards(from, s)}`);
}

/// "ahead of her", "to her left", … from her position and facing.
export function towards(from: { x: number; z: number; yaw: number }, p: { x: number; z: number }): string {
  let a = Math.atan2(p.x - from.x, p.z - from.z) - from.yaw;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  const deg = (a * 180) / Math.PI; // + = her left
  if (Math.abs(deg) < 35) return "ahead of her";
  if (Math.abs(deg) > 145) return "behind her";
  if (Math.abs(deg) < 80) return deg > 0 ? "ahead-left of her" : "ahead-right of her";
  return deg > 0 ? "to her left" : "to her right";
}

// MARK: Rooms

export type Room = { name: string; firstSeen: number; lastSeen: number; visits: number; description?: string };
const ROOMS = path.join(DATA, "rooms.json");

export function readRooms(): Record<string, Room> {
  try { return JSON.parse(fs.readFileSync(ROOMS, "utf8")); } catch { return {}; }
}
export function writeRooms(rooms: Record<string, Room>): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(ROOMS, JSON.stringify(rooms, null, 1));
}

/// A new room's first save: what she noticed before it had an id is its own.
export function adoptUnsaved(mapId: string, readPlaces: (id: string | null) => Record<string, unknown>, writePlaces: (id: string | null, p: Record<string, any>) => void): void {
  const things = readThings(null);
  if (Object.keys(things).length) {
    writeThings(mapId, { ...readThings(mapId), ...things });
    writeThings(null, {});
  }
  const places = readPlaces(null);
  if (Object.keys(places).length) {
    writePlaces(mapId, { ...readPlaces(mapId), ...places });
    writePlaces(null, {});
  }
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};

/// The phone says which room it's in: remember it and tell the mind.
export function roomEvent(info: { mapId?: string; status: string }, places: Record<string, unknown>): string {
  const rooms = readRooms();
  const now = Date.now();
  if (info.status === "new") return "The phone is in a room it doesn't recognise (a new place, or a known one that didn't match yet). Explore it like somewhere new; it's saved automatically as you go.";
  const id = info.mapId!;
  const known = rooms[id];
  if (info.status === "saved") {
    rooms[id] = known ?? { name: "", firstSeen: now, lastSeen: now, visits: 1 };
    writeRooms(rooms);
    return `This room is now saved (map ${id.slice(0, 8)}): what she learns here stays with it. Give it a name with name_room when she knows what it is (living room, bedroom, kitchen, …).`;
  }
  const room = known ?? { name: "", firstSeen: now, lastSeen: now, visits: 0 };
  const since = now - room.lastSeen;
  room.visits++;
  room.lastSeen = now;
  rooms[id] = room;
  writeRooms(rooms);
  const things = Object.keys(readThings(id));
  return [
    `The phone recognised the room: she's back in ${room.name ? `the ${room.name}` : `a room she's been in before (unnamed; name it with name_room)`}${known ? `, visit ${room.visits}, last here ${ago(since)} ago` : ""}.${room.description ? ` ${room.description}` : ""}`,
    Object.keys(places).length ? `Places she knows here: ${Object.keys(places).join(", ")}.` : "",
    things.length ? `Things she remembers here: ${things.join(", ")}.` : "",
    "Let her recognise it like a person would (it's familiar, she knows where things are).",
  ].filter(Boolean).join(" ");
}
