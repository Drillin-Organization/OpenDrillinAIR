// Ears worker: the phone's microphone stream comes in here, Silero (a small
// open neural voice detector) finds where someone speaks — telling voices
// apart from music and room noise, and catching short words like "hey" —
// and Whisper (OpenAI's open speech model) turns each phrase into text.
// Runs in its own process on Node ≥ 22, like the voice worker.
//
// Each phrase also gets its tone: loudness, pitch, how much the pitch moves,
// whether it rises at the end, and a guess at the emotion in the voice (a
// small wav2vec2 classifier). While she is talking, a quick early look
// ("peek") at the first second of a phrase tells the brain whether the user
// is talking over her, so she can stop.
//
// In:  {audio: base64 16 kHz mono Int16} | {model: "whisper-small"|"whisper-large"} | {preload: model} | {talking: bool}
// Out: {speech: "start"} | {speech: "end"} | {text, seconds, ms, tone} | {peek: text} | {loading|ready|failed: model}
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import { pipeline } from "@huggingface/transformers";

const MODELS = {
  "whisper-small": "onnx-community/whisper-small.en",
  "whisper-large": "onnx-community/whisper-large-v3-turbo",
};
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// MARK: Whisper

const loaded = new Map();
let model = "whisper-small";
function load(name) {
  if (!loaded.has(name)) {
    const repo = MODELS[name] ?? MODELS["whisper-small"];
    out({ loading: name });
    const p = pipeline("automatic-speech-recognition", repo, { dtype: "q8", device: "cpu" }).then((asr) => {
      out({ ready: name });
      void emotionModel(); // tone model loads after the ears are ready
      return asr;
    });
    p.catch((e) => { loaded.delete(name); out({ failed: name, error: String(e?.message ?? e) }); });
    loaded.set(name, p);
  }
  return loaded.get(name);
}

let queue = Promise.resolve();
function transcribe(samples) {
  const name = model;
  queue = queue.then(async () => {
    const t0 = Date.now();
    try {
      const asr = await load(name);
      const multilingual = !String(MODELS[name]).endsWith(".en");
      const r = await asr(samples, multilingual ? { language: "en", task: "transcribe" } : {});
      const tone = await toneOf(samples).catch(() => null);
      out({ text: String(r.text ?? "").trim(), seconds: samples.length / 16000, ms: Date.now() - t0, tone });
    } catch (e) {
      out({ error: String(e?.message ?? e) });
    }
  });
}

/// A quick transcription of the start of a phrase (is the user talking over her?).
function peek(samples, n) {
  queue = queue.then(async () => {
    try {
      const asr = await load(model);
      const r = await asr(samples, String(MODELS[model]).endsWith(".en") ? {} : { language: "en", task: "transcribe" });
      out({ peek: String(r.text ?? "").trim(), n });
    } catch {}
  });
}

// MARK: Tone of voice

let emotion = null;
function emotionModel() {
  emotion ??= pipeline("audio-classification", "onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX", { dtype: "q8", device: "cpu" }).catch(() => null);
  return emotion;
}

/// Loudness (dBFS of voiced frames), pitch (Hz, median), pitch movement
/// (semitones, spread), rise at the end (semitones), and the emotion guess.
async function toneOf(samples) {
  const FRAME = 640, HOP = 320; // 40 ms frames
  const pitches = [], levels = [];
  for (let at = 0; at + FRAME <= samples.length; at += HOP) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) e += samples[at + i] ** 2;
    const rms = Math.sqrt(e / FRAME);
    if (rms < 0.01) continue;
    levels.push(20 * Math.log10(rms));
    // Autocorrelation pitch, 75–400 Hz.
    let best = 0, lag = 0;
    for (let l = 40; l <= 213; l++) {
      let c = 0, n1 = 0, n2 = 0;
      for (let i = 0; i < FRAME - l; i += 2) { c += samples[at + i] * samples[at + i + l]; n1 += samples[at + i] ** 2; n2 += samples[at + i + l] ** 2; }
      const r = c / Math.sqrt(n1 * n2 + 1e-9);
      if (r > best) { best = r; lag = l; }
    }
    if (best > 0.55) pitches.push({ t: at / samples.length, hz: 16000 / lag });
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const st = (hz, ref) => 12 * Math.log2(hz / ref);
  const hz = median(pitches.map((p) => p.hz));
  const semis = pitches.map((p) => st(p.hz, hz || 1));
  const spread = semis.length > 3 ? Math.sqrt(semis.reduce((s, x) => s + x * x, 0) / semis.length) : 0;
  const end = pitches.filter((p) => p.t > 0.75).map((p) => p.hz), mid = pitches.filter((p) => p.t > 0.3 && p.t <= 0.75).map((p) => p.hz);
  const rise = end.length && mid.length ? st(median(end), median(mid)) : 0;
  let feel = null;
  const clf = await emotionModel();
  if (clf && samples.length > 8000) {
    const r = await clf(samples, { top_k: 2 });
    feel = r.map((x) => ({ label: String(x.label).toLowerCase(), score: Math.round(x.score * 100) / 100 }));
  }
  return { db: Math.round(median(levels) * 10) / 10, hz: Math.round(hz), spread: Math.round(spread * 10) / 10, rise: Math.round(rise * 10) / 10, feel };
}

