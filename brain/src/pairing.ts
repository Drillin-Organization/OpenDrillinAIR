// Pairing: only a phone the user paired can connect to this brain, and the
// phone only talks to a brain it paired with. On the local network anyone
// could otherwise receive the camera and microphone, or drive the body.
//
// First time: the phone asks to pair; the brain makes a 6-digit code (valid
// 10 minutes, once) and the mind tells the user in the Claude chat. The phone
// proves it knows the code (HMAC over both sides' nonces, the code never
// travels) and receives a long random token, encrypted with a key from the
// code, so it also knows the brain had the code. From then on, every
// connection is a mutual challenge with that token: each side proves it
// holds it, and the token never travels again.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.js";

type Paired = { id: string; token: string; device: string; at: number; last: number };
type State = { brain: string; phones: Paired[] };

const file = () => path.join(DATA, "pairing.json");
let state: State | null = null;
let code: { value: string; until: number } | null = null;
let fails: number[] = [];

function load(): State {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { state = null; }
  if (!state?.brain) state = { brain: crypto.randomUUID(), phones: [] };
  save();
  return state!;
}
function save(): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 1), { mode: 0o600 });
}

const hmac = (key: string, msg: string) => crypto.createHmac("sha256", key).update(msg).digest("hex");
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function brainId(): string {
  return load().brain;
}
export function nonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/// The code to show the user (a fresh one when none is valid).
export function pairingCode(): { code: string; until: number } {
  if (!code || Date.now() > code.until) code = { value: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), until: Date.now() + 10 * 60_000 };
  return { code: code.value, until: code.until };
}
export function activeCode(): { code: string; until: number } | null {
  return code && Date.now() <= code.until ? { code: code.value, until: code.until } : null;
}

/// A phone proved it knows the code: a new token for it, encrypted with a
/// key from the code. Null when wrong (or too many tries lately).
export function pair(nb: string, np: string, proof: string, device: string): { iv: string; ct: string; tag: string } | { error: string } {
  const now = Date.now();
  fails = fails.filter((t) => now - t < 10 * 60_000);
  if (fails.length >= 5) return { error: "Too many wrong codes. Wait a few minutes and try again." };
  const c = activeCode();
  if (!c) return { error: "The code has expired. Ask for a new one." };
  if (!same(hmac(c.code, `pair|${nb}|${np}`), String(proof))) { fails.push(now); return { error: "That code isn't right." }; }
  code = null; // once
  const token = crypto.randomBytes(32).toString("hex");
  const s = load();
  s.phones.push({ id: crypto.randomUUID(), token, device, at: now, last: now });
  save();
  const key = crypto.createHash("sha256").update(`${c.code}|${nb}|${np}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/// The phone proved it holds a token: the brain's answer proving it holds it too.
export function auth(nb: string, np: string, proof: string): { proof: string; device: string } | null {
  const s = load();
  for (const p of s.phones) {
    if (same(hmac(p.token, `phone|${nb}|${np}`), String(proof))) {
      p.last = Date.now();
      save();
      return { proof: hmac(p.token, `brain|${np}|${nb}`), device: p.device };
    }
  }
  return null;
}

export function phones(): Array<{ device: string; at: number; last: number }> {
  return load().phones.map(({ device, at, last }) => ({ device, at, last }));
}

/// Forget every paired phone (they pair again).
export function unpairAll(): number {
  const s = load();
  const n = s.phones.length;
  s.phones = [];
  save();
  return n;
}
