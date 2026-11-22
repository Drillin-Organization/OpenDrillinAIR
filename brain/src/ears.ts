// Ears: in Whisper mode the phone streams its microphone here (16 kHz mono
// Int16, binary WebSocket frames). The ears worker finds speech (Silero) and
// transcribes it (Whisper) on this Mac; each phrase goes to the mind like any
// heard phrase. The phone hears back at once when speech starts and ends, and
// what was understood, so the user never talks to a wall.
// The phone picks the method in Settings ("whisper-small", "whisper-large",
// or "apple" = the phone recognises speech itself).
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Body } from "./body.js";
import { BRAIN_ROOT } from "./store.js";
import { findNode, Voice } from "./voice.js";

/// Whisper's usual inventions on breath, music and room noise.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+|♪.*|music\.?)$/i;

export class Ears {
  private worker: ChildProcess | null = null;
  private workerModel = "";
  /// Lines a character said lately (so her own voice through the mic is dropped).
  private said: Array<{ text: string; until: number }> = [];
  status = "";

  /// She is talking right now (the phone says so); the user's voice over hers stops her.
  private talking = false;
  /// "hearing" held back while she talks, until it's clearly the user (not her echo).
  private heldHearing = false;
  /// When she last stopped talking (her voice still rings in the mic a moment after).
  private talkEndedAt = 0;
  /// The phrase now being heard began while she talked: it's her own voice
  /// coming back unless it clearly interrupted her (barge).
  private overHer = false;
  private barged = false;
  /// The user's usual voice (running averages), so "loud" means loud for them.
  private usual = { db: -30, hz: 0, spread: 2, n: 0 };

  constructor(private body: Body, private voice: Voice, private log: (l: string) => void) {
    body.on("audio", (chunk: Buffer) => this.onAudio(chunk));
    body.on("talking", (active: boolean) => {
      this.talking = active;
      if (!active) { this.heldHearing = false; this.talkEndedAt = Date.now(); }
      this.worker?.stdin?.write(JSON.stringify({ talking: active }) + "\n");
    });
  }

  get model(): string | null {
    return this.body.earsPref.startsWith("whisper") ? this.body.earsPref : null;
  }

  /// Loads the chosen model ahead of the first phrase.
  prepare(): void {
    if (!this.model) return;
    this.start();
  }

  /// A character said this (spoken lines are remembered for ~10 s + length).
  heardHerSay(text: string): void {
    const now = Date.now();
    this.said = this.said.filter((s) => s.until > now);
    this.said.push({ text, until: now + 10_000 + text.length * 80 });
  }

  private start(): void {
    const model = this.model;
    if (!model) return;
    if (!this.worker) {
      const node = findNode();
      if (!node) { this.tell("Whisper needs Node 22 or newer on the Mac"); return; }
      const w = spawn(node, [path.join(BRAIN_ROOT, "src/stt-worker.mjs")], { cwd: BRAIN_ROOT, stdio: ["pipe", "pipe", "pipe"] });
      this.worker = w;
      this.workerModel = "";
      createInterface({ input: w.stdout! }).on("line", (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        this.onWorker(msg);
      });
      let err = "";
      w.stderr!.on("data", (d) => { err = (err + d).slice(-400); });
      w.on("exit", (code) => {
        this.worker = null;
        this.log(`ears: worker exited (${code})${code ? `: ${err.trim().split("\n").pop()}` : ""}; restarts with the next audio`);
      });
    }
    if (this.workerModel !== model) {
      this.workerModel = model;
      this.worker!.stdin!.write(JSON.stringify({ model }) + "\n");
    }
  }

  /// Status for the phone ("" when ready).
  private tell(status: string): void {
    this.status = status;
    if (status) this.log(`ears: ${status}`);
    this.body.send({ type: "ears", status });
  }

  private onAudio(chunk: Buffer): void {
    if (!this.model) return;
    this.start();
    this.worker?.stdin?.write(JSON.stringify({ audio: chunk.toString("base64") }) + "\n");
  }

  private onWorker(msg: any): void {
    if (msg.loading) return this.tell(`Loading the speech model (${msg.loading}); the first time it downloads…`);
    if (msg.ready) return this.tell("");
    if (msg.failed) return this.tell(`Speech model failed: ${msg.error}`);
    if (msg.speech) {
      if (msg.speech === "start") {
        this.overHer = this.talking || Date.now() - this.talkEndedAt < 1500;
        this.barged = false;
      }
      // While she talks, the mic hears her too: wait for proof it's the user.
      if (this.talking) {
        this.heldHearing = msg.speech === "start";
        return;
      }
      if (msg.speech === "start") this.body.emit("user_activity");
      this.body.send({ type: "hearing", active: msg.speech === "start" });
      return;
    }
    if (typeof msg.peek === "string") return this.onPeek(msg.peek, Number(msg.n) || 1);
    if (msg.error) { this.log(`ears: ${msg.error}`); return; }
    if (typeof msg.text !== "string") return;
    const text = msg.text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").trim();
    this.log(`ears: “${text}” (${Number(msg.seconds).toFixed(1)} s audio, ${msg.ms} ms)`);
    if (!text || HALLUCINATIONS.test(text)) { this.body.send({ type: "heard", text: "" }); return; }
    // Began while she talked and didn't clearly cut in: her own voice through the speaker.
    const overHer = this.overHer && !this.barged && !this.clearlyUser(text);
    this.overHer = false;
    if (overHer || this.isEcho(text)) { this.log(`ears: dropped her own voice${overHer ? " (said over her)" : ""}: ${text}`); this.body.send({ type: "heard", text: "" }); return; }
    this.body.send({ type: "heard", text });
    const tone = msg.tone ? this.describeTone(msg.tone, text, Number(msg.seconds)) : "";
    if (msg.tone) this.log(`ears: tone ${JSON.stringify(msg.tone)} → ${tone || "(usual)"}`);
    this.body.emit("event", { kind: "user_text", data: { text, speech: true, ...(tone ? { tone } : {}) } });
  }

