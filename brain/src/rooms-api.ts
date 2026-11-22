// The galaxy's rooms browser: every room she remembers with its map (the
// phone's LiDAR scan plus what camera memory filled in), the things and
// places she knows there, where the camera has been, and the camera-memory
// pictures with their depth.
import type http from "node:http";
import * as frames from "./frames.js";
import * as groups from "./groups.js";
import { png } from "./preview.js";
import * as roommap from "./roommap.js";
import * as store from "./store.js";
import * as world from "./world.js";

let liveSource: (() => unknown) | null = null;
/// The event hub tells us what's live (room, positions, beliefs, helpers).
export function setLive(fn: () => unknown): void {
  liveSource = fn;
}

const json = (res: http.ServerResponse, v: unknown) => {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(v));
};

/// Map ids in a room (all joined maps), with transforms onto the room's coordinates.
function group(id: string): Array<{ mapId: string; xf: groups.Xf | null }> {
  return id === "unsaved" ? [{ mapId: "unsaved", xf: groups.IDENTITY }] : groups.members(id);
}
const inGroup = (id: string) => {
  const ids = new Set(group(id).map((m) => m.mapId));
  return (m: frames.FrameMeta) => ids.has(m.mapId ?? "unsaved");
};

function rooms() {
  const named = world.readRooms();
  const joins = groups.readJoins();
  const mapIds = new Set<string>([...Object.keys(named), ...roommap.ids()]);
  for (const m of frames.all()) mapIds.add(m.mapId ?? "unsaved");
  const canon = new Set([...mapIds].map((id) => (id === "unsaved" ? id : groups.canonical(id).id)));
  return [...canon].map((id) => {
    const members = group(id);
    const r = named[id] ?? members.map((m) => named[m.mapId]).find((x) => x?.name);
    const fs = frames.all().filter(inGroup(id));
    const things = id === "unsaved" ? world.readThings(null) : world.readThings(id);
    const places = id === "unsaved" ? {} : store.readPlaces(id);
    const mapped = members.some((m) => m.mapId !== "unsaved" && (roommap.readPhone(m.mapId) || Object.keys(roommap.read(m.mapId).cells).length));
    const seen = members.map((m) => named[m.mapId]?.lastSeen ?? 0);
    return {
      id, name: r?.name || (id === "unsaved" ? "Rooms not saved yet" : ""), description: r?.description ?? "",
      firstSeen: Math.min(...members.map((m) => named[m.mapId]?.firstSeen ?? Infinity), fs[0]?.t ?? Infinity) || null,
      lastSeen: Math.max(...seen, fs.at(-1)?.t ?? 0) || null, visits: members.reduce((n, m) => n + (named[m.mapId]?.visits ?? 0), 0),
      frames: fs.length, keyFrames: fs.filter((m) => m.key).length, cover: (fs.filter((m) => m.key).at(-1) ?? fs.at(-1))?.t ?? null,
      things: Object.keys(things).length, places: Object.keys(places).length, mapped,
      maps: members.map((m) => ({ id: m.mapId, aligned: !!m.xf, why: joins[m.mapId]?.why ?? "", score: joins[m.mapId]?.score ?? null, at: joins[m.mapId]?.at ?? null })),
      scannedAt: Math.max(0, ...members.map((m) => (m.mapId === "unsaved" ? 0 : roommap.readPhone(m.mapId)?.at ?? 0))) || null,
    };
  }).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/// The room's map in its own coordinates: every joined map's scan and
/// camera-memory cells carried over (the phone's scan wins over memory).
function combinedGroup(id: string) {
  if (id === "unsaved") return null;
  const CELL = 0.1, rank: Record<string, number> = { "#": 4, ".": 3, b: 2, f: 1, " ": 0 };
  const cells = new Map<string, string>();
  for (const m of group(id)) {
    if (!m.xf) continue;
    const g = roommap.combined(m.mapId);
    if (!g) continue;
    for (let r = 0; r < g.rows.length; r++) for (let q = 0; q < g.rows[r].length; q++) {
      const ch = g.rows[r][q];
      if (ch === " ") continue;
      const p = groups.apply(m.xf, { x: g.originX + (q + 0.5) * g.cell, z: g.originZ + (r + 0.5) * g.cell });
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      if ((rank[cells.get(k) ?? " "] ?? 0) < rank[ch]) cells.set(k, ch);
    }
  }
  if (!cells.size) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const k of cells.keys()) { const [x, z] = k.split(",").map(Number); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const rows: string[] = [];
  for (let z = z0; z <= z1; z++) { let r = ""; for (let x = x0; x <= x1; x++) r += cells.get(`${x},${z}`) ?? " "; rows.push(r); }
  return { originX: x0 * CELL, originZ: z0 * CELL, cell: CELL, width: x1 - x0 + 1, height: z1 - z0 + 1, rows };
}

function roomMap(id: string) {
  const things = Object.entries(id === "unsaved" ? world.readThings(null) : world.readThings(id))
    .map(([name, t]) => ({ name, x: t.x, z: t.z, kind: t.kind, note: t.note, visits: t.visits }));
  const places = Object.entries(id === "unsaved" ? {} : store.readPlaces(id)).map(([name, p]) => ({ name, x: p.x, z: p.z }));
  const xfs = new Map(group(id).map((m) => [m.mapId, m.xf]));
  const path = frames.all().filter((m) => m.key && inGroup(id)(m)).slice(-1500).flatMap((m) => {
    const xf = xfs.get(m.mapId ?? "unsaved");
    if (!xf) return [];
    const c = frames.camera(m), p = groups.apply(xf, c);
    return [{ t: m.t, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +groups.applyYaw(xf, c.yaw).toFixed(2), map: m.mapId }];
  });
  return { grid: combinedGroup(id), things, places, path };
}

function frameList(room: string, before: number, limit: number, keyOnly: boolean) {
  const xfs = new Map(group(room).map((m) => [m.mapId, m.xf]));
  const list = frames.all().filter((m) => inGroup(room)(m) && m.t < before && (!keyOnly || m.key));
  return list.slice(-limit).reverse().map((m) => {
    const c = frames.camera(m), xf = xfs.get(m.mapId ?? "unsaved");
    const p = xf ? groups.apply(xf, c) : c;
    return { t: m.t, key: m.key, studied: !!m.studied, depth: !!m.depth, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +(xf ? groups.applyYaw(xf, c.yaw) : c.yaw).toFixed(2),
      aligned: !!xf, map: m.mapId, characters: (m.characters ?? []).map((ch) => ch.name) };
  });
}

/// The frame's depth as a picture the same way up as the photo: near warm,
/// far cool, unknown dark.
function depthPng(m: frames.FrameMeta): Buffer | null {
  const d = frames.depthGrid(m);
  if (!d || !m.depth) return null;
  const { w, h } = m.depth;
  // Sensor (landscape) → portrait, turned 90° clockwise like the photo.
  const W = h, H = w, rgb = Buffer.alloc(W * H * 3);
  let lo = Infinity, hi = 0;
  for (const v of d) if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(1, hi - lo);
  for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) {
    const v = d[gy * w + gx];
    const px = h - 1 - gy, py = gx, o = (py * W + px) * 3;
    if (!v) { rgb[o] = 18; rgb[o + 1] = 20; rgb[o + 2] = 26; continue; }
    const k = Math.pow((v - lo) / span, 0.7); // 0 near … 1 far
    // A warm-to-cool ramp: amber → magenta → blue.
    rgb[o] = Math.round(255 * (1 - k * 0.75));
    rgb[o + 1] = Math.round(190 * (1 - k) * (1 - k) + 40 * k);
    rgb[o + 2] = Math.round(70 + 185 * k);
  }
  return png(W, H, rgb);
}

