// Natural voice: lines are spoken by Kokoro, a small open neural voice model
// running on this Mac (free, offline, no account), and the audio goes to the
// phone sentence by sentence. The phone picks the voice in Settings
// ("kokoro:af_heart", …) or uses its own iPhone voice ("apple:…"). If the
// model can't run, the phone falls back to its iPhone voice.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Body } from "./body.js";
import { BRAIN_ROOT } from "./store.js";

type Reply = { id: number; wav?: string; seconds?: number; error?: string };

/// The phonemizer Kokoro uses crashes on Node 20, so the worker needs ≥ 22.
export function findNode(): string | null {
  const ok = (bin: string) => {
    try {
      const v = execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 3000 }).trim();
      return Number(v.replace(/^v/, "").split(".")[0]) >= 22 ? v : null;
    } catch {
      return null;
    }
  };
  if (process.env.BRAIN_TTS_NODE && ok(process.env.BRAIN_TTS_NODE)) return process.env.BRAIN_TTS_NODE;
  if (Number(process.versions.node.split(".")[0]) >= 22) return process.execPath;
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
  const nvm = path.join(os.homedir(), ".nvm/versions/node");
  try {
    for (const v of fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
      candidates.unshift(path.join(nvm, v, "bin/node"));
  } catch {}
  return candidates.find((c) => fs.existsSync(c) && ok(c)) ?? null;
}

export class Voice {
  private worker: ChildProcess | null = null;
  private waiting = new Map<number, (r: Reply) => void>();
  private nextId = 1;
  private chain: Promise<void> = Promise.resolve();
  private lines = 0;
  /// A new id for a spoken line (the phone matches audio to it).
  lineId(): number { return ++this.lines; }
  /// Why the natural voice can't run, if it can't.
  problem: string | null = null;
  ready = false;

  constructor(private body: Body, private log: (l: string) => void) {}

  /// "kokoro:af_heart" → "af_heart"; anything else → null (iPhone voice).
  static natural(pref: string | undefined): string | null {
    return pref?.startsWith("kokoro:") ? pref.slice(7) : null;
  }

  /// Starts the worker (once); safe to call often.
  start(): void {
    if (this.worker || this.problem) return;
    const node = findNode();
    if (!node) {
      this.problem = "natural voice needs Node 22 or newer on the Mac";
      this.log(`voice: ${this.problem}`);
      return;
    }
    const w = spawn(node, [path.join(BRAIN_ROOT, "src/tts-worker.mjs")], { cwd: BRAIN_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    this.worker = w;
    createInterface({ input: w.stdout! }).on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if ("ready" in msg) {
        this.ready = !!msg.ready;
        if (!msg.ready) this.problem = `voice model failed to load: ${msg.error}`;
        this.log(msg.ready ? "voice: natural voice ready" : `voice: ${this.problem}`);
        this.tellPhone();
        return;
      }
      const done = this.waiting.get(msg.id);
      if (done) { this.waiting.delete(msg.id); done(msg); }
    });
    w.stderr!.on("data", () => {}); // model noise
    w.on("exit", (code) => {
      this.worker = null;
      this.ready = false;
      for (const [, done] of this.waiting) done({ id: 0, error: "voice worker stopped" });
      this.waiting.clear();
      this.log(`voice: worker exited (${code}); restarts on the next line`);
    });
  }

  /// Lets the phone show whether the natural voice works.
  tellPhone(): void {
    this.body.send({ type: "voice", ready: this.ready, problem: this.problem });
  }

  /// Short sounds ("Mm-hm.") are kept, so acknowledgements play at once.
  private cache = new Map<string, Reply>();

  /// Makes the little acknowledgement sounds ahead of time for this voice.
  warm(voice: string, lines: string[]): void {
    for (const l of lines) void this.synth(l, voice);
  }

  private async synth(text: string, voice: string): Promise<Reply> {
    const key = `${voice}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = await this.synthNow(text, voice);
    if (text.length <= 16 && r.wav) this.cache.set(key, r);
    return r;
  }

  private synthNow(text: string, voice: string): Promise<Reply> {
    this.start();
    const w = this.worker;
    if (!w) return Promise.resolve({ id: 0, error: this.problem ?? "voice unavailable" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ id, error: "voice took too long" }); }, 30000);
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      w.stdin!.write(JSON.stringify({ id, text, voice }) + "\n");
    });
  }

  /// The user talked over her: sentences not sent yet are dropped.
  private cancelledUpTo = 0;
  cancel(): void { this.cancelledUpTo = this.lines; }

  /// Speaks `text` on the phone, sentence by sentence (the first sentence
  /// starts playing while the rest are made). Lines queue in order.
  speak(character: string, text: string, voice: string, line = this.lineId(), preview = false): void {
    const parts = text.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
    // Tiny fragments ("Oh.") join the next one so the speech doesn't stutter.
    const sentences: string[] = [];
    for (const p of parts) {
      const prev = sentences[sentences.length - 1];
      if (prev !== undefined && prev.length < 20) sentences[sentences.length - 1] = `${prev} ${p}`;
      else sentences.push(p);
    }
    this.chain = this.chain.then(async () => {
      for (let i = 0; i < sentences.length; i++) {
        if (line <= this.cancelledUpTo) break;
        const r = await this.synth(sentences[i], voice);
        if (line <= this.cancelledUpTo) break;
        if (r.error) this.log(`voice: ${r.error}`);
        await this.body.command("audio", {
          character, line, seq: i, last: i === sentences.length - 1, text: sentences[i], preview,
          ...(r.wav ? { wav: r.wav } : { error: r.error ?? "no audio" }),
        }, 10000);
      }
    });
  }
}

export const VOICE_PREVIEW = "Hi! This is how I sound. Do you like my voice?";
