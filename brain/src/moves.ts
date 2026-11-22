// Her library of real human moves (motion capture, shipped in the app as
// Soul/Moves/moves.json + moves.bin; built by mocap/build-pack.ts). The mind
// finds moves by meaning ("shy", "celebrate", "sit on the floor"), plays them
// by name, and free time suggests a few that fit her energy.
import fs from "node:fs";
import path from "node:path";
import { APP_SOUL } from "./store.js";
import { allComposed } from "./compose.js";

export type LibraryMove = { name: string; desc: string; tags: string[]; frames: number; seconds: number };

const FILE = path.join(APP_SOUL, "Moves", "moves.json");
let cache: { at: number; moves: LibraryMove[] } | null = null;

export function library(): LibraryMove[] {
  try {
    const stat = fs.statSync(FILE);
    if (!cache || cache.at !== stat.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as { fps: number; moves: Array<{ name: string; desc: string; tags: string[]; frames: number }> };
      cache = { at: stat.mtimeMs, moves: raw.moves.map((m) => ({ ...m, seconds: Math.round((m.frames / raw.fps) * 10) / 10 })) };
    }
    // Plus the moves she made from the library (make_move).
    const made = allComposed().map((m) => ({ name: m.name, desc: m.desc, tags: m.tags, frames: m.frames, seconds: Math.round((m.frames / m.fps) * 10) / 10 }));
    return made.length ? cache.moves.concat(made) : cache.moves;
  } catch {
    return [];
  }
}

export function inLibrary(name: string): LibraryMove | undefined {
  return library().find((m) => m.name === name);
}

/// Words people use → words in the descriptions.
const SYNONYMS: Record<string, string[]> = {
  happy: ["happy", "joy", "excited", "celebrate", "cheer", "laugh", "dance"],
  sad: ["sad", "depressed", "cry", "upset", "sigh"],
  angry: ["angry", "frustrated", "mad", "stomp"],
  shy: ["shy", "nervous", "timid", "bashful"],
  tired: ["tired", "yawn", "exhausted", "stretch"],
  hello: ["wave", "hello", "greet", "hi"],
  bye: ["wave", "bye", "goodbye"],
  yes: ["nod", "yes", "agree"],
  no: ["no", "shake", "disagree"],
  think: ["think", "ponder", "scratch", "chin", "look"],
  exercise: ["exercise", "stretch", "yoga", "squat", "lunge", "jumping", "push", "warm"],
  sit: ["sit", "seat", "chair", "stool", "squat", "kneel", "crouch"],
  lie: ["lie", "lying", "lay"],
  celebrate: ["celebrate", "cheer", "jump", "clap", "victory"],
  fight: ["box", "punch", "kick", "martial", "karate", "fencing"],
  play: ["play", "game", "ball", "throw", "catch", "mime", "pantomime"],
  clean: ["wash", "sweep", "clean", "wipe", "brush"],
  eat: ["eat", "drink", "sip", "pour"],
};

export function search(query: string, category?: string, limit = 12): LibraryMove[] {
  const words: string[] = query.toLowerCase().match(/[a-z]+/g) ?? [];
  const terms = new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]));
  const scored = library()
    .filter((m) => !category || m.tags.includes(category))
    .map((m) => {
      const hay = `${m.name.replace(/_/g, " ")} ${m.desc.toLowerCase()}`;
      let s = 0;
      for (const t of terms) {
        if (new RegExp(`\\b${t}`).test(hay)) s += (words as string[]).includes(t) ? 3 : 1;
        if (m.tags.includes(t)) s += 2;
      }
      return { m, s: s + Math.random() * 0.5 };
    })
    .filter((x) => x.s >= 1 || (!words.length && category))
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.m);
}

/// A handful of moves that fit her energy, a little different every time.
export function suggest(energy: number, avoid: string, n = 8): LibraryMove[] {
  const weights: Record<string, number> = energy > 0.72
    ? { dance: 4, exercise: 4, play: 3, emotion: 1, gesture: 1, everyday: 1 }
    : energy > 0.52
      ? { play: 3, gesture: 3, everyday: 3, dance: 2, exercise: 2, emotion: 2, idle: 1 }
      : energy > 0.32
        ? { everyday: 4, gesture: 3, idle: 3, emotion: 2, sit: 2, exercise: 1 }
        : { sit: 5, idle: 4, everyday: 2, emotion: 2 };
  // Pantomimes (animals, monsters) stay searchable but aren't suggested unasked.
  const pool = library().filter((m) => !avoid.includes(m.name.replace(/_/g, " ")) && !/human subject|ghost|zombie|monster|dinosaur/i.test(m.desc));
  const pick: LibraryMove[] = [];
  const seen = new Set<string>();
  for (let tries = 0; pick.length < n && tries < 400 && pool.length; tries++) {
    const m = pool[Math.floor(Math.random() * pool.length)];
    const w = Math.max(...m.tags.map((t) => weights[t] ?? 0.3));
    const key = m.desc.toLowerCase();
    if (seen.has(key) || Math.random() * 5 > w) continue;
    seen.add(key);
    pick.push(m);
  }
  return pick;
}
