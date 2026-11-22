// idle v4: resting while the mind is on: breathing, slow weight shifts, small
// arm movement. Her gaze (the user, people, glances around) is the native
// attention layer's; args.look holds it on a direction.
animation("idle_stand", {
  duration: 8,
  loop: true,
  keys: [
    { t: 0, root: [0.015, 0, 0], joints: { pelvis: [0, 0, 2], spine1: [1, 0, -1], spine3: [2, 0, -1], neck: [2, 0, 0],
        left_shoulder: [2, 0, -73], right_shoulder: [-2, 0, 74], left_elbow: [0, -14, 0], right_elbow: [0, 10, 0] } },
    { t: 2, root: [0.02, -0.005, 0], joints: { pelvis: [0, 2, 3], spine1: [2, 0, -1.5], spine3: [3, 1, -1.5], neck: [3, -2, 0],
        left_shoulder: [3, 0, -72], right_shoulder: [-1, 0, 73], left_elbow: [0, -16, 0], right_elbow: [0, 12, 0] } },
    { t: 4, root: [-0.015, 0, 0], joints: { pelvis: [0, 0, -2], spine1: [1, 0, 1], spine3: [2, 0, 1], neck: [2, 2, 0],
        left_shoulder: [-2, 0, -74], right_shoulder: [2, 0, 73], left_elbow: [0, -10, 0], right_elbow: [0, 14, 0] } },
    { t: 6, root: [-0.02, -0.005, 0], joints: { pelvis: [0, -2, -3], spine1: [2, 0, 1.5], spine3: [3, -1, 1.5], neck: [3, 0, 0],
        left_shoulder: [-1, 0, -73], right_shoulder: [3, 0, 72], left_elbow: [0, -12, 0], right_elbow: [0, 16, 0] } },
    { t: 8, root: [0.015, 0, 0], joints: { pelvis: [0, 0, 2], spine1: [1, 0, -1], spine3: [2, 0, -1], neck: [2, 0, 0],
        left_shoulder: [2, 0, -73], right_shoulder: [-2, 0, 74], left_elbow: [0, -14, 0], right_elbow: [0, 10, 0] } },
  ],
});

behavior("idle", {
  start: function (ch, args, s) {
    s.t = 0;
    s.head = 0;
    s.from = soul.poses[ch.id] || null;
    s.args = args;
    if (typeof args.look === "number") {
      var a = ch.yaw + args.look * Math.PI / 180;
      body.lookAt(ch.id, { x: ch.x + Math.sin(a) * 3, y: 1.4, z: ch.z + Math.cos(a) * 3, seconds: 600 });
      s.looking = true;
    }
  },
  stop: function (ch, s) {
    if (s.fidgeting) body.stopMove(ch.id);
    if (s.looking && ch) body.lookAt(ch.id, { seconds: 0 });
  },
  // Small unconscious movements from her move library while she rests
  // (shifting weight, hands on hips, a stretch): args.fidgets overrides the
  // set with name prefixes that fit her personality.
  fidgets: ["graceful_lady_wait", "normal_wait", "idle", "shifting_weight", "standing_still", "waiting", "wait_for_bus", "stretch_and_yawn"],

  tick: function (ch, dt, s) {
    // A fidget playing: let it finish, then settle back into resting.
    if (s.fidgeting) {
      if (body.moveActive(ch.id)) return;
      s.fidgeting = false;
      s.from = body.currentPose(ch.id) || s.from;
      s.t = 0;
    }
    // She's never still for long: a small movement every few seconds.
    s.fidgetIn = (s.fidgetIn == null ? 1.5 + Math.random() * 2.5 : s.fidgetIn) - dt;
    if (s.fidgetIn <= 0) {
      s.fidgetIn = 3 + Math.random() * 4;
      if (!s.pool) s.pool = body.moveNames(s.args && s.args.fidgets ? s.args.fidgets : this.fidgets);
      if (s.pool.length) {
        var name = s.pool[Math.floor(Math.random() * s.pool.length)];
        if (body.playMove(ch.id, name, { times: 1 }) > 0) { s.fidgeting = true; return; }
      }
    }
    s.t += dt;
    var pose = soul.sample(__clips.idle_stand, s.t % 8);
    // Breathing.
    var breath = Math.sin(s.t * 2 * Math.PI / 4.2);
    pose.joints.spine2 = [1.2 * breath, 0, 0];
    // Where she looks is the gaze layer's job (native attention: the user,
    // people, the room); args.look points it somewhere for her.
    if (s.from && s.t < 0.6) pose = soul.mixPose(s.from, pose, soul.ease(s.t / 0.6));
    soul.setPose(ch.id, pose, { fade: 3 });
  },
});
