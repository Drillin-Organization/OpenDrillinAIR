// The phone, as the mind sees it: one WebSocket connection at a time.
// Commands go down and resolve when the phone replies; events and scene
// updates come up.
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

export type Scene = {
  characters: Array<{ id: string; name: string; x: number; y: number; z: number; yaw: number; behavior: string; [k: string]: unknown }>;
  user: Record<string, number>;
  planes: Array<Record<string, unknown>>;
  props: Array<Record<string, unknown>>;
  behaviors: string[];
  [k: string]: unknown;
};

export type BodyEvent = { kind: string; data: Record<string, unknown> };

type Pending = { resolve: (v: CommandResult) => void; timer: NodeJS.Timeout };
export type CommandResult = { ok: boolean; data?: any; error?: string };

export class Body extends EventEmitter {
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  scene: Scene | null = null;
  /// When the phone last sent its scene (it stops when locked or in the background).
  sceneAt = 0;
  device = "";
  /// The phone's chosen voice ("kokoro:af_heart" or "apple:<id>").
  voicePref = "";
  /// A character is talking on the phone right now.
  talking = false;
  /// How the phone's speech is recognised: "whisper-small" | "whisper-large" | "apple".
  earsPref = "";

  get connected(): boolean {
    return this.socket !== null;
  }

  attach(socket: WebSocket): void {
    if (this.socket) this.socket.close(1000, "replaced by a newer connection");
    this.socket = socket;
    socket.on("message", (raw, isBinary) => {
      // Binary frames are the phone's microphone (Whisper mode).
      if (isBinary) {
        this.emit("audio", Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
          this.device = String(msg.device ?? "phone");
          this.voicePref = String(msg.voice ?? "");
          this.earsPref = String(msg.ears ?? "");
          this.emit("hello", msg);
          break;
        case "prefs":
          if (typeof msg.voice === "string") this.voicePref = msg.voice;
          if (typeof msg.ears === "string") this.earsPref = msg.ears;
          this.emit("prefs");
          break;
        case "talking":
          this.talking = !!msg.active;
          this.emit("talking", this.talking);
          break;
        case "voice_preview":
          this.emit("voice_preview", String(msg.voice ?? ""));
          break;
        case "scene":
          this.scene = msg.data as Scene;
          this.sceneAt = Date.now();
          this.emit("scene");
          break;
        case "event": {
          const data = (msg.data ?? {}) as Record<string, unknown>;
          if (data.scene) this.scene = data.scene as Scene;
          delete data.scene;
          this.emit("event", { kind: String(msg.kind), data } satisfies BodyEvent);
          break;
        }
        case "result": {
          const p = this.pending.get(Number(msg.id));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(Number(msg.id));
            p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
          }
          break;
        }
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "phone disconnected" });
      }
      this.pending.clear();
      this.emit("disconnected");
    });
  }

  send(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

  /// Sends a message with an id and waits for the phone's reply.
  request(msg: Record<string, unknown>, timeoutMs = 15000): Promise<CommandResult> {
    if (!this.socket) return Promise.resolve({ ok: false, error: "phone not connected" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "phone did not answer in time" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ ...msg, id });
    });
  }

  command(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<CommandResult> {
    return this.request({ type: "cmd", op, ...args }, timeoutMs);
  }

  /// Moves made from the library (make_move), so the phone can play them.
  pushMoves(moves: Array<{ name: string; fps: number; frames: number; data: string }>): Promise<CommandResult> {
    return this.command("moves_add", { moves }, 15000);
  }

  pushBehaviors(files: Record<string, string>): Promise<CommandResult> {
    return this.request({ type: "behaviors", files });
  }

  chat(text: string): void {
    this.send({ type: "chat", text });
  }

  status(thinking: boolean): void {
    this.send({ type: "status", thinking });
  }

  /// A command started a behaviour: show it in the scene right away, so a wake
  /// in the next second doesn't report the old one.
  started(id: string, behavior: string): void {
    const c = this.scene?.characters.find((x) => x.id === id);
    if (c) c.behavior = behavior;
  }

  characterName(id: string): string | null {
    return this.scene?.characters.find((c) => c.id === id)?.name ?? null;
  }
}
