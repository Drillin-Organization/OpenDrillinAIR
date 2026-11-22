// Where she thinks she is: a helper looks at the latest camera pictures and
// what she knows of the rooms, and writes down which room this is, where she
// and the user are in it, and how it reasoned. Shown live in the galaxy.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";

export type Belief = {
  at: number;
  mapId: string | null;
  room: string;
  sameAs?: string;
  confidence: number;
  where: string;
  user?: string;
  reasoning: string;
  by?: string;
};

const file = () => path.join(DATA, "beliefs.jsonl");
let cache: Belief[] | null = null;

export function recent(n = 20): Belief[] {
  if (!cache) {
    try { cache = fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { cache = []; }
  }
  return cache.slice(-n).reverse();
}

export function add(b: Belief): void {
  recent(1);
  cache!.push(b);
  if (cache!.length > 400) cache = cache!.slice(-200);
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(file(), JSON.stringify(b) + "\n");
}

export function latest(): Belief | undefined {
  return recent(1)[0];
}
