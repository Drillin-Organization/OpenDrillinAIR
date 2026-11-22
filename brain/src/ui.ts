// The brain galaxy: a local web page (http://localhost:8788) that shows the
// mind live — its areas, what it knows (behaviours, animations, memories,
// places, characters) and every thought, sense and action as pulses. The
// page gets a snapshot from /graph and a live stream from /events (SSE).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Body } from "./body.js";
import type { Ears } from "./ears.js";
import type { Life } from "./life.js";
import * as moves from "./moves.js";
import * as soul from "./soul.js";
import * as store from "./store.js";
import type { Voice } from "./voice.js";
import type { EventHub } from "./events.js";
import * as world from "./world.js";

/// Live parts of the brain the page reads (set by main.ts and tools.ts).
export const wiring: { life?: Life; ears?: Ears; voice?: Voice; hub?: EventHub } = {};

export type Activity = {
  t: number;
  kind: "event" | "tool" | "result" | "wake" | "report" | "error";
  area: AreaId;
  node?: string;
  label: string;
  detail?: string;
  ok?: boolean;
  /// The graph changed (a new memory, animation version, place, …).
  grew?: boolean;
  /// Seconds the node stays lit (a move playing).
  hold?: number;
};

export type AreaId = "mind" | "senses" | "voice" | "body" | "skills" | "soul" | "memory" | "space" | "helpers" | "characters";

export const AREAS: Array<{ id: AreaId; label: string; hue: number; about: string }> = [
  { id: "mind", label: "Mind", hue: 0, about: "The thought loop: waking on events, deciding, acting. Reflexes act before it thinks; free time wakes it when you're quiet; while the phone is away it dreams." },
  { id: "senses", label: "Senses", hue: 196, about: "What reaches the mind from the phone: speech (Whisper on the Mac), taps, the scene, camera pictures, people in view." },
  { id: "voice", label: "Voice", hue: 330, about: "What she says (natural Kokoro voice or Apple), narration notes, buttons and status lines." },
  { id: "body", label: "Body", hue: 28, about: "Behaviour scripts that move the body every frame (walk, idle, sit on seats…), plus the phone's gaze and ground following." },
  { id: "skills", label: "Skills", hue: 52, about: "Her move library (2,493 real motion-captured moves, by kind) and animations she learned herself." },
  { id: "soul", label: "Inner life", hue: 96, about: "Who she is (her soul profile), her needs and feelings right now, her energy, the plan she's living, and her dreams." },
  { id: "memory", label: "Memory", hue: 268, about: "Personas, memories and life plans of each character." },
  { id: "space", label: "Space", hue: 150, about: "The room: LiDAR map, named places, props." },
  { id: "helpers", label: "Helpers", hue: 12, about: "Background subagents learning new moves." },
  { id: "characters", label: "Characters", hue: 312, about: "The characters in the room." },
];

export const activity = new EventEmitter();
activity.setMaxListeners(50);
const recent: Activity[] = [];

export function emitActivity(a: Omit<Activity, "t">): void {
  const full = { ...a, t: Date.now() };
  recent.push(full);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  activity.emit("activity", full);
}

