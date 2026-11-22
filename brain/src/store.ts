// Brain data on disk (brain/data, not in the app repo):
//   behaviors/<name>.js   behaviour scripts, a git repo of their own so every
//                         change the mind makes is a commit that can be reverted
//   characters/<name>/    persona.md, memory.md, life.md per character
//   state.json            last seen, characters already introduced this thread
import { execFileSync } from "node:child_process";
import * as groups from "./groups.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BRAIN_ROOT = path.resolve(here, "..");
export const DATA = process.env.BRAIN_DATA ? path.resolve(process.env.BRAIN_DATA) : path.join(BRAIN_ROOT, "data");
const BEHAVIORS = path.join(DATA, "behaviors");
const CHARACTERS = path.join(DATA, "characters");
/// What the app ships with (behaviour seeds, the move library): brain/assets
/// in the standalone OpenDrillinAIR package, else the app's own Soul folder
/// next to the brain in the app repo. BRAIN_ASSETS overrides both.
export const APP_SOUL = process.env.BRAIN_ASSETS
  ? path.resolve(process.env.BRAIN_ASSETS)
  : fs.existsSync(path.join(BRAIN_ROOT, "assets", "Moves"))
    ? path.join(BRAIN_ROOT, "assets")
    : path.resolve(BRAIN_ROOT, "../Drillin AIR/Drillin AIR/Soul");
/// The behaviours the app ships with (seed for a fresh brain).
const APP_BEHAVIORS = path.join(APP_SOUL, "Behaviors");

export const BEHAVIOR_NAME = /^[a-z][a-z0-9_]{0,40}$/;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", BEHAVIORS, ...args], { encoding: "utf8" }).trim();
}

export function initStore(): void {
  fs.mkdirSync(CHARACTERS, { recursive: true });
  const fresh = !fs.existsSync(BEHAVIORS);
  if (fresh) {
    fs.mkdirSync(BEHAVIORS, { recursive: true });
    git("init", "-q");
  }
  // Add behaviours the app ships that this brain doesn't have yet (the
  // mind's own edits to existing ones are kept).
  const added: string[] = [];
  for (const file of fs.readdirSync(APP_BEHAVIORS)) {
    const m = /^soul-(.+)\.js$/.exec(file);
    if (!m || m[1] === "runtime") continue;
    const dest = path.join(BEHAVIORS, `${m[1]}.js`);
    const shipped = fs.readFileSync(path.join(APP_BEHAVIORS, file), "utf8");
    if (fs.existsSync(dest)) {
      // A newer app version replaces it, unless the mind has edited it.
      if (fs.readFileSync(dest, "utf8") === shipped) continue;
      const history = git("log", "--format=%s", "--", `${m[1]}.js`).split("\n").filter(Boolean);
      if (!history.every((h) => /^(Seed behaviours|Add app behaviours|Update app behaviours)/.test(h))) continue;
    }
    fs.writeFileSync(dest, shipped);
    added.push(m[1]);
  }
  if (added.length) {
    git("add", "-A");
    git("-c", "user.name=Drillin brain", "-c", "user.email=brain@localhost", "commit", "-qm",
      fresh ? "Seed behaviours from the app" : `Update app behaviours: ${added.join(", ")}`);
  }
}

// MARK: Behaviours

export function behaviorFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of fs.readdirSync(BEHAVIORS).sort()) {
    if (file.endsWith(".js")) files[file.slice(0, -3)] = fs.readFileSync(path.join(BEHAVIORS, file), "utf8");
  }
  return files;
}

export function readBehavior(name: string): string | null {
  const file = path.join(BEHAVIORS, `${name}.js`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function writeBehavior(name: string, code: string): void {
  fs.writeFileSync(path.join(BEHAVIORS, `${name}.js`), code);
}

export function removeBehavior(name: string): void {
  fs.rmSync(path.join(BEHAVIORS, `${name}.js`), { force: true });
}

export function commitBehavior(name: string, message: string): string {
  git("add", "-A", "--", `${name}.js`);
  git("-c", "user.name=Drillin brain", "-c", "user.email=brain@localhost", "commit", "-qm", `${name}: ${message}`);
  return git("rev-parse", "--short", "HEAD");
}

/// Versions of a behaviour, newest first: "abc1234 walk: slower turns".
export function behaviorHistory(name: string): string[] {
  const out = git("log", "--format=%h %s", "--", `${name}.js`);
  return out ? out.split("\n") : [];
}

export function behaviorAt(name: string, rev: string): string | null {
  try {
    return git("show", `${rev}:${name}.js`);
  } catch {
    return null;
  }
}

// MARK: Characters

function characterDir(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "character";
  const dir = path.join(CHARACTERS, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export type CharacterFile = "persona" | "memory" | "life";

export function readCharacter(name: string, file: CharacterFile): string {
  const p = path.join(characterDir(name), `${file}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
}

export function writeCharacter(name: string, file: CharacterFile, text: string): void {
  fs.writeFileSync(path.join(characterDir(name), `${file}.md`), text.trim() + "\n");
}

export function appendMemory(name: string, fact: string): void {
  const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")}: ${fact.trim()}\n`;
  fs.appendFileSync(path.join(characterDir(name), "memory.md"), line);
}

// MARK: State and conversation

export type State = {
  lastSeen: number | null; introduced: string[];
  /// The characters and room the phone last showed (her world while it's away).
  known?: { mapId: string | null; characters: Array<{ id: string; name: string; x: number; z: number; yaw: number }> };
  /// When the user had the phone showing her (sessions), to learn their routine.
  presence?: Array<{ start: number; end: number }>;
};

const STATE = path.join(DATA, "state.json");

export function loadState(): State {
  try {
    return { lastSeen: null, introduced: [], ...JSON.parse(fs.readFileSync(STATE, "utf8")) };
  } catch {
    return { lastSeen: null, introduced: [] };
  }
}

export function saveState(state: State): void {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}

// MARK: Named places (per saved room map; coordinates only hold within it)

const PLACES = path.join(DATA, "places");
export type Place = { x: number; z: number };

function placesFile(mapId: string | null | undefined): string {
  fs.mkdirSync(PLACES, { recursive: true });
  return path.join(PLACES, `${(mapId || "unsaved").replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

/// Places she knows in this map, plus those from other maps of the same
/// room (joined), carried into this map's coordinates (its own win).
export function readPlaces(mapId: string | null | undefined): Record<string, Place> {
  const own = readPlacesRaw(mapId);
  if (!mapId) return own;
  const shared: Record<string, Place> = {};
  for (const m of groups.members(mapId)) {
    if (m.mapId === mapId) continue;
    const xf = groups.between(m.mapId, mapId);
    if (!xf) continue;
    for (const [n, p] of Object.entries(readPlacesRaw(m.mapId))) shared[n] = { ...p, ...groups.apply(xf, p) };
  }
  return { ...shared, ...own };
}

export function readPlacesRaw(mapId: string | null | undefined): Record<string, Place> {
  try {
    return JSON.parse(fs.readFileSync(placesFile(mapId), "utf8"));
  } catch {
    return {};
  }
}

export function writePlaces(mapId: string | null | undefined, places: Record<string, Place>): void {
  fs.writeFileSync(placesFile(mapId), JSON.stringify(places, null, 1));
}

export function characterNames(): string[] {
  try {
    return fs.readdirSync(CHARACTERS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}
