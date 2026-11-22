// Her life between interactions. In free time the mind writes what she does
// next as a short plan (a minute or two of steps); this runner lives it step
// by step on the phone without a thinking pause between steps, so she's
// continuously, naturally busy. Anything the user does, or the mind taking
// over a character, ends her plan at once. Also keeps a log of what each
// character did lately and an energy rhythm (ups and downs over minutes).
import type { Body, BodyEvent } from "./body.js";
import { log } from "./events.js";
import * as store from "./store.js";
import { emitActivity, stepNode } from "./ui.js";
import { inLibrary } from "./moves.js";
import * as soul from "./soul.js";
import * as world from "./world.js";

export type Step =
  | { do: "walk"; x?: number; z?: number; to?: string; place?: string; thing?: string }
  | { do: "face"; x?: number; z?: number; to?: string; place?: string; thing?: string }
  | { do: "idle"; seconds?: number; look?: number; fidgets?: string[] }
  | { do: "sit_on"; seconds?: number; x?: number; z?: number; place?: string; thing?: string }
  | { do: "play"; name: string; times?: number }
  | { do: "behavior"; name: string; args?: Record<string, unknown>; seconds?: number }
  | { do: "think"; text: string }
  | { do: "say"; text: string }
  | { do: "look" }
  | { do: "gaze"; seconds?: number; x?: number; z?: number; to?: string; place?: string; thing?: string }
  | { do: "wait"; seconds: number };

type Plan = { id: string; steps: Step[]; note: string; i: number; cancelled: boolean; done: string[] };

export class Life {
  private plans = new Map<string, Plan>();
  private recent = new Map<string, Array<{ t: number; what: string }>>();
  private phase = new Map<string, number>();

  constructor(
    private body: Body,
    private speak: (id: string, line: string) => Promise<unknown>,
    private wake: (line: string, image?: string) => void,
  ) {}

  /// Her plan right now, for the galaxy page.
  current(id: string): { note: string; step: number; steps: string[]; done: string[] } | null {
    const p = this.plans.get(id);
    if (!p) return null;
    const show = (st: Step) => {
      const { do: kind, ...rest } = st as Record<string, unknown> & { do: string };
      const arg = rest.name ?? rest.text ?? rest.place ?? rest.thing ?? rest.to ?? (rest.seconds ? `${rest.seconds} s` : "");
      return `${kind}${arg ? ` ${String(arg).slice(0, 60)}` : ""}`;
    };
    return { note: p.note, step: p.i, steps: p.steps.map(show), done: [...p.done] };
  }

  /// Recent things she did (newest last).
  recentDone(id: string): Array<{ t: number; what: string }> {
    return [...(this.recent.get(id) ?? [])];
  }

  running(id?: string): boolean {
    return id ? this.plans.has(id) : this.plans.size > 0;
  }

  /// Something she did (from plans and from the mind's own commands).
  note(id: string, what: string): void {
    const list = this.recent.get(id) ?? [];
    list.push({ t: Date.now(), what });
    if (list.length > 20) list.shift();
    this.recent.set(id, list);
  }

  /// "4 min ago: sat on the sofa; 1 min ago: stretched" (newest last).
  history(id: string): string {
    const now = Date.now();
    const list = (this.recent.get(id) ?? []).filter((r) => now - r.t < 15 * 60_000).slice(-8);
    if (!list.length) return "nothing yet";
    return list.map((r) => {
      const s = Math.round((now - r.t) / 1000);
      return `${s < 60 ? `${s} s` : `${Math.round(s / 60)} min`} ago: ${r.what}`;
    }).join("; ");
  }

  /// Energy rises and falls over a few minutes, a little different per character.
  energy(id: string): { level: number; label: string } {
    if (!this.phase.has(id)) this.phase.set(id, Math.random() * Math.PI * 2);
    const t = Date.now() / 1000;
    const p = this.phase.get(id)!;
    // The day's rhythm underneath: liveliest mid-afternoon, lowest in the small hours.
    const d = new Date(), hour = d.getHours() + d.getMinutes() / 60;
    const day = 0.14 * Math.cos(((hour - 15) / 24) * 2 * Math.PI);
    const level = Math.max(0, Math.min(1, 0.48 + day + 0.25 * Math.sin((2 * Math.PI * t) / 420 + p) + 0.12 * Math.sin((2 * Math.PI * t) / 97 + 2 * p)));
    const label = level > 0.72 ? "restless: wants to move, explore, do something physical"
      : level > 0.52 ? "lively: curious, up for wandering and trying things"
      : level > 0.32 ? "mellow: unhurried, likes looking around, small things, sitting a while"
      : "low: wants to rest, sit or lie down, daydream";
    return { level: Math.round(level * 100) / 100, label };
  }

