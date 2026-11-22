// sit_on v1: sit on a real seat (sofa, chair, bed edge, bench). Walks to
// the front of it, turns her back to it, lowers onto it with her hips at the
// seat's measured height and her feet on the floor, hands resting on her
// thighs; stays seated (breathing, small weight shifts) until something else
// starts, then stands back up.
//
// args: {x, z, y}  seat centre and surface height (world, metres);
//       optional facing: radians she should face when seated (else away
//       from the seat centre, toward where she came from).
behavior("sit_on", {
  lower: 1.4,        // seconds to sit down
  hipAboveSeat: 0.09,

  start: function (ch, args, s) {
    if (typeof args.x !== "number" || typeof args.z !== "number" || typeof args.y !== "number")
      throw new Error("sit_on needs the seat's x, z and y (surface height)");
    s.seat = { x: args.x, z: args.z, y: args.y };
    // Stand just in front of the seat, on the side she's coming from.
    var dx = ch.x - args.x, dz = ch.z - args.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
    s.out = { x: dx / d, z: dz / d };
    s.face = typeof args.facing === "number" ? args.facing : Math.atan2(s.out.x, s.out.z);
    s.spot = { x: args.x + s.out.x * 0.12, z: args.z + s.out.z * 0.12 };
    s.approach = { x: args.x + s.out.x * 0.55, z: args.z + s.out.z * 0.55 };
    s.phase = "walk";
    s.walk = {};
    __behaviors.walk.start(ch, { x: s.approach.x, z: s.approach.z, quiet: true }, s.walk);
  },

  tick: function (ch, dt, s) {
    if (s.phase === "walk") {
      if (__behaviors.walk.tick(ch, dt, s.walk) === "done") { s.phase = "turn"; s.walk = null; }
      return;
    }
    if (s.phase === "turn") {
      var diff = soul.angleDiff(ch.yaw, s.face);
      // Back up the last steps to the seat while turning.
      var mx = s.spot.x - ch.x, mz = s.spot.z - ch.z, md = Math.sqrt(mx * mx + mz * mz);
      if (md > 0.02) {
        var step = Math.min(md, 0.35 * dt);
        body.setPosition(ch.id, ch.x + mx / md * step, ch.z + mz / md * step);
      }
      if (Math.abs(diff) > 0.03) body.setYaw(ch.id, ch.yaw + Math.max(-2.2 * dt, Math.min(2.2 * dt, diff)));
      else if (md <= 0.02) { s.phase = "sit"; s.t = 0; s.from = soul.poses[ch.id] || null; }
      return;
    }
    s.t += dt;
    var pose = this.seated(ch, s);
    if (s.t < this.lower) {
      var e = soul.ease(s.t / this.lower);
      pose = s.from ? soul.mixPose(s.from, pose, e) : soul.mixPose({ joints: {}, root: [0, 0, 0] }, pose, e);
    }
    soul.setPose(ch.id, pose, { plantFeet: false, fade: 3 });
  },

  stop: function (ch, s) {
    if (s.walk) __behaviors.walk.stop(ch, s.walk);
    body.clearPose(ch.id, 1.4);
    delete soul.poses[ch.id];
  },

  /// The seated pose for this seat height (model-space metres at her scale).
  seated: function (ch, s) {
    var scale = ch.scale || 1;
    var seatH = Math.max(0.2, Math.min(0.75, (s.seat.y - ch.y) / scale));
    var hipY = seatH + this.hipAboveSeat;          // hip joints above the floor
    var L1 = 0.375, L2 = 0.41, ankleY = 0.07, restHip = 0.855;
    // Shin vertical, thigh angled forward from the hip so the feet reach the floor.
    var c = Math.max(-0.2, Math.min(0.95, (hipY - L2 - ankleY) / L1));
    var a = Math.acos(c) * 180 / Math.PI;           // thigh angle from vertical
    var t = s.t || 0;
    var breath = Math.sin(t * 2 * Math.PI / 4.4);
    var shift = Math.sin(t * 2 * Math.PI / 17) * 2.5;
    return {
      root: [0.01 * Math.sin(t / 3), hipY - restHip, 0],
      joints: {
        pelvis: [-4, shift * 0.4, 0],
        spine1: [3, 0, -shift * 0.3], spine2: [1.5 * breath + 2, 0, 0], spine3: [3, 0, shift * 0.2],
        neck: [2, 0, 0],
        left_hip: [-a, -4, -4], right_hip: [-a, 4, 4],
        left_knee: [a, 0, 0], right_knee: [a, 0, 0],
        left_ankle: [0, 0, 0], right_ankle: [0, 0, 0],
        // Hands resting on her thighs.
        left_collar: [0, 0, -4], right_collar: [0, 0, 4],
        left_shoulder: [0, -12, -74], right_shoulder: [0, 12, 74],
        left_elbow: [0, -70, 0], right_elbow: [0, 70, 0],
        left_wrist: [0, 0, -12], right_wrist: [0, 0, 12],
      },
    };
  },
});
