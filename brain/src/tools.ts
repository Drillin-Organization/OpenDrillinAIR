// The mind's tools, served over MCP to a Claude Code chat: the body's
// affordances, behaviour editing, memory, and wait_for_events.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Body } from "./body.js";
import { compactScene, introduce, log, type EventHub } from "./events.js";
import { renderMap, type Grid } from "./map.js";
import { contactSheet, review } from "./preview.js";
import * as store from "./store.js";
import { characterNode, emitActivity, toolArea, toolNames, wiring } from "./ui.js";
import { Voice } from "./voice.js";
import type { Ears } from "./ears.js";
import { Life, namedTarget, sitOnArgs, type Step } from "./life.js";
import { inLibrary, library, search as searchMoves } from "./moves.js";
import * as soul from "./soul.js";
import * as compose from "./compose.js";
import * as world from "./world.js";
import * as frames from "./frames.js";
import * as roommap from "./roommap.js";
import * as jobs from "./jobs.js";
import * as beliefs from "./beliefs.js";
import * as roomjoin from "./roomjoin.js";
import * as groups from "./groups.js";

/// Tools whose success changes what the mind knows (the galaxy grows).
const GROWS = new Set(["write_animation", "write_behavior", "revert_behavior", "remember", "update_persona", "update_life", "name_place", "forget_place"]);

function summary(name: string, input: Record<string, any>): string {
  switch (name) {
    case "say": return `${input.character}: “${input.text}”`;
    case "note": return String(input.text ?? "");
    case "run_behavior": return `${input.character} → ${input.behavior}${input.args ? " " + JSON.stringify(input.args) : ""}`;
    case "play_animation": return `${input.character} plays ${input.name}`;
    case "write_animation": return `${input.name}: ${String(input.note ?? "").slice(0, 80)}`;
    case "write_behavior": return `${input.name}: ${String(input.note ?? "").slice(0, 80)}`;
    case "remember": return `${input.character}: ${input.fact}`;
    case "update_persona": case "update_life": return `${input.character}: ${String(input.text ?? input.plan ?? "").slice(0, 80)}`;
    case "name_place": return `“${input.name}”`;
    case "report": return String(input.text ?? "");
    case "set_status": return `${input.character}: ${input.text || "(cleared)"}`;
    case "dream": return `${input.character}: ${String(input.thought ?? "").slice(0, 100)}`;
    case "make_move": return `${input.name}: ${input.desc ?? ""}`;
    case "reflect": return `${input.character}: ${(input.insights ?? [])[0] ?? ""}`;
    case "relate": return `${input.character}: ${[input.closeness && `closeness ${input.closeness > 0 ? "+" : ""}${input.closeness}`, input.trust && `trust ${input.trust > 0 ? "+" : ""}${input.trust}`, input.joke && `joke “${input.joke}”`, input.moment && `moment “${input.moment}”`, input.likes && `likes ${input.likes.join(", ")}`].filter(Boolean).join(", ")}`;
    case "soul_review": return String(input.character);
    case "feel": return `${input.character} feels ${input.emotion} ${Math.round(Number(input.intensity ?? 0) * 100)}%: ${input.why ?? ""}`;
    case "live": return `${input.character}: ${(input.steps ?? []).length} steps`;
    case "create_soul": return `${input.character}: ${input.name ?? ""}, ${input.age ?? ""}`;
    case "find_moves": return `“${input.query ?? input.category ?? ""}”`;
    case "name_room": return `“${input.name}”`;
    case "recall_frames": return [input.seconds_ago !== undefined && `${input.seconds_ago} s ago`, input.at, input.near].filter(Boolean).join(", ") || "lately";
    case "note_from_frame": return (input.things ?? []).map((t: any) => t.name).join(", ");
    case "next_job": return String(input.worker ?? "");
    case "job_done": return `${input.worker}: ${String(input.result ?? "").slice(0, 80)}`;
    case "queue_job": return String(input.title ?? "");
    case "room_belief": return `${input.room} (${input.confidence}): ${String(input.where ?? "").slice(0, 60)}`;
    case "join_rooms": case "keep_rooms_apart": return `${String(input.a ?? "").slice(0, 8)} / ${String(input.b ?? "").slice(0, 8)}`;
    case "mark_thing": return (input.things ?? []).map((t: any) => t.name).join(", ") || String(input.name ?? "");
    default: {
      const s = JSON.stringify(input);
      return s === "{}" ? "" : s.slice(0, 90);
    }
  }
}

/// Saved versions an animation needs before it may be played.
const MIN_VERSIONS = 3;

/// Bumped when tools or instructions change; /soul checks it so a chat never
/// runs on a stale brain process.
export const BRAIN_VERSION = 34;

const text = (t: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }],
});
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

const character = z.string().describe("Character id from the scene, e.g. c1");