  start(id: string, steps: Step[], note: string): void {
    this.cancel(id, "replaced by a new plan");
    const plan: Plan = { id, steps: steps.slice(0, 24), note, i: 0, cancelled: false, done: [] };
    this.plans.set(id, plan);
    emitActivity({ kind: "tool", area: "soul", node: `plan:${id}`, label: `${id} plans: ${note}`, grew: true });
    void this.run(plan);
  }

  /// Ends her plan (the user did something, or the mind took over).
  cancel(id: string, why: string): void {
    const plan = this.plans.get(id);
    if (!plan) return;
    plan.cancelled = true;
    this.plans.delete(id);
    log(`life: ${id}'s plan stopped (${why})`);
  }

  cancelAll(why: string): void {
    for (const id of [...this.plans.keys()]) this.cancel(id, why);
  }

  private async run(plan: Plan): Promise<void> {
    const { id } = plan;
    for (; plan.i < plan.steps.length && !plan.cancelled; plan.i++) {
      const step = plan.steps[plan.i];
      try {
        const did = await this.step(id, step, plan);
        if (did && !plan.cancelled) {
          plan.done.push(did);
          this.note(id, did);
          emitActivity({ kind: "tool", area: step.do === "play" ? "skills" : step.do === "say" ? "voice" : step.do === "think" ? "soul" : "body", node: stepNode(id, step as { do: string; name?: string }), label: `${id} (plan ${plan.i + 1}/${plan.steps.length}): ${did}` });
        }
      } catch (e) {
        log(`life: ${id} step ${plan.i + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (plan.cancelled) return;
    this.plans.delete(id);
    await this.body.command("status", { character: id, text: "" });
    this.wake(`Free time: ${id}'s plan ("${plan.note}") is done. She did: ${plan.done.join("; ") || "nothing (every step failed)"}. Decide her next stretch of life.`);
  }

  private async step(id: string, s: Step, plan: Plan): Promise<string | null> {
    switch (s.do) {
      case "walk": case "face": {
        const args = this.target(s);
        if (!args) return null;
        const r = await this.body.command("run", { character: id, behavior: s.do, args: { ...args, quiet: true } });
        if (!r.ok) { this.note(id, `couldn't ${s.do} to ${this.describe(s)} (${r.error})`); return null; }
        const end = await this.until(id, [s.do], s.do === "walk" ? 40_000 : 6000, plan);
        if (s.do === "walk" && end !== "stuck") {
          if (!this.history(id).includes(this.describe(s))) soul.discovered(id);
          const c = this.body.scene?.characters.find((x) => x.id === id);
          if (c) world.visitedNear(this.body.scene?.mapId as string | null, c.x, c.z);
        }
        return end === "stuck" ? `got stuck walking to ${this.describe(s)}` : `${s.do === "walk" ? "walked to" : "turned to"} ${this.describe(s)}`;
      }
      case "idle": {
        const r = await this.body.command("run", { character: id, behavior: "idle", args: { ...(s.look !== undefined ? { look: s.look } : {}), ...(s.fidgets ? { fidgets: s.fidgets } : {}) } });
        if (!r.ok) return null;
        await this.sleep(Math.min(120, Math.max(2, s.seconds ?? 8)) * 1000, plan);
        return `rested and looked around (${Math.round(s.seconds ?? 8)} s)`;
      }
      case "play": {
        // Her own learned moves, else the motion-capture library.
        const own = store.readBehavior(`anim_${s.name}`) !== null;
        if (this.history(id).includes(s.name.replace(/_/g, " "))) soul.repeated(id);
        if (!own && !inLibrary(s.name)) { this.note(id, `wanted to ${s.name} but doesn't know it`); return null; }
        const behavior = own ? "play" : "move";
        const r = await this.body.command("run", { character: id, behavior, args: { name: s.name, ...(s.times ? { times: s.times } : {}) } });
        if (!r.ok) return null;
        await this.until(id, [behavior], 180_000, plan);
        return `did ${s.name.replace(/_/g, " ")}${s.times && s.times > 1 ? ` ×${s.times}` : ""}`;
      }
      case "behavior": {
        const r = await this.body.command("run", { character: id, behavior: s.name, args: s.args ?? {} });
        if (!r.ok) { this.note(id, `couldn't ${s.name} (${r.error})`); return null; }
        await this.until(id, [s.name], Math.min(180, s.seconds ?? 20) * 1000, plan);
        return s.name.replace(/_/g, " ");
      }
      case "think":
        await this.body.command("status", { character: id, text: s.text });
        return `thought “${s.text}”`;
      case "say": {
        await this.speak(id, s.text);
        await this.sleep(Math.max(1500, s.text.length * 70), plan);
        return `said “${s.text}”`;
      }
      case "look": {
        const r = await this.body.command("snapshot", { longSide: 640 }, 5000);
        soul.discovered(id);
        if (r.ok && r.data?.jpeg) this.wake(`${id} looks around during her plan ("${plan.note}"); the camera picture is attached. React if something catches her eye (remember it, name the spot, change her plan) or let her carry on.`, r.data.jpeg as string);
        return "looked around";
      }
      case "sit_on": {
        const seat = this.seat(id, s);
        if (!seat) { this.note(id, `looked for a seat at ${this.describe(s)} but found none`); return null; }
        const r = await this.body.command("run", { character: id, behavior: "sit_on", args: seat });
        if (!r.ok) { this.note(id, `couldn't sit at ${this.describe(s)} (${r.error})`); return null; }
        await this.sleep(Math.min(300, Math.max(5, s.seconds ?? 25)) * 1000, plan);
        return `sat on ${s.thing ?? s.place ?? "a seat"} for ${Math.round(s.seconds ?? 25)} s`;
      }
      case "gaze": {
        // Look at something (or the user) while carrying on as she is.
        const secs = Math.min(60, Math.max(1, s.seconds ?? 4));
        const t = s.to === "user" ? { to: "user" } : this.target(s);
        if (!t) return null;
        const th = s.thing ? world.readThings(this.body.scene?.mapId as string | null)[s.thing] : undefined;
        await this.body.command("gaze", { character: id, ...t, ...(th ? { y: th.y } : {}), seconds: secs });
        await this.sleep(secs * 1000, plan);
        return `looked at ${this.describe(s)} for ${Math.round(secs)} s`;
      }
      case "wait":
        await this.sleep(Math.min(120, Math.max(1, s.seconds)) * 1000, plan);
        return null;
    }
  }

  /// A seat to sit on: a marked thing (its measured height), or the seat
  /// plane nearest the given spot (else nearest her).
  private seat(id: string, s: { x?: number; z?: number; place?: string; thing?: string }): { x: number; z: number; y: number } | null {
    const scene = this.body.scene;
    if (s.thing) {
      const t = world.readThings(scene?.mapId as string | null)[s.thing];
      if (t) return { x: t.x, z: t.z, y: t.y };
    }
    const c = scene?.characters.find((x) => x.id === id);
    const at = this.target(s) as { x?: number; z?: number } | null;
    const from = at && typeof at.x === "number" ? { x: at.x, z: at.z! } : c ? { x: c.x, z: c.z } : null;
    if (!from) return null;
    const seats = ((scene?.planes ?? []) as Array<Record<string, any>>).filter((p) => ["seat", "bed"].includes(p.kind) || (p.kind === "table" && false));
    const best = seats.map((p) => ({ p, d: Math.hypot(p.x - from.x, p.z - from.z) })).sort((a, b) => a.d - b.d)[0];
    if (!best || best.d > 2.5) return null;
    return { x: best.p.x, z: best.p.z, y: best.p.y };
  }

  private target(s: { x?: number; z?: number; to?: string; place?: string; thing?: string }): Record<string, unknown> | null {
    if (s.thing) {
      const t = world.readThings(this.body.scene?.mapId as string | null)[s.thing];
      return t ? { x: t.x, z: t.z } : null;
    }
    if (s.place) {
      const p = store.readPlaces(this.body.scene?.mapId as string | null)[s.place];
      return p ? { x: p.x, z: p.z } : null;
    }
    if (s.to) return { to: s.to };
    if (typeof s.x === "number" && typeof s.z === "number") return { x: s.x, z: s.z };
    return null;
  }

  private describe(s: { x?: number; z?: number; to?: string; place?: string; thing?: string }): string {
    return s.thing ?? s.place ?? (s.to === "user" ? "the user" : s.to ?? `(${s.x?.toFixed(1)}, ${s.z?.toFixed(1)})`);
  }

  /// Waits until her behaviour finishes (done, stuck, error, replaced) or the time's up.
  private until(id: string, names: string[], ms: number, plan: Plan): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearInterval(poll);
        this.body.off("event", onEvent);
        resolve(why);
      };
      const onEvent = (e: BodyEvent) => {
        if (e.data.character !== id) return;
        if (e.kind === "walk_stuck") finish("stuck");
        else if ((e.kind === "behavior_done" || e.kind === "behavior_error") && names.includes(String(e.data.behavior))) finish(e.kind);
      };
      this.body.on("event", onEvent);
      const started = Date.now();
      const poll = setInterval(() => {
        if (plan.cancelled) return finish("cancelled");
        const c = this.body.scene?.characters.find((x) => x.id === id);
        if (Date.now() - started > 3000 && c && !names.includes(c.behavior)) finish("ended");
      }, 500);
      const timer = setTimeout(() => finish("timeout"), ms);
    });
  }

  private sleep(ms: number, plan: Plan): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (plan.cancelled || Date.now() - t0 >= ms) { clearInterval(tick); resolve(); }
      }, 250);
    });
  }
}