// MARK: Voice activity (Silero v5: 512-sample chunks plus 64 samples of context)

const CHUNK = 512;
const vad = await ort.InferenceSession.create(path.join(ROOT, "models/silero_vad.onnx"));
let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
let context = new Float32Array(64);
let pending = new Float32Array(0);

const START = 0.5, KEEP = 0.35;
const END_CHUNKS = 16;     // ~0.5 s below KEEP ends a phrase
const PREROLL = 10;        // ~0.3 s kept from before the start
const MAX_CHUNKS = 470;    // ~15 s per phrase at most
let speaking = false, above = 0, below = 0, voiced = 0;
/// She's talking (from the phone): peek at phrases to spot the user talking over her.
let talking = false, peeked = 0;
let preroll = [], phrase = [];

async function onChunk(chunk) {
  const input = new Float32Array(64 + CHUNK);
  input.set(context); input.set(chunk, 64);
  context = chunk.slice(CHUNK - 64);
  const r = await vad.run({ input: new ort.Tensor("float32", input, [1, input.length]), state, sr });
  state = r.stateN;
  const p = r.output.data[0];

  if (!speaking) {
    preroll.push(chunk);
    if (preroll.length > PREROLL) preroll.shift();
    above = p > START ? above + 1 : 0;
    if (above >= 2) {
      speaking = true;
      phrase = [...preroll];
      preroll = [];
      voiced = above; below = 0; peeked = 0;
      out({ speech: "start" });
    }
    return;
  }
  phrase.push(chunk);
  if (p > KEEP) { voiced++; below = 0; } else below++;
  // While she talks: look at the first ~0.8 s and again at ~1.8 s.
  if (talking && ((peeked === 0 && phrase.length >= 25) || (peeked === 1 && phrase.length >= 56))) {
    peeked++;
    const all = new Float32Array(phrase.length * CHUNK);
    phrase.forEach((c, i) => all.set(c, i * CHUNK));
    peek(all, peeked);
  }
  if (below >= END_CHUNKS || phrase.length >= MAX_CHUNKS) {
    speaking = false; above = 0;
    out({ speech: "end" });
    // At least ~100 ms of voice (a short "hey" counts).
    if (voiced >= 3) {
      const all = new Float32Array(phrase.length * CHUNK);
      phrase.forEach((c, i) => all.set(c, i * CHUNK));
      transcribe(all);
    }
    phrase = [];
  }
}

let vadQueue = Promise.resolve();
function onAudio(b64) {
  const bytes = Buffer.from(b64, "base64");
  const fresh = new Float32Array(bytes.length / 2);
  for (let i = 0; i < fresh.length; i++) fresh[i] = bytes.readInt16LE(i * 2) / 32768;
  const all = new Float32Array(pending.length + fresh.length);
  all.set(pending); all.set(fresh, pending.length);
  let at = 0;
  const chunks = [];
  while (all.length - at >= CHUNK) { chunks.push(all.slice(at, at + CHUNK)); at += CHUNK; }
  pending = all.slice(at);
  vadQueue = vadQueue.then(async () => { for (const c of chunks) await onChunk(c); });
}

const rl = createInterface({ input: process.stdin });
rl.on("close", () => Promise.all([vadQueue, queue]).then(() => process.exit(0)));
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.audio) onAudio(req.audio);
  else if (req.model) { model = MODELS[req.model] ? req.model : "whisper-small"; load(model).catch(() => {}); }
  else if (req.preload) load(req.preload).catch(() => {});
  else if ("talking" in req) talking = !!req.talking;
});
