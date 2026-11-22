// walk v2: walks to a target around walls and furniture (route planned on the
// LiDAR room map), turning into each leg of the route, with the procedural
// gait blended over (feet locked to the stride); back to resting on arrival.
//
// args: {x, z} | {to: "user"} | {to: "<character id>"}; optional keep (m),
// direct: true to ignore the room map (straight line); route: a route already
// planned with body.navigate; quiet: true to not report arriving.
behavior("walk", {
  cycleTime: 1.1,      // seconds per walk cycle (two steps)
  turnRate: 3.5,       // rad/s
  blendIn: 3.0,        // weight per second
  blendOut: 2.5,
  arriveRadius: 0.06,  // m, final target
  passRadius: 0.18,    // m, intermediate waypoints

  start: function (ch, args, s) {
    var target = soul.target(args, ch);
    var route = args.direct ? null : (args.route || body.navigate(ch.id, target.x, target.z));
    if (!args.direct && !route)
      throw new Error("no walkable route there: walls or furniture are in the way, or that part of the room isn't scanned yet (look at get_map)");
    s.route = route ? route.map(function (p) { return { x: p[0], z: p[1] }; }) : [target];
    s.leg = 0;
    s.weight = ch.walkWeight || 0;
    s.phase = ch.walkPhase || 0;
    s.arrived = false;
    s.quiet = !!args.quiet;
    s.best = 1e9;
    s.stuck = 0;
  },

  tick: function (ch, dt, s) {
    var self = this;
    var goal = s.route[s.leg];
    var last = s.leg === s.route.length - 1;
    var dx = goal.x - ch.x, dz = goal.z - ch.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    if (!last && dist < self.passRadius) { s.leg++; s.best = 1e9; s.stuck = 0; return; }
    // No progress for 3 s (blocked, or walking in place): give up and say so.
    if (!s.arrived) {
      if (dist < s.best - 0.05) { s.best = dist; s.stuck = 0; } else s.stuck += dt;
      if (s.stuck > 3) {
        s.arrived = true;
        body.emit("walk_stuck", { character: ch.id, x: ch.x, z: ch.z, left_m: Math.round(dist * 100) / 100 });
      }
    }
    if (!s.arrived && dist > self.arriveRadius) {
      // Turn toward the current waypoint (yaw 0 faces +Z).
      var diff = soul.angleDiff(ch.yaw, Math.atan2(dx, dz));
      var step = Math.max(-self.turnRate * dt, Math.min(self.turnRate * dt, diff));
      var yaw = ch.yaw + step;
      body.setYaw(ch.id, yaw);
      s.weight = Math.min(1, s.weight + self.blendIn * dt);
      // Speed from the stride, so planted feet don't slide.
      var dPhase = dt * s.weight / self.cycleTime;
      var facing = Math.abs(diff) < 1.0 ? 1 : 0.3;
      var move = Math.min(dist, dPhase * body.gait().cycleLength * ch.scale * facing);
      body.setPosition(ch.id, ch.x + Math.sin(yaw) * move, ch.z + Math.cos(yaw) * move);
      s.phase += dPhase;
    } else {
      if (!s.arrived) {
        s.arrived = true;
        if (!s.quiet) body.emit("arrived", { character: ch.id, x: ch.x, z: ch.z });
      }
      // Finish the current step while blending back.
      s.weight = Math.max(0, s.weight - self.blendOut * dt);
      s.phase += dt * s.weight / self.cycleTime;
    }
    body.setWalk(ch.id, s.weight, s.phase);
    if (s.arrived && s.weight === 0) return "done";
  },

  stop: function (ch, s) {
    if (ch) body.setWalk(ch.id, 0, s.phase || 0);
  },
});
