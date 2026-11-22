// Background helpers: a pool of workers (Claude Code subagents started by the
// main loop) that keep her inner life going in parallel: where she thinks she
// is, studying rooms, joining rooms that are the same, reflection, and any
// slow work the main loop hands over (learning a move, thinking something
// through). Each worker loops: next_job → do it → job_done → next_job. The
// brain keeps the queue and asks the main loop to start more workers when
// fewer than the configured number (phone Settings, default 2) are alive.
import { emitActivity } from "./ui.js";

export type Job = {
  id: string;
  kind: "locate" | "study" | "join" | "reflect" | "task";
  title: string;
  brief: string;
  images?: string[];
  /// Only one job with the same key is queued or running at a time.
  key: string;
  at: number;
  takenBy?: string;
  takenAt?: number;
  /// Called when the job is handed out (e.g. mark frames studied).
  onTake?: () => void;
};
type Worker = { name: string; started: number; seen: number; jobs: number; current?: string; waiting: boolean };

const PRIORITY: Record<Job["kind"], number> = { task: 0, locate: 1, join: 2, reflect: 3, study: 4 };
/// A worker retires after this many jobs or minutes (its context stays small).
const RETIRE_JOBS = 12, RETIRE_MS = 45 * 60_000;
const WAIT_MS = 4 * 60_000;

const queue: Job[] = [];
const running = new Map<string, Job>();
const workers = new Map<string, Worker>();
const done: Array<{ id: string; title: string; by: string; result: string; at: number; kind: string }> = [];
let requested: Array<{ at: number; n: number }> = [];
let target = Number(process.env.BRAIN_HELPERS ?? 2);
let nextId = 1;
const waiters: Array<() => void> = [];

export function setTarget(n: number): void {
  if (Number.isFinite(n)) target = Math.max(0, Math.min(12, Math.round(n)));
}
export function getTarget(): number {
  return target;
}

/// Queues a job unless one with the same key is already queued or running.
export function add(job: Omit<Job, "id" | "at">): Job | null {
  if (queue.some((j) => j.key === job.key) || [...running.values()].some((j) => j.key === job.key)) return null;
  const j: Job = { ...job, id: `j${nextId++}`, at: Date.now() };
  queue.push(j);
  queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.at - b.at);
  emitActivity({ kind: "event", area: "helpers", node: `job:${j.kind}`, label: `queued: ${j.title}` });
  waiters.splice(0).forEach((w) => w());
  return j;
}

export function has(key: string): boolean {
  return queue.some((j) => j.key === key) || [...running.values()].some((j) => j.key === key);
}

function alive(now = Date.now()): Worker[] {
  // Gone quiet: no call for a while (longer while it's on a job: learning a move takes time).
  for (const [n, w] of workers) if (!w.waiting && now - w.seen > (w.current ? 25 * 60_000 : WAIT_MS + 3 * 60_000)) workers.delete(n);
  return [...workers.values()];
}

/// A worker asks for its next job (waits up to 4 minutes for one).
export async function next(name: string): Promise<{ job: Job } | { retire: true } | { none: true }> {
  const now = Date.now();
  let w = workers.get(name);
  if (!w) {
    w = { name, started: now, seen: now, jobs: 0, waiting: false };
    workers.set(name, w);
    const req = requested.find((r) => r.n > 0); // one of the requested workers arrived
    if (req) req.n--;
    emitActivity({ kind: "event", area: "helpers", node: `worker:${name}`, label: `helper ${name} started`, grew: true });
  }
  w.seen = now;
  if (w.current) { running.delete(w.current); w.current = undefined; }
  if (w.jobs >= RETIRE_JOBS || now - w.started > RETIRE_MS || alive().length > target) {
    workers.delete(name);
    emitActivity({ kind: "event", area: "helpers", node: `worker:${name}`, label: `helper ${name} retired` });
    return { retire: true };
  }
  const deadline = now + WAIT_MS;
  w.waiting = true;
  try {
    while (!queue.length) {
      const left = deadline - Date.now();
      if (left <= 0) return { none: true };
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(left, 30_000)); waiters.push(() => { clearTimeout(t); resolve(); }); });
      w.seen = Date.now();
    }
  } finally { w.waiting = false; }
  const job = queue.shift()!;
  job.takenBy = name; job.takenAt = Date.now();
  running.set(job.id, job);
  w.current = job.id; w.jobs++; w.seen = Date.now();
  try { job.onTake?.(); } catch { /* best effort */ }
  emitActivity({ kind: "tool", area: "helpers", node: `job:${job.kind}`, label: `${name}: ${job.title}` });
  return { job };
}

export function finish(name: string, id: string, result: string): Job | undefined {
  const job = running.get(id);
  running.delete(id);
  const w = workers.get(name);
  if (w) { w.seen = Date.now(); if (w.current === id) w.current = undefined; }
  done.push({ id, title: job?.title ?? id, by: name, result, at: Date.now(), kind: job?.kind ?? "task" });
  if (done.length > 60) done.shift();
  emitActivity({ kind: "report", area: "helpers", node: `job:${job?.kind ?? "task"}`, label: `${name} done: ${result}`.slice(0, 200), grew: true });
  return job;
}

/// Running jobs whose worker vanished go back on the queue.
export function reap(): void {
  const now = Date.now();
  for (const [id, j] of running) {
    if (now - (j.takenAt ?? now) > 20 * 60_000 || (j.takenBy && !workers.has(j.takenBy))) {
      running.delete(id);
      if (!has(j.key)) { j.takenBy = undefined; queue.push(j); }
    }
  }
}

/// How many more workers the main loop should start now.
export function needed(): number {
  const now = Date.now();
  requested = requested.filter((r) => now - r.at < 3 * 60_000 && r.n > 0);
  const pending = requested.reduce((s, r) => s + r.n, 0);
  return Math.max(0, target - alive(now).length - pending);
}
export function requestedNow(n: number): void {
  if (n > 0) requested.push({ at: Date.now(), n });
}

export function status() {
  const now = Date.now();
  return {
    target,
    workers: alive(now).map((w) => ({ name: w.name, jobs: w.jobs, busy: w.current ? running.get(w.current)?.title ?? "working" : null, minutes: Math.round((now - w.started) / 60_000) })),
    queued: queue.map((j) => ({ kind: j.kind, title: j.title, waiting: Math.round((now - j.at) / 1000) })),
    running: [...running.values()].map((j) => ({ kind: j.kind, title: j.title, by: j.takenBy, for: Math.round((now - (j.takenAt ?? now)) / 1000) })),
    done: done.slice(-15).reverse(),
  };
}

/// What a worker is told to do, for the main loop to start it with.
export const WORKER_BRIEF = `You are a background helper of the Drillin AIR soul, one of several working in parallel to keep the characters' inner life going. Make up a short worker name (for example "w" and four random letters) and use it in every call. Loop: call next_job with your name. It waits up to four minutes and returns a job (instructions, sometimes pictures) or "no job". Do the job exactly as its instructions say with the brain tools, then call job_done with your name, the job id and a one-line result, and call next_job again. "No job" means call next_job again. When next_job says to retire, stop and finish with one line. Never call wait_for_events, and never use say, live, run_behavior, play_animation or other tools that move or voice a character unless the job says so. Keep each job focused and quick.`;
