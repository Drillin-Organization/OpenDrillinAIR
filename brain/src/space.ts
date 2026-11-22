// Directions from the user's point of view, so the mind never has to turn
// raw world coordinates into "left", "ahead" or "behind" itself.
// World: metres, y up; yaw 0 faces +z and grows toward +x.
export type Pt = { x: number; z: number };

export const angleDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/// Bearing of `p` from `from` facing `yaw`, in degrees: + = to the left.
export function bearing(from: Pt, yaw: number, p: Pt): number {
  return (angleDiff(yaw, Math.atan2(p.x - from.x, p.z - from.z)) * 180) / Math.PI;
}

export function direction(deg: number): string {
  const a = Math.abs(deg), side = deg > 0 ? "left" : "right";
  if (a < 20) return "ahead";
  if (a < 70) return `ahead-${side}`;
  if (a < 110) return `to the ${side}`;
  if (a < 160) return `behind-${side}`;
  return "behind";
}

/// "2.3 m ahead-left of you (35°)".
export function fromUser(user: Pt & { yaw: number }, p: Pt): string {
  const d = Math.hypot(p.x - user.x, p.z - user.z);
  if (d < 0.25) return "where you stand";
  const b = bearing(user, user.yaw, p);
  return `${d.toFixed(1)} m ${direction(b)} of you (${Math.round(Math.abs(b))}° ${b >= 0 ? "left" : "right"})`;
}

/// How a character stands relative to the user: "facing you", "facing away from you", …
export function facingUser(ch: Pt & { yaw: number }, user: Pt): string {
  const b = bearing(ch, ch.yaw, user);
  const a = Math.abs(b);
  if (a < 30) return "facing you";
  if (a > 150) return "facing away from you (back to you)";
  return `turned so you're on her ${b > 0 ? "left" : "right"}`;
}
