// Top-down map of the room for the mind, turned so the user's facing
// direction is up (so "left" on the map is the user's left): scanned floor,
// walls/furniture, unscanned areas, the user, characters, doors and places.
import { png } from "./preview.js";
import { fromUser, type Pt } from "./space.js";

export type Grid = { originX: number; originZ: number; cell: number; width: number; height: number; rows: string[] };
type Mark = { label: string; x: number; z: number; yaw?: number; kind: "character" | "place" | "door" | "window" };

const COLORS = {
  blocked: [120, 52, 40], free: [205, 205, 200], unknown: [58, 58, 62], ring: [150, 150, 150],
  user: [255, 255, 255], character: [255, 90, 170], place: [255, 210, 40], door: [60, 200, 120], window: [90, 170, 255],
} as const;

export function renderMap(grid: Grid, user: Pt & { yaw: number }, marks: Mark[], radius = 6): { png: Buffer; legend: string } {
  const S = 520, px = S / (2 * radius);
  const cx = S / 2, cy = S / 2 + S * 0.12; // user a bit below centre: more room ahead
  const f = { x: Math.sin(user.yaw), z: Math.cos(user.yaw) };
  const right = { x: -f.z, z: f.x };
  const img = Buffer.alloc(S * S * 3);
  const put = (x: number, y: number, c: readonly number[]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 3;
    img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
  };
  const toScreen = (p: Pt): [number, number] => {
    const dx = p.x - user.x, dz = p.z - user.z;
    return [cx + (dx * right.x + dz * right.z) * px, cy - (dx * f.x + dz * f.z) * px];
  };
  // Cells.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = (x - cx) / px, a = (cy - y) / px;
      const wx = user.x + right.x * r + f.x * a, wz = user.z + right.z * r + f.z * a;
      const gx = Math.floor((wx - grid.originX) / grid.cell), gz = Math.floor((wz - grid.originZ) / grid.cell);
      const ch = gz >= 0 && gz < grid.height && gx >= 0 && gx < grid.width ? grid.rows[gz][gx] : " ";
      put(x, y, ch === "#" ? COLORS.blocked : ch === "." ? COLORS.free : COLORS.unknown);
      // 1 m rings around the user.
      const d = Math.hypot(r, a);
      if (Math.abs(d - Math.round(d)) * px < 0.6 && Math.round(d) > 0) put(x, y, COLORS.ring);
    }
  }
  const disc = (x: number, y: number, r: number, c: readonly number[]) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(x + dx, y + dy, c);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: readonly number[]) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let i = 0; i <= n; i++) disc(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, 1, c);
  };
  // The user: a triangle pointing up (the way the phone looks).
  for (let i = 0; i < 16; i++) for (let j = -i / 2; j <= i / 2; j++) put(cx + j, cy - 10 + i, COLORS.user);
  const lines: string[] = ["Map (top-down, turned so the way you face is UP; left on the map = your left; 1 m rings around you):",
    "white triangle = you; light = scanned floor; brown = walls/furniture; dark = not scanned yet"];
  marks.forEach((m, i) => {
    const [x, y] = toScreen(m);
    const c = COLORS[m.kind];
    if (m.kind === "character") {
      disc(x, y, 7, c);
      if (m.yaw !== undefined) {
        const [hx, hy] = toScreen({ x: m.x + Math.sin(m.yaw) * 0.45, z: m.z + Math.cos(m.yaw) * 0.45 });
        line(x, y, hx, hy, c);
      }
    } else if (m.kind === "place") {
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (Math.abs(dx) === 6 || Math.abs(dy) === 6) put(x + dx, y + dy, c);
    } else {
      disc(x, y, 5, c);
    }
    lines.push(`${m.kind === "character" ? "pink dot (line = where she faces)" : m.kind === "place" ? "yellow square" : m.kind === "door" ? "green dot" : "blue dot"} #${i + 1}: ${m.label}, ${fromUser(user, m)}`);
  });
  return { png: png(S, S, img), legend: lines.join("\n") };
}