/// Which area and node a tool works in.
export function toolArea(name: string, input: Record<string, any>): { area: AreaId; node?: string } {
  const ch = input.character ? `char:${input.character}` : undefined;
  switch (name) {
    case "wait_for_events": return { area: "mind" };
    case "get_scene": case "snapshot": return { area: "senses", node: name === "snapshot" ? "sense:camera" : "sense:scene" };
    case "say": case "note": case "set_controls": case "set_status": return { area: "voice", node: `voice:${name}` };
    case "run_behavior": return input.behavior === "move" && input.args?.name ? { area: "skills", node: moveNode(String(input.args.name)) } : { area: "body", node: `behavior:${input.behavior}` };
    case "stop_behavior": return { area: "body", node: "behavior:idle" };
    case "list_behaviors": case "read_behavior": case "write_behavior": case "revert_behavior":
      return { area: "body", node: input.name ? `behavior:${input.name}` : undefined };
    case "play_animation": return { area: "skills", node: moveNode(String(input.name ?? "")) };
    case "write_animation": case "animation_guide": return { area: "skills", node: input.name ? `anim:${input.name}` : undefined };
    case "remember": case "update_persona": case "update_life": case "get_character": return { area: "memory", node: ch };
    case "get_map": case "name_place": case "forget_place": case "spawn_prop":
      return { area: "space", node: input.name ? `place:${input.name}` : "space:map" };
    case "report": return { area: "helpers" };
    case "make_move": return { area: "skills", node: input.name ? `move:${input.name}` : undefined };
    case "reflect": return { area: "soul", node: input.character ? `insights:${input.character}` : undefined };
    case "relate": return { area: "soul", node: input.character ? `bond:${input.character}` : undefined };
    case "soul_review": return { area: "soul", node: input.character ? `inner:${input.character}` : undefined };
    case "dream": return { area: "soul", node: input.character ? `dreams:${input.character}` : undefined };
    case "create_soul": case "feel": return { area: "soul", node: input.character ? `inner:${input.character}` : undefined };
    case "mark_thing": return { area: "space", node: "space:things" };
    case "get_scene": return { area: "senses", node: "sense:scene" };
    case "name_room": return { area: "space", node: "space:rooms" };
    case "find_moves": return { area: "skills", node: "tool:find_moves" };
    case "live": return { area: "soul", node: input.character ? `plan:${input.character}` : undefined };
    default: return { area: "mind" };
  }
}

/// The dot a move lands on: that exact library move, or a learned animation.
export function moveNode(name: string): string {
  return moves.inLibrary(name) ? `move:${name}` : `anim:${name}`;
}

/// Every tool the mind has (each is its own dot, lit when it's called).
export const toolNames = new Set<string>();

/// The dot a plan step lands on.
export function stepNode(id: string, step: { do: string; name?: string }): string {
  switch (step.do) {
    case "play": return moveNode(String(step.name ?? ""));
    case "behavior": return `behavior:${step.name}`;
    case "walk": case "face": case "idle": case "sit_on": return `behavior:${step.do}`;
    case "say": return "voice:say";
    case "gaze": return "body:gaze";
    case "look": return "sense:camera";
    default: return `plan:${id}`;
  }
}

