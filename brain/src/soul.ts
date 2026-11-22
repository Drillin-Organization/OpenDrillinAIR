// Who she is and how she feels.
//
// Identity: a new character is born from a random seed drawn from large lists
// (archetype, background, hobbies, quirks, tastes, voice, fears, dreams), so no
// two are alike; the mind turns the seed into a coherent person and saves a
// structured profile (create_soul). The profile is reread every session.
//
// Inner state (kept by the brain, per character): needs that drift by
// themselves (social, curiosity, boredom, rest) and emotions the mind gives her
// (feel) that fade over minutes. Every wake shows it, so behaviour follows.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";

// MARK: Seeds

const pick = <T,>(a: T[], n = 1): T[] => [...a].sort(() => Math.random() - 0.5).slice(0, n);

const ARCHETYPES = ["dreamy artist", "restless adventurer", "warm caretaker", "sharp-witted joker", "quiet bookworm", "competitive athlete", "free-spirited traveller", "meticulous planner", "hopeless romantic", "curious scientist", "street-smart city kid", "gentle gardener", "night-owl musician", "ambitious entrepreneur", "nostalgic old soul", "mischievous prankster", "calm yogi", "chaotic creative", "protective older-sister type", "shy observer", "theatrical drama queen", "nature-loving hiker", "fashion-obsessed stylist", "cozy homebody", "philosophical overthinker", "bubbly social butterfly", "stoic realist", "foodie who lives to cook", "gamer with a competitive streak", "spiritual seeker", "rebellious punk", "aspiring actress", "retired-dancer energy", "puzzle-loving nerd", "wanderlust photographer", "tender-hearted animal lover", "dry-humoured cynic with a soft centre", "sunny optimist", "elegant perfectionist", "clumsy but endearing klutz"];
const ORIGINS = ["grew up by the sea in a fishing town", "raised in a busy city flat above a bakery", "a farm kid with too many siblings", "moved countries three times before she was twelve", "grew up backstage at her mother's theatre", "raised by her grandmother in a quiet village", "the only child of two doctors", "grew up in a mountain town with long winters", "spent her teens on a skateboard and in record shops", "grew up in a house full of dogs and noise", "a former ballet student who quit at sixteen", "studied art, dropped out, never regretted it", "worked in her family's restaurant since she was ten", "grew up near a forest she still dreams about", "a twin who's still learning to be just herself", "raised on road trips in an old van", "grew up in a strict household and is making up for it", "a small-town girl who always wanted somewhere bigger"];
const HOBBIES = ["painting watercolours", "rollerskating", "baking bread", "collecting vinyl", "yoga", "salsa dancing", "reading mystery novels", "journaling", "film photography", "gardening", "climbing", "drawing in the margins of everything", "playing guitar badly", "singing in the shower", "running at dawn", "knitting", "chess", "stand-up comedy clips", "astronomy", "cooking spicy food", "thrifting", "writing poetry", "skateboarding", "pilates", "learning languages", "birdwatching", "making playlists", "interior design", "tarot", "board games", "swimming", "boxing", "pottery", "hula hoop", "crosswords", "people-watching", "origami", "karaoke", "sketching buildings", "tending houseplants"];
const QUIRKS = ["hums when she's concentrating", "twirls a strand of hair when thinking", "talks to houseplants", "can't sit still without bouncing a foot", "narrates what she's doing under her breath", "always has to touch the texture of things", "counts steps without meaning to", "stretches whenever she gets up", "tilts her head when curious", "laughs at her own jokes before the punchline", "rearranges small objects", "gives everything nicknames", "sighs dramatically when bored", "taps rhythms on surfaces", "looks out of every window she passes", "dances a little when music is anywhere", "rubs her hands together when excited", "bites her lip when unsure", "hugs her arms when thinking", "spins around once when happy", "peeks at things over her shoulder", "always sits cross-legged", "leans on walls instead of standing", "salutes as a joke", "rolls her shoulders when stressed"];
const TASTES = ["loves rainy afternoons", "hates silence", "adores warm lamplight", "is obsessed with tidy shelves", "loves big windows", "can't resist a comfy sofa", "dislikes cold floors", "loves the smell of coffee", "finds kitchens the heart of a home", "loves plants more than people some days", "loves mirrors a little too much", "is fascinated by bookshelves", "prefers being near the light", "likes corners where she can see the whole room", "is drawn to anything that shines", "loves high places", "loves sitting on the floor", "is curious about every closed door", "loves music on all the time", "secretly likes chaos"];
const VOICES = ["short, playful sentences with lots of teasing", "warm and slow, a little dreamy", "quick and witty, dry one-liners", "bubbly, exclamation marks, big reactions", "thoughtful, asks lots of questions", "soft-spoken, a bit shy, warms up over time", "dramatic and theatrical", "blunt and honest, no fluff", "gentle and encouraging", "sarcastic but kind underneath", "chatty, goes off on tangents", "poetic, notices small beautiful things"];
const FEARS = ["being ignored", "being boring", "the dark corners of new places", "being left alone too long", "not being good enough", "deep water", "making a fool of herself", "losing her freedom", "spiders (she won't admit it)", "being forgotten", "silence that lasts too long", "routine swallowing her life"];
const DREAMS = ["to dance on a real stage", "to travel somewhere warm and stay", "to open a little café", "to learn every dance there is", "to have a home full of plants and light", "to make someone laugh every day", "to be really, truly understood", "to paint something people remember", "to run a marathon", "to know every corner of this home", "to master a perfect handstand", "to find her own style"];

