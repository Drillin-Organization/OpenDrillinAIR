// Reads the built move pack back (as the phone does) and renders contact
// sheets of some moves, to check the shipped data by eye.
// Usage: tsx mocap/check-pack.ts <out dir> [name|count]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sheet } from "./sheet.js";
import type { Pose, V3 } from "./retarget.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "../../Drillin AIR/Drillin AIR/Soul/Moves");
const index = JSON.parse(fs.readFileSync(path.join(DIR, "moves.json"), "utf8"));
const bin = fs.readFileSync(path.join(DIR, "moves.bin"));
const out = process.argv[2];
const arg = process.argv[3] ?? "6";

function poses(m: { frames: number; offset: number }): Pose[] {
  const res: Pose[] = [];
  for (let f = 0; f < m.frames; f++) {
    let o = (m.offset + f) * index.values * 2;
    const root = [0, 1, 2].map(() => { const v = bin.readInt16LE(o) / 1000; o += 2; return v; }) as V3;
    const joints: Record<string, V3> = {};
    for (const j of index.joints as string[]) {
      joints[j] = [0, 1, 2].map(() => { const v = bin.readInt16LE(o) / 100; o += 2; return v; }) as V3;
    }
    res.push({ joints, root });
  }
  return res;
}

const list = isNaN(Number(arg))
  ? index.moves.filter((m: any) => m.name.includes(arg))
  : [...index.moves].sort(() => Math.random() - 0.5).slice(0, Number(arg));
fs.mkdirSync(out, { recursive: true });
for (const m of list.slice(0, 12)) {
  const file = path.join(out, `${m.name}.png`);
  sheet(poses(m), index.fps, file);
  console.log(`${m.name}: ${m.desc} (${(m.frames / index.fps).toFixed(1)} s, ${m.tags.join(", ")}) → ${file}`);
}
