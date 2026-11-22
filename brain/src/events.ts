// Events from the phone, queued until the mind (a Claude Code chat) asks
// for them with wait_for_events. Some events wake the mind; the rest ride
// along as "meanwhile" notes. After a few quiet minutes an "idle" beat wakes
// it so characters keep living; after a long gap the next wake says how long
// the user was away (lazy catch-up).
import type { Grid } from "./map.js";
import * as jobs from "./jobs.js";
import * as beliefs from "./beliefs.js";
import * as groups from "./groups.js";
import * as roomjoin from "./roomjoin.js";
import { setLive } from "./rooms-api.js";
import * as frames from "./frames.js";
import * as roommap from "./roommap.js";
import type { Body, BodyEvent } from "./body.js";
import { bearing, facingUser, fromUser } from "./space.js";
import type { Life } from "./life.js";
import * as soul from "./soul.js";
import * as world from "./world.js";
import { suggest as suggestMoves } from "./moves.js";
import { react } from "./reflexes.js";
import * as store from "./store.js";
import { characterNode, emitActivity, moveNode } from "./ui.js";
import * as moves from "./moves.js";
import { allComposed } from "./compose.js";

const WAKING = new Set(["user_text", "button", "character_tap", "character_placed", "behavior_error", "walk_stuck", "connected"]);
/// Free time: after this long without the user interacting, she's woken to
/// live on her own, and again after each gap while it lasts (gaps grow if the
/// user stays away for long, so an app left open doesn't churn).
const FREE_AFTER_MS = Number(process.env.BRAIN_FREE_AFTER_S ?? 8) * 1000;
function freeGapMs(quietMs: number, ignored: number): number {
  // She's always up to something: when no plan is running, free time comes
  // again within seconds (her plans themselves ask for the next one before
  // they end). Unanswered ones back off a little.
  const base = quietMs > 30 * 60_000 ? 20_000 : quietMs > 10 * 60_000 ? 10_000 : 4_000;
  return Math.min(60_000, base * 2 ** Math.min(3, ignored));
}
const RETURN_GAP_MS = Number(process.env.BRAIN_RETURN_GAP_MIN ?? 20) * 60_000;
/// Dreaming: while the phone is away (disconnected, locked, nobody placed)
/// she keeps living in her head. Away counts after this long without a live
/// scene; dreams come on a rhythm that slows the longer the phone is gone.
/// Away this long and back: she greets the user.
const GREET_AFTER_MS = Number(process.env.BRAIN_GREET_AFTER_S ?? 180) * 1000;
const AWAY_AFTER_MS = Number(process.env.BRAIN_AWAY_AFTER_S ?? 15) * 1000;
function dreamGapMs(awayMs: number, ignored: number): number {
  // A thought now and then, not a stream: 2 min at first, then 6, then 20.
  const base = awayMs > 60 * 60_000 ? 1_200_000 : awayMs > 10 * 60_000 ? 360_000 : Number(process.env.BRAIN_DREAM_GAP_S ?? 120) * 1000;
  return Math.min(3_600_000, base * 2 ** Math.min(3, ignored));
}
/// Time of day as she feels it.
export function dayPart(d = new Date()): { part: string; hint: string } {
  const h = d.getHours();
  if (h >= 5 && h < 9) return { part: "early morning", hint: "waking up slowly, fresh, maybe a stretch" };
  if (h >= 9 && h < 12) return { part: "morning", hint: "awake and up for things" };
  if (h >= 12 && h < 17) return { part: "afternoon", hint: "her liveliest stretch of the day" };
  if (h >= 17 && h < 22) return { part: "evening", hint: "winding down, cosy, chatty" };
  return { part: "night", hint: "sleepy and quiet; soft voice, slow moves, maybe lying down" };
}
/// Learned from when the phone shows her: the hours the user is usually around.
export function usualHours(sessions: Array<{ start: number; end: number }>): string {
  const since = Date.now() - 21 * 86_400_000;
  const days = new Map<number, Set<string>>();
  const active = new Set<string>();
  for (const s of sessions) {
    if (s.end < since) continue;
    for (let t = Math.max(s.start, since); t < s.end; t += 15 * 60_000) {
      const d = new Date(t), day = d.toDateString();
      active.add(day);
      (days.get(d.getHours()) ?? days.set(d.getHours(), new Set()).get(d.getHours())!).add(day);
    }
  }
  if (active.size < 2) return "";
  const hours = [...Array(24).keys()].filter((h) => (days.get(h)?.size ?? 0) >= Math.max(2, active.size * 0.3));
  if (!hours.length) return "";
  const ranges: string[] = [];
  let a = hours[0], b = hours[0];
  for (const h of hours.slice(1).concat(-1)) {
    if (h === b + 1) { b = h; continue; }
    ranges.push(`${a}–${b + 1} h`);
    a = b = h;
  }
  return `The user is usually around ${ranges.join(" and ")} (seen on ${active.size} of the last 21 days).`;
}

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

/// Short speech that is still worth waking for ("stop", "come here", "yes").
const KEEP = new Set(("stop wait come here back sit stand up down jump dance walk run go follow stay look turn hi hello hey bye " +
  "yes no nope yep sure don't dont thanks thank please help what why where who how name sleep lie kneel wave again more").split(" "));
const FILLER = new Set(("so ok okay well um uh er hmm mm mhm like the a an and but this that i i'm just oh ah right nice " +
  "good cool yeah see let's lets check is it's its in of to my me you").split(" "));
/// Phrases that point at something in the room: a camera picture comes along.
const POINTING = /\b(there|that one|this one|over|look|see|watch|show|these|those|him|his|friend|door|window|table|sofa|couch|chair|bed|kitchen|outside|thing)\b/i;

