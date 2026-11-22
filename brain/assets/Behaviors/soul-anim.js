// anim v3: keyframe animations on the body's pose layer, and "play" / "dance".
//
// A pose is { joints: { name: [x, y, z] }, root: [x, y, z] }:
//   joint rotations in degrees, local to the parent, measured from the rest
//   T-pose and applied x first, then y, then z (R = Rz·Ry·Rx);
//   root moves the pelvis (metres; +x her left, +y up, +z forward).
//
// animation(name, {
//   duration: 2,            // seconds
//   loop: false,
//   plantFeet: true,        // legs whose hip/knee aren't set keep feet planted
//   keys: [ { t: 0, joints: {...}, root: [0, 0, 0], ease: "inOut" }, { t: 1, ... }, ... ]
// });
//
// Every joint (and the root) has its own timeline: it eases between the keys
// that list it (starting from neutral at t = 0 if its first key is later) and
// holds its value after its last key, so
// joints can move on their own timing (overlap, follow-through). A joint no
// key lists keeps the neutral standing pose (soul.neutral). `ease` on a key
// shapes the motion arriving at it: "inOut" (default), "in", "out",
// "linear", "step" (jump at the key).
// Kept when this file is loaded again (the brain re-sends it), so animations
// registered from other files survive.
var __clips = (typeof __clips !== "undefined" && __clips) || {};
function animation(name, clip) { __clips[name] = clip; }

/// Relaxed standing: arms down at the sides, elbows slightly bent.
soul.neutral = {
  left_shoulder: [0, 0, -72], right_shoulder: [0, 0, 72],
  left_elbow: [0, -12, 0], right_elbow: [0, 12, 0],
};

soul.poses = soul.poses || {}; // last pose sent per character, so the next one can blend from it

soul.setPose = function (id, pose, opts) {
  soul.poses[id] = pose;
  body.setPose(id, {
    joints: pose.joints, root: pose.root || [0, 0, 0],
    plantFeet: opts && opts.plantFeet === false ? false : true,
    weight: 1, fade: (opts && opts.fade) || 4,
  });
};

/// The full pose of a key: neutral, overridden by the key's joints.
soul.fullPose = function (key) {
  var joints = {};
  for (var n in soul.neutral) joints[n] = soul.neutral[n];
  for (var k in (key.joints || {})) joints[k] = key.joints[k];
  return { joints: joints, root: key.root || [0, 0, 0] };
};

soul.mixPose = function (a, b, t) {
  var joints = {}, names = {};
  for (var n in a.joints) names[n] = true;
  for (var m in b.joints) names[m] = true;
  for (var j in names) {
    var p = a.joints[j] || soul.neutral[j] || [0, 0, 0];
    var q = b.joints[j] || soul.neutral[j] || [0, 0, 0];
    joints[j] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  }
  var ra = a.root || [0, 0, 0], rb = b.root || [0, 0, 0];
  return { joints: joints, root: [ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t] };
};

soul.ease = function (t) { return t * t * (3 - 2 * t); };

soul.easeKinds = {
  inOut: function (t) { return t * t * (3 - 2 * t); },
  in: function (t) { return t * t; },
  out: function (t) { return 1 - (1 - t) * (1 - t); },
  linear: function (t) { return t; },
  step: function (t) { return t < 1 ? 0 : 1; },
};

/// Per-joint tracks of a clip (cached on it): { joint: [{t, v, ease}] }, root under "$root".
soul.tracks = function (clip) {
  if (clip.__tracks) return clip.__tracks;
  var tracks = {};
  var keys = (clip.keys || []).slice().sort(function (a, b) { return a.t - b.t; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    for (var j in (k.joints || {})) (tracks[j] = tracks[j] || []).push({ t: k.t, v: k.joints[j], ease: k.ease });
    if (k.root) (tracks.$root = tracks.$root || []).push({ t: k.t, v: k.root, ease: k.ease });
  }
  // A joint whose first key is after the start eases in from neutral at t = 0.
  for (var n in tracks) {
    if (tracks[n][0].t > 0) tracks[n].unshift({ t: 0, v: n === "$root" ? [0, 0, 0] : (soul.neutral[n] || [0, 0, 0]) });
  }
  clip.__tracks = tracks;
  return tracks;
};

soul.sampleTrack = function (track, time) {
  if (time <= track[0].t) return track[0].v;
  for (var i = 1; i < track.length; i++) {
    var b = track[i];
    if (time <= b.t) {
      var a = track[i - 1];
      var u = (time - a.t) / Math.max(1e-4, b.t - a.t);
      var e = (soul.easeKinds[b.ease] || soul.easeKinds.inOut)(u);
      return [a.v[0] + (b.v[0] - a.v[0]) * e, a.v[1] + (b.v[1] - a.v[1]) * e, a.v[2] + (b.v[2] - a.v[2]) * e];
    }
  }
  return track[track.length - 1].v;
};

/// Pose of `clip` at time `time`.
soul.sample = function (clip, time) {
  var tracks = soul.tracks(clip);
  var joints = {};
  for (var n in soul.neutral) joints[n] = soul.neutral[n];
  var root = [0, 0, 0];
  for (var j in tracks) {
    var v = soul.sampleTrack(tracks[j], time);
    if (j === "$root") root = v; else joints[j] = v;
  }
  return { joints: joints, root: root };
};

// play: runs an animation. args: { name, loop?, speed?, blend? (s) }
behavior("play", {
  start: function (ch, args, s) {
    s.clip = __clips[args.name];
    if (!s.clip) throw new Error("no animation named " + args.name);
    s.t = 0;
    // times: play it N times in a row (e.g. 20 push-ups), then stop.
    s.times = args.times > 1 ? Math.floor(args.times) : 1;
    s.loop = s.times > 1 ? false : (args.loop != null ? args.loop : !!s.clip.loop);
    s.speed = args.speed || 1;
    s.blend = args.blend != null ? args.blend : 0.35;
    s.from = soul.poses[ch.id] || null;
  },
  tick: function (ch, dt, s) {
    s.t += dt * s.speed;
    var dur = Math.max(0.05, s.clip.duration || 1);
    var total = dur * s.times;
    var at = s.loop || s.times > 1 ? (s.t >= total ? dur : s.t % dur) : Math.min(s.t, dur);
    var pose = soul.sample(s.clip, at);
    if (s.from && s.t < s.blend) pose = soul.mixPose(s.from, pose, soul.ease(s.t / s.blend));
    soul.setPose(ch.id, pose, { plantFeet: s.clip.plantFeet !== false });
    if (!s.loop && s.t >= total) return "done";
  },
});

// dance: back to her own dance (fades the pose layer out) until replaced.
behavior("dance", {
  start: function (ch) {
    body.clearPose(ch.id, 2.5);
    delete soul.poses[ch.id];
  },
  tick: function () {},
});

// move: a move from her motion-capture library (real human motion, played
// natively). args: {name, times, speed, loop}.
behavior("move", {
  start: function (ch, args, s) {
    var d = body.playMove(ch.id, String(args.name), { times: args.times || 1, speed: args.speed || 1, loop: !!args.loop });
    if (d < 0) throw new Error("no move named " + args.name + " in her library");
    s.duration = d;
  },
  tick: function (ch, dt, s) {
    if (!body.moveActive(ch.id)) {
      var p = body.currentPose(ch.id);
      if (p) soul.poses[ch.id] = p;
      return "done";
    }
  },
  stop: function (ch, s) {
    body.stopMove(ch.id);
    var p = body.currentPose(ch.id);
    if (p) soul.poses[ch.id] = p;
  },
});