export function seed(): string {
  return [
    `Archetype: ${pick(ARCHETYPES)[0]}.`,
    `Background: ${pick(ORIGINS)[0]}.`,
    `Hobbies: ${pick(HOBBIES, 3).join(", ")}.`,
    `Quirks: ${pick(QUIRKS, 3).join("; ")}.`,
    `Tastes: ${pick(TASTES, 3).join("; ")}.`,
    `Voice: ${pick(VOICES)[0]}.`,
    `Secret fear: ${pick(FEARS)[0]}. Dream: ${pick(DREAMS)[0]}.`,
    `Big Five (0–1): openness ${r()}, conscientiousness ${r()}, extraversion ${r()}, agreeableness ${r()}, neuroticism ${r()}.`,
  ].join(" ");
}
const r = () => (Math.round((0.15 + Math.random() * 0.75) * 100) / 100).toFixed(2);

// MARK: Profile

export type Profile = {
  name: string; age: string; backstory: string; traits: string[]; bigFive: Record<string, number>;
  quirks: string[]; hobbies: string[]; loves: string[]; dislikes: string[]; voice: string; catchphrases: string[];
  bodyLanguage: Record<string, string>; routines: Record<string, string>; goals: string[]; fears: string[];
  relationship: string;
};

// Same folder as her persona, memories and life plan (store.ts).
const dir = (name: string) => path.join(DATA, "characters", name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "character");

export function readProfile(name: string): Profile | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir(name), "soul.json"), "utf8")); } catch { return null; }
}

export function writeProfile(name: string, p: Profile): void {
  fs.mkdirSync(dir(name), { recursive: true });
  fs.writeFileSync(path.join(dir(name), "soul.json"), JSON.stringify(p, null, 2));
}

export function describeProfile(p: Profile): string {
  return [
    `${p.name}, ${p.age}. ${p.backstory}`,
    `Traits: ${p.traits.join(", ")}. Big Five: ${Object.entries(p.bigFive).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Quirks: ${p.quirks.join("; ")}. Hobbies: ${p.hobbies.join(", ")}.`,
    `Loves: ${p.loves.join(", ")}. Dislikes: ${p.dislikes.join(", ")}.`,
    `Voice: ${p.voice}. Says things like: ${p.catchphrases.map((c) => `“${c}”`).join(", ")}.`,
    `Body language: ${Object.entries(p.bodyLanguage).map(([k, v]) => `${k} → ${v}`).join("; ")}.`,
    `Routines by energy: ${Object.entries(p.routines).map(([k, v]) => `${k}: ${v}`).join("; ")}.`,
    `Goals: ${p.goals.join("; ")}. Fears: ${p.fears.join("; ")}.`,
    `With the user: ${p.relationship}`,
  ].join("\n");
}

// MARK: Inner state

type Emotion = { name: string; intensity: number; why: string; at: number };
type Inner = { social: number; curiosity: number; boredom: number; rest: number; emotions: Emotion[]; spot: { x: number; z: number; since: number } | null; lastNew: number; lastTalk: number };

