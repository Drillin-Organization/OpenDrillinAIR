// Text-to-speech worker: Kokoro (an open, local neural voice model) in its
// own process, so the brain stays up if it crashes and it can run on a newer
// Node than the brain. Reads JSON lines {id, text, voice, speed} on stdin and
// writes {id, wav} (base64 16-bit mono WAV) or {id, error} on stdout. The
// model (~90 MB) downloads from Hugging Face on first use and is cached.
import { createInterface } from "node:readline";
import { KokoroTTS } from "kokoro-js";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let tts = null;
const ready = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" })
  .then((t) => {
    tts = t;
    out({ ready: true, voices: Object.keys(t.voices) });
  })
  .catch((e) => out({ ready: false, error: String(e?.message ?? e) }));

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf.toString("base64");
}

// One at a time: the model isn't re-entrant and order matters for speech.
let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("close", () => queue.then(() => process.exit(0)));
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  queue = queue.then(async () => {
    await ready;
    if (!tts) return out({ id: req.id, error: "voice model failed to load" });
    try {
      const a = await tts.generate(String(req.text), { voice: req.voice ?? "af_heart", speed: req.speed ?? 1 });
      out({ id: req.id, wav: wav(a.audio, a.sampling_rate), seconds: a.audio.length / a.sampling_rate });
    } catch (e) {
      out({ id: req.id, error: String(e?.message ?? e) });
    }
  });
});