  /// The start of a phrase heard while she talks: if it isn't her own voice
  /// coming back, the user is talking over her, so she stops and listens.
  private onPeek(text: string, n: number): void {
    const clean = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").trim();
    if (!this.talking || !clean || HALLUCINATIONS.test(clean)) return;
    // Real talking over her: several words that aren't hers, even misheard
    // (Whisper turns her "Ta-da, back view" into "Tada Backview"). A cough,
    // a bump or one stray word must not cut her off.
    const hers = this.herRecentSpeech();
    const fresh = freshWords(clean, hers);
    if (fresh < (n <= 1 ? 3 : 2) || overlap(clean, hers) >= 0.45) {
      this.log(`ears: not talking over her (“${clean}”: ${fresh} new words, ${Math.round(overlap(clean, hers) * 100)}% hers)`);
      return;
    }
    this.barged = true;
    this.log(`ears: the user talks over her (“${clean}”): she stops`);
    this.talking = false;
    this.voice.cancel();
    this.body.send({ type: "barge" });
    this.body.send({ type: "hearing", active: true });
    this.heldHearing = false;
    this.body.emit("user_activity");
    this.body.emit("barge", clean);
  }

  /// "softly, slower than usual, flat; sounds sad (a guess)" — against the user's usual voice.
  private describeTone(t: { db: number; hz: number; spread: number; rise: number; feel?: Array<{ label: string; score: number }> | null }, text: string, seconds: number): string {
    const u = this.usual;
    const parts: string[] = [];
    if (u.n >= 3) {
      if (t.db > u.db + 6) parts.push("loudly"); else if (t.db < u.db - 7) parts.push("softly");
      if (t.hz && u.hz && t.hz > u.hz * 1.18) parts.push("higher than usual");
      if (t.spread > u.spread * 1.6 && t.spread > 3) parts.push("animated"); else if (t.spread < u.spread * 0.55) parts.push("flat");
    }
    const words = (text.match(/[A-Za-z']+/g) ?? []).length;
    const rate = seconds > 0.6 ? words / seconds : 0;
    if (words >= 4 && rate > 3.6) parts.push("fast"); else if (words >= 3 && rate > 0 && rate < 1.6) parts.push("slowly");
    if (t.rise > 2.5 && !/\?$/.test(text)) parts.push("rising at the end, like a question");
    const top = t.feel?.[0], second = t.feel?.[1];
    if (top && top.label !== "neutral" && top.score >= 0.6 && top.score - (second?.score ?? 0) >= 0.3) parts.push(`sounds ${{ angry: "annoyed", sad: "sad", happy: "happy", fearful: "anxious", fear: "anxious", disgust: "put off", surprised: "surprised", calm: "calm" }[top.label] ?? top.label} (a guess from the voice)`);
    // Learn their usual voice slowly.
    const k = u.n < 5 ? 1 / (u.n + 1) : 0.1;
    if (t.db) u.db += (t.db - u.db) * k;
    if (t.hz) u.hz = u.hz ? u.hz + (t.hz - u.hz) * k : t.hz;
    if (t.spread) u.spread += (t.spread - u.spread) * k;
    u.n++;
    return parts.join(", ");
  }

  /// Everything she said lately, as one run of letters.
  private herRecentSpeech(): string {
    const now = Date.now();
    return this.said.filter((s) => s.until > now).map((s) => letters(s.text)).join(" ");
  }

  /// Her own voice coming back through the mic, even misheard (for phrases
  /// that began after she stopped, so only when it's nearly all hers).
  private isEcho(text: string): boolean {
    if (letters(text).length < 4) return false;
    return overlap(text, this.herRecentSpeech()) >= 0.75;
  }

  /// Said over her, but plainly not her lines: at least two words of its own.
  private clearlyUser(text: string): boolean {
    const hers = this.herRecentSpeech();
    return freshWords(text, hers) >= 2 && overlap(text, hers) < 0.5;
  }
}

/// Words in what was heard that she didn't say lately (spelling-tolerant).
/// "Stop", "wait", "hey", "listen", "no" (not her own) count as two: the user
/// cutting in, even in a single word.
export function freshWords(heard: string, hers: string): number {
  const words = (heard.toLowerCase().match(/[a-z']+/g) ?? []).map((w) => w.replace(/'/g, ""));
  const stopper = words.some((w) => /^(stop|wait|hey|listen|no+|shh+|quiet|enough)$/.test(w) && !hers.split(" ").some((line) => line.includes(w)));
  return words.filter((w) => w.length > 2 && !hers.includes(w)).length + (stopper ? 2 : 0);
}

/// Lowercase letters only ("Ta-da, back view!" → "tadabackview").
function letters(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, "");
}

/// How much of what was heard sounds like her lines: the share of its letter
/// triples found in what she said (robust to Whisper's spelling and splits).
export function overlap(heard: string, hers: string): number {
  const h = letters(heard);
  const her = hers.replace(/ /g, "|");
  if (h.length < 3 || !her) return 0;
  let hit = 0, all = 0;
  for (let i = 0; i + 3 <= h.length; i++) { all++; if (her.includes(h.slice(i, i + 3))) hit++; }
  return all ? hit / all : 0;
}