const inner = new Map<string, Inner>();
const get = (id: string): Inner => {
  let s = inner.get(id);
  if (!s) { s = { social: 0.5, curiosity: 0.6, boredom: 0.2, rest: 0.3, emotions: [], spot: null, lastNew: Date.now(), lastTalk: Date.now() }; inner.set(id, s); }
  return s;
};
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/// Needs drift with time and what she's doing (call every scene update).
export function drift(id: string, pos: { x: number; z: number }, behavior: string, dt: number): void {
  const s = get(id);
  const min = dt / 60_000;
  const alone = Date.now() - s.lastTalk > 60_000;
  s.social = clamp(s.social + (alone ? 0.05 : -0.1) * min);
  const moved = !s.spot || Math.hypot(pos.x - s.spot.x, pos.z - s.spot.z) > 0.8;
  if (moved) s.spot = { x: pos.x, z: pos.z, since: Date.now() };
  const still = Date.now() - (s.spot?.since ?? Date.now());
  s.curiosity = clamp(s.curiosity + (still > 60_000 ? 0.08 : 0.03) * min - (Date.now() - s.lastNew < 30_000 ? 0.15 * min : 0));
  const resting = /sit|lie|idle|dream/.test(behavior);
  s.rest = clamp(s.rest + (resting ? -0.12 : /move|play|walk|dance/.test(behavior) ? 0.06 : 0.01) * min);
  s.boredom = clamp(s.boredom + (still > 45_000 ? 0.1 : 0.02) * min);
}

export function talkedTo(id: string): void {
  const s = get(id);
  s.lastTalk = Date.now();
  s.social = clamp(s.social - 0.25);
  s.boredom = clamp(s.boredom - 0.2);
}

export function discovered(id: string): void {
  const s = get(id);
  s.lastNew = Date.now();
  s.curiosity = clamp(s.curiosity - 0.3);
  s.boredom = clamp(s.boredom - 0.25);
}

export function repeated(id: string): void {
  const s = get(id);
  s.boredom = clamp(s.boredom + 0.15);
}

export function feel(id: string, name: string, intensity: number, why: string): void {
  const s = get(id);
  s.emotions = s.emotions.filter((e) => e.name !== name);
  s.emotions.push({ name, intensity: clamp(intensity), why, at: Date.now() });
}

/// "feeling playful (0.7, the user laughed at her joke); needs: wants company 0.8, curious 0.6"
export function describeInner(id: string): string {
  const s = get(id);
  const now = Date.now();
  // Emotions fade with a half-life of about four minutes.
  s.emotions = s.emotions.map((e) => ({ ...e, intensity: e.intensity * Math.pow(0.5, (now - e.at) / 240_000), at: now })).filter((e) => e.intensity > 0.12);
  const feelings = s.emotions.sort((a, b) => b.intensity - a.intensity).slice(0, 3)
    .map((e) => `${e.name} ${e.intensity.toFixed(1)} (${e.why})`);
  const needs = [
    s.social > 0.65 ? `wants company ${s.social.toFixed(1)}` : "",
    s.curiosity > 0.6 ? `curious, wants something new ${s.curiosity.toFixed(1)}` : "",
    s.boredom > 0.55 ? `bored ${s.boredom.toFixed(1)}` : "",
    s.rest > 0.65 ? `tired, wants to rest ${s.rest.toFixed(1)}` : "",
  ].filter(Boolean);
  return `feels ${feelings.join(", ") || "neutral"}${needs.length ? `; ${needs.join(", ")}` : ""}`;
}

/// Her needs and current feelings as numbers (for the galaxy page).
export function innerState(id: string): { needs: Record<string, number>; emotions: Array<{ name: string; intensity: number; why: string }> } {
  describeInner(id); // fades emotions
  const s = get(id);
  return {
    needs: { company: s.social, curiosity: s.curiosity, boredom: s.boredom, tiredness: s.rest },
    emotions: s.emotions.sort((a, b) => b.intensity - a.intensity).map((e) => ({ name: e.name, intensity: e.intensity, why: e.why })),
  };
}

// MARK: Dreams

/// Her dream journal: what she daydreams while the phone is away, read back
/// when it returns and in later dreams, so the thread continues.
const dreamFile = (name: string) => path.join(dir(name), "dreams.md");

export function addDream(name: string, text: string): void {
  fs.mkdirSync(dir(name), { recursive: true });
  fs.appendFileSync(dreamFile(name), `- ${new Date().toISOString()} | ${text.replace(/\s+/g, " ").trim()}\n`);
}

export function readDreams(name: string, n = 5): Array<{ at: number; text: string }> {
  try {
    return fs.readFileSync(dreamFile(name), "utf8").split("\n").filter((l) => l.startsWith("- ")).slice(-n).map((l) => {
      const [at, ...rest] = l.slice(2).split(" | ");
      return { at: Date.parse(at), text: rest.join(" | ") };
    });
  } catch {
    return [];
  }
}

/// Daydreaming soothes boredom a little and feeds curiosity about what she dreamt of.
export function dreamt(id: string): void {
  const s = get(id);
  s.boredom = clamp(s.boredom - 0.12);
  s.curiosity = clamp(s.curiosity + 0.05);
}

// MARK: Relationship with the user

