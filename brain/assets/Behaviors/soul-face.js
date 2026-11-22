// face v1: turn in place toward the user, a character or a point.
// args: {to: "user"} (default) | {to: "<character id>"} | {x, z}
behavior("face", {
  turnRate: 2.5, // rad/s

  start: function (ch, args, s) {
    if (!args.to && typeof args.x !== "number") args = { to: "user" };
    s.target = soul.target(Object.assign({}, args, { keep: 0 }), ch);
  },

  tick: function (ch, dt, s) {
    var want = Math.atan2(s.target.x - ch.x, s.target.z - ch.z);
    var diff = soul.angleDiff(ch.yaw, want);
    if (Math.abs(diff) < 0.03) return "done";
    var step = Math.max(-this.turnRate * dt, Math.min(this.turnRate * dt, diff));
    body.setYaw(ch.id, ch.yaw + step);
  },
});
