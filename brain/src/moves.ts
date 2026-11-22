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
  // Only what a person does at home, unprompted: small gestures, idling,
  // stretching, sitting, a sway or a little dance when she's full of energy.
  // Everything else (sport, acrobatics, ballet, work, miming objects she
  // doesn't hold, two-person scenes) stays searchable with find_moves, for
  // when the moment really calls for it, but is never suggested.
  // Gestures meant for someone (wave, laugh, bow, point) are for talking
  // with the user, not for doing alone: she finds those with find_moves.
  const calm = /\b(wait(ing)?|look(ing)? (around|up|down|at|for)|stretch|yawn|think|scratch|hair|hands? on hips|arms? crossed|cross(ed)? arms|lean|relax|rest(ing)?|sigh|bored|sway|tap(ping)? (her |the )?foot|standing still|breath|shift(ing)? weight|idle|shrug|nod|check(ing)?|adjust|fix(ing)?|smooth|brush(ing)? off|rub(bing)?|touch(ing)?|play(ing)? with|fidget|kneel|crouch|peek|inspect|examin|search|wonder|curious|happy|content|hum|clap|snap|bounce|walk(ing)? (around|in place)|pace|pacing|turn(ing)? around)\b/i;
  const sitting = /\b(sit(ting)?|sits) (down|on the floor|cross|and)|\bsitting\b|\bsit down\b/i;
  const dancey = /^(dance|dancing)\b(?!.*(arabesque|pirouette|jete|attitude|plie|calibration|pose))/i;
  const odd = /human subject|flashlight|strong man|bus|old man|macho|dinosaur|cat wait|cartwheel|spin|tiptoe|reach for|vignette|traffic|arrow|shoot|smash|angr|crying|drunk|zombie|monster|ghost|chicken|animal|calibration|sword|fight|punch|kick|saw|bolt|hammer|sweep|mop|clean|wash|toss|throw|catch|lift|carry|phone|mug|coffee|headphone|\bA\b|\bB\b|partner|part (?!1 of)\d+/i;
  const fits = (m: LibraryMove) => {
    const d = m.desc;
    if (odd.test(d) || m.seconds > 12) return 0;
    if (dancey.test(d)) return energy > 0.72 ? 2 : 0;
    if (sitting.test(d)) return energy < 0.45 ? 4 : 1;
    return calm.test(d) ? 3 : m.tags.some((t) => t === "everyday" || t === "gesture" || t === "idle") ? 2 : 0;
  };
  const pool = library().filter((m) => !avoid.includes(m.name.replace(/_/g, " ")) && fits(m) > 0);
  const pick: LibraryMove[] = [];
  const seen = new Set<string>();
  for (let tries = 0; pick.length < n && tries < 400 && pool.length; tries++) {
    const m = pool[Math.floor(Math.random() * pool.length)];
    const w = fits(m);
    const key = m.desc.toLowerCase();
    if (seen.has(key) || Math.random() * 5 > w) continue;
    seen.add(key);
    pick.push(m);
  }
  return pick;
}