const MOVE_KINDS: Record<string, string> = {
  everyday: "Everyday life", play: "Play and games", other: "Other moves", exercise: "Exercise and sport",
  dance: "Dance", sit: "Sitting, kneeling, lying", made: "Made by her", emotion: "Emotions and moods", gesture: "Gestures", idle: "Resting and waiting",
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

// MARK: Graph snapshot

type GNode = { id: string; label: string; area: AreaId; kind: string; weight: number; note?: string; links?: string[]; level?: number };

function graph(body: Body): { areas: typeof AREAS; nodes: GNode[] } {
  const nodes: GNode[] = [];
  const add = (n: GNode) => nodes.push(n);
  add({ id: "mind", label: "Mind", area: "mind", kind: "core", weight: 4, note: "The Claude Code chat running /soul." });
  for (const a of AREAS) if (a.id !== "mind") add({ id: `area:${a.id}`, label: a.label, area: a.id, kind: "area", weight: 3, note: a.about, links: ["mind"] });

  // Senses and voice: fixed organs.
  const ears = body.earsPref || "whisper-small";
  const earsLabel = ears === "apple" ? "Apple dictation" : ears === "whisper-large" ? "Whisper large" : "Whisper small";
  const people = ((body.scene?.people as unknown[]) ?? []).length;
  for (const [id, label, note] of [
    ["sense:speech", `Hearing · ${earsLabel}`, ears === "apple"
      ? "Apple's on-device dictation on the phone, phrase by phrase."
      : `The phone streams the mic to the Mac. Silero hears when someone speaks (even over music), Whisper writes it down. Her own voice and Whisper's made-up phrases are dropped.${wiring.ears?.status ? `\nNow: ${wiring.ears.status}` : ""}`],
    ["sense:touch", "Touch", "Taps on characters and buttons."],
    ["sense:scene", "Scene", "Where everyone is, from the user's point of view: what she's doing, what's on screen, rooms and seats around her."],
    ["sense:camera", "Sight", "Camera pictures of the room: when she looks around, and when you point at something."],
    ["sense:people", people ? `People · ${people} in view` : "People", "Other people the camera sees (Apple Vision), placed on the floor. She glances at them, and the mind is told."],
  ]) add({ id, label, area: "senses", kind: "organ", weight: id === "sense:people" ? 1.2 + Math.min(1.5, people * 0.5) : 1.6, note, links: ["area:senses"] });
  const vp = body.voicePref || "kokoro:af_heart";
  const voiceLabel = vp.startsWith("kokoro:") ? `Kokoro ${vp.slice(7)}` : vp.startsWith("apple") || vp.includes(".") ? "Apple voice" : vp;
  for (const [id, label, note] of [
    ["voice:say", `Speech · ${voiceLabel}`, vp.startsWith("kokoro:") ? `A natural voice made on the Mac (Kokoro), sentence by sentence; music dips while she talks.${wiring.voice ? (wiring.voice.ready ? "\nReady." : "\nWarming up.") : ""}` : "Apple's voice on the phone."],
    ["voice:note", "Narration", "Notes in the phone's chat panel."],
    ["voice:set_controls", "Buttons", "Buttons the mind shows the user."],
    ["voice:set_status", "Status", "Status lines over a character."],
  ]) add({ id, label, area: "voice", kind: "organ", weight: 1.4, note, links: ["area:voice"] });
  add({ id: "space:map", label: "Room map", area: "space", kind: "organ", weight: 1.8, note: "LiDAR walkability map.", links: ["area:space"] });

  // Mind: the fast mind and free time.
  add({ id: "mind:reflexes", label: "Reflexes", area: "mind", kind: "organ", weight: 1.6, note: "The fast mind: \"come here\", \"follow me\", \"stop\", \"sit down\", \"stand up\", \"look at me\", \"wave\", \"jump\", \"go to the kitchen\" start the moment they're heard. The slow mind is told and adds the words.", links: ["mind", "sense:speech", "area:body"] });
  add({ id: "mind:free", label: "Free time", area: "mind", kind: "organ", weight: 1.6, note: "After 10 s without you, the mind is woken to give her a stretch of her own life: where she's been, what she hasn't explored, how she feels, moves that suit her energy. It backs off when you've been gone a long time.", links: ["mind", "area:soul"] });

  const away = wiring.hub?.awayFor() ?? null;
  add({ id: "mind:dreams", label: away !== null ? "Dreaming now" : "Dreaming", area: "mind", kind: "organ", weight: away !== null ? 2.4 : 1.4, note: `While the phone is away (disconnected, locked, nobody placed), her life goes on in her head: the mind is woken now and then to write what she daydreams, from the world she has seen. When the phone is back she carries on from it.${away !== null ? `\nThe phone has been away for ${Math.round(away / 60000)} min.` : ""}`, links: ["mind", "area:soul"] });

  // Body: what the phone does by itself, every frame.
  add({ id: "body:gaze", label: "Gaze", area: "body", kind: "organ", weight: 1.5, note: "Eyes, head, neck and chest turn toward what holds her attention: you when you talk or look at her, the way ahead when walking, people in view, glances around the room.", links: ["area:body", "sense:people"] });
  add({ id: "body:ground", label: "Ground", area: "body", kind: "organ", weight: 1.5, note: "Her floor height comes from the LiDAR mesh under her feet as she moves (steps, rugs, other rooms), and her feet never go below it in any pose.", links: ["area:body", "space:map"] });

  // Tools: every one the mind has, as a dot in the area it works in.
  for (const name of toolNames) {
    if (name === "wait_for_events") continue;
    const where = toolArea(name, {});
    add({ id: `tool:${name}`, label: name.replace(/_/g, " "), area: where.area, kind: "tool", weight: 0.7, note: `A tool the mind calls. Lights up when it's used${where.node ? "" : ""}.`, links: [where.area === "mind" ? "mind" : `area:${where.area}`] });
  }

  // Skills: the move library by kind.
  const lib = moves.library();
  if (lib.length) {
    const byKind = new Map<string, moves.LibraryMove[]>();
    for (const m of lib) { const k = m.tags[0] ?? "other"; (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(m); }
    add({ id: "skills:library", label: `Move library · ${lib.length}`, area: "skills", kind: "organ", weight: 2.4, note: `${lib.length} real human moves, motion-captured (CMU Graphics Lab) and fitted to her skeleton. The mind finds them by meaning and plays them by name, any number of times.`, links: ["area:skills", "behavior:move"] });
    for (const [k, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
      const examples = [...new Set(list.map((m) => m.desc.replace(/ \(part \d+ of \d+\)$/, "")))].slice(0, 8);
      add({ id: `moves:${k}`, label: `${MOVE_KINDS[k] ?? k} · ${list.length}`, area: "skills", kind: "moves", weight: 1 + Math.min(2.2, Math.sqrt(list.length) / 12), note: `For example: ${examples.join("; ")}…`, links: ["skills:library"] });
    }
  }

  // Behaviours and animations.
  const files = store.behaviorFiles();
  for (const [name, code] of Object.entries(files)) {
    const versions = store.behaviorHistory(name).length;
    const about = code.split("\n")[0].replace(/^\/\/\s*/, "");
    if (name.startsWith("anim_")) {
      const anim = name.slice(5);
      add({ id: `anim:${anim}`, label: anim.replace(/_/g, " "), area: "skills", kind: "animation", weight: 1 + Math.min(2, versions * 0.4), note: `${about} · ${versions} version${versions === 1 ? "" : "s"}`, links: ["area:skills", "behavior:play"] });
    } else {
      add({ id: `behavior:${name}`, label: name.replace(/_/g, " "), area: "body", kind: "behaviour", weight: 1.2 + Math.min(1.5, versions * 0.3), note: about, links: ["area:body"] });
    }
  }

  // Characters and their memory.
  const live = new Map((body.scene?.characters ?? []).map((c) => [c.name, c]));
  for (const name of store.characterNames()) {
    const c = live.get(name);
    const cid = `charname:${name}`;
    add({ id: cid, label: c ? `${name} (${c.id})` : name, area: "characters", kind: c ? "character" : "character-away", weight: c ? 2.2 : 1.3, note: c ? `In the room · ${c.behavior}` : "Not placed right now.", links: ["area:characters"] });
    const persona = store.readCharacter(name, "persona");
    if (persona) add({ id: `persona:${name}`, label: `${name}: persona`, area: "memory", kind: "persona", weight: 1.6, note: persona, links: ["area:memory", cid] });
    const life = store.readCharacter(name, "life");
    if (life) add({ id: `life:${name}`, label: `${name}: life plan`, area: "memory", kind: "life", weight: 1.4, note: life, links: ["area:memory", cid] });
    store.readCharacter(name, "memory").split("\n").filter((l) => l.trim()).forEach((line, i) =>
      add({ id: `mem:${name}:${i}`, label: line.replace(/^- [\d-]+ [\d:]+: /, "").slice(0, 60), area: "memory", kind: "memory", weight: 0.9, note: line.replace(/^- /, ""), links: [`persona:${name}`, cid] }));
  }
  for (const c of body.scene?.characters ?? []) {
    if (!store.characterNames().includes(c.name)) add({ id: `charname:${c.name}`, label: `${c.name} (${c.id})`, area: "characters", kind: "character", weight: 2.2, note: `In the room · ${c.behavior}`, links: ["area:characters"] });
  }
  // Inner life of the characters in the room (needs and feelings live per character).
  const known = wiring.hub?.knownCharacters() ?? (body.scene?.characters ?? []);
  for (const c of known) {
    const hub = `inner:${c.id}`, cid = `charname:${c.name}`;
    const profile = soul.readProfile(c.name);
    const energy = wiring.life?.energy(c.id);
    add({ id: hub, label: `${c.name}: inner life`, area: "soul", kind: "inner", level: energy?.level, weight: 2, note: energy ? `Energy ${pct(energy.level)}: ${energy.label}` : "", links: ["area:soul", cid] });
    if (profile) add({ id: `soul:${c.name}`, label: `${c.name}: who she is`, area: "soul", kind: "identity", weight: 2, note: soul.describeProfile(profile), links: [hub, `persona:${c.name}`] });
    const st = soul.innerState(c.id);
    for (const [k, v] of Object.entries(st.needs))
      add({ id: `need:${c.id}:${k}`, label: `${k} ${pct(v)}`, area: "soul", kind: "need", level: v, weight: 0.6 + v * 1.8, note: `How much ${c.name} feels ${k === "company" ? "she wants company" : k === "curiosity" ? "curious, wanting something new" : k === "boredom" ? "bored" : "tired"}: ${pct(v)}. It drifts by itself with time and what she does.`, links: [hub] });
    for (const e of st.emotions.slice(0, 5))
      add({ id: `emo:${c.id}:${e.name}`, label: `feels ${e.name}`, area: "soul", kind: "emotion", level: e.intensity, weight: 0.8 + e.intensity * 2, note: `${pct(e.intensity)} · ${e.why}\nFeelings fade over minutes.`, links: [hub] });
    const plan = wiring.life?.current(c.id);
    const bond = soul.readBond(c.name);
    add({ id: `bond:${c.id}`, label: `${c.name} ↔ you · ${Math.round(bond.closeness * 100)}%`, area: "soul", kind: "inner", level: bond.closeness, weight: 1.4 + bond.closeness, note: soul.describeBond(c.name), links: [hub] });
    const insights = soul.readInsights(c.name, 8);
    add({ id: `insights:${c.id}`, label: `${c.name}: insights · ${insights.length}`, area: "soul", kind: "identity", weight: 1.2 + Math.min(1.2, insights.length * 0.1), note: insights.length ? insights.map((i) => `• ${i}`).join("\n") : "Nothing condensed yet: reflection turns memories, dreams and conversations into insights.", links: [hub] });
    const dreams = soul.readDreams(c.name, 6);
    if (dreams.length) {
      add({ id: `dreams:${c.id}`, label: `${c.name}: dreams`, area: "soul", kind: "dreams", weight: 1.6 + (away !== null ? 0.8 : 0), note: "Her dream journal: daydreams while the phone was away. Later dreams continue the thread.", links: [hub, "mind:dreams"] });
      dreams.forEach((d, i) => add({ id: `dream:${c.id}:${d.at}`, label: d.text.slice(0, 50), area: "soul", kind: "dream", weight: 0.8 + (i + 1) / dreams.length, note: `${new Date(d.at).toLocaleString()}\n${d.text}`, links: [`dreams:${c.id}`] }));
    }
    if (plan) add({ id: `plan:${c.id}`, label: `living: ${plan.note}`.slice(0, 60), area: "soul", kind: "plan", level: plan.steps.length ? plan.step / plan.steps.length : 0, weight: 1.8, note: plan.steps.map((s, i) => `${i < plan.step ? "✓" : i === plan.step ? "▶" : "·"} ${s}`).join("\n"), links: [hub, "mind:free"] });
  }

  // Space: rooms she knows, things she noticed here, places.
  const mapId = (body.scene?.mapId as string | null) ?? wiring.hub?.knownMap() ?? null;
  const rooms = Object.entries(world.readRooms());
  add({ id: "space:rooms", label: `Rooms · ${rooms.length}`, area: "space", kind: "organ", weight: 1.6, note: "Saved rooms. The phone recognises them again by how they look (Apple Vision), and ARKit confirms; what she learns stays with each room.", links: ["area:space", "space:map"] });
  for (const [id, r] of rooms) {
    const here = id === mapId;
    add({ id: `room:${id}`, label: `${r.name || "unnamed room"}${here ? " (here)" : ""}`, area: "space", kind: here ? "room-here" : "room", weight: here ? 2 : 1.2, note: `Visit ${r.visits}, first seen ${new Date(r.firstSeen).toLocaleDateString()}, last ${new Date(r.lastSeen).toLocaleString()}.`, links: ["space:rooms"] });
  }
  const things = Object.entries(world.readThings(mapId));
  add({ id: "space:things", label: `Things noticed · ${things.length}`, area: "space", kind: "organ", weight: 1.4, note: "Things she noticed in camera pictures and went to see. Curiosity about each fades with visits.", links: ["area:space", mapId ? `room:${mapId}` : "space:map"] });
  for (const [name, t] of things)
    add({ id: `thing:${name}`, label: name, area: "space", kind: "thing", weight: 0.9 + Math.max(0, 1 - t.visits * 0.25), note: `${t.kind}${t.note ? ` · ${t.note}` : ""}\nVisited ${t.visits}×.`, links: ["space:things"] });
  for (const [name] of Object.entries(store.readPlaces(mapId)))
    add({ id: `place:${name}`, label: name, area: "space", kind: "place", weight: 1.3, links: ["area:space", mapId ? `room:${mapId}` : "space:map"] });
  return { areas: AREAS, nodes };
}

/// What's happening right now (the page's "Now" panel, polled often).
function now(body: Body) {
  const mapId = (body.scene?.mapId as string | null) ?? wiring.hub?.knownMap() ?? null;
  const room = mapId ? world.readRooms()[mapId] : undefined;
  return {
    connected: body.connected,
    ears: { pref: body.earsPref || "whisper-small", status: wiring.ears?.status ?? "" },
    voice: { pref: body.voicePref || "kokoro:af_heart", ready: wiring.voice?.ready ?? false },
    room: mapId ? (room?.name || "an unnamed room") : null,
    people: ((body.scene?.people as unknown[]) ?? []).length,
    away: wiring.hub?.awayFor() ?? null,
    characters: (wiring.hub?.knownCharacters() ?? body.scene?.characters ?? []).map((c) => {
      const st = soul.innerState(c.id);
      const away = wiring.hub?.awayFor() ?? null;
      return {
        id: c.id, name: c.name, behavior: away !== null ? "dreaming" : (body.scene?.characters.find((x) => x.id === c.id)?.behavior ?? ""),
        dreams: soul.readDreams(c.name, 3),
        energy: wiring.life?.energy(c.id) ?? null,
        needs: st.needs, emotions: st.emotions.slice(0, 3),
        plan: wiring.life?.current(c.id) ?? null,
        recent: (wiring.life?.recentDone(c.id) ?? []).slice(-4),
      };
    }),
  };
}

/// Character ids (c1…) → graph ids, so live activity lands on the right star.
export function characterNode(body: Body, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const name = body.characterName(id);
  return name ? `charname:${name}` : undefined;
}

// MARK: Server

export function startUI(body: Body, port: number, log: (l: string) => void): void {
  const page = path.join(store.BRAIN_ROOT, "ui/galaxy.html");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/galaxy") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(page));
    } else if (url.pathname === "/graph") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...graph(body), connected: body.connected, device: body.device, recent: recent.slice(-60) }));
    } else if (url.pathname === "/moves") {
      // Every library move as its own dot (sent once; the page adds them to the galaxy).
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(moves.library().map((m) => ({ id: `move:${m.name}`, kind: m.tags[0] ?? "other", label: m.desc, name: m.name, s: m.seconds, tags: m.tags }))));
    } else if (url.pathname === "/now") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(now(body)));
    } else if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`: hello\n\n`);
      const send = (a: Activity) => res.write(`data: ${JSON.stringify(a)}\n\n`);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
      activity.on("activity", send);
      req.on("close", () => {
        clearInterval(ping);
        activity.off("activity", send);
      });
    } else {
      res.writeHead(404).end();
    }
  });
  server.on("error", (e) => log(`galaxy page: ${e.message}`));
  server.listen(port, "127.0.0.1", () => log(`brain galaxy on http://localhost:${port}`));
}
