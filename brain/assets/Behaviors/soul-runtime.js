// Behaviour runtime (JavaScriptCore). Native code provides `body`; the
// brain pushes behaviour files that call `behavior(name, def)`.
//
//   behavior("walk", {
//     start(ch, args, state) {},   // once, when started
//     tick(ch, dt, state) {},      // every frame; return "done" to finish
//     stop(ch, state) {},          // when replaced or stopped
//   });
//
// `ch` is the character as body.characters() reports it.
var __behaviors = {};
var __active = {};   // character id -> { name, state, args }

function behavior(name, def) { __behaviors[name] = def; }

function __char(id) {
  var all = body.characters();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function __stop(id, why) {
  var a = __active[id];
  if (!a) return;
  if (!a.isDefault) body.log(id + " " + a.name + " stopped (" + (why || "stop") + ")");
  delete __active[id];
  var def = __behaviors[a.name];
  if (def && def.stop) {
    try { def.stop(__char(id), a.state); }
    catch (e) { body.emit("behavior_error", { character: id, behavior: a.name, error: String(e) }); }
  }
}

function __run(id, name, args) {
  var def = __behaviors[name];
  if (!def) throw new Error("no behaviour named " + name);
  var ch = __char(id);
  if (!ch) throw new Error("no character " + id);
  __stop(id, "replaced by " + name);
  var state = {};
  __active[id] = { name: name, state: state, args: args || {} };
  if (def.start) {
    try { def.start(ch, args || {}, state); }
    catch (e) { delete __active[id]; throw e; }
  }
  body.log(id + " " + name + " started");
}

/// Whether a character is just resting (nothing the mind asked for running).
function __isResting(id) { var a = __active[id]; return !a || !!a.isDefault; }

var __defaultBehavior = null;

function __tick(dt) {
  var all = body.characters();
  for (var i = 0; i < all.length; i++) {
    var ch = all[i];
    var a = __active[ch.id];
    // Resting behaviour (idle while the mind is on); back to the dance when off.
    if (a && a.isDefault && a.name !== __defaultBehavior) {
      __stop(ch.id, "resting changed");
      body.clearPose(ch.id);
      a = null;
    }
    if (!a && __defaultBehavior && ch.canWalk && __behaviors[__defaultBehavior]) {
      try {
        __run(ch.id, __defaultBehavior, {});
        __active[ch.id].isDefault = true;
      } catch (e) {
        body.emit("behavior_error", { character: ch.id, behavior: __defaultBehavior, error: String(e) });
      }
      a = __active[ch.id];
    }
    if (!a) continue;
    var def = __behaviors[a.name];
    try {
      if (def && def.tick && def.tick(ch, dt, a.state) === "done") {
        delete __active[ch.id];
        if (!a.isDefault) body.log(ch.id + " " + a.name + " done");
        body.emit("behavior_done", { character: ch.id, behavior: a.name });
      }
    } catch (e) {
      delete __active[ch.id];
      body.emit("behavior_error", { character: ch.id, behavior: a.name, error: String(e) });
    }
  }
}

function __activeName(id) { var a = __active[id]; return a ? a.name : null; }
function __names() { return Object.keys(__behaviors); }

// Helpers shared by behaviours.
var soul = {
  // Shortest signed angle from a to b (radians).
  angleDiff: function (a, b) {
    var d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  },
  // Resolves a target: {x, z}, {to: "user"}, {to: "<character id>"}.
  // `keep` is the distance to stop short of a person or character.
  target: function (args, ch) {
    if (args.to === "user") {
      var c = body.camera();
      return soul.stopShort(ch, c.x, c.z, args.keep != null ? args.keep : 0.9);
    }
    if (args.to) {
      var o = __char(args.to);
      if (!o) throw new Error("no character " + args.to);
      return soul.stopShort(ch, o.x, o.z, args.keep != null ? args.keep : 0.7);
    }
    if (typeof args.x === "number" && typeof args.z === "number") return { x: args.x, z: args.z };
    throw new Error("target needs {x, z} or {to}");
  },
  stopShort: function (ch, x, z, keep) {
    var dx = x - ch.x, dz = z - ch.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d <= keep) return { x: ch.x, z: ch.z };
    return { x: x - dx / d * keep, z: z - dz / d * keep };
  },
};