/// Handles /rooms… and /frames… on the galaxy server; false if not ours.
export function roomsRoute(url: URL, res: http.ServerResponse): boolean {
  const p = url.pathname;
  if (p === "/rooms") { json(res, rooms()); return true; }
  if (p === "/rooms/live") { json(res, liveSource?.() ?? null); return true; }
  let m = /^\/rooms\/([A-Za-z0-9_-]+)\/map$/.exec(p);
  if (m) { json(res, roomMap(m[1])); return true; }
  if (p === "/frames") {
    const room = url.searchParams.get("room") ?? "unsaved";
    const before = Number(url.searchParams.get("before") ?? Date.now() + 1);
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60));
    json(res, frameList(room, before, limit, url.searchParams.get("key") !== "0"));
    return true;
  }
  m = /^\/frames\/(\d+)\.jpg$/.exec(p);
  if (m) {
    const f = frames.get(m[1]);
    const data = f && frames.jpeg(f);
    if (!data) { res.writeHead(404).end(); return true; }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" });
    res.end(Buffer.from(data, "base64"));
    return true;
  }
  m = /^\/frames\/(\d+)\/depth\.png$/.exec(p);
  if (m) {
    const f = frames.get(m[1]);
    const out = f && depthPng(f);
    if (!out) { res.writeHead(404).end(); return true; }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
    res.end(out);
    return true;
  }
  return false;
}
