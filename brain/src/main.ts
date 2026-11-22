// Drillin brain: connects the phone to the characters' mind, which is a
// Claude Code chat. Claude Code starts this as an MCP server (see .mcp.json);
// the phone finds it over Bonjour on the same Wi-Fi. No API key: the chat
// itself thinks, using the tools registered in tools.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bonjour } from "bonjour-service";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Body } from "./body.js";
import { EventHub, log } from "./events.js";
import { BRAIN_ROOT, initStore } from "./store.js";
import { registerTools } from "./tools.js";
import { startUI, wiring } from "./ui.js";
import { Voice, VOICE_PREVIEW } from "./voice.js";
import { Ears } from "./ears.js";

const PORT = Number(process.env.BRAIN_PORT ?? 8787);

initStore();
const body = new Body();
const hub = new EventHub(body);
const voice = new Voice(body, log);
const ears = new Ears(body, voice, log);
wiring.voice = voice;
wiring.ears = ears;
// The natural voice model starts as soon as the phone wants it.
const wantVoice = () => {
  if (Voice.natural(body.voicePref)) voice.start();
  voice.tellPhone();
  ears.prepare();
};
body.on("hello", wantVoice);
body.on("prefs", wantVoice);
body.on("voice_preview", (pref: string) => {
  const v = Voice.natural(pref);
  if (v) voice.speak("", VOICE_PREVIEW, v, voice.lineId(), true);
});

// Phone side: WebSocket + Bonjour.
const sockets = new WebSocketServer({ port: PORT, path: "/body", maxPayload: 32 << 20 });
sockets.on("error", (e) => log(`WebSocket server: ${e.message} (is another brain already running on port ${PORT}?)`));
sockets.on("connection", (socket, req) => {
  log(`connection from ${req.socket.remoteAddress}`);
  body.attach(socket);
});
const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a!.address);
const bonjour = new Bonjour();
bonjour.publish({
  name: `Drillin brain on ${os.hostname().split(".")[0]}`,
  type: "drillin-brain",
  port: PORT,
  // Every address (Wi-Fi, a phone's hotspot, …): the phone uses the first it can reach.
  txt: { host: ips[0] ?? `${os.hostname().split(".")[0]}.local`, hosts: ips.join(","), port: String(PORT) },
});
log(`listening on port ${PORT} (${ips.join(", ") || "no network"})`);
startUI(body, Number(process.env.BRAIN_UI_PORT ?? 8788), log);

// Mind side: MCP over stdio to the Claude Code chat.
const server = new McpServer(
  { name: "drillin-body", version: "0.2.0" },
  { instructions: fs.readFileSync(path.join(BRAIN_ROOT, "prompts/system.md"), "utf8") },
);
registerTools(server, body, hub, voice, ears);
await server.connect(new StdioServerTransport());

function shutdown(): void {
  bonjour.unpublishAll(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
