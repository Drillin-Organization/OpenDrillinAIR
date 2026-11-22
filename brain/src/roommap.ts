// A lasting map of each saved room, built from camera memory: every key
// frame's depth points become floor (free) or walls and furniture (blocked)
// on a 10 cm grid that keeps growing across visits. get_map fills the
// phone's unscanned cells from it, and it still shows the room while the
// phone is away.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";
import type { Grid } from "./map.js";
import { camera, worldPoints, type FrameMeta } from "./frames.js";

const DIR = path.join(DATA, "roommaps");
const CELL = 0.1;
/// Points this far up from the floor are walls or furniture she can't walk through.
const LOW = 0.12, HIGH = 1.9, FLOOR_BAND = 0.08;

type RoomMap = { cell: number; floorY: number | null; floorN: number; frames: number; cells: Record<string, [number, number]> };

const cache = new Map<string, RoomMap>();
const dirty = new Set<string>();
const file = (mapId: string) => path.join(DIR, `${mapId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);

export function read(mapId: string): RoomMap {
  let m = cache.get(mapId);
  if (!m) {
    try { m = JSON.parse(fs.readFileSync(file(mapId), "utf8")) as RoomMap; } catch { m = { cell: CELL, floorY: null, floorN: 0, frames: 0, cells: {} }; }
    cache.set(mapId, m);
  }
  return m;
}

export function save(): void {
  for (const id of dirty) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(id), JSON.stringify(cache.get(id)));
  }
  dirty.clear();
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

/// Adds one frame's points to its room's map. Returns how many cells it touched.
export function fuse(f: FrameMeta, floorHint?: number | null): number {
  if (!f.mapId) return 0;
  const m = read(f.mapId);
  const pts = worldPoints(f);
  if (pts.length < 8) return 0;
  const cam = camera(f);
  // The floor: the lowest points, if they're a sensible height below the camera.
  const low = percentile(pts.map((p) => p[1]), 0.05);
  const est = floorHint ?? low;
  if (cam.y - est > 0.4 && cam.y - est < 2.3) {
    if (m.floorY === null || m.floorN < 5) { m.floorY = m.floorY === null ? est : (m.floorY * m.floorN + est) / (m.floorN + 1); m.floorN++; }
    else if (Math.abs(est - m.floorY) < 0.25) { m.floorY = m.floorY * 0.95 + est * 0.05; m.floorN++; }
  }
  if (m.floorY === null) return 0;
  const touched = new Set<string>();
  for (const [x, y, z] of pts) {
    if (Math.hypot(x - cam.x, z - cam.z) > 6) continue;
    const h = y - m.floorY;
    const free = h > -0.15 && h < FLOOR_BAND, blocked = h > LOW && h < HIGH;
    if (!free && !blocked) continue;
    const key = `${Math.floor(x / m.cell)},${Math.floor(z / m.cell)}`;
    const c = (m.cells[key] ??= [0, 0]);
    if (free) c[0] = Math.min(60, c[0] + 1); else c[1] = Math.min(60, c[1] + 1);
    touched.add(key);
  }
  m.frames++;
  dirty.add(f.mapId);
  return touched.size;
}

function state(c: [number, number] | undefined): "#" | "." | " " {
  if (!c) return " ";
  if (c[1] >= 2 && c[1] >= c[0] * 0.3) return "#";
  if (c[0] >= 2) return ".";
  return " ";
}

/// The whole lasting map as a grid (null if nothing is known yet).
export function grid(mapId: string): Grid | null {
  const m = read(mapId);
  const keys = Object.keys(m.cells);
  if (!keys.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const k of keys) {
    const [gx, gz] = k.split(",").map(Number);
    x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); z0 = Math.min(z0, gz); z1 = Math.max(z1, gz);
  }
  const rows: string[] = [];
  for (let gz = z0; gz <= z1; gz++) {
    let r = "";
    for (let gx = x0; gx <= x1; gx++) r += state(m.cells[`${gx},${gz}`]);
    rows.push(r);
  }
  return { originX: x0 * m.cell, originZ: z0 * m.cell, cell: m.cell, width: x1 - x0 + 1, height: z1 - z0 + 1, rows };
}

/// The phone's grid with its unscanned cells filled in from the lasting map.
export function fill(phone: Grid, mapId: string | null | undefined): { grid: Grid; filled: number } {
  if (!mapId) return { grid: phone, filled: 0 };
  const m = read(mapId);
  if (!Object.keys(m.cells).length) return { grid: phone, filled: 0 };
  let filled = 0;
  const rows = phone.rows.map((row, gz) => {
    let out = "";
    for (let gx = 0; gx < row.length; gx++) {
      let ch = row[gx];
      if (ch !== "#" && ch !== ".") {
        const x = phone.originX + (gx + 0.5) * phone.cell, z = phone.originZ + (gz + 0.5) * phone.cell;
        const s = state(m.cells[`${Math.floor(x / m.cell)},${Math.floor(z / m.cell)}`]);
        if (s !== " ") { ch = s; filled++; }
      }
      out += ch;
    }
    return out;
  });
  return { grid: { ...phone, rows }, filled };
}

/// For tests.
export function reset(): void {
  cache.clear(); dirty.clear();
}