/// Whether a phrase heard by speech recognition should wake the mind:
/// fragments ("So", "Okay, do a", "Galaxy") ride along as meanwhile notes.
export function worthWaking(text: string, names: string[]): boolean {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return false;
  const nameWords = new Set(names.flatMap((n) => n.toLowerCase().match(/[a-z']+/g) ?? []));
  if (words.some((w) => nameWords.has(w))) return true;
  if (words.every((w) => FILLER.has(w))) return false;
  // Cut off mid-sentence ("Okay, do a"): the rest usually follows.
  if (!/[?!]\s*$/.test(text) && /^(a|an|the|to|of|my|your|and|but|or|with|for)$/.test(words[words.length - 1])) return false;
  if (words.length >= 3) return true;
  return words.some((w) => KEEP.has(w));
}

export class EventHub {
  private waking: string[] = [];
  private meanwhile: string[] = [];
  private waiter: (() => void) | null = null;
  private lastWake = Date.now();
  /// When the user last spoke to her (and she answered), typed or tapped.
  private lastInteraction = Date.now();
  private speakingUntil = 0;
  private lastDrift = Date.now();
  /// Characters introduced to this chat (this brain process).
  private introducedNow = new Set<string>();
  /// Her life between interactions (plans the mind writes for her).
  life: Life | null = null;
  /// Free-time wakes in a row the mind did nothing with.
  private ignoredFree = 0;
  private lastWasFree = false;
  /// When the phone stopped showing her world (null while it does).
  private awaySince: number | null = null;
  private dreamsSinceAway = new Map<string, string[]>();
  private ignoredDreams = 0;
  private lastWasDream = false;

  /// The mind did something (any tool but waiting): it's engaged.
  acted(): void {
    this.ignoredFree = 0;
    this.lastWasFree = false;
    this.ignoredDreams = 0;
    this.lastWasDream = false;
  }

  /// Whether the phone is showing her world right now.
  private present(): boolean {
    return this.body.connected && Date.now() - this.body.sceneAt < 6000 && (this.body.scene?.characters.length ?? 0) > 0;
  }

  /// How long the phone has been away (null while it's here or only blinked).
  awayFor(): number | null {
    return this.awaySince !== null && Date.now() - this.awaySince >= AWAY_AFTER_MS ? Date.now() - this.awaySince : null;
  }

  /// The characters of her world: on the phone now, or the last ones it showed.
  knownCharacters(): Array<{ id: string; name: string; x: number; z: number; yaw: number }> {
    const live = this.body.scene?.characters ?? [];
    if (live.length) return live.map(({ id, name, x, z, yaw }) => ({ id, name, x, z, yaw }));
    if (this.state.known?.characters.length) return this.state.known.characters;
    return store.characterNames().filter((n) => soul.readProfile(n)).map((n) => ({ id: n, name: n, x: 0, z: 0, yaw: 0 }));
  }

  knownMap(): string | null {
    return (this.body.scene?.mapId as string | null) ?? this.state.known?.mapId ?? null;
  }

  /// She dreamt (the dream tool): kept for when the phone comes back.
  dreamt(id: string, text: string): void {
    const list = this.dreamsSinceAway.get(id) ?? [];
    list.push(text);
    this.dreamsSinceAway.set(id, list.slice(-6));
  }

  /// Notices the phone going away and coming back (checked every second).
  private checkAway(): void {
    const now = Date.now();
    if (this.present()) {
      const p = (this.state.presence ??= []);
      const last = p[p.length - 1];
      if (last && now - last.end < 5 * 60_000) last.end = now; else p.push({ start: now, end: now });
      if (p.length > 200) p.splice(0, p.length - 200);
      if (now - this.presenceSaved > 30_000) { this.presenceSaved = now; store.saveState(this.state); }
      if (this.awaySince !== null) {
        const away = now - this.awaySince;
        const leftAt = this.awaySince;
        this.awaySince = null;
        if (away >= AWAY_AFTER_MS) {
          const dreams = [...this.dreamsSinceAway].map(([id, d]) => `${id} daydreamed: ${d.map((t) => `“${t}”`).join(" → ")}`);
          this.dreamsSinceAway.clear();
          this.studiesThisAway = 0;
          this.dreamsThisAway = 0;
          emitActivity({ kind: "event", area: "senses", node: "sense:scene", label: `back from dreaming after ${ago(away)}` });
          const today = new Date().toDateString();
          const firstToday = !p.some((s) => s.start < leftAt && new Date(leftAt).toDateString() === today && new Date(Math.min(s.end, leftAt)).toDateString() === today);
          const { part } = dayPart();
          const greet = away >= GREET_AFTER_MS
            ? ` The user is back${firstToday ? ` for the first time today (${part})` : ""}: let her notice and greet them her way, as warmly as ${ago(away)} away and your relationship call for (a few minutes: a glance or smile; hours: a real welcome; ${part}: fitting words).`
            : "";
          void this.pushWithLook(away >= GREET_AFTER_MS, `The phone is back after ${ago(away)} away.${greet} ${dreams.length ? dreams.join(" ") + " Let her carry on from where her mind wandered (maybe do or mention what she dreamt of)." : ""}`.trim());
        }
      }
      return;
    }
    if (this.awaySince === null) { this.awaySince = now; return; }
    if (now - this.awaySince >= AWAY_AFTER_MS && !this.awayAnnounced) {
      this.awayAnnounced = true;
      this.life?.cancelAll("the phone is away");
      emitActivity({ kind: "event", area: "soul", label: "The phone is away: she drifts into daydreams" });
    }
    // Her needs keep drifting while she dreams.
    const dt = Math.min(10_000, now - this.lastDrift);
    this.lastDrift = now;
    for (const c of this.knownCharacters()) soul.drift(c.id, c, "dreaming", dt);
  }
  private awayAnnounced = false;
  private presenceSaved = 0;

  /// The user is here and doing something: her own plans give way.
  private userIsHere(): void {
    this.lastInteraction = Date.now();
    this.life?.cancelAll("the user is interacting");
  }

  /// Wakes the mind with a fresh camera picture attached (at most every 2
  /// minutes), so she sees where the user is before saying anything about it.
  private lastLook = 0;
  private async pushWithLook(wake: boolean, line: string): Promise<void> {
    if (this.body.connected && Date.now() - this.lastLook > 120_000) {
      const r = await this.body.command("snapshot", { longSide: 640 }, 4000).catch(() => null);
      if (r?.ok && r.data?.jpeg) {
        this.lastLook = Date.now();
        this.images.push(r.data.jpeg as string);
        line += "\n(A camera picture of where the user is now is attached: look at it before saying anything about the place.)";
      }
    }
    this.push(wake, line);
  }

  /// Something the runner or a sense wants the mind to see now.
  wakeWith(line: string, image?: string): void {
    if (image) this.images.push(image);
    this.push(true, line);
  }
  /// When the last phrase meant for her was heard.
  private heardAt = 0;

  /// She answered something the user said: that was a real exchange.
  answered(id?: string): void {
    if (Date.now() - this.heardAt < 20_000) {
      this.lastInteraction = Date.now();
      if (id) {
        soul.talkedTo(id);
        const name = this.body.characterName(id);
        if (name) soul.exchanged(name);
      }
    }
  }
  /// When she last started something with the user herself.
  private lastInitiative = 0;
  private returnGap: number | null = null;
  private state = store.loadState();
  /// Camera pictures taken for pointing phrases, delivered with the next wake.
  private images: string[] = [];
  /// Pictures a wake may carry (more for a study of camera memory).
  private maxImages = 2;
  /// Camera-memory studies while the phone is away (reset when it's back).
  private studiesThisAway = 0;
  private dreamsThisAway = 0;
  /// What the last wake's scene said, so unchanged parts aren't repeated.
  private lastScene: Record<string, string> = {};
  /// "c1:walk" — behaviours the mind wants to hear about when they finish.
  readonly notify = new Map<string, number>();

  /// Wake the mind when this character's behaviour ends, however it ends.
  watch(id: string, behavior: string): void {
    this.notify.set(`${id}:${behavior}`, Date.now());
  }

  private idNames = new Map<string, string>();

  constructor(private body: Body) {
    body.on("hello", () => this.onHello());
    body.on("frame", (data: Record<string, unknown>) => this.onFrame(data));
    body.on("pair_request", (r: { device: string; code: string; until: number }) => {
      const code = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
      log(`pairing code for ${r.device}: ${code}`);
      emitActivity({ kind: "event", area: "senses", node: "sense:scene", label: `${r.device} wants to pair: code ${code}` });
      this.push(true, `Pairing: the phone "${r.device}" wants to connect to this brain for the first time. Tell the user in the chat, as plain text in one short line (not with say): "Pairing code: ${code}: enter it on your phone (valid 10 minutes)." Then wait for events as usual.`);
    });
    body.on("paired", (device: string) => {
      log(`paired with ${device}`);
      emitActivity({ kind: "event", area: "senses", node: "sense:scene", label: `paired with ${device}`, grew: true });
    });
    setInterval(() => this.tidyFrames(), 5 * 60_000).unref();
    // Keep the phone's LiDAR scan of each room (for browsing rooms in the galaxy).
    setInterval(() => void this.keepScan(), 60_000).unref();
    setTimeout(() => this.tidyFrames(), 20_000).unref();
    // Background helpers: keep their job queue full (where she is, rooms to study or join, reflection).
    setInterval(() => this.keepJobs(), 15_000).unref();
    setLive(() => this.live());
    body.on("event", (e: BodyEvent) => this.onEvent(e));
    body.on("scene", () => {
      this.checkWatched();
      // Her needs drift with time and what she's doing.
      const now = Date.now();
      const dt = Math.min(10_000, now - this.lastDrift);
      this.lastDrift = now;
      for (const c of this.body.scene?.characters ?? []) {
        // The phone reuses ids (c1 is whoever was placed first): another
        // character under an old id starts with her own inner state.
        if (this.idNames.get(c.id) !== c.name) {
          if (this.idNames.has(c.id)) { soul.forgetInner(c.id); this.life?.forget(c.id); }
          this.idNames.set(c.id, c.name);
        }
        soul.drift(c.id, c, c.behavior, dt);
        world.track(c.id, c.x, c.z);
      }
      this.awayAnnounced = false;
      this.rememberWorld();
    });
    setInterval(() => this.checkAway(), 1000).unref();
    // Someone started talking (ears): hold free time for a few seconds, but
    // noise, music or her own voice must not keep resetting the clock.
    body.on("user_activity", () => { this.speakingUntil = Date.now() + 4000; });
    // The user talked over her: she stopped mid-sentence.
    body.on("barge", (heard: string) => {
      this.life?.cancelAll("the user is talking");
      emitActivity({ kind: "event", area: "voice", node: "voice:say", label: `she stops talking: the user talks over her (“${heard}”)` });
      this.push(false, `She stopped mid-sentence because the user started talking over her (it began “${heard}”). Listen; don't finish the old line unless they want it.`);
    });
    body.on("disconnected", () => {
      this.seen();
      emitActivity({ kind: "error", area: "senses", label: "The phone disconnected" });
      this.push(false, "The phone disconnected.");
    });
  }

  /// Connection the camera-memory frames come from (unsaved rooms are adopted per connection).
  private session = 0;
  private framesSeen = 0;
  private framesNoted = 0;

  /// A camera-memory frame: kept; a key frame of a saved room also fills in its lasting map.
  private onFrame(data: Record<string, unknown>): void {
    let meta: frames.FrameMeta | null = null;
    try { meta = frames.add(data, this.session); } catch (e) { log(`frame not stored: ${(e as Error).message}`); }
    if (!meta) return;
    this.framesSeen++;
    if (meta.key && meta.mapId) {
      roommap.fuse(meta, this.floorHint());
      frames.mark([meta], "fused");
    }
    if (Date.now() - this.framesNoted > 60_000) {
      this.framesNoted = Date.now();
      emitActivity({ kind: "event", area: "senses", node: "sense:camera", label: `camera memory: ${this.framesSeen} frames this visit, ${frames.all().length} kept` });
      roommap.save();
    }
  }

  /// The floor height the phone found (lowest floor plane), if any.
  private floorHint(): number | null {
    const ys = ((this.body.scene?.planes ?? []) as Array<Record<string, any>>).filter((p) => p.kind === "floor" && typeof p.y === "number").map((p) => p.y as number);
    return ys.length ? Math.min(...ys) : null;
  }

  private async keepScan(): Promise<void> {
    const mapId = this.body.scene?.mapId as string | null;
    if (!this.body.connected || !mapId || Date.now() - this.body.sceneAt > 10_000) return;
    const r = await this.body.command("map", {}, 15000).catch(() => null);
    if (r?.ok && r.data?.rows && (r.data.mapId ?? mapId) === mapId) roommap.savePhone(mapId, r.data as Grid);
  }

  private tidyFrames(): void {
    try {
      const r = frames.thin();
      if (r.removed) log(`camera memory: thinned ${r.removed} frames; ${r.frames} kept (${(r.bytes / 1024 ** 2).toFixed(0)} MB)`);
      roommap.save();
    } catch (e) { log(`camera memory tidy failed: ${(e as Error).message}`); }
  }

  private async onHello(): Promise<void> {
    this.session = Date.now();
    const r = await this.body.pushBehaviors(store.behaviorFiles());
    const made = allComposed();
    if (made.length) void this.body.pushMoves(made);
    const errors: string[] = r.data?.errors ?? [];
    log(`phone connected (${this.body.device}); behaviours ${errors.length ? "with errors: " + errors.join("; ") : "loaded"}`);
    emitActivity({ kind: "event", area: "senses", node: "sense:scene", label: "The phone connected", detail: this.body.device });
    const gap = this.state.lastSeen ? Date.now() - this.state.lastSeen : null;
    this.returnGap = gap !== null && gap > RETURN_GAP_MS ? gap : null;
    this.seen();
    // Give the phone a moment to report its scene.
    setTimeout(() => void this.pushWithLook(true, `The phone connected (${this.body.device}).`), 2500);
  }

  private onEvent(e: BodyEvent): void {
    this.seen();
    // A move started on the phone (any source): light that exact move, nothing for the mind.
    if (e.kind === "move_played") {
      const name = String(e.data.name ?? "");
      emitActivity({ kind: "event", area: "skills", node: moveNode(name), label: `${e.data.character} moves: ${moves.inLibrary(name)?.desc ?? name.replace(/_/g, " ")}`, detail: `${name} · ${e.data.seconds} s`, hold: Number(e.data.seconds) || 3 });
      return;
    }
    // Taps, buttons and typing are the user for sure; speech only once it
    // turns out to be meant for her (below), not every noise the mic picks up.
    if (e.kind === "button" || e.kind === "character_tap" || (e.kind === "user_text" && !e.data.speech)) this.userIsHere();
    const line = `${e.kind} ${JSON.stringify(e.data)}`;
    const ch = characterNode(this.body, e.data.character as string | undefined);
    switch (e.kind) {
      case "user_text":
        emitActivity({ kind: "event", area: "senses", node: e.data.speech ? "sense:speech" : "sense:touch", label: `“${String(e.data.text ?? "")}”` });
        break;
      case "character_tap": case "button":
        emitActivity({ kind: "event", area: "senses", node: "sense:touch", label: e.kind === "button" ? `button ${e.data.label}` : "tap on a character" });
        break;
      case "character_placed":
        emitActivity({ kind: "event", area: "characters", node: ch, label: `${e.data.name} placed`, grew: true });
        break;
      case "person_seen":
        emitActivity({ kind: "event", area: "senses", node: "sense:people", label: "someone else came into view" });
        break;
      case "walk_stuck":
        emitActivity({ kind: "error", area: "body", node: "behavior:walk", label: `${String(e.data.character ?? "")} got stuck walking` });
        break;
      case "behavior_error":
        emitActivity({ kind: "error", area: "body", node: `behavior:${e.data.behavior}`, label: `${e.data.behavior} failed`, detail: String(e.data.error ?? "") });
        break;
      default:
        emitActivity({ kind: "event", area: e.kind === "arrived" || e.kind === "behavior_done" ? "body" : "senses", node: e.data.behavior ? `behavior:${e.data.behavior}` : ch, label: e.kind.replace(/_/g, " ") });
    }
    log(`event ${line}`);
    if (e.kind === "room") {
      const info = e.data as { mapId?: string; status: string };
      this.roomNow = { mapId: info.mapId ?? null, status: info.status, at: Date.now() };
      if (info.status === "saved" && info.mapId) {
        world.adoptUnsaved(info.mapId, store.readPlaces, store.writePlaces);
        const adopted = frames.adopt(info.mapId, this.session).filter((m) => m.key && !m.fused);
        for (const m of adopted) roommap.fuse(m, this.floorHint());
        frames.mark(adopted, "fused");
        roommap.save();
      }
      const places = info.mapId ? store.readPlaces(info.mapId) : {};
      emitActivity({ kind: "event", area: "space", node: "space:map", label: `room: ${info.status}`, grew: info.status !== "new" });
      this.push(true, world.roomEvent(info, places));
      return;
    }
    if (e.kind === "user_text") {
      const spoken = e.data.speech === true;
      const said = String(e.data.text ?? "");
      const names = (this.body.scene?.characters ?? []).map((c) => c.name);
      if (spoken && worthWaking(said, names)) {
        this.heardAt = Date.now();
        this.life?.cancelAll("the user is talking");
      }
      if (spoken && !worthWaking(said, names)) {
        this.push(false, `Heard in passing (didn't wake you): "${said}"`);
        return;
      }
      const tone = e.data.tone ? ` (said ${e.data.tone})` : "";
      for (const c of this.body.scene?.characters ?? []) soul.logTalk(c.name, "user", `${said}${tone}`);
      const line = spoken
        ? `Heard (speech recognition, may contain errors or be talk not meant for her): "${said}"${tone}`
        : `The user types: "${said}"`;
      void (async () => {
        // Fast mind: clear everyday requests start at once, before the mind thinks.
        const reflex = this.body.connected ? await react(this.body, said).catch(() => null) : null;
        const full = reflex ? `${line}\n${reflex}` : line;
        if (POINTING.test(said) && this.body.connected) {
          // Look first, so the mind doesn't need a separate snapshot round trip.
          const r = await this.body.command("snapshot", { longSide: 640 }, 4000);
          if (r.ok && r.data?.jpeg) { this.images.push(r.data.jpeg as string); this.lastLook = Date.now(); }
          this.push(true, full + (r.ok ? "\n(The camera picture from that moment is attached.)" : ""));
        } else {
          this.push(true, full);
        }
      })();
    } else if (e.kind === "behavior_done") {
      const key = `${e.data.character}:${e.data.behavior}`;
      // Steps of her own plan finishing are the plan's business.
      if (this.life?.running(String(e.data.character)) && !this.notify.has(key)) return;
      this.push(this.notify.delete(key), `Finished: ${line}`);
    } else {
      // Her own plan handles a stuck walk itself.
      const inPlan = e.kind === "walk_stuck" && this.life?.running(String(e.data.character));
      if (e.kind === "character_placed") void this.pushWithLook(true, line);
      else this.push(WAKING.has(e.kind) && !inPlan, line);
    }
  }

  /// A watched behaviour that stopped without saying so (replaced, failed
  /// quietly, or the character was removed) still wakes the mind.
  private checkWatched(): void {
    const chars = this.body.scene?.characters ?? [];
    for (const [key, since] of this.notify) {
      if (Date.now() - since < 2500) continue;
      const [id, behavior] = key.split(":");
      const c = chars.find((x) => x.id === id);
      if (c && c.behavior === behavior) continue;
      this.notify.delete(key);
      this.push(true, c
        ? `Stopped: ${id}'s ${behavior} ended without finishing (she's now ${c.behavior} at x ${c.x.toFixed(2)}, z ${c.z.toFixed(2)}).`
        : `Stopped: ${id}'s ${behavior} ended (she's no longer in the scene).`);
    }
  }

  private push(wakes: boolean, line: string): void {
    (wakes ? this.waking : this.meanwhile).push(line);
    if (this.meanwhile.length > 40) this.meanwhile.splice(0, this.meanwhile.length - 40);
    if (wakes) this.waiter?.();
  }

  private worldSaved = 0;
  /// Keeps her world (characters, room) for when the phone is away, even across brain restarts.
  private rememberWorld(): void {
    const chars = this.body.scene?.characters ?? [];
    if (!chars.length || Date.now() - this.worldSaved < 20_000) return;
    this.worldSaved = Date.now();
    const r1 = (v: number) => Math.round(v * 10) / 10;
    this.state.known = { mapId: (this.body.scene?.mapId as string | null) ?? null, characters: chars.map(({ id, name, x, z, yaw }) => ({ id, name, x: r1(x), z: r1(z), yaw: r1(yaw) })) };
    store.saveState(this.state);
  }

  private seen(): void {
    this.state.lastSeen = Date.now();
    store.saveState(this.state);
  }

  /// A helper (background subagent) reports back to the main loop.
  report(text: string): void {
    emitActivity({ kind: "report", area: "helpers", label: text, grew: true });
    this.push(true, `Helper report: ${text}`);
  }

  private waiting = false;
  get isWaiting(): boolean {
    return this.waiting;
  }

  /// Resolves with the wake text once something wakes the mind, free time
  /// is due, or `timeoutMs` passes (then null).
  async next(timeoutMs: number): Promise<{ text: string; images: string[] } | null> {
    this.waiting = true;
    try {
      return await this.waitForWake(timeoutMs);
    } finally {
      this.waiting = false;
    }
  }

  private async waitForWake(timeoutMs: number): Promise<{ text: string; images: string[] } | null> {
    this.body.status(false);
    const deadline = Date.now() + timeoutMs;
    while (this.waking.length === 0) {
      const now = Date.now();
      const quiet = now - this.lastInteraction;
      // Only while the phone is live (it stops sending its scene when locked).
      const present = this.present();
      // Phone away: she dreams, on a slowing rhythm.
      const away = this.awayFor();
      if (away !== null && this.knownCharacters().length) {
        const dreamAt = Math.max(this.awaySince! + AWAY_AFTER_MS + 5_000, this.lastWake + dreamGapMs(away, this.ignoredDreams));
        if (now >= dreamAt) {
          if (this.lastWasDream) this.ignoredDreams++;
          this.lastWasDream = true;
          this.waking.push(this.dreamWake(away));
          break;
        }
      }
      // While she's busy with something you'll be told about, let her finish (up to a minute).
      const busy = this.notify.size > 0 ? 60_000 : 0;
      // While she's living a plan, the plan wakes the mind when it ends.
      const living = this.life?.running() ?? false;
      const freeAt = living ? Infinity : Math.max(this.lastInteraction + FREE_AFTER_MS, this.lastWake + Math.max(freeGapMs(quiet, this.ignoredFree), busy));
      // Hold for speech only when the user has been talking to her lately.
      const talking = now < this.speakingUntil && now - this.heardAt < 20_000;
      if (present && now >= freeAt && !talking) {
        const starter = this.initiativeDue(quiet);
        if (starter) {
          this.lastInitiative = now;
          this.waking.push(starter);
          break;
        }
        if (this.lastWasFree) this.ignoredFree++;
        this.lastWasFree = true;
        this.waking.push(await this.freeTime(quiet));
        break;
      }
      const left = deadline - now;
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(50, Math.min(left, present ? 15_000 : 1_000, present && freeAt !== Infinity ? freeAt - now : 15_000)));
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = null;
    }
    this.lastWake = Date.now();
    this.body.status(true);
    const batch = this.waking.splice(0);
    emitActivity({ kind: "wake", area: "mind", node: /^Free time/.test(batch[0] ?? "") ? "mind:free" : /^Dreaming/.test(batch[0] ?? "") ? "mind:dreams" : "mind", label: (batch[0]?.split("\n")[0] ?? "woke up").replace(/^Heard \(speech recognition[^)]*\): /, "Heard: ").slice(0, 120), detail: batch.length > 1 ? `+${batch.length - 1} more` : undefined });
    const images = this.images.splice(0).slice(-this.maxImages);
    this.maxImages = 2;
    return { text: this.compose(batch), images };
  }

  /// Sometimes she starts something with the user herself: when she wants
  /// company, they're in front of her, it's been a while since she last did.
  private initiativeDue(quietMs: number): string | null {
    const now = Date.now();
    if (now - this.lastInitiative < 4 * 60_000 || quietMs < 40_000 || quietMs > 30 * 60_000) return null;
    const scene = this.body.scene;
    const u = (scene?.user ?? {}) as Record<string, number>;
    const user = { x: u.x ?? 0, z: u.z ?? 0, yaw: u.yaw ?? 0 };
    const c = (scene?.characters ?? []).find((ch) => Math.abs(bearing(user, user.yaw, ch)) < 32 && Math.hypot(ch.x - user.x, ch.z - user.z) < 6);
    if (!c) return null;
    const st = soul.innerState(c.id);
    const want = st.needs.company * 0.6 + st.needs.boredom * 0.3 + (st.emotions[0]?.intensity ?? 0) * 0.2;
    if (want < 0.45 || Math.random() > want) return null;
    const { part, hint } = dayPart();
    const dreams = soul.readDreams(c.name, 2).map((d) => d.text);
    return [
      `Initiative: ${c.id} (${c.name}) wants to start something with the user herself (they're in front of her, quiet for ${ago(quietMs)}; she ${st.needs.company > 0.6 ? "misses company" : "is a bit bored"}). It's ${part} (${hint}).`,
      `Make it hers and specific: show them something she found or dreamt of${dreams.length ? ` (lately: ${dreams.join(" / ")})` : ""}, ask about their day, recall an inside joke, invite them to dance or watch her try a move, share a thought about the room or the time of day. One short line with an action (walk over, gesture), then let them answer. If they don't react, she goes back to her own life without fuss.`,
      soul.describeBond(c.name),
    ].join("\n");
  }

  private reflectJob(name: string): string {
    return `Reflect for ${name} (use exactly this name in every call). Call soul_review with character "${name}". Think about what it adds up to, then: (1) call reflect with 1–3 new insights, only ones the record clearly supports (something the user said or did more than once, a real preference, a pattern); don't read psychology into one short exchange, don't build on dreams (they're imagination), and add nothing rather than guess; don't repeat existing insights; (2) call relate if the relationship moved (small closeness/trust steps, likes, dislikes, an inside joke, a treasured moment); (3) if her life plan should change, call update_life. Result line: "${name} reflected: <one line>".`;
  }

  // MARK: Background jobs and the rooms view

  private roomNow: { mapId: string | null; status: string; at: number } = { mapId: null, status: "unknown", at: 0 };
  private lastLocate = 0;
  private locateMap: string | null | undefined;
  private lastJoinScan = 0;

  /// Keeps the helpers' queue full: where she is (every 2 min, or when the
  /// room changes), rooms with pictures nobody studied, rooms that may be
  /// the same room. Reflection is queued by reflectionBrief.
  private keepJobs(): void {
    try {
      jobs.reap();
      if (jobs.getTarget() === 0) return;
      const now = Date.now();
      const mapId = (this.body.scene?.mapId as string | null) ?? null;
      if (this.present() && (mapId !== this.locateMap || now - this.lastLocate > 120_000) && !jobs.has("locate")) {
        this.lastLocate = now; this.locateMap = mapId;
        const recent = frames.all().filter((m) => m.mapId === mapId).slice(-12);
        const pics = [recent.at(-1), recent.at(-6)].filter(Boolean) as frames.FrameMeta[];
        const images = pics.map((m) => frames.jpeg(m)).filter(Boolean) as string[];
        jobs.add({ kind: "locate", key: "locate", title: "where is she?", brief: this.locateBrief(mapId, pics), images });
      }
      // Rooms with pictures nobody has studied closely.
      for (const id of new Set(frames.all().filter((m) => m.mapId).map((m) => groups.canonical(m.mapId!).id))) {
        if (jobs.has(`study:${id}`)) continue;
        const group = new Set(groups.members(id).map((m) => m.mapId));
        const fresh = frames.all().filter((m) => m.key && !m.studied && m.mapId && group.has(m.mapId));
        if (fresh.length < 4) continue;
        const picks = frames.varied(fresh.slice(-200), 5);
        const images = picks.map((m) => frames.jpeg(m)).filter(Boolean) as string[];
        if (images.length < picks.length) { frames.mark(picks, "studied"); continue; }
        jobs.add({ kind: "study", key: `study:${id}`, title: `study ${world.readRooms()[id]?.name || "a room"}`, brief: this.studyBrief(id, picks), images, onTake: () => frames.mark(picks, "studied") });
      }
      // Rooms that may be the same room (re-scored every 2 minutes).
      if (now - this.lastJoinScan > 120_000) {
        this.lastJoinScan = now;
        for (const p of roomjoin.refresh().slice(0, 2)) {
          const key = `join:${p.a}|${p.b}`;
          if (jobs.has(key)) continue;
          const pick = (id: string) => frames.varied(frames.all().filter((m) => m.key && m.mapId === id).slice(-100), 2);
          const pa = pick(p.a), pb = pick(p.b);
          const images = [...pa, ...pb].map((m) => frames.jpeg(m)).filter(Boolean) as string[];
          jobs.add({ kind: "join", key, title: `same room? ${this.roomLabel(p.a)} / ${this.roomLabel(p.b)}`, brief: this.joinBrief(p, pa.length, pb.length), images, onTake: () => roomjoin.mark(p.a, p.b, "asked") });
        }
      }
    } catch (e) { log(`jobs: ${(e as Error).message}`); }
  }

  private roomLabel(mapId: string | null): string {
    if (!mapId) return "an unsaved room";
    const c = groups.canonical(mapId).id;
    const r = world.readRooms()[c] ?? world.readRooms()[mapId];
    return r?.name ? `"${r.name}" (map ${mapId.slice(0, 8)})` : `unnamed map ${mapId.slice(0, 8)}`;
  }

  private roomsKnown(): string {
    const rooms = world.readRooms();
    return Object.entries(rooms).filter(([id]) => groups.isCanonical(id)).map(([id, r]) => {
      const things = Object.keys(world.readThings(id)).slice(0, 12);
      const joined = groups.members(id).length - 1;
      return `- ${r.name || "unnamed"} (map ${id})${joined ? ` [joined with ${joined} other map${joined > 1 ? "s" : ""}]` : ""}${r.description ? `: ${r.description}` : ""}${things.length ? `. Things: ${things.join(", ")}` : ""}`;
    }).join("\n") || "(none yet)";
  }

  /// Her position in words: the nearest things and places she knows.
  private nearWords(mapId: string | null, p: { x: number; z: number }): string {
    if (!mapId) return "";
    const spots = [...Object.entries(world.readThings(mapId)).map(([n, t]) => ({ n, x: t.x, z: t.z })), ...Object.entries(store.readPlaces(mapId)).map(([n, q]) => ({ n, x: q.x, z: q.z }))]
      .map((s) => ({ ...s, d: Math.hypot(s.x - p.x, s.z - p.z) })).sort((a, b) => a.d - b.d).slice(0, 3);
    return spots.map((s) => `${s.d.toFixed(1)} m from the ${s.n}`).join(", ");
  }

  private locateBrief(mapId: string | null, pics: frames.FrameMeta[]): string {
    const scene = this.body.scene;
    const u = (scene?.user ?? {}) as Record<string, number>;
    const chars = (scene?.characters ?? []).map((c) => `${c.id} ${c.name} at x ${c.x.toFixed(1)}, z ${c.z.toFixed(1)}${this.nearWords(mapId, c) ? ` (${this.nearWords(mapId, c)})` : ""}`);
    return [
      `Work out where she is right now, like a person walking into a room would. ${pics.length ? `The ${pics.length} attached pictures are what the phone's camera saw in the last seconds (newest first).` : "No camera pictures yet: use what you know."}`,
      `The phone says: map ${mapId ?? "none (not saved yet)"}, ${this.roomNow.mapId === mapId ? `status "${this.roomNow.status}"` : "no recognition status"}${mapId ? `; this map is ${this.roomLabel(mapId)}` : ""}.`,
      `Characters: ${chars.join("; ") || "none placed"}. The user (the phone) is at x ${(u.x ?? 0).toFixed(1)}, z ${(u.z ?? 0).toFixed(1)}${this.nearWords(mapId, { x: u.x ?? 0, z: u.z ?? 0 }) ? ` (${this.nearWords(mapId, { x: u.x ?? 0, z: u.z ?? 0 })})` : ""}.`,
      `Rooms she knows:\n${this.roomsKnown()}`,
      `Then call room_belief once: room (the room's name: an existing one if this is a room she knows, else a fitting new name), same_as (the map id of a known room if this map looks like it but isn't joined with it yet), confidence 0–1, where (where she is in the room in plain words, by the things around her), user (where the user is), reasoning (2–4 plain sentences: what in the pictures and map made you think so, and what doesn't fit). Only what you can see or know; say when you're unsure. If this map has no name yet and you're fairly sure (0.7+), also call name_room with that name and a one-sentence description. Result line: "<room>, <confidence>".`,
    ].join("\n");
  }

  private studyBrief(id: string, picks: frames.FrameMeta[]): string {
    const known = Object.keys(world.readThings(id));
    return [
      `Study ${this.roomLabel(id)}: ${picks.length} camera-memory pictures nobody has looked at closely are attached, in this order:`,
      ...picks.map((m, i) => { const c = frames.camera(m); return `${i + 1}. frame ${m.t}: ${new Date(m.t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}, camera at x ${c.x.toFixed(1)}, z ${c.z.toFixed(1)}`; }),
      `Add to what she knows of this place, only from what is clearly visible: note_from_frame for specific things (frame id, u from the left, v from the top; kind "door" or "window" for those), name_room with a short description if it has none or you can describe it better. Skip what she already knows${known.length ? ` (${known.slice(0, 30).join(", ")})` : ""}. Nothing to add is fine. Result line: what you added.`,
    ].join("\n");
  }

  private joinBrief(p: roomjoin.Pair, na: number, nb: number): string {
    return [
      `Are these the same room? The phone saved two maps: A = ${this.roomLabel(p.a)} and B = ${this.roomLabel(p.b)}. Pictures 1–${na} are from A, ${na + 1}–${na + nb} from B.`,
      p.score < 0 ? `Their maps are too small to compare (saved before camera memory, or barely scanned): judge by the pictures${na + nb ? "" : " (none kept) and names"} only, and only join if you're confident.`
        : `Their LiDAR maps line up with a score of ${p.score} (how well walls and furniture land on each other both ways, above chance, when best turned and shifted; 0.5+ is a strong match, under 0.3 weak).`,
      `Rooms she knows:\n${this.roomsKnown()}`,
      `Compare what you see: furniture, windows, doors, walls, floor, light. If clearly the same room, call join_rooms with a "${p.a}", b "${p.b}" and why. If clearly different rooms, call keep_rooms_apart with both and why. If you can't tell, do neither. Result line: your decision.`,
    ].join("\n");
  }

  /// Live state for the galaxy's rooms view.
  private live() {
    const scene = this.body.scene;
    const mapId = (scene?.mapId as string | null) ?? null;
    const canon = mapId ? groups.canonical(mapId) : null;
    const toCanon = (p: { x: number; z: number; yaw?: number }) => {
      if (!canon?.xf) return p;
      const q = groups.apply(canon.xf, p);
      return { ...q, ...(p.yaw !== undefined ? { yaw: groups.applyYaw(canon.xf, p.yaw) } : {}) };
    };
    const u = (scene?.user ?? {}) as Record<string, number>;
    return {
      connected: this.body.connected, present: this.present(), mapId, room: canon?.id ?? null, roomName: canon ? world.readRooms()[canon.id]?.name ?? "" : "",
      recognition: this.roomNow,
      characters: (scene?.characters ?? []).map((c) => ({ id: c.id, name: soul.readProfile(c.name)?.name ?? c.name, ...toCanon({ x: c.x, z: c.z, yaw: c.yaw }), near: this.nearWords(mapId, c), doing: this.life?.current(c.id)?.note ?? "" })),
      user: scene ? { ...toCanon({ x: u.x ?? 0, z: u.z ?? 0, yaw: u.yaw ?? 0 }), near: this.nearWords(mapId, { x: u.x ?? 0, z: u.z ?? 0 }) } : null,
      beliefs: beliefs.recent(10),
      jobs: jobs.status(),
    };
  }

  /// Reflection is due: the main loop hands it to a background helper (a ready brief).
  private reflectionBrief(): string {
    const now = Date.now();
    const lines: string[] = [];
    for (const c of this.knownCharacters()) {
      const b = soul.readBond(c.name);
      const due = b.pending >= (this.awayFor() !== null ? 8 : 20) && now - b.askedReflect > 30 * 60_000;
      if (!due) continue;
      if (jobs.getTarget() > 0) {
        if (!jobs.has(`reflect:${c.name}`)) {
          b.askedReflect = now;
          soul.writeBond(c.name, b);
          jobs.add({ kind: "reflect", key: `reflect:${c.name}`, title: `${c.name} reflects`, brief: this.reflectJob(c.name) });
        }
        continue;
      }
      b.askedReflect = now;
      soul.writeBond(c.name, b);
      lines.push(`Reflection is due for ${c.name}: ${b.pending} new memories, dreams and conversations. Don't do it yourself: start a background helper now (Agent tool, run_in_background, model "sonnet") with this brief, then carry on with this wake:\n> You are ${c.name}'s reflection, working quietly in the background for the Drillin AIR soul. Call soul_review with character "${c.name}" (use exactly this name in every call). Think about what it adds up to, then: (1) call reflect with 1–3 new insights, only ones the record clearly supports (something the user said or did more than once, a real preference, a pattern); don't read psychology into one short exchange, don't build on dreams (they're imagination), and add nothing rather than guess; don't repeat existing insights; (2) call relate if the relationship moved (small closeness/trust steps, likes, dislikes, an inside joke, a treasured moment); (3) if her life plan should change, call update_life. Never call wait_for_events, say, run_behavior, play_animation or live. Finish with report: "${c.name} reflected: <one line>".`);
    }
    return lines.join("\n");
  }

  /// A dreaming wake: everything she knows of her world, her last dreams, how she feels.
  /// Every other dream while the phone is away (up to 3 times), she studies
  /// camera memory of the last room instead: a few varied frames she hasn't
  /// looked at closely, to learn the place (things, doors, what the room is).
  private studyWake(mapId: string | null): string | null {
    if (jobs.getTarget() > 0) return null; // helpers study rooms in the background
    if (this.studiesThisAway >= Number(process.env.BRAIN_STUDIES_PER_AWAY ?? 3) || this.dreamsThisAway % 2 === 1) return null;
    const fresh = frames.all().filter((m) => m.key && !m.studied && (mapId ? m.mapId === mapId : true));
    if (fresh.length < 3) return null;
    const picks = frames.varied(fresh.slice(-200), 5);
    const pics = picks.map((m) => frames.jpeg(m));
    if (pics.some((p) => !p)) { frames.mark(picks, "studied"); return null; }
    frames.mark(picks, "studied");
    this.studiesThisAway++;
    this.images.push(...(pics as string[]));
    this.maxImages = picks.length;
    const room = mapId ? world.readRooms()[mapId] : undefined;
    const known = Object.keys(world.readThings(mapId));
    const desc = picks.map((m, i) => {
      const c = frames.camera(m);
      const who = m.characters?.length ? `, ${m.characters.map((x) => x.name).join(" and ")} in view` : "";
      return `${i + 1}. frame ${m.t}: ${new Date(m.t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}, camera at x ${c.x.toFixed(1)}, z ${c.z.toFixed(1)}, looking ${c.pitch < -0.6 ? "down" : c.pitch > 0.4 ? "up" : "ahead"}${who}`;
    });
    return [
      `Studying the place (the phone is away; this is quiet study instead of a dream). ${picks.length} camera-memory pictures of ${room?.name ? `"${room.name}"` : "the last room"} she hasn't looked at closely are attached, in this order:`,
      ...desc,
      `Look at them carefully and add to what she knows of this place, only from what is clearly visible: \`note_from_frame\` for specific things (frame number, u from the left, v from the top; kind "door" or "window" for those, so they show on her map), \`name_room\` with a short description if you can tell what the room is${room?.name ? "" : " (it has no name yet)"}, \`remember\` anything about the user's home worth knowing. Skip what she already knows${known.length ? ` (${known.slice(0, 25).join(", ")})` : ""}. Nothing to add is fine. No dream needed this time.`,
    ].join("\n");
  }

  private dreamWake(awayMs: number): string {
    const mapId = this.knownMap();
    this.dreamsThisAway++;
    const study = this.studyWake(mapId);
    if (study) return study;
    const rooms = world.readRooms();
    const lines = [
      `Dreaming (the phone has been away for ${ago(awayMs)}: locked, closed or out of reach. She has no body or voice right now, and that's fine). Her life goes on inside her head. Write what passes through her head with \`dream\`: one or two plain first-person sentences, the way a real person's mind idles (thinking back to something that happened, wondering about a thing she noticed, looking forward to something small, missing the user a little). Grounded in what really happened and what she has really seen; no fantasy adventures, no inventing new places or people, no plans to open businesses. Quiet is fine. Don't call body tools (walk, say, play, live, run_behavior): they wait for the phone. When it's back you'll be told, and she carries on from where her mind wandered.`,
    ];
    const roomNames = Object.entries(rooms).map(([id, r]) => `${r.name || "an unnamed room"}${id === mapId ? " (where she was last)" : ""}${r.description ? ` (${r.description})` : ""}`);
    if (roomNames.length) lines.push(`Rooms she knows: ${roomNames.join(", ")}.`);
    const things = Object.entries(world.readThings(mapId)).map(([n, t]) => `${n}${t.note ? ` (${t.note})` : ""}`);
    if (things.length) lines.push(`Things she noticed there: ${things.join("; ")}.`);
    const places = Object.keys(store.readPlaces(mapId));
    if (places.length) lines.push(`Places she knows there: ${places.join(", ")}.`);
    for (const c of this.knownCharacters()) {
      const dreams = soul.readDreams(c.name, 4);
      const memories = store.readCharacter(c.name, "memory").split("\n").filter((l) => l.trim()).slice(-4).map((l) => l.replace(/^- /, ""));
      const e = this.life?.energy(c.id);
      lines.push([
        `${c.id} (${c.name}): ${soul.describeInner(c.id)}${e ? `; energy ${e.level} (${e.label.split(":")[0]})` : ""}.`,
        `Before the phone went away: ${this.life?.history(c.id) ?? "nothing recorded"}.`,
        dreams.length ? `Her last dreams (continue the thread, don't repeat): ${dreams.map((d) => `[${ago(Date.now() - d.at)} ago] ${d.text}`).join(" · ")}` : "This is her first daydream.",
        memories.length ? `Recent memories: ${memories.join("; ")}.` : "",
        soul.readInsights(c.name, 5).length ? `What she has come to understand: ${soul.readInsights(c.name, 5).join("; ")}.` : "",
        soul.describeBond(c.name),
      ].filter(Boolean).join(" "));
    }
    if (this.ignoredDreams > 0) lines.push("(You let the last dream pass. Her mind doesn't stop: give her a thought.)");
    return lines.join("\n");
  }

  /// A free-time wake with what she needs to choose well: her energy, what
  /// she did lately, places and things near her, the moves she knows.
  private async freeTime(quietMs: number): Promise<string> {
    const secs = Math.round(quietMs / 1000);
    const quiet = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
    const scene = this.body.scene;
    const moves = Object.keys(store.behaviorFiles()).filter((n) => n.startsWith("anim_")).map((n) => n.slice(5));
    const places = Object.entries(store.readPlaces(scene?.mapId as string | null));
    const lines = [`Free time (the user hasn't interacted for ${quiet}; that's normal, they may be busy or out of view). Her own life goes on: write her next stretch with \`live\`: 8–16 steps, always busy, short pauses (2–5 s), plenty of moves from her library.`];
    for (const c of scene?.characters ?? []) {
      const e = this.life?.energy(c.id);
      const near = (p: { x: number; z: number }) => Math.hypot(p.x - c.x, p.z - c.z);
      const things = (scene?.planes as Array<Record<string, any>> ?? [])
        .filter((p) => ["seat", "table", "window", "door", "bed", "surface"].includes(p.kind))
        .map((p) => ({ kind: p.kind, d: near(p as any), x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }))
        .sort((a, b) => a.d - b.d).slice(0, 6)
        .map((p) => `${p.kind} ${p.d.toFixed(1)} m away (x ${p.x}, z ${p.z})${p.kind === "seat" || p.kind === "bed" ? " — sit_on works here" : ""}`);
      const history = this.life?.history(c.id) ?? "";
      const unvisited = places.filter(([n]) => !history.includes(n)).map(([n, p]) => `${n} (${near(p).toFixed(1)} m)`);
      const known = Object.entries(world.readThings(scene?.mapId as string | null))
        .sort((a, b) => a[1].visits - b[1].visits).slice(0, 6)
        .map(([n, t]) => `${n} (${near(t).toFixed(1)} m ${world.towards(c, t)}${t.visits ? `, been there ${t.visits}×` : ", not been to yet"})`);
      const fresh = await world.unexplored(this.body, c.id, c).catch(() => [] as string[]);
      const ideas = suggestMoves(e?.level ?? 0.5, history).map((m) => `${m.name} (${m.desc}, ${m.seconds} s)`);
      lines.push([
        `${c.id} (${c.name}): energy ${e?.level} — ${e?.label}; ${soul.describeInner(c.id)}.`,
        `Lately: ${history}.`,
        unvisited.length ? `Places she hasn't been to lately: ${unvisited.join(", ")}.` : "",
        known.length ? `Things she has noticed in this home: ${known.join("; ")}.` : "",
        fresh.length ? `Parts of the room she hasn't explored yet: ${fresh.join("; ")}.` : "",
        things.length ? `Furniture near her: ${things.join("; ")}.` : "",
        ideas.length ? `Moves from her library that fit her energy right now: ${ideas.join("; ")}.` : "",
        `Her own made moves: ${moves.join(", ") || "none yet"}. Find more with find_moves.`,
        soul.readInsights(c.name, 4).length ? `What she has come to understand: ${soul.readInsights(c.name, 4).join("; ")}.` : "",
      ].filter(Boolean).join(" "));
    }
    if (this.ignoredFree > 0) lines.push("(You let the last free time pass. She doesn't wait for anyone: give her something to live.)");
    return lines.join("\n");
  }

  private compose(events: string[]): string {
    const scene = this.body.scene;
    const { part, hint } = dayPart();
    const routine = usualHours(this.state.presence ?? []);
    const parts: string[] = [`Time: ${new Date().toString()} — ${part} (${hint}).${routine ? ` ${routine}` : ""}`];
    const brief = this.reflectionBrief();
    if (brief) events = [...events, brief];
    const more = jobs.needed();
    if (more > 0) {
      jobs.requestedNow(more);
      const st = jobs.status();
      events = [...events, `Background helpers: ${st.workers.length} of ${st.target} running. Start ${more} more now, all in one message: ${more} Agent tool call${more > 1 ? "s" : ""} with run_in_background true, model "sonnet", description "soul helper", each with exactly this prompt (then carry on with this wake; never wait for them):\n> ${jobs.WORKER_BRIEF}`];
    }
    if (this.returnGap) {
      const hours = this.returnGap / 3_600_000;
      parts.push(
        `The user is back after ${hours >= 1 ? hours.toFixed(1) + " hours" : Math.round(hours * 60) + " minutes"} away. ` +
          "Decide what each character did meanwhile (true to her persona and life plan), let it show, and update her life plan.",
      );
      this.returnGap = null;
    }
    const away = this.awayFor();
    if (away !== null) parts.push(`The phone is away (${ago(away)}): she's dreaming; body tools wait for it.`);
    for (const c of scene?.characters?.length ? scene.characters : this.knownCharacters()) {
      // Once per chat (each new chat needs to know who she is).
      if (this.introducedNow.has(c.name)) continue;
      this.introducedNow.add(c.name);
      if (!this.state.introduced.includes(c.name)) this.state.introduced.push(c.name);
      parts.push(introduce(c.id, c.name));
    }
    store.saveState(this.state);
    parts.push(...events);
    if (this.meanwhile.length) parts.push(`Meanwhile:\n${this.meanwhile.splice(0).map((l) => `- ${l}`).join("\n")}`);
    if (away !== null) {
      // The phone isn't showing her world: no stale positions; resend it all on return.
      this.lastScene = {};
      parts.push(`Scene: the phone is away. Last seen: ${this.knownCharacters().map((c) => `${c.id} (${c.name})`).join(", ") || "nobody"} in ${world.readRooms()[this.knownMap() ?? ""]?.name || "an unnamed room"}.`);
    } else {
      parts.push(`Scene: ${this.sceneDiff()}`);
    }
    return parts.join("\n\n");
  }

  /// The scene for a wake: characters and the user always; the room parts
  /// (planes, places, props, behaviours, map) only when they changed.
  private sceneDiff(): string {
    const full = compactScene(this.body);
    if (typeof full !== "object" || full === null) return JSON.stringify(full);
    const out: Record<string, unknown> = {};
    const same: string[] = [];
    for (const [k, v] of Object.entries(full as Record<string, unknown>)) {
      if (k === "note") continue;
      const json = JSON.stringify(v);
      if (k === "user" || k === "characters" || this.lastScene[k] !== json) out[k] = v;
      else same.push(k);
      this.lastScene[k] = json;
    }
    if (same.length) out.unchanged = same.join(", ");
    return JSON.stringify(out);
  }
}

export function introduce(id: string, name: string): string {
  const profile = soul.readProfile(name);
  const persona = store.readCharacter(name, "persona");
  const memory = store.readCharacter(name, "memory");
  const life = store.readCharacter(name, "life");
  if (!profile) {
    // Born from a random seed (or grown from what we already know of her).
    const known = [persona && `What you already know of her:\n${persona}`, memory && `Memories:\n${memory}`].filter(Boolean).join("\n");
    return [`${id} is "${name}" and doesn't have a full soul yet. Build her one now with create_soul: a believable, grounded young woman you'd actually enjoy living with, specific but not a bundle of quirks${known ? ", true to what you already know" : ""}. Seed for who she is (use it, make it hers): ${soul.seed()}`, known].filter(Boolean).join("\n");
  }
  const insights = soul.readInsights(name, 12);
  return [`${id} is "${name}". Her soul:\n${soul.describeProfile(profile)}`, soul.describeBond(name), insights.length && `What she has come to understand:\n${insights.map((i) => `- ${i}`).join("\n")}`, memory && `Memories:\n${memory}`, life && `Life plan:\n${life}`]
    .filter(Boolean)
    .join("\n");
}

export function compactScene(body: Body): unknown {
  const scene = body.scene;
  if (!scene) return body.connected ? "no scene yet" : "phone not connected";
  const u = scene.user as Record<string, number>;
  const user = { x: u.x ?? 0, z: u.z ?? 0, yaw: u.yaw ?? 0 };
  const places = store.readPlaces(scene.mapId as string | null);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    note: "fromUser: distance and direction as the user sees it (left/right = the user's left/right). Coordinates are for tools.",
    user: { x: r2(user.x), z: r2(user.z), yaw: r2(user.yaw) },
    characters: scene.characters.map(({ id, name, x, z, yaw, behavior, selected, canWalk }) => ({
      id, name, behavior, selected, canWalk,
      // On the user's screen right now (roughly inside the camera's view).
      onScreen: Math.abs(bearing(user, user.yaw, { x, z })) < 32,
      inner: soul.describeInner(id),
      fromUser: fromUser(user, { x, z }),
      stance: facingUser({ x, z, yaw }, user),
      x: r2(x), z: r2(z), yaw: r2(yaw),
    })),
    places: Object.entries(places).map(([name, p]) => ({ name, fromUser: fromUser(user, p), x: r2(p.x), z: r2(p.z) })),
    things: Object.entries(world.readThings(scene.mapId as string | null)).map(([name, t]) => ({ name, kind: t.kind, x: r2(t.x), z: r2(t.z) })),
    // Other people the camera sees in the room right now (not the user: they hold the phone).
    people: ((scene.people as Array<{ x: number; z: number }>) ?? []).map((p) => ({ fromUser: fromUser(user, p), x: r2(p.x), z: r2(p.z) })),
    planes: (scene.planes as Array<Record<string, any>>)
      .filter((p) => p.kind !== "ceiling")
      .map((p) => ({ id: p.id, kind: p.kind, size: `${Number(p.w).toFixed(1)}×${Number(p.d).toFixed(1)} m`, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 })),
    props: scene.props,
    behaviors: scene.behaviors,
    room: scene.mapId ? (world.readRooms()[scene.mapId as string]?.name || `unnamed room (map ${String(scene.mapId).slice(0, 8)})`) : "not saved yet (saved automatically soon)",
  };
}

/// Logs go to stderr: stdout is the MCP channel.
export function log(line: string): void {
  process.stderr.write(`[brain] ${line}\n`);
}
