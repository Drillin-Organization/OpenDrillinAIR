// The fast mind: everyday physical requests ("come here", "sit down", "go to
// the kitchen", "stop") are carried out the moment they're heard, before the
// slow mind (the chat) has thought about them. The mind is told what she
// already started, and adds the words and anything else.
import type { Body } from "./body.js";
import * as store from "./store.js";
import * as world from "./world.js";
import { emitActivity, moveNode } from "./ui.js";

type Act = { behavior: string; args?: Record<string, unknown>; did: string } | { gaze: true; did: string };

const NEGATION = /\b(don'?t|do not|never|not|no need|stop (coming|following))\b/i;

/// The character being spoken to: named in the phrase, selected, or nearest.
function listener(body: Body, text: string): string | null {
  const scene = body.scene;
  const chars = scene?.characters ?? [];
  if (!chars.length) return null;
  const lower = text.toLowerCase();
  const named = chars.find((c) => lower.includes(c.name.toLowerCase()));
  if (named) return named.id;
  const sel = chars.find((c) => (c as any).selected);
  if (sel) return sel.id;
  const u = (scene?.user ?? {}) as Record<string, number>;
  return [...chars].sort((a, b) => Math.hypot(a.x - (u.x ?? 0), a.z - (u.z ?? 0)) - Math.hypot(b.x - (u.x ?? 0), b.z - (u.z ?? 0)))[0].id;
}

/// What a phrase asks her body to do right now, if it's a clear everyday request.
function decide(body: Body, id: string, text: string): Act | null {
  const t = text.toLowerCase().replace(/[^\w' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (NEGATION.test(t)) return null;
  const c = body.scene?.characters.find((x) => x.id === id);
  if (/\b(come (here|over|to me|back|closer)|come$|get over here)\b/.test(t)) return { behavior: "walk", args: { to: "user" }, did: "walking to the user" };
  if (/\bfollow me\b/.test(t)) return { behavior: "follow_user", args: { keep: 1 }, did: "following the user" };
  if (/^(stop|wait|stay|hold on|freeze)\b|\b(stop (it|there|walking|moving))\b/.test(t)) return { behavior: "idle", did: "stopped where she is" };
  if (/\b(stand up|get up)\b/.test(t)) return { behavior: "idle", did: "standing up" };
  if (/\b(sit down|take a seat|have a seat)\b/.test(t) && c) {
    const seat = ((body.scene?.planes ?? []) as Array<Record<string, any>>)
      .filter((p) => p.kind === "seat")
      .map((p) => ({ p, d: Math.hypot(p.x - c.x, p.z - c.z) }))
      .sort((a, b) => a.d - b.d)[0];
    if (seat && seat.d < 3) return { behavior: "sit_on", args: { x: seat.p.x, z: seat.p.z, y: seat.p.y }, did: "going to sit on the seat nearby" };
    return null; // no seat near: let the mind choose (floor, etc.)
  }
  if (/\blook at me\b/.test(t)) return { gaze: true, did: "looking at the user" };
  if (/\b(wave|say hi|say hello)\b/.test(t)) return { behavior: "move", args: { name: "wave_hello" }, did: "waving" };
  if (/\bjump\b/.test(t) && !/\bjump(ing)? (rope|jack)/.test(t)) return { behavior: "move", args: { name: "jump" }, did: "jumping" };
  // "go to the kitchen", "walk over to the plant"
  const m = /\b(go|walk|run|head|move) (over |back )?(to|towards|into) (the |my |your )?([\w' ]{2,40})$/.exec(t);
  if (m) {
    const want = m[5].trim();
    const mapId = body.scene?.mapId as string | null;
    const places = store.readPlaces(mapId), things = world.readThings(mapId);
    const match = (names: string[]) => names.find((n) => n.toLowerCase() === want) ?? names.find((n) => want.includes(n.toLowerCase()) || n.toLowerCase().includes(want));
    const place = match(Object.keys(places));
    if (place) return { behavior: "walk", args: { x: places[place].x, z: places[place].z }, did: `walking to the ${place}` };
    const thing = match(Object.keys(things));
    if (thing) return { behavior: "walk", args: { x: things[thing].x, z: things[thing].z }, did: `walking to the ${thing}` };
  }
  return null;
}

/// Runs a reflex for a heard or typed phrase; returns a note for the mind, or null.
export async function react(body: Body, text: string): Promise<string | null> {
  const id = listener(body, text);
  if (!id) return null;
  const act = decide(body, id, text);
  if (!act) return null;
  if ("gaze" in act) {
    await body.command("gaze", { character: id, to: "user", seconds: 5 });
  } else {
    const r = await body.command("run", { character: id, behavior: act.behavior, args: act.args ?? {} });
    if (!r.ok) return null;
    body.started(id, act.behavior);
  }
  emitActivity({ kind: "tool", area: "mind", node: "mind:reflexes", label: `reflex: ${id} ${act.did}` });
  if (!("gaze" in act)) emitActivity({ kind: "result", area: act.behavior === "move" ? "skills" : "body", node: act.behavior === "move" ? moveNode(String(act.args?.name)) : `behavior:${act.behavior}`, label: `reflex ${act.did}`, ok: true });
  return `(Reflex: ${id} already started ${act.did}. Don't repeat it; add what she says, and anything more the moment needs.)`;
}
