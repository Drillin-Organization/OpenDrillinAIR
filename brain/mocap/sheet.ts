// Renders a converted clip as a contact sheet PNG, for checking by eye.
import fs from "node:fs";
import { contactSheet, poseWorld, type Review } from "../src/preview.js";
import type { Pose } from "./retarget.js";

export function sheet(poses: Pose[], fps: number, file: string, count = 8): void {
  const frames: Review["frames"] = [];
  for (let i = 0; i < count; i++) {
    const k = Math.round((i * (poses.length - 1)) / (count - 1));
    frames.push({ t: k / fps, world: poseWorld(poses[k] as any, false) as any });
  }
  fs.writeFileSync(file, contactSheet({ errors: [], notes: [], animatedJoints: [], frames }, count));
}