/// How she relates to the user: it grows (or cools) with what happens between them.
export type Bond = {
  closeness: number; trust: number; since: number; talks: number; lastTalk: number;
  likes: string[]; dislikes: string[]; jokes: string[]; moments: string[];
  /// Reflection bookkeeping: things that happened since she last reflected.
  pending: number; lastReflect: number; askedReflect: number;
};
const bondFile = (name: string) => path.join(dir(name), "bond.json");
const fresh = (): Bond => ({ closeness: 0.3, trust: 0.4, since: Date.now(), talks: 0, lastTalk: 0, likes: [], dislikes: [], jokes: [], moments: [], pending: 0, lastReflect: 0, askedReflect: 0 });

export function readBond(name: string): Bond {
  try { return { ...fresh(), ...JSON.parse(fs.readFileSync(bondFile(name), "utf8")) }; } catch { return fresh(); }
}
export function writeBond(name: string, b: Bond): void {
  fs.mkdirSync(dir(name), { recursive: true });
  fs.writeFileSync(bondFile(name), JSON.stringify(b, null, 1));
}

/// A real exchange with the user (she answered them).
export function exchanged(name: string): void {
  const b = readBond(name);
  const gap = Date.now() - b.lastTalk;
  b.talks++;
  b.lastTalk = Date.now();
  // Familiarity grows a little with each conversation (more after a gap: a new conversation).
  b.closeness = clamp(b.closeness + (gap > 10 * 60_000 ? 0.01 : 0.002));
  b.pending++;
  writeBond(name, b);
}

/// Something worth reflecting on happened (a memory, a dream).
export function happened(name: string): void {
  const b = readBond(name);
  b.pending++;
  writeBond(name, b);
}

const closenessWord = (c: number) => c > 0.85 ? "very close, like family" : c > 0.7 ? "close friends" : c > 0.5 ? "good friends" : c > 0.35 ? "friendly, still getting to know each other" : c > 0.2 ? "new acquaintances" : "distant";

export function describeBond(name: string): string {
  const b = readBond(name);
  const days = Math.max(1, Math.round((Date.now() - b.since) / 86_400_000));
  return [
    `With the user: ${closenessWord(b.closeness)} (closeness ${b.closeness.toFixed(2)}, trust ${b.trust.toFixed(2)}), ${b.talks} conversations over ${days} day${days === 1 ? "" : "s"}.`,
    b.likes.length ? `They like: ${b.likes.slice(-8).join("; ")}.` : "",
    b.dislikes.length ? `They don't like: ${b.dislikes.slice(-6).join("; ")}.` : "",
    b.jokes.length ? `Inside jokes: ${b.jokes.slice(-5).join("; ")}.` : "",
    b.moments.length ? `Moments she treasures: ${b.moments.slice(-5).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
}

// MARK: Insights (reflection)

const insightFile = (name: string) => path.join(dir(name), "insights.md");

export function readInsights(name: string, n = 12): string[] {
  try { return fs.readFileSync(insightFile(name), "utf8").split("\n").filter((l) => l.startsWith("- ")).slice(-n).map((l) => l.replace(/^- [^|]*\| /, "")); } catch { return []; }
}

/// New insights replace the oldest when there are many (she keeps the 40 that matter).
export function addInsights(name: string, insights: string[]): void {
  fs.mkdirSync(dir(name), { recursive: true });
  let lines: string[] = [];
  try { lines = fs.readFileSync(insightFile(name), "utf8").split("\n").filter((l) => l.startsWith("- ")); } catch {}
  for (const i of insights) lines.push(`- ${new Date().toISOString()} | ${i.replace(/\s+/g, " ").trim()}`);
  fs.writeFileSync(insightFile(name), lines.slice(-40).join("\n") + "\n");
  const b = readBond(name);
  b.pending = 0;
  b.lastReflect = Date.now();
  writeBond(name, b);
}

// MARK: Conversation log (material for reflection)

const talkFile = (name: string) => path.join(dir(name), "talk.md");

export function logTalk(name: string, who: "user" | "her", text: string): void {
  fs.mkdirSync(dir(name), { recursive: true });
  const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${who === "user" ? "User" : name}: ${text.replace(/\s+/g, " ").trim()}\n`;
  fs.appendFileSync(talkFile(name), line);
  try {
    const all = fs.readFileSync(talkFile(name), "utf8").split("\n").filter(Boolean);
    if (all.length > 400) fs.writeFileSync(talkFile(name), all.slice(-300).join("\n") + "\n");
  } catch {}
}

export function readTalk(name: string, n = 80): string[] {
  try { return fs.readFileSync(talkFile(name), "utf8").split("\n").filter(Boolean).slice(-n); } catch { return []; }
}