export function registerTools(server: McpServer, body: Body, hub: EventHub, voice: Voice, ears: Ears): void {
  function nameOf(id: string): string {
    // In the scene, or (while the phone is away) the last ones it showed.
    // A stored character's exact name works too (helpers use names: ids get reused).
    const name = body.characterName(id) ?? hub.knownCharacters().find((c) => c.id === id || c.name.toLowerCase() === id.toLowerCase())?.name
      ?? store.characterNames().find((n) => n.toLowerCase() === id.toLowerCase());
    if (!name) throw new Error(`no character "${id}" in the scene`);
    return name;
  }

  /// Says a line: with a natural voice the phone shows it now and plays the
  /// audio as it arrives; otherwise it speaks with its iPhone voice.
  async function speak(id: string, line: string, alongAction = false) {
    const natural = !voice.problem ? Voice.natural(body.voicePref) : null;
    const lineId = voice.lineId();
    const r = await body.command("say", { character: id, text: line, natural: !!natural, line: lineId });
    if (r.ok) {
      ears.heardHerSay(line);
      hub.answered(id);
      const who = body.characterName(id);
      if (who) soul.logTalk(who, "her", line);
      log(`${id} said: ${line}`);
      if (alongAction) emitActivity({ kind: "tool", area: "voice", node: "voice:say", label: `${id}: “${line}”` });
      if (natural) voice.speak(id, line, natural, lineId);
    }
    return r;
  }

  // Her life between interactions: plans the mind writes, lived step by step.
  const life = new Life(body, (id, line) => speak(id, line), (line, image) => hub.wakeWith(line, image));
  wiring.life = life;
  wiring.hub = hub;
  hub.life = life;

  // Wraps handlers so thrown errors come back as tool errors.
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.objectOutputType<S, z.ZodTypeAny>) => Promise<CallToolResult>,
  ): void {
    toolNames.add(name);
    server.registerTool(name, { description, inputSchema: shape }, (async (input: z.objectOutputType<S, z.ZodTypeAny>) => {
      const where = toolArea(name, input as Record<string, any>);
      const node = (where.node?.startsWith("char:") ? characterNode(body, where.node.slice(5)) : where.node) ?? `tool:${name}`;
      if (name !== "wait_for_events") {
        hub.acted();
        emitActivity({ kind: "tool", area: where.area, node, label: `${name} ${summary(name, input as Record<string, any>)}`.trim() });
      }
      let result: CallToolResult;
      try {
        result = await run(input);
      } catch (e) {
        result = fail(e instanceof Error ? e.message : String(e));
      }
      if (name !== "wait_for_events") {
        const first = result.content.find((c) => c.type === "text");
        emitActivity({
          kind: result.isError ? "error" : "result", area: where.area, node, ok: !result.isError,
          label: name, detail: first && "text" in first ? String(first.text).slice(0, 160) : undefined,
          grew: !result.isError && GROWS.has(name),
        });
      }
      return result;
    }) as any);
  }

  tool(
    "wait_for_events",
    "Wait until something happens on the phone (the user speaks or taps, a character is placed, a behaviour you asked about finishes, free time when the user has been quiet a while, the user returns) or, while the phone is away, until she dreams. Returns the events with the current scene, or 'nothing happened' after the timeout. Call it again after acting.",
    { timeout_seconds: z.number().min(5).max(540).optional().describe("Default 120") },
    async ({ timeout_seconds }) => {
      if (hub.isWaiting) return fail("Another wait_for_events is already running. Only the main loop waits for events; helpers must not call it (use report instead).");
      const wake = await hub.next((timeout_seconds ?? 120) * 1000);
      if (!wake) return text(body.connected ? "Nothing happened. Call wait_for_events again." : "Nothing happened; the phone is away (she dreams while it is). Call wait_for_events again: the loop never stops on its own.");
      return { content: [{ type: "text", text: wake.text }, ...wake.images.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" }))] };
    },
  );

  tool(
    "run_behavior",
    "Start a behaviour script on a character (replaces her current one). Built in: walk {thing:'<marked thing>'} | {place:'<named place>'} | {to:'user'} | {to:'<id>'} | {x,z} (by name is best: she stops beside a thing, no coordinates to guess; plans a route around walls and furniture on the LiDAR room map; fails if there is no route); face (same targets; a face away from the user holds: when the user talks she no longer turns back to them by reflex, until you face her {to:'user'}, walk, sit or stop her; pass hold:false for a passing glance); sit_on {thing|seat:'<plane id>'|place|x,z} (sits properly on a real seat; the brain finds its height); idle (resting; {look: degrees} to look somewhere, + = her left); dance (her own dance until replaced); play {name} (an animation; prefer play_animation). Set notify to be woken when it finishes.",
    {
      character,
      behavior: z.string(),
      args: z.record(z.any()).optional().describe("Arguments for the behaviour's start()"),
      notify: z.boolean().optional().describe("Wake me when it finishes"),
      say: z.string().optional().describe("A short line she says as she starts (same as calling say; saves a step)"),
    },
    async ({ character: id, behavior, args, notify, say: line }) => {
      if ((behavior === "walk" || behavior === "face") && args && (args.thing || args.place)) {
        const { thing, place, ...rest } = args;
        const at = namedTarget(body, id, { thing, place }, behavior === "walk");
        if (!at) {
          const mapId = body.scene?.mapId as string | null;
          const known = thing ? Object.keys(world.readThings(mapId)) : Object.keys(store.readPlaces(mapId));
          return fail(`No ${thing ? "thing" : "place"} "${thing ?? place}" in this room. Known: ${known.join(", ") || "none yet"}.`);
        }
        args = { ...rest, ...at };
      }
      // A turn the mind asks for (away from the user) holds: the phone won't
      // turn her back to the user when they speak, until she's told otherwise.
      if (behavior === "face" && args && args.to !== "user" && args.hold === undefined) args = { ...args, hold: true };
      if (behavior === "sit_on") {
        const seated = sitOnArgs(body, id, args ?? {});
        if (!seated) return fail("No seat found there. Give sit_on a marked thing {thing:'sofa'}, a seat plane id from the scene {seat:'p7'}, a named place, or x/z right next to a seat (sofa, chair, bench, bed edge). If the phone hasn't detected the seat as a plane, mark_thing it first.");
        args = seated;
      }
      life.cancel(id, "the mind took over");
      life.note(id, `${behavior}${args && Object.keys(args).length ? " " + JSON.stringify(args) : ""}`);
      const [r] = await Promise.all([
        body.command("run", { character: id, behavior, args: args ?? {} }),
        line ? speak(id, line, true) : Promise.resolve(),
      ]);
      if (!r.ok) return fail(r.error ?? "failed");
      body.started(id, behavior);
      if (notify) hub.watch(id, behavior);
      log(`${id} ${behavior} ${JSON.stringify(args ?? {})}`);
      return text(`started ${behavior} on ${id}`);
    },
  );

  tool("stop_behavior", "Stop a character's behaviour (and her plan); she goes back to resting.", { character }, async ({ character: id }) => {
    life.cancel(id, "stopped by the mind");
    const r = await body.command("stop", { character: id });
    return r.ok ? text("stopped") : fail(r.error ?? "failed");
  });

  tool(
    "say",
    "A character says something out loud (shown and spoken on the phone). One or two natural sentences.",
    { character, text: z.string().min(1) },
    async ({ character: id, text: line }) => {
      const r = await speak(id, line);
      if (!r.ok) return fail(r.error ?? "failed");
      return text("said");
    },
  );

  tool(
    "create_soul",
    "Give a character her full soul: who she is, in depth (asked for when you meet someone without one). Make her a believable, grounded person, true to her seed and to anything you already know of her: specific, warm, with an inner life, not a bundle of quirks (quirks are small and show rarely; catchphrases are things she might say once a day, not every line). bodyLanguage maps moods to how she shows them (moves from find_moves or your own words); routines say what she likes doing at each energy level. Saved for good and shown each session.",
    {
      character,
      name: z.string().describe("What she calls herself (may differ from the app's label)"),
      age: z.string(),
      backstory: z.string().describe("4–8 sentences: where she's from, what shaped her, what she's doing with her life now"),
      traits: z.array(z.string()).min(5).max(12),
      bigFive: z.object({ openness: z.number(), conscientiousness: z.number(), extraversion: z.number(), agreeableness: z.number(), neuroticism: z.number() }),
      quirks: z.array(z.string()).min(3).max(10),
      hobbies: z.array(z.string()).min(3).max(10),
      loves: z.array(z.string()).min(4).max(15),
      dislikes: z.array(z.string()).min(3).max(10),
      voice: z.string().describe("How she talks: rhythm, humour, words she uses"),
      catchphrases: z.array(z.string()).min(3).max(8),
      bodyLanguage: z.record(z.string()).describe("mood → how she shows it, e.g. happy: 'spins once, hums', bored: 'sighs, slumps on the nearest seat'"),
      routines: z.record(z.string()).describe("energy (restless/lively/mellow/low) → what she likes doing"),
      goals: z.array(z.string()).min(1).max(8),
      fears: z.array(z.string()).min(1).max(5),
      relationship: z.string().describe("What the user is to her so far and how she'd like that to grow"),
    },
    async ({ character: id, ...p }) => {
      const label = nameOf(id);
      soul.writeProfile(label, p as soul.Profile);
      log(`${id} (${label}) has a soul: ${p.name}`);
      return text(`${p.name}'s soul is saved. Live her from now on.`);
    },
  );

  tool(
    "feel",
    "Give a character an emotion with a reason (it fades over a few minutes and shows in every wake, so her behaviour can follow it): e.g. feel c1 'delighted' 0.8 'the user complimented her dancing'. Use whenever something touches her.",
    { character, emotion: z.string(), intensity: z.number().min(0).max(1), why: z.string() },
    async ({ character: id, emotion, intensity, why }) => {
      nameOf(id);
      soul.feel(id, emotion, intensity, why);
      return text(`${id} feels ${emotion}`);
    },
  );

  tool(
    "dream",
    "While the phone is away (a Dreaming wake), write what a character daydreams: one or two plain first-person sentences, the way a real person's mind idles, grounded in what really happened and what she has seen. It goes into her dream journal; later dreams and her return to the phone carry on from it. Optionally a feeling the dream leaves her with.",
    {
      character,
      thought: z.string().min(3).describe("Her daydream, first person, 1–3 sentences"),
      about: z.string().optional().describe("The place, thing, person or memory it's about, if any"),
      feeling: z.object({ emotion: z.string(), intensity: z.number().min(0).max(1) }).optional(),
    },
    async ({ character: id, thought, about, feeling }) => {
      const name = nameOf(id);
      soul.addDream(name, about ? `${thought} (about: ${about})` : thought);
      soul.happened(name);
      soul.dreamt(id);
      if (feeling) soul.feel(id, feeling.emotion, feeling.intensity, `a daydream${about ? ` about ${about}` : ""}`);
      hub.dreamt(id, thought);
      return text(`${name} dreams on. (Call wait_for_events.)`);
    },
  );

  tool(
    "make_move",
    "Make a new move instantly from the recorded library instead of writing an animation (milliseconds, not minutes): a sequence of library moves (find_moves for names), each optionally cut (from/to seconds), sped up or slowed (speed), mirrored (left↔right) or repeated (times), crossfaded together; optionally another move's upper body layered on top (e.g. walking legs + waving arms). It's saved, sent to the phone, and played with play_animation like any library move. Prefer this to a helper whenever the library has the pieces.",
    {
      name: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/).describe("lower_snake_case, new"),
      desc: z.string().min(3).describe("What it looks like, in a few words"),
      segments: z.array(z.object({
        move: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
        speed: z.number().min(0.25).max(4).optional(), mirror: z.boolean().optional(), times: z.number().int().min(1).max(20).optional(),
      })).min(1).max(12),
      upper: z.object({ move: z.string(), mirror: z.boolean().optional(), speed: z.number().min(0.25).max(4).optional() }).optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ name, desc, segments, upper, tags }) => {
      const m = compose.compose(name, desc, segments, upper, tags);
      const r = body.connected ? await body.pushMoves([m]) : { ok: true };
      emitActivity({ kind: "result", area: "skills", node: `move:${name}`, label: `new move: ${name} (${(m.frames / m.fps).toFixed(1)} s)`, grew: true });
      return text(`Made "${name}" (${(m.frames / m.fps).toFixed(1)} s)${r.ok ? "; on the phone now, play it with play_animation" : `; the phone didn't take it yet (${r.error}), it's sent on the next connection`}.`);
    },
  );

  tool(
    "soul_review",
    "Everything a reflection helper needs about a character: who she is, her memories, insights so far, dreams, her relationship with the user, and the recent conversations. For background helpers doing reflection (the main loop rarely needs it).",
    { character },
    async ({ character: id }) => {
      const name = nameOf(id);
      const profile = soul.readProfile(name);
      return text([
        `# ${name}`,
        profile ? soul.describeProfile(profile) : store.readCharacter(name, "persona"),
        `## Relationship\n${soul.describeBond(name)}`,
        `## Insights so far\n${soul.readInsights(name, 40).map((i) => `- ${i}`).join("\n") || "(none yet)"}`,
        `## Memories\n${store.readCharacter(name, "memory") || "(none)"}`,
        `## Life plan\n${store.readCharacter(name, "life") || "(none)"}`,
        `## Recent dreams\n${soul.readDreams(name, 12).map((d) => `- ${new Date(d.at).toLocaleString()}: ${d.text}`).join("\n") || "(none)"}`,
        `## Recent conversations (newest last)\n${soul.readTalk(name, 120).join("\n") || "(none)"}`,
      ].join("\n\n"));
    },
  );

  tool(
    "reflect",
    "Save insights a character drew from her memories, dreams and conversations: higher-level understanding, not events (\"they light up when I dance badly\", \"I get restless when the evenings are quiet\", \"they're stressed about work on Mondays\"). 1–6 at a time; they guide her from now on (shown when she's introduced and in free time).",
    { character, insights: z.array(z.string().min(5)).min(1).max(6) },
    async ({ character: id, insights }) => {
      const name = nameOf(id);
      soul.addInsights(name, insights);
      emitActivity({ kind: "result", area: "soul", node: `insights:${id}`, label: `${name} realises: ${insights[0]}`, grew: true });
      return text(`${name} keeps ${insights.length} insight${insights.length === 1 ? "" : "s"}.`);
    },
  );

  tool(
    "relate",
    "Update a character's relationship with the user after something between them: closeness and trust change by small steps (-0.15…0.15), and add what they like or don't, an inside joke, or a moment she treasures.",
    {
      character,
      closeness: z.number().min(-0.15).max(0.15).optional(),
      trust: z.number().min(-0.15).max(0.15).optional(),
      likes: z.array(z.string()).optional(), dislikes: z.array(z.string()).optional(),
      joke: z.string().optional(), moment: z.string().optional(),
    },
    async ({ character: id, closeness, trust, likes, dislikes, joke, moment }) => {
      const name = nameOf(id);
      const b = soul.readBond(name);
      const c = (v: number) => Math.max(0, Math.min(1, v));
      if (closeness) b.closeness = c(b.closeness + closeness);
      if (trust) b.trust = c(b.trust + trust);
      const addTo = (list: string[], items?: string[], max = 20) => { for (const i of items ?? []) if (!list.includes(i)) list.push(i); list.splice(0, Math.max(0, list.length - max)); };
      addTo(b.likes, likes); addTo(b.dislikes, dislikes);
      if (joke) addTo(b.jokes, [joke], 12);
      if (moment) addTo(b.moments, [moment], 15);
      soul.writeBond(name, b);
      emitActivity({ kind: "result", area: "soul", node: `bond:${id}`, label: `${name} ↔ user: closeness ${b.closeness.toFixed(2)}, trust ${b.trust.toFixed(2)}`, grew: true });
      return text(soul.describeBond(name));
    },
  );

  tool(
    "mark_thing",
    "Remember something she noticed in the last camera picture (a snapshot or an attached picture): give where it is in the picture (u from the left, v from the top, 0–1) and the phone finds it in the room. It becomes part of her world: listed in every free time, and she can walk to it (run_behavior walk {thing:'guitar'}, or live: {do:'walk', thing:'guitar'}). Mark interesting, specific things (a guitar, the big plant, a painting, the fruit bowl), not walls.",
    {
      things: z.array(z.object({
        name: z.string().describe("short and specific, e.g. 'green armchair'"),
        u: z.number().min(0).max(1), v: z.number().min(0).max(1),
        kind: z.string().optional().describe("e.g. furniture, plant, art, instrument, food, light, toy"),
        note: z.string().optional().describe("what she thinks of it"),
      })).min(1).max(10),
    },
    async ({ things }) => {
      const r = await body.command("locate", { points: things.map((t) => [t.u, t.v]) }, 5000);
      if (!r.ok) return fail(r.error ?? "the phone couldn't locate them");
      const mapId = body.scene?.mapId as string | null;
      const known = world.readThings(mapId);
      const out: string[] = [];
      things.forEach((t, i) => {
        const p = (r.data as Array<{ x: number; y: number; z: number } | null>)[i];
        if (!p) { out.push(`${t.name}: couldn't find it in the room (try again when it's in clearer view)`); return; }
        known[t.name] = { x: p.x, y: p.y, z: p.z, kind: t.kind ?? "thing", note: t.note ?? "", at: Date.now(), visits: known[t.name]?.visits ?? 0 };
        out.push(`${t.name}: at x ${p.x.toFixed(2)}, z ${p.z.toFixed(2)}`);
      });
      world.writeThings(mapId, known);
      emitActivity({ kind: "result", area: "space", node: "space:map", label: `noticed ${things.map((t) => t.name).join(", ")}`, grew: true });
      return text(out.join("\n"));
    },
  );

  tool(
    "next_job",
    "For background helpers only: your next job (waits up to 4 minutes). Returns the job's instructions and pictures, 'no job' (call again), or 'retire' (finish).",
    { worker: z.string().min(1).describe("Your worker name, the same in every call") },
    async ({ worker }) => {
      const r = await jobs.next(worker);
      if ("retire" in r) return text("Retire now: you've done your share. Finish with one line; a fresh helper takes over.");
      if ("none" in r) return text("No job right now. Call next_job again.");
      const j = r.job;
      return { content: [
        { type: "text", text: `Job ${j.id} (${j.kind}): ${j.title}\n\n${j.brief}\n\nWhen done, call job_done with worker "${worker}", job "${j.id}" and a one-line result, then next_job again.` },
        ...(j.images ?? []).map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" })),
      ] };
    },
  );

  tool(
    "job_done",
    "For background helpers only: the job is finished; give a one-line result. Set tell_mind when the main loop should know now (e.g. a move is ready to play); otherwise it's only shown in the galaxy.",
    { worker: z.string().min(1), job: z.string(), result: z.string(), tell_mind: z.boolean().optional() },
    async ({ worker, job, result, tell_mind }) => {
      const j = jobs.finish(worker, job, result);
      if (tell_mind || j?.kind === "task") hub.report(`${j?.title ?? job}: ${result}`);
      return text("Thanks. Call next_job for the next one.");
    },
  );

  tool(
    "queue_job",
    "Hand slow or thoughtful work to the background helpers instead of doing it in the main loop: learning a move, planning something for the user, preparing an answer that needs care. Give a title and a full brief (what to do, which tools, what to report). A free helper picks it up; its result comes back to you as a helper report.",
    { title: z.string().min(1), brief: z.string().min(10) },
    async ({ title, brief }) => {
      const j = jobs.add({ kind: "task", key: `task:${title}`, title, brief });
      const st = jobs.status();
      return text(j ? `Queued for the helpers (${st.workers.length} running, ${st.queued.length} jobs waiting).` : "That job is already queued or running.");
    },
  );

  tool(
    "room_belief",
    "For helpers working out where she is: write down which room she's in, where she and the user are in it, and how you reasoned. Shown live in the galaxy's rooms view.",
    {
      room: z.string().min(1).describe("The room's name: an existing one if she knows it, else a fitting new name"),
      map: z.string().optional().describe("The map id this is about (default: the phone's current map)"),
      same_as: z.string().optional().describe("Map id of a known room this map looks like but isn't joined with"),
      confidence: z.number().min(0).max(1),
      where: z.string().describe("Where she is in the room, in plain words, by the things around her"),
      user: z.string().optional().describe("Where the user is"),
      reasoning: z.string().describe("2–4 plain sentences: what made you think so, what doesn't fit"),
      worker: z.string().optional(),
    },
    async ({ room, map, same_as, confidence, where, user, reasoning, worker }) => {
      const mapId = map ?? (body.scene?.mapId as string | null) ?? null;
      beliefs.add({ at: Date.now(), mapId, room, ...(same_as ? { sameAs: same_as } : {}), confidence, where, ...(user ? { user } : {}), reasoning, ...(worker ? { by: worker } : {}) });
      emitActivity({ kind: "result", area: "space", node: "space:rooms", label: `she thinks: ${room} (${Math.round(confidence * 100)}%) · ${where}`.slice(0, 160), grew: true });
      let extra = "";
      if (same_as && mapId && same_as !== mapId && groups.canonical(same_as).id !== groups.canonical(mapId).id) {
        const a = groups.canonical(same_as).id, b = groups.canonical(mapId).id;
        if (!jobs.has(`join:${a}|${b}`) && !jobs.has(`join:${b}|${a}`)) {
          const p = roomjoin.pair(a, b) ?? (() => { const r = roomjoin.align(a, b); return r ? { a, b, ...r, at: Date.now(), status: "candidate" as const } : undefined; })();
          const pick = (id: string) => frames.varied(frames.all().filter((m) => m.key && m.mapId === id).slice(-100), 2);
          const pa = pick(a), pb = pick(b);
          jobs.add({ kind: "join", key: `join:${a}|${b}`, title: `same room? ${a.slice(0, 8)} / ${b.slice(0, 8)}`,
            brief: `Are these the same room? Map A ${a} (${world.readRooms()[a]?.name || "unnamed"}) and map B ${b} (${world.readRooms()[b]?.name || "unnamed"}). Pictures 1–${pa.length} are from A, ${pa.length + 1}–${pa.length + pb.length} from B. ${p ? `Their LiDAR maps line up with a score of ${p.score} (0.5+ strong, under 0.3 weak).` : "Their maps couldn't be compared yet."} A helper thought: ${reasoning} Compare what you see. Clearly the same: join_rooms with a "${a}", b "${b}" and why. Clearly different: keep_rooms_apart. Unsure: neither. Result line: your decision.`,
            images: [...pa, ...pb].map((m) => frames.jpeg(m)).filter(Boolean) as string[] });
          extra = " A helper will check whether the two maps are the same room.";
        }
      }
      return text(`Noted: ${room}.${extra}`);
    },
  );

  tool(
    "join_rooms",
    "For helpers: two saved maps are the same room. Joins them: things and places are shared, and the rooms view shows them as one (aligned by their LiDAR maps when they line up).",
    { a: z.string().describe("Map id (the room to keep)"), b: z.string().describe("Map id (joins into a)"), why: z.string() },
    async ({ a, b, why }) => {
      const r = roomjoin.joinRooms(a, b, why);
      emitActivity({ kind: "result", area: "space", node: "space:rooms", label: r.text.slice(0, 160), grew: true });
      return text(r.text);
    },
  );

  tool(
    "keep_rooms_apart",
    "For helpers: two saved maps are different rooms (they won't be suggested for joining again).",
    { a: z.string(), b: z.string(), why: z.string() },
    async ({ a, b, why }) => {
      roomjoin.mark(groups.canonical(a).id, groups.canonical(b).id, "apart", why);
      return text("Kept apart.");
    },
  );

  tool(
    "recall_frames",
    "Look back through camera memory: plain camera pictures the phone keeps sending (no characters drawn in), stored on this computer. Use it whenever you wonder what happened or what is around: what the user showed a moment ago, what was in view when they said something, what a spot looked like earlier. By time (seconds_ago, or at a clock time today like '14:13'), or near a marked thing or named place (pictures that looked at it). Returns up to 8 pictures with their frame ids, oldest first; give a frame id to note_from_frame to mark something in it.",
    {
      seconds_ago: z.number().min(0).optional().describe("Centre of the moment to look at, in seconds before now"),
      at: z.string().optional().describe("A clock time today, 'HH:MM' or 'HH:MM:SS'"),
      span_s: z.number().min(1).max(3600).optional().describe("How long a stretch around that moment (default 10 s; 60 s without a time)"),
      near: z.string().optional().describe("A marked thing or named place: pictures that looked at it"),
      room: z.string().optional().describe("A map id: only pictures from that room (all its joined maps)"),
      count: z.number().int().min(1).max(8).optional().describe("How many pictures (default 4)"),
    },
    async ({ seconds_ago, at, span_s, near, room, count }) => {
      const n = count ?? 4;
      let list = frames.all();
      if (room) { const g = new Set(groups.members(room).map((m) => m.mapId)); list = list.filter((m) => m.mapId && g.has(m.mapId)); }
      if (!list.length) return fail("Camera memory is empty (Settings › Camera memory on the phone; frames arrive while the mind is connected).");
      let centre: number | null = null;
      if (seconds_ago !== undefined) centre = Date.now() - seconds_ago * 1000;
      else if (at) {
        const m = at.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return fail("at must look like 14:13 or 14:13:20");
        const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
        centre = d.getTime();
      }
      if (near) {
        const mapId = (body.scene?.mapId as string | null) ?? hub.knownMap();
        const spot = world.readThings(mapId)[near] ?? store.readPlaces(mapId)[near];
        if (!spot) return fail(`No thing or place "${near}" in this room. Known: ${[...Object.keys(world.readThings(mapId)), ...Object.keys(store.readPlaces(mapId))].join(", ") || "none yet"}.`);
        list = list.filter((m) => {
          if (m.mapId !== mapId) return false;
          const c = frames.camera(m);
          const dx = spot.x - c.x, dz = spot.z - c.z, d = Math.hypot(dx, dz);
          if (d > 5) return false;
          let a = Math.abs(Math.atan2(dx, dz) - c.yaw); if (a > Math.PI) a = 2 * Math.PI - a;
          return d < 0.8 || a < 0.5;
        });
      }
      const span = (span_s ?? (centre !== null ? 10 : 60)) * 1000;
      const mid = centre ?? (list.length ? list[list.length - 1].t - span / 2 : Date.now());
      let window = centre !== null || !near ? list.filter((m) => Math.abs(m.t - mid) <= span / 2) : list;
      if (!window.length && centre !== null) {
        // Nothing then (thinned or not running): the nearest frames to that moment.
        window = [...list].sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid)).slice(0, n).sort((a, b) => a.t - b.t);
      }
      if (!window.length) return fail(near ? `No pictures that looked at ${near} yet.` : "No pictures from then.");
      const picks = frames.spread(window, n);
      const content: CallToolResult["content"] = [];
      const rooms = world.readRooms();
      const lines = picks.map((m) => {
        const c = frames.camera(m);
        const ago = Math.round((Date.now() - m.t) / 1000);
        const when = new Date(m.t).toLocaleTimeString("en-GB");
        const agoText = ago < 120 ? `${ago} s ago` : ago < 7200 ? `${Math.round(ago / 60)} min ago` : `${(ago / 3600).toFixed(1)} h ago`;
        const who = m.characters?.length ? `; ${m.characters.map((x) => x.name).join(", ")} in view` : "";
        return `frame ${m.t}: ${when} (${agoText}), ${m.mapId ? `in ${rooms[m.mapId]?.name ? `"${rooms[m.mapId].name}"` : "a saved room"}` : "in an unsaved room"}, camera at x ${c.x.toFixed(1)}, z ${c.z.toFixed(1)}${who}`;
      });
      content.push({ type: "text", text: `${picks.length} of ${window.length} pictures from then, oldest first (characters are not drawn in camera memory):\n${lines.join("\n")}` });
      for (const m of picks) {
        const data = frames.jpeg(m);
        if (data) content.push({ type: "image", data, mimeType: "image/jpeg" });
      }
      return { content };
    },
  );

  tool(
    "note_from_frame",
    "Mark things she sees in a camera-memory picture (from recall_frames or a study wake), like mark_thing but for an older picture: give the frame id and where the thing is in that picture (u from the left, v from the top, 0–1). It's found in the room from that picture's own depth, so it works while the phone is away. Use kind 'door' or 'window' for those, so they show on her map.",
    {
      frame: z.union([z.string(), z.number()]).describe("Frame id (the number after 'frame')"),
      things: z.array(z.object({
        name: z.string().describe("short and specific, e.g. 'green armchair'"),
        u: z.number().min(0).max(1), v: z.number().min(0).max(1),
        kind: z.string().optional().describe("e.g. furniture, plant, art, door, window, light"),
        note: z.string().optional().describe("what she thinks of it"),
      })).min(1).max(10),
    },
    async ({ frame, things }) => {
      const m = frames.get(frame);
      if (!m) return fail(`No frame ${frame} in camera memory (it may have been thinned out).`);
      const known = world.readThings(m.mapId);
      const out: string[] = [];
      for (const t of things) {
        const p = frames.locate(m, t.u, t.v);
        if (!p) { out.push(`${t.name}: no depth there in that picture (try a point on it nearer the middle, or another frame)`); continue; }
        known[t.name] = { x: p.x, y: p.y, z: p.z, kind: t.kind ?? "thing", note: t.note ?? "", at: Date.now(), visits: known[t.name]?.visits ?? 0 };
        out.push(`${t.name}: at x ${p.x.toFixed(2)}, z ${p.z.toFixed(2)}`);
      }
      world.writeThings(m.mapId, known);
      emitActivity({ kind: "result", area: "space", node: "space:map", label: `noticed ${things.map((t) => t.name).join(", ")} in camera memory`, grew: true });
      return text(out.join("\n") + (m.mapId ? "" : "\n(That picture is from a room that wasn't saved yet; these stay with the unsaved room until it is.)"));
    },
  );

  tool(
    "name_room",
    "Name the room the phone is in (saved room maps are recognised when the user comes back): 'living room', 'Sam's bedroom', 'kitchen', … Everything she learns here stays with this room.",
    { name: z.string().min(1), description: z.string().optional().describe("A sentence or two on what the room is like (from what she has seen), kept with it") },
    async ({ name, description }) => {
      const mapId = (body.scene?.mapId as string | null) ?? hub.knownMap();
      if (!mapId) return fail("This room isn't saved yet (it saves automatically within half a minute of scanning); try again shortly.");
      const rooms = world.readRooms();
      rooms[mapId] = { ...(rooms[mapId] ?? { firstSeen: Date.now(), lastSeen: Date.now(), visits: 1 }), name, ...(description ? { description } : {}) };
      world.writeRooms(rooms);
      emitActivity({ kind: "result", area: "space", node: "space:map", label: `room named ${name}`, grew: true });
      return text(`This room is "${name}".`);
    },
  );

  tool(
    "find_moves",
    `Search her library of ${library().length || "hundreds of"} real human moves (motion capture of real people: gestures, emotions, everyday actions, sitting and getting up, stretches and exercise, dances, play and pantomime). Describe what you want in plain words ("shy", "celebrate", "sit down on the floor", "drink", "waltz"), optionally one category: dance, sit, exercise, emotion, gesture, everyday, play, idle. Play a result with play_animation or a live 'play' step by its name. Prefer these over learning a move from scratch.`,
    { query: z.string(), category: z.enum(["dance", "sit", "exercise", "emotion", "gesture", "everyday", "play", "idle", "other"]).optional(), limit: z.number().int().min(1).max(30).optional() },
    async ({ query, category, limit }) => {
      const found = searchMoves(query, category, limit ?? 12);
      if (!found.length) return text(`Nothing in her library for "${query}"${category ? ` (${category})` : ""}. Try other words, or learn it in the background.`);
      return text(found.map((m) => `${m.name} — ${m.desc} (${m.seconds} s; ${m.tags.join(", ")})`).join("\n"));
    },
  );

  tool(
    "live",
    "Free time: give a character her next minute or two of life as a plan of steps, lived one after another on the phone with no pause between them (far smoother than one tool call per wake). You're woken when the plan ends, when she looks around (look step) or when the user does anything (which ends the plan at once). Steps: {do:'walk', thing|place|x,z|to} · {do:'face', place|x,z|to:'user'} · {do:'idle', seconds, look: degrees (+ = her left), fidgets: move-name prefixes for her little resting movements (e.g. ['graceful_lady_wait','sexy_lady_wait'])} · {do:'sit_on', thing|place|x,z, seconds} (sits properly on the real seat there: sofa, chair, bed edge) · {do:'play', name, times} · {do:'behavior', name, args, seconds} (sit, lie_down, follow_user, …) · {do:'think', text} (a small thought label, silent) · {do:'say', text} (aloud; rarely) · {do:'look'} (wakes you with a camera picture) · {do:'gaze', thing|place|x,z|to:'user', seconds} (look at something while carrying on) · {do:'wait', seconds}. 8–16 steps: always busy, one thing flowing into the next, pauses 2–5 s (idle/wait are capped at 8 s), plenty of moves from her library. When a plan is nearly done you're asked for the next one: calling live then queues it to follow on with no gap.",
    {
      character,
      note: z.string().describe("What she's up to, in a few words (e.g. 'restless: checks out the kitchen, then stretches')"),
      steps: z.array(z.object({
        do: z.enum(["walk", "face", "idle", "sit_on", "play", "behavior", "think", "say", "look", "gaze", "wait"]),
        fidgets: z.union([z.array(z.string()), z.string()]).optional().transform((f) => (typeof f === "string" ? [f] : f)),
        place: z.string().optional(), thing: z.string().optional(), x: z.number().optional(), z: z.number().optional(), to: z.string().optional(),
        seconds: z.number().optional(), look: z.number().optional(),
        name: z.string().optional(), times: z.number().int().optional(), args: z.record(z.any()).optional(),
        text: z.string().optional(),
      })).min(1).max(24),
    },
    async ({ character: id, note, steps }) => {
      nameOf(id);
      const how = life.start(id, steps as Step[], note);
      log(`${id} lives: ${note} (${how})`);
      return text(how === "queued"
        ? `queued: ${note} (${steps.length} steps) follows on as soon as her current plan ends.`
        : `living: ${note} (${steps.length} steps). You'll be asked for the next plan when this one is nearly done, woken when she looks around, or when the user does something.`);
    },
  );

  tool(
    "set_status",
    "Show a small status line over a character (e.g. 'learning to sit…'); empty text clears it. Her spoken lines show over her automatically.",
    { character, text: z.string() },
    async ({ character: id, text: t }) => {
      const r = await body.command("status", { character: id, text: t });
      return r.ok ? text(t ? "status shown" : "status cleared") : fail(r.error ?? "failed");
    },
  );

  tool(
    "report",
    "For helpers (background subagents) only: report back to the main loop, e.g. 'sit_floor is ready (v3): sits down to the floor via a supported crouch'. Wakes the main loop's wait_for_events.",
    { text: z.string().min(1) },
    async ({ text: t }) => {
      hub.report(t);
      log(`helper report: ${t}`);
      return text("reported to the main loop");
    },
  );

  tool(
    "note",
    "Show a short narration note in the phone's chat panel (not spoken), e.g. what you're doing behind the scenes.",
    { text: z.string().min(1) },
    async ({ text: t }) => {
      body.chat(t);
      return text("shown");
    },
  );

  tool(
    "set_controls",
    "Replace the buttons shown to the user (empty list clears them). Taps come back as events with the button id.",
    { buttons: z.array(z.object({ id: z.string(), label: z.string() })).max(8) },
    async ({ buttons }) => {
      const r = await body.command("controls", { buttons });
      return r.ok ? text(`${buttons.length} buttons shown`) : fail(r.error ?? "failed");
    },
  );

  tool("snapshot", "See what the user's phone camera sees right now (the room and the characters).", {}, async () => {
    const r = await body.command("snapshot", {}, 20000);
    if (!r.ok || !r.data?.jpeg) return fail(r.error ?? "no image");
    return { content: [{ type: "image", data: r.data.jpeg as string, mimeType: "image/jpeg" }] };
  });

  tool(
    "spawn_prop",
    "Place a simple primitive prop on the floor.",
    {
      shape: z.enum(["box", "sphere", "cylinder"]),
      color: z.string().optional().describe("Hex colour, e.g. #ff3366"),
      size: z.number().optional().describe("Metres (0.03-1.5), default 0.2"),
      x: z.number(),
      z: z.number(),
    },
    async ({ shape, color, size, x, z: zPos }) => {
      const r = await body.command("spawn", { shape, color: color ?? "#ffffff", size: size ?? 0.2, x, z: zPos });
      return r.ok ? text(r.data) : fail(r.error ?? "failed");
    },
  );

  tool("get_scene", "The current scene graph (characters, user, planes, props, behaviours) and the brain's version.", {}, async () =>
    text({ brain: BRAIN_VERSION, scene: compactScene(body) }),
  );

  tool(
    "get_map",
    "A top-down map of the room from the phone's LiDAR scan, turned so the way the user faces is up: walls and furniture, scanned floor, unscanned areas, the user, the characters (and where they face), doors, windows and named places, with a legend of directions from the user. Use it before walking somewhere you can't see, and whenever left/right/behind is unclear.",
    { radius_m: z.number().min(2).max(15).optional().describe("How far around the user to show (default 6)") },
    async ({ radius_m }) => {
      const scene = body.scene;
      const mapId = (scene?.mapId as string | null) ?? hub.knownMap();
      const r = body.connected ? await body.command("map", {}, 15000) : { ok: false, error: "the phone is away" } as { ok: boolean; data?: any; error?: string };
      let grid: Grid | null = r.ok && r.data?.rows ? (r.data as Grid) : null;
      let memoryNote = "";
      if (grid) {
        if (mapId) roommap.savePhone(mapId, grid);
        const f = roommap.fill(grid, mapId);
        grid = f.grid;
        if (f.filled) memoryNote = `\n(${f.filled} cells the phone hasn't scanned this time are filled in from camera memory.)`;
      } else if (mapId && (grid = roommap.grid(mapId))) {
        memoryNote = `\n(The phone's scan isn't available (${r.error ?? r.data?.error ?? "no map"}): this is the room as camera memory knows it; the user and characters are where they were last seen.)`;
      }
      if (!grid) return fail(r.error ?? r.data?.error ?? "no map yet");
      const u = (scene?.user ?? {}) as Record<string, number>;
      const user = { x: u.x ?? 0, z: u.z ?? 0, yaw: u.yaw ?? 0 };
      const marks: Parameters<typeof renderMap>[2] = [];
      for (const c of scene?.characters ?? []) marks.push({ label: `${c.id} ${c.name}`, x: c.x, z: c.z, yaw: c.yaw, kind: "character" });
      for (const [name, p] of Object.entries(store.readPlaces(mapId))) marks.push({ label: name, x: p.x, z: p.z, kind: "place" });
      for (const [name, t] of Object.entries(world.readThings(mapId))) marks.push({ label: name, x: t.x, z: t.z, kind: t.kind === "door" || t.kind === "window" ? t.kind : "place" });
      for (const p of (scene?.planes ?? []) as Array<Record<string, any>>) {
        if (p.kind === "door" || p.kind === "window") marks.push({ label: `${p.kind} ${p.id}`, x: p.x, z: p.z, kind: p.kind });
      }
      const map = renderMap(grid, user, marks, radius_m ?? 6);
      const note = (r.ok && r.data && !r.data.lidar ? "\n(No LiDAR on this phone: only walls detected as planes are shown.)" : "") + memoryNote;
      return { content: [{ type: "text", text: map.legend + note }, { type: "image", data: map.png.toString("base64"), mimeType: "image/png" }] };
    },
  );

  tool(
    "name_place",
    "Remember a named spot in this room map ('kitchen', 'sofa', 'Sam's desk'): at the user's position (default), at a character, or at x/z. Places are listed in every scene with directions from the user, and walking there is run_behavior walk {place: name}.",
    {
      name: z.string().min(1),
      at: z.string().optional().describe("'user' (default) or a character id"),
      x: z.number().optional(),
      z: z.number().optional(),
    },
    async ({ name, at, x, z: zPos }) => {
      const scene = body.scene;
      if (!scene) return fail("no scene yet");
      let p: { x: number; z: number } | undefined;
      if (x !== undefined && zPos !== undefined) p = { x, z: zPos };
      else if (at && at !== "user") {
        const c = scene.characters.find((ch) => ch.id === at);
        if (!c) return fail(`no character ${at}`);
        p = { x: c.x, z: c.z };
      } else {
        const u = scene.user as Record<string, number>;
        p = { x: u.x ?? 0, z: u.z ?? 0 };
      }
      const places = store.readPlaces(scene.mapId as string | null);
      places[name] = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
      store.writePlaces(scene.mapId as string | null, places);
      return text(`remembered "${name}"${scene.mapId ? "" : " (this room map isn't saved yet, so it lasts for this session)"}`);
    },
  );

  tool("forget_place", "Forget a named place.", { name: z.string() }, async ({ name }) => {
    const scene = body.scene;
    const places = store.readPlaces(scene?.mapId as string | null);
    if (!(name in places)) return fail(`no place "${name}"`);
    delete places[name];
    store.writePlaces(scene?.mapId as string | null, places);
    return text(`forgot "${name}"`);
  });

  tool("get_character", "A character's persona, memories and life plan.", { character }, async ({ character: id }) =>
    text(introduce(id, nameOf(id))),
  );

  tool("list_behaviors", "Behaviour scripts with their one-line descriptions.", {}, async () => {
    const files = store.behaviorFiles();
    return text(Object.entries(files).map(([n, code]) => `${n}: ${code.split("\n")[0].replace(/^\/\/\s*/, "")}`).join("\n"));
  });

  tool("read_behavior", "Read a behaviour script, with its version history.", { name: z.string() }, async ({ name }) => {
    const code = store.readBehavior(name);
    if (code === null) return fail(`no behaviour "${name}"`);
    return text(`${code}\n\n// history (newest first):\n${store.behaviorHistory(name).map((l) => `// ${l}`).join("\n")}`);
  });

  tool(
    "write_behavior",
    "Create or replace a behaviour script. It is loaded on the phone at once; if it fails to load, nothing changes and you get the error. Every write is a new version you can revert.",
    {
      name: z.string().describe("lower_snake_case"),
      code: z.string().describe("Full JavaScript source; must call behavior(name, {...})"),
      note: z.string().describe("What changed and why (the version message)"),
    },
    async ({ name, code, note }) => {
      if (!store.BEHAVIOR_NAME.test(name)) return fail("name must be lower_snake_case");
      if (!code.includes(`behavior("${name}"`) && !code.includes(`behavior('${name}'`))
        return fail(`the script must register itself with behavior("${name}", {...})`);
      if (store.readBehavior(name) === code) return text("unchanged");
      const r = await body.pushBehaviors({ [name]: code });
      const errors: string[] = r.data?.errors ?? [];
      if (!r.ok || errors.length) return fail(`not saved; the phone said: ${errors.join("; ") || r.error}`);
      store.writeBehavior(name, code);
      const rev = store.commitBehavior(name, note);
      log(`wrote behaviour ${name} (${rev})`);
      return text(`saved ${name} as ${rev}; live on the phone`);
    },
  );

  const euler = z.tuple([z.number(), z.number(), z.number()]);
  const key = z.object({
    t: z.number().min(0).describe("Seconds from the start"),
    joints: z.record(euler).optional().describe("Joint name → [x, y, z] degrees (see the pose guide)"),
    root: euler.optional().describe("Pelvis offset in metres [x left, y up, z forward]"),
  });

  tool(
    "animation_guide",
    "The pose guide and animation craft rules (read this before writing animations, especially as a helper).",
    {},
    async () => {
      const prompt = fs.readFileSync(path.join(store.BRAIN_ROOT, "prompts/system.md"), "utf8");
      const start = prompt.indexOf("# Moving the body");
      const end = prompt.indexOf("# Behaviours are yours to improve and invent");
      const reference = store.readBehavior("anim_wave_hello") ?? "";
      return text(`${prompt.slice(start, end > start ? end : undefined)}\n\nReference move (anim_wave_hello):\n${reference}`);
    },
  );

  tool(
    "write_animation",
    "Create or refine a keyframe animation (a move: wave, toe touch, sit, bow, …). Every call returns a contact sheet of the move (front and side views of her skeleton over time, drawn with the phone's own maths) and a critique. Drafts with errors (feet through the floor, too few joints or keys) are not saved. A move must be refined to at least 3 saved versions, each one looked at and improved, before play_animation will play it. Follow the animation craft and pose guide in your instructions.",
    {
      name: z.string().describe("lower_snake_case, e.g. touch_toes"),
      duration: z.number().min(0.1).max(60),
      loop: z.boolean().optional(),
      plant_feet: z.boolean().optional().describe("Default true: legs whose hip/knee you don't set keep their feet on the floor"),
      keys: z.array(key.extend({ ease: z.enum(["inOut", "in", "out", "linear", "step"]).optional() })).min(1).max(120),
      note: z.string().describe("What it is and what this version improved (the version message)"),
    },
    async ({ name, duration, loop, plant_feet, keys, note }) => {
      if (!store.BEHAVIOR_NAME.test(name)) return fail("name must be lower_snake_case");
      const sorted = [...keys].sort((a, b) => a.t - b.t);
      if (sorted[sorted.length - 1].t > duration + 1e-6) return fail("a key's t is after the duration");
      const clip = { duration, loop: loop ?? false, plantFeet: plant_feet ?? true, keys: sorted };
      const file = `anim_${name}`;
      let rev;
      try {
        rev = review(name, clip);
      } catch (e) {
        return fail(`could not preview it: ${e instanceof Error ? e.message : String(e)}`);
      }
      const sheet = { type: "image" as const, data: contactSheet(rev).toString("base64"), mimeType: "image/png" };
      const legend =
        "Contact sheet: 8 moments left→right (green bar = time), top row front view (her left on your right), bottom row side view from her left (she faces left). Blue = left limbs, orange = right, red dot = nose, red joints = under the floor.";
      const versions = store.behaviorHistory(file).length;
      if (rev.errors.length) {
        return {
          content: [
            { type: "text", text: `Not saved (draft ${name}, ${versions} saved version(s)). Fix:\n- ${rev.errors.join("\n- ")}${rev.notes.length ? `\nAlso:\n- ${rev.notes.join("\n- ")}` : ""}\n${legend}` },
            sheet,
          ],
          isError: true,
        };
      }
      const code = `// ${note.split("\n")[0]}\nanimation(${JSON.stringify(name)}, ${JSON.stringify(clip, null, 1)});\n`;
      if (store.readBehavior(file) === code) return text("unchanged");
      const r = await body.pushBehaviors({ [file]: code });
      const errors: string[] = r.data?.errors ?? [];
      if (body.connected && (!r.ok || errors.length)) return fail(`not saved; the phone said: ${errors.join("; ") || r.error}`);
      store.writeBehavior(file, code);
      const commit = store.commitBehavior(file, note);
      const now = versions + 1;
      log(`wrote animation ${name} v${now} (${commit})`);
      const next =
        now < MIN_VERSIONS
          ? `Version ${now} of at least ${MIN_VERSIONS}. Study the sheet like an animator: silhouette and line of action at each moment, weight over the feet, arcs, timing and spacing, which body parts are still dead. Then improve it with write_animation (same name).`
          : `Version ${now}: playable with play_animation. Refine more if the sheet still looks stiff or wrong.`;
      return {
        content: [
          { type: "text", text: `Saved ${name} v${now} (${commit}). ${rev.animatedJoints.length} joints move.${rev.notes.length ? `\nCritique:\n- ${rev.notes.join("\n- ")}` : ""}\n${next}\n${legend}` },
          sheet,
        ],
      };
    },
  );

  tool(
    "play_animation",
    "Play an animation on a character (blends from her current pose). When it ends she goes back to resting (idle). times plays it that many times in a row (\"do 20 push-ups\": times = 20 ÷ reps in one play); loop keeps it going until something else starts; notify wakes you when it ends. Fails if she doesn't have the move yet: then learn it first.",
    {
      character,
      name: z.string(),
      loop: z.boolean().optional(),
      times: z.number().int().min(1).max(200).optional().describe("Play it this many times in a row"),
      speed: z.number().min(0.1).max(4).optional(),
      notify: z.boolean().optional(),
      say: z.string().optional().describe("A short line she says as she starts (same as calling say; saves a step)"),
    },
    async ({ character: id, name, loop, times, speed, notify, say: line }) => {
      life.cancel(id, "the mind took over");
      life.note(id, `did ${name.replace(/_/g, " ")}${times ? ` ×${times}` : ""}`);
      if (store.readBehavior(`anim_${name}`) === null) {
        // Not one she made herself: her motion-capture library?
        const lib = inLibrary(name);
        if (lib) {
          const [r] = await Promise.all([
            body.command("run", { character: id, behavior: "move", args: { name, ...(times ? { times } : {}), ...(speed ? { speed } : {}), ...(loop ? { loop } : {}) } }),
            line ? speak(id, line, true) : Promise.resolve(),
          ]);
          if (!r.ok) return fail(r.error ?? "failed");
          body.started(id, "move");
          if (notify) hub.watch(id, "move");
          return text(`playing ${name} (${lib.desc}) on ${id}${times ? ` ${times} times` : ""} (about ${Math.round((lib.seconds * (times ?? 1)) / (speed ?? 1))} s)`);
        }
        const have = Object.keys(store.behaviorFiles()).filter((n) => n.startsWith("anim_") && n !== "anim").map((n) => n.slice(5));
        return fail(`She doesn't have "${name}" (her own moves: ${have.join(", ") || "none"}; search her library with find_moves). Use one she has, or learn it in the background.`);
      }
      const history = store.behaviorHistory(`anim_${name}`);
      const versions = history.length;
      const shipped = history.every((h) => / (Seed behaviours|Add app behaviours|Update app behaviours)/.test(h));
      if (store.readBehavior(`anim_${name}`) !== null && versions < MIN_VERSIONS && !shipped)
        return fail(`${name} has ${versions} saved version(s); refine it to at least ${MIN_VERSIONS} with write_animation (look at each contact sheet and improve it) before playing. Tell the user in character that you're working on it.`);
      const args: Record<string, unknown> = { name };
      if (loop !== undefined) args.loop = loop;
      if (times !== undefined) args.times = times;
      if (speed !== undefined) args.speed = speed;
      const [r] = await Promise.all([
        body.command("run", { character: id, behavior: "play", args }),
        line ? speak(id, line, true) : Promise.resolve(),
      ]);
      if (!r.ok) return fail(r.error ?? "failed");
      body.started(id, "play");
      if (notify) hub.watch(id, "play");
      const dur = Number(/"?duration"?\s*:\s*([\d.]+)/.exec(store.readBehavior(`anim_${name}`) ?? "")?.[1] ?? 0);
      const secs = dur * (times ?? 1) / (speed ?? 1);
      log(`${id} plays ${name}${times ? ` ×${times}` : ""}`);
      return text(`playing ${name} on ${id}${times ? ` ${times} times` : ""}${secs ? ` (about ${Math.round(secs)} s)` : ""}`);
    },
  );

  tool(
    "revert_behavior",
    "Put a behaviour back to an earlier version (from read_behavior's history). Without a version, goes back one.",
    { name: z.string(), version: z.string().optional() },
    async ({ name, version }) => {
      const rev = version ?? store.behaviorHistory(name)[1]?.split(" ")[0];
      if (!rev) return fail("no earlier version");
      const code = store.behaviorAt(name, rev);
      if (code === null) return fail(`no version ${rev} of ${name}`);
      const r = await body.pushBehaviors({ [name]: code });
      if (!r.ok || (r.data?.errors ?? []).length) return fail(`phone rejected it: ${(r.data?.errors ?? []).join("; ") || r.error}`);
      store.writeBehavior(name, code);
      const now = store.commitBehavior(name, `revert to ${rev}`);
      return text(`${name} is back at ${rev} (saved as ${now})`);
    },
  );

  tool(
    "remember",
    "Add a long-term memory for a character (facts about the user, shared moments, preferences).",
    { character, fact: z.string().min(1) },
    async ({ character: id, fact }) => {
      const name = nameOf(id);
      store.appendMemory(name, fact);
      soul.happened(name);
      return text("remembered");
    },
  );

  tool(
    "update_persona",
    "Rewrite a character's persona: who she is, how she talks, what she cares about. Under 200 words.",
    { character, text: z.string().min(1) },
    async ({ character: id, text: t }) => {
      store.writeCharacter(nameOf(id), "persona", t);
      return text("persona saved");
    },
  );

  tool(
    "update_life",
    "Rewrite a character's life plan: what she's up to, her mood, goals, what she'll do while the user is away. Short.",
    { character, plan: z.string().min(1) },
    async ({ character: id, plan }) => {
      store.writeCharacter(nameOf(id), "life", plan);
      return text("life plan saved");
    },
  );
}
