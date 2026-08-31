/**
 * Sky raid — a vertical shooter with a leaderboard nobody can lie their way onto.
 *
 * The page draws and the page plays, but the page never says what a run was
 * worth. It is handed a seed, it records which keys were held on which frame,
 * and at the end it sends back only those two things. The handler replays the
 * same frames through the same `stepRun` and reads the score off its own copy of
 * the game. Editing anything in the browser changes what you see, not what the
 * board says.
 *
 * That only works if one simulation exists. `CONFIG` and the three sim functions
 * below are the simulation; they are serialised into the page verbatim rather
 * than written out a second time, so the two sides cannot drift apart.
 */

/** Every number the simulation depends on. Shared verbatim with the page. */
const CONFIG = {
  W: 360,
  H: 640,
  // 15 minutes at 60fps. The cap is a budget, not a rule of the game: a replay
  // is the one thing a member's data makes the sandbox do work for, and the
  // sandbox is killed at 3s. Measured worst case here is well under 300ms.
  MAX_FRAMES: 54000,
  MAX_RUNS_REPLAYED: 4096,

  PLAYER_Y: 560,
  PLAYER_SPEED: 4.3,
  PLAYER_R: 11,
  PLAYER_LIVES: 3,
  INVULN_FRAMES: 96,
  RESPAWN_FRAMES: 48,

  SHOT_COOLDOWN: 9,
  SHOT_SPEED: 10,
  SHOT_R: 4,
  SHOT_DAMAGE: 1,

  ENEMY_SHOT_SPEED: 3.4,
  ENEMY_SHOT_R: 5,

  COMBO_MAX: 5,
  COMBO_STEP: 6,

  POWER_MAX: 3,
  DROP_CHANCE: 0.28,
  LIFE_DROP_CHANCE: 0.06,
  PICKUP_SPEED: 1.5,
  PICKUP_R: 10,

  WAVE_GAP: 96,
  BOSS_EVERY: 5,

  KINDS: {
    drone: { hp: 1, r: 12, speed: 1.75, score: 100, fireEvery: 0, drops: false },
    wasp: { hp: 2, r: 13, speed: 2.05, score: 250, fireEvery: 104, drops: false },
    hulk: { hp: 6, r: 22, speed: 1.0, score: 600, fireEvery: 78, drops: true },
    boss: { hp: 60, r: 46, speed: 1.25, score: 3000, fireEvery: 30, drops: true },
  },
};

/**
 * Deterministic RNG. Every random decision the game makes goes through this and
 * nothing else, which is what lets a replay come out identical.
 */
function rngNext(run) {
  run.seed = (run.seed + 0x6d2b79f5) >>> 0;
  let t = run.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function createRun(seed) {
  return {
    seed: seed >>> 0,
    frame: 0,
    over: false,
    score: 0,
    lives: CONFIG.PLAYER_LIVES,
    power: 1,
    combo: 0,
    comboKills: 0,
    wave: 0,
    waveTimer: CONFIG.WAVE_GAP,
    pending: [],
    px: CONFIG.W / 2,
    invuln: CONFIG.INVULN_FRAMES,
    respawn: 0,
    cooldown: 0,
    shots: [],
    foes: [],
    flak: [],
    drops: [],
    // Cosmetic-only counters the renderer reads; they never feed a decision.
    events: [],
  };
}

/**
 * One frame. `input` is a bitmask: 1 left, 2 right, 4 fire.
 *
 * Everything that decides the outcome lives here, and nothing here touches a
 * canvas, a clock or `Math.random`. `run.events` is the one output that exists
 * purely for the renderer — the replay throws it away.
 */
function stepRun(run, input) {
  if (run.over) {
    return run;
  }

  const C = CONFIG;
  const K = C.KINDS;
  run.frame++;
  run.events = [];

  if (run.respawn > 0) {
    run.respawn--;
    if (run.respawn === 0) {
      run.px = C.W / 2;
      run.invuln = C.INVULN_FRAMES;
    }
  }

  const alive = run.respawn === 0;
  if (run.invuln > 0) {
    run.invuln--;
  }

  if (alive) {
    if (input & 1) {
      run.px -= C.PLAYER_SPEED;
    }
    if (input & 2) {
      run.px += C.PLAYER_SPEED;
    }
    if (run.px < 18) {
      run.px = 18;
    }
    if (run.px > C.W - 18) {
      run.px = C.W - 18;
    }

    if (run.cooldown > 0) {
      run.cooldown--;
    }
    if (input & 4 && run.cooldown === 0) {
      run.cooldown = C.SHOT_COOLDOWN;
      const spread = run.power === 1 ? [0] : run.power === 2 ? [-7, 7] : [-11, 0, 11];
      for (let i = 0; i < spread.length; i++) {
        run.shots.push({ x: run.px + spread[i], y: C.PLAYER_Y - 14, vx: spread[i] * 0.06 });
      }
      run.events.push({ t: "shot", x: run.px, y: C.PLAYER_Y - 14 });
    }
  }

  // Waves. A wave is a queue of spawns; the next one opens once the queue is
  // empty and the field is clear, so the pace follows the player.
  if (run.pending.length === 0 && run.foes.length === 0) {
    if (run.waveTimer > 0) {
      run.waveTimer--;
    } else {
      run.wave++;
      run.waveTimer = C.WAVE_GAP;
      run.pending = planWave(run, run.wave);
      run.events.push({ t: "wave", n: run.wave });
    }
  }

  for (let i = run.pending.length - 1; i >= 0; i--) {
    const spawn = run.pending[i];
    spawn.at--;
    if (spawn.at <= 0) {
      run.foes.push({
        kind: spawn.kind,
        x: spawn.x,
        y: -30,
        hp: K[spawn.kind].hp + (spawn.kind === "boss" ? Math.floor(run.wave / C.BOSS_EVERY) * 22 : 0),
        maxHp: K[spawn.kind].hp + (spawn.kind === "boss" ? Math.floor(run.wave / C.BOSS_EVERY) * 22 : 0),
        phase: spawn.phase,
        cool: K[spawn.kind].fireEvery,
        hit: 0,
      });
      run.pending.splice(i, 1);
    }
  }

  for (let i = run.foes.length - 1; i >= 0; i--) {
    const foe = run.foes[i];
    const spec = K[foe.kind];
    if (foe.hit > 0) {
      foe.hit--;
    }

    if (foe.kind === "boss") {
      foe.y += foe.y < 110 ? spec.speed : 0;
      foe.x = C.W / 2 + Math.sin((run.frame + foe.phase) / 62) * (C.W / 2 - 70);
    } else if (foe.kind === "wasp") {
      foe.y += spec.speed;
      foe.x += Math.sin((run.frame + foe.phase) / 22) * 2.1;
    } else {
      foe.y += spec.speed;
    }

    if (spec.fireEvery > 0 && foe.y > 0) {
      foe.cool--;
      if (foe.cool <= 0) {
        foe.cool = spec.fireEvery;
        fireAt(run, foe);
      }
    }

    if (foe.y > C.H + 40 || foe.x < -60 || foe.x > C.W + 60) {
      run.foes.splice(i, 1);
      // Letting one through is not free: the streak is what it costs.
      if (foe.y > C.H + 40) {
        run.combo = 0;
        run.comboKills = 0;
      }
    }
  }

  for (let i = run.shots.length - 1; i >= 0; i--) {
    const shot = run.shots[i];
    shot.y -= C.SHOT_SPEED;
    shot.x += shot.vx;
    if (shot.y < -20) {
      run.shots.splice(i, 1);
      continue;
    }

    for (let j = run.foes.length - 1; j >= 0; j--) {
      const foe = run.foes[j];
      const spec = K[foe.kind];
      if (!hits(shot.x, shot.y, C.SHOT_R, foe.x, foe.y, spec.r)) {
        continue;
      }

      run.shots.splice(i, 1);
      foe.hp -= C.SHOT_DAMAGE;
      foe.hit = 6;
      run.events.push({ t: "spark", x: shot.x, y: shot.y });

      if (foe.hp <= 0) {
        run.foes.splice(j, 1);
        run.comboKills++;
        if (run.comboKills % C.COMBO_STEP === 0 && run.combo < C.COMBO_MAX - 1) {
          run.combo++;
        }
        run.score += spec.score * (run.combo + 1);
        run.events.push({ t: "boom", x: foe.x, y: foe.y, r: spec.r, boss: foe.kind === "boss" });
        if (spec.drops) {
          maybeDrop(run, foe);
        }
      }
      break;
    }
  }

  for (let i = run.flak.length - 1; i >= 0; i--) {
    const bolt = run.flak[i];
    bolt.x += bolt.vx;
    bolt.y += bolt.vy;
    if (bolt.y > C.H + 20 || bolt.y < -20 || bolt.x < -20 || bolt.x > C.W + 20) {
      run.flak.splice(i, 1);
      continue;
    }
    if (alive && run.invuln === 0 && hits(bolt.x, bolt.y, C.ENEMY_SHOT_R, run.px, C.PLAYER_Y, C.PLAYER_R)) {
      run.flak.splice(i, 1);
      hurtPlayer(run);
    }
  }

  if (alive && run.invuln === 0) {
    for (let i = run.foes.length - 1; i >= 0; i--) {
      const foe = run.foes[i];
      if (hits(foe.x, foe.y, K[foe.kind].r, run.px, C.PLAYER_Y, C.PLAYER_R)) {
        if (foe.kind !== "boss") {
          run.foes.splice(i, 1);
          run.events.push({ t: "boom", x: foe.x, y: foe.y, r: K[foe.kind].r, boss: false });
        }
        hurtPlayer(run);
        break;
      }
    }
  }

  for (let i = run.drops.length - 1; i >= 0; i--) {
    const drop = run.drops[i];
    drop.y += CONFIG.PICKUP_SPEED;
    if (drop.y > C.H + 20) {
      run.drops.splice(i, 1);
      continue;
    }
    if (alive && hits(drop.x, drop.y, C.PICKUP_R, run.px, C.PLAYER_Y, C.PLAYER_R + 6)) {
      run.drops.splice(i, 1);
      if (drop.kind === "life") {
        run.lives++;
      } else if (run.power < C.POWER_MAX) {
        run.power++;
      } else {
        run.score += 500;
      }
      run.events.push({ t: "pickup", x: drop.x, y: drop.y, kind: drop.kind });
    }
  }

  if (run.frame >= C.MAX_FRAMES) {
    run.over = true;
  }

  return run;
}

function planWave(run, wave) {
  const C = CONFIG;
  const queue = [];

  if (wave % C.BOSS_EVERY === 0) {
    queue.push({ kind: "boss", x: C.W / 2, at: 40, phase: Math.floor(rngNext(run) * 400) });
    const escorts = 2 + Math.floor(wave / C.BOSS_EVERY);
    for (let i = 0; i < escorts; i++) {
      queue.push({
        kind: "wasp",
        x: 40 + rngNext(run) * (C.W - 80),
        at: 120 + i * 70,
        phase: Math.floor(rngNext(run) * 400),
      });
    }
    return queue;
  }

  const drones = 5 + wave * 2;
  const wasps = Math.max(0, wave - 1) * 2;
  const hulks = Math.floor(wave / 3);

  for (let i = 0; i < drones; i++) {
    queue.push({
      kind: "drone",
      x: 30 + rngNext(run) * (C.W - 60),
      at: 20 + i * Math.max(11, 26 - wave),
      phase: Math.floor(rngNext(run) * 400),
    });
  }
  for (let i = 0; i < wasps; i++) {
    queue.push({
      kind: "wasp",
      x: 40 + rngNext(run) * (C.W - 80),
      at: 90 + i * 46,
      phase: Math.floor(rngNext(run) * 400),
    });
  }
  for (let i = 0; i < hulks; i++) {
    queue.push({
      kind: "hulk",
      x: 60 + rngNext(run) * (C.W - 120),
      at: 150 + i * 130,
      phase: Math.floor(rngNext(run) * 400),
    });
  }
  return queue;
}

function fireAt(run, foe) {
  const C = CONFIG;
  const dx = run.px - foe.x;
  const dy = C.PLAYER_Y - foe.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angles = foe.kind === "boss" ? [-0.34, -0.12, 0.12, 0.34] : foe.kind === "hulk" ? [-0.22, 0, 0.22] : [0];

  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const nx = dx / len;
    const ny = dy / len;
    run.flak.push({
      x: foe.x,
      y: foe.y + 12,
      vx: (nx * cos - ny * sin) * C.ENEMY_SHOT_SPEED,
      vy: (nx * sin + ny * cos) * C.ENEMY_SHOT_SPEED,
    });
  }
  run.events.push({ t: "flak", x: foe.x, y: foe.y });
}

function maybeDrop(run, foe) {
  const roll = rngNext(run);
  if (roll < CONFIG.LIFE_DROP_CHANCE) {
    run.drops.push({ x: foe.x, y: foe.y, kind: "life" });
  } else if (roll < CONFIG.DROP_CHANCE) {
    run.drops.push({ x: foe.x, y: foe.y, kind: "power" });
  }
}

function hurtPlayer(run) {
  run.lives--;
  run.combo = 0;
  run.comboKills = 0;
  run.power = 1;
  run.events.push({ t: "hurt", x: run.px, y: CONFIG.PLAYER_Y });
  if (run.lives <= 0) {
    run.lives = 0;
    run.over = true;
  } else {
    run.respawn = CONFIG.RESPAWN_FRAMES;
  }
}

function hits(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Replays a recorded run and reports what it was actually worth.
 *
 * `ticks` is run-length encoded input: [[mask, frames], …]. Bounded on every
 * axis, because this is the one place a member's data decides how much work the
 * sandbox does.
 */
function replay(seed, ticks) {
  if (!Array.isArray(ticks) || ticks.length > CONFIG.MAX_RUNS_REPLAYED) {
    return null;
  }

  const run = createRun(seed);
  let frames = 0;

  for (let i = 0; i < ticks.length; i++) {
    const entry = ticks[i];
    if (!Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const mask = entry[0] | 0;
    const count = entry[1] | 0;
    if (mask < 0 || mask > 7 || count < 1) {
      return null;
    }
    frames += count;
    if (frames > CONFIG.MAX_FRAMES) {
      return null;
    }
    for (let f = 0; f < count; f++) {
      stepRun(run, mask);
      if (run.over) {
        return { score: run.score, wave: run.wave, frames: run.frame };
      }
    }
  }

  return { score: run.score, wave: run.wave, frames: run.frame };
}

/** The board is one shared key rather than one per player: an app's shared area
 * has a key budget, and a leaderboard that stops accepting people once it gets
 * popular is not a leaderboard. */
const BOARD_KEY = "board";
const BOARD_SIZE = 10;

async function readBoard(api) {
  const shared = await api.kv.listPublic();
  const entry = (shared ?? []).find((row) => row.key === BOARD_KEY);
  return Array.isArray(entry?.value) ? entry.value : [];
}

function placeOnBoard(board, name, score, wave) {
  const without = board.filter((row) => row.name !== name);
  const mine = board.find((row) => row.name === name);
  const best = Math.max(score, mine?.score ?? 0);
  const next = without.concat([{ name, score: best, wave: best === score ? wave : mine.wave }]);
  next.sort((a, b) => b.score - a.score);
  return next.slice(0, BOARD_SIZE);
}

function seedFor(userId, runNo, installId) {
  let h = 2166136261 ^ (userId >>> 0);
  h = Math.imul(h ^ (runNo >>> 0), 16777619);
  h = Math.imul(h ^ (installId >>> 0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * The simulation, as source, for the page to run.
 *
 * Serialised rather than duplicated: the injected script is a string, not a
 * closure, so anything it needs has to arrive this way — and generating it from
 * the same declarations the handler uses is what keeps one simulation.
 */
function simulationSource() {
  return [
    "var CONFIG = " + JSON.stringify(CONFIG) + ";",
    rngNext.toString(),
    createRun.toString(),
    stepRun.toString(),
    planWave.toString(),
    fireAt.toString(),
    maybeDrop.toString(),
    hurtPlayer.toString(),
    hits.toString(),
  ].join("\n");
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; background: #05060f; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
  }
  /* The canvas takes the whole surface it is given, top to bottom. The play
     field keeps its own proportions inside it — see fit() — so what fills the
     rest is the game's own sky rather than a band of nothing. */
  #stage { position: relative; width: 100%; height: 100%; }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; }
`;

const PAGE_HTML = '<div id="stage"><canvas id="screen"></canvas></div>';

/**
 * The page: presentation, input capture, and the two bridge calls.
 *
 * Written as one string because that is how it is delivered. Nothing in here
 * decides a score — it steps the shared simulation for the player to look at,
 * and keeps the tape of what was pressed.
 */
const PAGE_JS = `
(function () {
  "use strict";

  var boot = window.__SKY_RAID__ || {};
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");

  var VW = CONFIG.W;
  var VH = CONFIG.H;

  // Two coordinate systems. SW/SH is the surface we were given, edge to edge,
  // and the sky is painted across all of it. VW/VH is the play field, which has
  // fixed proportions because the simulation is written in those units — the
  // field is centred inside the surface rather than stretched to it.
  var SW = 0;
  var SH = 0;
  var scale = 1;
  var offX = 0;
  var offY = 0;

  var lastDpr = 0;

  /**
   * Sizes the backing store to the box the canvas is actually painted in.
   *
   * Measured from the element, never from the window: the canvas is sized by CSS
   * to fill whatever frame the site gives it, and that frame reaches its final
   * height after this script first runs. Asking the window meant allocating a
   * bitmap for the wrong size and letting the browser stretch it — sharp only
   * after something happened to fire a resize.
   */
  function fit() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(120, Math.round(rect.width) || canvas.clientWidth || window.innerWidth);
    var h = Math.max(160, Math.round(rect.height) || canvas.clientHeight || window.innerHeight);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (w === SW && h === SH && dpr === lastDpr) { return; }

    SW = w;
    SH = h;
    lastDpr = dpr;
    canvas.width = Math.round(SW * dpr);
    canvas.height = Math.round(SH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    scale = Math.min(SW / VW, SH / VH);
    offX = (SW - VW * scale) / 2;
    offY = (SH - VH * scale) / 2;
    seedSky();
  }

  // ---- cosmetic layer -----------------------------------------------------
  // None of this is in the simulation, so it is free to use Math.random: a
  // different starfield never changes what a run scores.
  var stars = [];
  var nebulae = [];

  function seedSky() {
    var want = Math.round((SW * SH) / 1900);
    want = Math.max(120, Math.min(520, want));
    while (stars.length > want) { stars.pop(); }
    while (stars.length < want) {
      stars.push({ x: 0, y: 0, z: 0.35 + Math.random() * 1.5, tw: Math.random() * 6.28 });
    }
    for (var i = 0; i < stars.length; i++) {
      if (stars[i].x > SW || stars[i].y > SH || !stars[i].seeded) {
        stars[i].x = Math.random() * SW;
        stars[i].y = Math.random() * SH;
        stars[i].seeded = true;
      }
    }
    nebulae = [
      { x: SW * 0.2, y: SH * 0.2, r: Math.max(SW, SH) * 0.34, h: 265, a: 0.20 },
      { x: SW * 0.8, y: SH * 0.62, r: Math.max(SW, SH) * 0.40, h: 320, a: 0.15 },
      { x: SW * 0.45, y: SH * 1.0, r: Math.max(SW, SH) * 0.35, h: 195, a: 0.11 }
    ];
  }

  // The frame settles after this script runs, so waiting to be told is the only
  // way to catch the size it settles on. A resize listener alone misses it —
  // nothing resizes the window when a post finishes laying itself out — and it
  // covers the case an observer does not: the device pixel ratio changing under
  // a window that stayed the same size.
  if (window.ResizeObserver) {
    new window.ResizeObserver(fit).observe(canvas);
  }
  window.addEventListener("resize", fit);
  fit();
  var bits = [];
  var rings = [];
  var floats = [];
  var shake = 0;
  var flash = 0;
  var waveBanner = 0;
  var waveLabel = "";

  function spark(x, y, n, hue, power) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.28;
      var s = (0.6 + Math.random() * 2.6) * power;
      bits.push({
        x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 22 + Math.random() * 26, age: 0, hue: hue + Math.random() * 30 - 15,
        size: 1 + Math.random() * 2.2
      });
    }
  }
  function ring(x, y, r, hue) { rings.push({ x: x, y: y, r: r, age: 0, life: 26, hue: hue }); }
  function floatText(x, y, text, hue) { floats.push({ x: x, y: y, text: text, age: 0, life: 46, hue: hue }); }

  // ---- sound --------------------------------------------------------------
  // Synthesised, not sampled. The page arrives as one string with nothing behind
  // it to fetch, so a sample would have to ride along as base64 in the middle of
  // the source; an oscillator costs a few lines and cannot fail to load.
  //
  // Like the rest of the cosmetic layer this reads \`run.events\` and never writes
  // to the run, so a muted browser and a loud one score identically.
  var AC = window.AudioContext || window.webkitAudioContext;
  var audio = null;
  var master = null;
  var noiseBuf = null;
  var muted = false;
  var voices = [];
  var lastAt = {};
  var comboHeard = 0;

  // Browsers hand out a running context only in response to a gesture, so the
  // first key or tap is what actually starts the sound.
  function ensureAudio() {
    if (!AC) { return; }
    if (!audio) {
      try { audio = new AC(); } catch (e) { AC = null; return; }
      master = audio.createGain();
      master.gain.value = 0.5;
      master.connect(audio.destination);
    }
    if (audio.state === "suspended") { audio.resume(); }
  }

  function noise() {
    if (!noiseBuf) {
      var len = Math.floor(audio.sampleRate * 1.2);
      noiseBuf = audio.createBuffer(1, len, audio.sampleRate);
      var data = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) { data[i] = Math.random() * 2 - 1; }
    }
    return noiseBuf;
  }

  // A wave of drones dying together can ask for more voices than anyone can hear
  // apart; past the cap the extras are dropped rather than mixed into mud. The
  // count is kept by when each voice is due to end rather than by an "ended"
  // callback, because a callback that never arrives would silence the game for
  // the rest of the run.
  function slot(until) {
    if (!audio || muted) { return false; }
    var now = audio.currentTime;
    for (var i = voices.length - 1; i >= 0; i--) {
      if (voices[i] <= now) { voices.splice(i, 1); }
    }
    if (voices.length > 18) { return false; }
    voices.push(now + until);
    return true;
  }

  function ready(name, gap) {
    if (!audio) { return false; }
    var now = audio.currentTime;
    if (lastAt[name] !== undefined && now - lastAt[name] < gap) { return false; }
    lastAt[name] = now;
    return true;
  }

  function tone(type, from, to, dur, gain, delay) {
    if (!slot(dur + (delay || 0))) { return; }
    var t0 = audio.currentTime + (delay || 0);
    var osc = audio.createOscillator();
    var amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) { osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur); }
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp); amp.connect(master);
    osc.onended = function () { amp.disconnect(); };
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function hiss(dur, gain, from, to, delay) {
    if (!slot(dur + (delay || 0))) { return; }
    var t0 = audio.currentTime + (delay || 0);
    var src = audio.createBufferSource();
    var flt = audio.createBiquadFilter();
    var amp = audio.createGain();
    src.buffer = noise();
    flt.type = "lowpass";
    flt.frequency.setValueAtTime(from, t0);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(amp); amp.connect(master);
    src.onended = function () { amp.disconnect(); };
    src.start(t0, Math.random() * 0.4);
    src.stop(t0 + dur + 0.03);
  }

  function sfx(name, extra) {
    if (!audio || muted) { return; }

    if (name === "shot") {
      if (!ready("shot", 0.05)) { return; }
      tone("square", 900, 320, 0.11, 0.05, 0);
      hiss(0.05, 0.03, 4200, 900, 0);
    } else if (name === "flak") {
      if (!ready("flak", 0.07)) { return; }
      tone("sawtooth", 240, 90, 0.16, 0.04, 0);
    } else if (name === "spark") {
      if (!ready("spark", 0.045)) { return; }
      hiss(0.05, 0.035, 5200, 1600, 0);
      tone("triangle", 1400, 900, 0.05, 0.025, 0);
    } else if (name === "boom") {
      if (!ready("boom", 0.03)) { return; }
      hiss(0.34, 0.2, 2000, 140, 0);
      tone("sine", 190, 48, 0.3, 0.16, 0);
    } else if (name === "bossboom") {
      hiss(1.1, 0.38, 2600, 60, 0);
      hiss(0.7, 0.22, 900, 40, 0.18);
      tone("sawtooth", 110, 26, 0.9, 0.22, 0);
      tone("sine", 70, 22, 1.3, 0.18, 0.1);
    } else if (name === "hurt") {
      hiss(0.5, 0.22, 1800, 90, 0);
      tone("sawtooth", 420, 55, 0.5, 0.18, 0);
      tone("square", 210, 40, 0.36, 0.09, 0.05);
    } else if (name === "power") {
      tone("triangle", 523, 523, 0.09, 0.11, 0);
      tone("triangle", 784, 784, 0.09, 0.11, 0.06);
      tone("triangle", 1046, 1046, 0.16, 0.11, 0.12);
    } else if (name === "life") {
      tone("triangle", 659, 659, 0.08, 0.11, 0);
      tone("triangle", 880, 880, 0.08, 0.11, 0.06);
      tone("triangle", 1318, 1318, 0.08, 0.11, 0.12);
      tone("triangle", 1760, 1760, 0.22, 0.1, 0.18);
    } else if (name === "wave") {
      tone("triangle", 587, 587, 0.16, 0.08, 0);
      tone("triangle", 880, 880, 0.3, 0.08, 0.12);
    } else if (name === "warlord") {
      tone("sawtooth", 147, 147, 0.5, 0.1, 0);
      tone("sawtooth", 110, 110, 0.6, 0.1, 0.18);
      tone("sine", 55, 55, 1.2, 0.14, 0.3);
      hiss(1.0, 0.06, 400, 120, 0.3);
    } else if (name === "combo") {
      var step = 660 + (extra || 0) * 110;
      tone("square", step, step * 1.5, 0.12, 0.05, 0);
    } else if (name === "start") {
      tone("sawtooth", 180, 720, 0.35, 0.09, 0);
      tone("triangle", 440, 880, 0.3, 0.07, 0.1);
    } else if (name === "over") {
      tone("sawtooth", 392, 392, 0.24, 0.11, 0);
      tone("sawtooth", 311, 311, 0.24, 0.11, 0.2);
      tone("sawtooth", 262, 262, 0.28, 0.11, 0.4);
      tone("sine", 131, 98, 1.1, 0.13, 0.6);
    } else if (name === "blip") {
      tone("square", 520, 520, 0.07, 0.06, 0);
    }
  }

  function toggleMute() {
    muted = !muted;
    ensureAudio();
    if (master) { master.gain.value = muted ? 0 : 0.5; }
    if (!muted) { sfx("blip"); }
  }

  // ---- input --------------------------------------------------------------
  var held = { left: false, right: false, fire: false };
  var pointer = { active: false, x: 0 };
  var mode = "title";
  var run = null;
  var tape = [];
  var seed = 0;
  var busy = false;
  var board = boot.board || [];
  var best = boot.best || 0;
  var canScore = !!boot.canScore;
  var lastResult = null;
  var notice = boot.notice || "";

  function pushTick(mask) {
    var last = tape[tape.length - 1];
    if (last && last[0] === mask && last[1] < 60000) { last[1]++; } else { tape.push([mask, 1]); }
  }

  function currentMask() {
    var mask = 0;
    if (held.left) { mask |= 1; }
    if (held.right) { mask |= 2; }
    if (held.fire || pointer.active) { mask |= 4; }
    if (pointer.active && run) {
      var dx = pointer.x - run.px;
      if (dx < -2) { mask |= 1; }
      if (dx > 2) { mask |= 2; }
    }
    return mask;
  }

  function keyFlag(code, down) {
    if (code === "ArrowLeft" || code === "KeyA") { held.left = down; return true; }
    if (code === "ArrowRight" || code === "KeyD") { held.right = down; return true; }
    if (code === "Space" || code === "KeyZ" || code === "KeyJ") { held.fire = down; return true; }
    return false;
  }

  window.addEventListener("keydown", function (e) {
    ensureAudio();
    if (keyFlag(e.code, true)) { e.preventDefault(); }
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (mode === "title" || mode === "over") { startRun(); }
    }
    if (e.code === "KeyM" && !e.repeat) { toggleMute(); }
    if (e.code === "KeyP" && mode === "play") { mode = "paused"; sfx("blip"); }
    else if (e.code === "KeyP" && mode === "paused") { mode = "play"; sfx("blip"); }
  });
  window.addEventListener("keyup", function (e) { if (keyFlag(e.code, false)) { e.preventDefault(); } });
  window.addEventListener("blur", function () { held.left = held.right = held.fire = false; });

  function pointerAt(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left - offX) / scale;
  }
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    ensureAudio();
    if (mode === "title" || mode === "over") { startRun(); return; }
    pointer.active = true;
    pointer.x = pointerAt(e);
  });
  canvas.addEventListener("pointermove", function (e) { if (pointer.active) { pointer.x = pointerAt(e); } });
  function release() { pointer.active = false; }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // ---- run lifecycle ------------------------------------------------------
  function startRun() {
    if (busy) { return; }
    busy = true;
    notice = "";
    if (!canScore) {
      seed = (Date.now() >>> 0);
      begin();
      busy = false;
      return;
    }
    window.community.call("start", {}).then(function (result) {
      seed = (result && result.seed) >>> 0;
      begin();
    }).catch(function () {
      notice = "Could not reach the site. Playing unranked.";
      seed = (Date.now() >>> 0);
      begin();
    }).then(function () { busy = false; });
  }

  function begin() {
    run = createRun(seed);
    tape = [];
    lastResult = null;
    bits = []; rings = []; floats = [];
    comboHeard = 0;
    mode = "play";
    sfx("start");
  }

  function finish() {
    mode = "over";
    sfx("over");
    if (!canScore) { return; }
    busy = true;
    window.community.call("submit", { seed: seed, ticks: tape }).then(function (result) {
      if (!result) { return; }
      lastResult = result;
      board = result.board || board;
      best = result.best || best;
      if (result.rejected) { notice = "That run did not check out."; }
    }).catch(function () {
      notice = "Score could not be saved.";
    }).then(function () { busy = false; });
  }

  // ---- drawing ------------------------------------------------------------
  // Painted in surface coordinates, so the sky reaches every edge whatever
  // shape the frame is.
  function bg(t) {
    var sky = ctx.createLinearGradient(0, 0, 0, SH);
    sky.addColorStop(0, "#070a1c");
    sky.addColorStop(0.55, "#0a0718");
    sky.addColorStop(1, "#02030a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, SW, SH);

    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < nebulae.length; i++) {
      var n = nebulae[i];
      var y = (n.y + t * 0.22) % (SH + n.r * 2) - n.r;
      var g = ctx.createRadialGradient(n.x, y, 0, n.x, y, n.r);
      g.addColorStop(0, "hsla(" + n.h + ",90%,62%," + n.a + ")");
      g.addColorStop(1, "hsla(" + n.h + ",90%,50%,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, SW, SH);
    }
    ctx.globalCompositeOperation = "source-over";

    for (var s = 0; s < stars.length; s++) {
      var st = stars[s];
      st.y += st.z * 0.9;
      if (st.y > SH) { st.y = -2; st.x = Math.random() * SW; }
      var tw = 0.55 + Math.sin(t * 0.08 + st.tw) * 0.45;
      ctx.globalAlpha = Math.min(1, (0.25 + st.z * 0.4) * tw);
      ctx.fillStyle = st.z > 1.3 ? "#cfe4ff" : "#8ea6d8";
      ctx.fillRect(st.x, st.y, st.z > 1.2 ? 2 : 1.4, st.z > 1.2 ? 2.6 : 1.6);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Where the walls are.
   *
   * With the sky running edge to edge there is nothing else to say where the
   * ship stops, and the field's sides are a real boundary in the simulation. The
   * area outside is dimmed and the field is outlined, so what is in play is
   * legible without the picture going back to being a card on a black mat.
   */
  function fieldEdges() {
    var fx = offX;
    var fy = offY;
    var fw = VW * scale;
    var fh = VH * scale;

    ctx.fillStyle = "rgba(2,3,10,.5)";
    if (fx > 0.5) {
      ctx.fillRect(0, 0, fx, SH);
      ctx.fillRect(fx + fw, 0, SW - fx - fw, SH);
    }
    if (fy > 0.5) {
      ctx.fillRect(0, 0, SW, fy);
      ctx.fillRect(0, fy + fh, SW, SH - fy - fh);
    }

    var edge = ctx.createLinearGradient(fx, 0, fx + fw, 0);
    edge.addColorStop(0, "rgba(120,180,255,.30)");
    edge.addColorStop(0.5, "rgba(120,180,255,.06)");
    edge.addColorStop(1, "rgba(120,180,255,.30)");
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
  }

  function ship(x, y, invuln, t) {
    ctx.save();
    ctx.translate(x, y);

    var flame = 10 + Math.sin(t * 0.9) * 3 + Math.random() * 3;
    var fg = ctx.createLinearGradient(0, 8, 0, 8 + flame);
    fg.addColorStop(0, "rgba(180,240,255,.95)");
    fg.addColorStop(0.4, "rgba(90,170,255,.75)");
    fg.addColorStop(1, "rgba(60,90,255,0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-5, 8); ctx.lineTo(5, 8); ctx.lineTo(0, 8 + flame); ctx.closePath();
    ctx.fill();

    if (invuln > 0 && Math.floor(t * 0.6) % 2 === 0) { ctx.globalAlpha = 0.45; }

    ctx.shadowColor = "rgba(120,200,255,.9)";
    ctx.shadowBlur = 16;
    var body = ctx.createLinearGradient(0, -16, 0, 12);
    body.addColorStop(0, "#eaf6ff");
    body.addColorStop(0.5, "#7fb4ff");
    body.addColorStop(1, "#2b4f9e");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(6, -2); ctx.lineTo(14, 6); ctx.lineTo(5, 4); ctx.lineTo(3, 10);
    ctx.lineTo(-3, 10); ctx.lineTo(-5, 4); ctx.lineTo(-14, 6); ctx.lineTo(-6, -2);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(180,245,255,.95)";
    ctx.beginPath(); ctx.ellipse(0, -4, 2.4, 4.6, 0, 0, 6.28); ctx.fill();

    if (invuln > 0) {
      ctx.strokeStyle = "rgba(140,220,255," + (0.25 + 0.2 * Math.sin(t * 0.5)) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, -2, 20, 0, 6.28); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function foeArt(foe, t) {
    var spec = CONFIG.KINDS[foe.kind];
    ctx.save();
    ctx.translate(foe.x, foe.y);
    var flashing = foe.hit > 0;

    if (foe.kind === "drone") {
      ctx.rotate(t * 0.05);
      ctx.shadowColor = "rgba(255,120,90,.8)"; ctx.shadowBlur = 12;
      ctx.fillStyle = flashing ? "#fff" : "#ff6a4d";
      ctx.beginPath();
      ctx.moveTo(0, -spec.r); ctx.lineTo(spec.r * 0.8, 0); ctx.lineTo(0, spec.r); ctx.lineTo(-spec.r * 0.8, 0);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,230,180,.9)";
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, 6.28); ctx.fill();
    } else if (foe.kind === "wasp") {
      ctx.shadowColor = "rgba(255,220,80,.8)"; ctx.shadowBlur = 12;
      ctx.fillStyle = flashing ? "#fff" : "#ffc93c";
      ctx.beginPath();
      ctx.moveTo(0, spec.r); ctx.lineTo(spec.r, -spec.r * 0.5); ctx.lineTo(spec.r * 0.35, -spec.r);
      ctx.lineTo(-spec.r * 0.35, -spec.r); ctx.lineTo(-spec.r, -spec.r * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(90,20,10,.85)";
      ctx.fillRect(-spec.r * 0.5, -2, spec.r, 3);
    } else if (foe.kind === "hulk") {
      ctx.shadowColor = "rgba(190,110,255,.85)"; ctx.shadowBlur = 16;
      var hg = ctx.createLinearGradient(0, -spec.r, 0, spec.r);
      hg.addColorStop(0, flashing ? "#fff" : "#d9a6ff");
      hg.addColorStop(1, flashing ? "#fff" : "#5a2a94");
      ctx.fillStyle = hg;
      ctx.beginPath();
      for (var i = 0; i < 6; i++) {
        var a = (Math.PI / 3) * i - Math.PI / 2;
        var px = Math.cos(a) * spec.r, py = Math.sin(a) * spec.r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,230,255,.55)"; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.fillStyle = "rgba(255,120,255," + (0.6 + 0.35 * Math.sin(t * 0.3)) + ")";
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, 6.28); ctx.fill();
    } else {
      var pulse = 0.5 + 0.5 * Math.sin(t * 0.16);
      ctx.shadowColor = "rgba(255,60,120,.9)"; ctx.shadowBlur = 26;
      var bgd = ctx.createLinearGradient(0, -spec.r, 0, spec.r);
      bgd.addColorStop(0, flashing ? "#fff" : "#ff8fb0");
      bgd.addColorStop(0.6, flashing ? "#fff" : "#b0184f");
      bgd.addColorStop(1, "#3a0620");
      ctx.fillStyle = bgd;
      ctx.beginPath();
      ctx.moveTo(0, spec.r);
      ctx.lineTo(spec.r, spec.r * 0.25); ctx.lineTo(spec.r * 0.72, -spec.r * 0.7);
      ctx.lineTo(-spec.r * 0.72, -spec.r * 0.7); ctx.lineTo(-spec.r, spec.r * 0.25);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(60,10,30,.9)";
      ctx.fillRect(-spec.r * 0.8, -spec.r * 0.72, spec.r * 1.6, 8);
      ctx.fillStyle = "rgba(255,240,160," + (0.5 + pulse * 0.5) + ")";
      ctx.beginPath(); ctx.arc(0, 2, 10 + pulse * 3, 0, 6.28); ctx.fill();
      for (var g = -1; g <= 1; g += 2) {
        ctx.fillStyle = "#7d0f38";
        ctx.fillRect(g * spec.r * 0.62 - 4, spec.r * 0.1, 8, 14);
      }
    }
    ctx.restore();
  }

  function hud(t) {
    ctx.save();
    ctx.fillStyle = "rgba(4,6,18,.55)";
    ctx.fillRect(0, 0, VW, 42);
    ctx.strokeStyle = "rgba(120,180,255,.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 42.5); ctx.lineTo(VW, 42.5); ctx.stroke();

    ctx.font = "700 20px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#e8f2ff";
    ctx.textAlign = "left";
    ctx.fillText(String(run.score).padStart(7, "0"), 12, 28);

    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(160,190,235,.85)";
    ctx.textAlign = "center";
    ctx.fillText("WAVE " + Math.max(1, run.wave), VW / 2, 27);

    ctx.textAlign = "right";
    for (var i = 0; i < Math.min(run.lives, 6); i++) {
      var lx = VW - 14 - i * 15;
      ctx.fillStyle = "#7fb4ff";
      ctx.beginPath();
      ctx.moveTo(lx, 14); ctx.lineTo(lx + 5, 26); ctx.lineTo(lx - 5, 26);
      ctx.closePath(); ctx.fill();
    }

    if (run.combo > 0) {
      ctx.textAlign = "left";
      ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "hsl(" + (50 - run.combo * 8) + ",100%,65%)";
      ctx.fillText("x" + (run.combo + 1), 12, 40);
    }
    if (run.power > 1) {
      ctx.textAlign = "center";
      ctx.font = "700 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(150,255,220,.9)";
      ctx.fillText("POWER " + run.power, VW / 2, 39);
    }
    if (muted) {
      ctx.textAlign = "right";
      ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(150,180,225,.6)";
      ctx.fillText("MUTED", VW - 12, 39);
    }

    var boss = null;
    for (var b = 0; b < run.foes.length; b++) { if (run.foes[b].kind === "boss") { boss = run.foes[b]; } }
    if (boss) {
      var w = VW - 40;
      ctx.fillStyle = "rgba(255,255,255,.12)";
      ctx.fillRect(20, 50, w, 6);
      var pct = Math.max(0, boss.hp / boss.maxHp);
      var bar = ctx.createLinearGradient(20, 0, 20 + w, 0);
      bar.addColorStop(0, "#ff3b6b"); bar.addColorStop(1, "#ffb347");
      ctx.fillStyle = bar;
      ctx.fillRect(20, 50, w * pct, 6);
    }
    ctx.restore();
  }

  function panel(x, y, w, h) {
    ctx.fillStyle = "rgba(6,10,26,.82)";
    ctx.strokeStyle = "rgba(120,180,255,.25)";
    ctx.lineWidth = 1;
    var r = 12;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  function drawBoard(x, y, w) {
    ctx.textAlign = "left";
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(150,185,235,.7)";
    ctx.fillText("LEADERBOARD", x, y);
    if (!board.length) {
      ctx.fillStyle = "rgba(150,185,235,.5)";
      ctx.fillText("Nobody has flown yet.", x, y + 20);
      return;
    }
    for (var i = 0; i < Math.min(board.length, 6); i++) {
      var row = board[i];
      var ry = y + 20 + i * 17;
      ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = i === 0 ? "#ffd76a" : "rgba(225,236,255,.86)";
      ctx.textAlign = "left";
      ctx.fillText((i + 1) + ". " + row.name.slice(0, 14), x, ry);
      ctx.textAlign = "right";
      ctx.fillText(String(row.score), x + w, ry);
    }
  }

  function title(t) {
    ctx.textAlign = "center";
    var glow = 0.5 + 0.5 * Math.sin(t * 0.06);
    ctx.save();
    ctx.shadowColor = "rgba(120,180,255,.9)";
    ctx.shadowBlur = 24 + glow * 18;
    ctx.font = "800 46px ui-sans-serif, system-ui, sans-serif";
    var tg = ctx.createLinearGradient(0, 150, 0, 200);
    tg.addColorStop(0, "#ffffff"); tg.addColorStop(1, "#6fa8ff");
    ctx.fillStyle = tg;
    ctx.fillText("SKY RAID", VW / 2, 190);
    ctx.restore();

    ctx.font = "500 13px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(170,200,240,.8)";
    ctx.fillText("Hold the line. Every wave comes back harder.", VW / 2, 216);

    panel(30, 250, VW - 60, 148);
    drawBoard(48, 276, VW - 96);

    ctx.textAlign = "center";
    ctx.font = "700 15px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255," + (0.55 + glow * 0.45) + ")";
    ctx.fillText("PRESS SPACE  ·  OR TAP", VW / 2, 440);

    ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(150,180,225,.65)";
    ctx.fillText("\\u2190 \\u2192 or A D to steer   ·   SPACE to fire   ·   P to pause", VW / 2, 466);
    ctx.fillText("On touch: drag to fly, firing is automatic.   ·   M to mute", VW / 2, 484);

    if (best) {
      ctx.fillStyle = "rgba(255,215,106,.85)";
      ctx.font = "600 12px ui-monospace, monospace";
      ctx.fillText("YOUR BEST  " + best, VW / 2, 512);
    }
    if (notice) {
      ctx.fillStyle = "rgba(255,150,150,.9)";
      ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(notice, VW / 2, 534);
    }
  }

  function gameOver(t) {
    panel(30, 170, VW - 60, 300);
    ctx.textAlign = "center";
    ctx.font = "800 30px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#ff6b8a";
    ctx.fillText("RUN OVER", VW / 2, 214);

    ctx.font = "700 34px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#eaf3ff";
    ctx.fillText(String(run.score), VW / 2, 258);

    ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(170,200,240,.8)";
    ctx.fillText("Reached wave " + Math.max(1, run.wave), VW / 2, 280);

    if (busy) {
      ctx.fillStyle = "rgba(150,190,255,.75)";
      ctx.fillText("Checking the run\\u2026", VW / 2, 302);
    } else if (lastResult && lastResult.rank) {
      ctx.fillStyle = "#ffd76a";
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("Ranked #" + lastResult.rank + (lastResult.record ? "  ·  new personal best" : ""), VW / 2, 303);
    } else if (!canScore) {
      ctx.fillStyle = "rgba(170,200,240,.65)";
      ctx.fillText("Sign in to have your score counted.", VW / 2, 302);
    }

    drawBoard(48, 330, VW - 96);

    var glow = 0.5 + 0.5 * Math.sin(t * 0.08);
    ctx.textAlign = "center";
    ctx.font = "700 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255," + (0.5 + glow * 0.5) + ")";
    ctx.fillText("PRESS SPACE TO FLY AGAIN", VW / 2, 452);

    if (notice) {
      ctx.fillStyle = "rgba(255,150,150,.9)";
      ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(notice, VW / 2, 492);
    }
  }

  function drawEffects() {
    ctx.globalCompositeOperation = "lighter";
    for (var i = bits.length - 1; i >= 0; i--) {
      var b = bits[i];
      b.age++; b.x += b.vx; b.y += b.vy; b.vx *= 0.965; b.vy = b.vy * 0.965 + 0.03;
      if (b.age > b.life) { bits.splice(i, 1); continue; }
      var k = 1 - b.age / b.life;
      ctx.fillStyle = "hsla(" + b.hue + ",100%," + (55 + k * 35) + "%," + k + ")";
      ctx.fillRect(b.x - b.size / 2, b.y - b.size / 2, b.size, b.size);
    }
    for (var r = rings.length - 1; r >= 0; r--) {
      var g = rings[r];
      g.age++;
      if (g.age > g.life) { rings.splice(r, 1); continue; }
      var p = g.age / g.life;
      ctx.strokeStyle = "hsla(" + g.hue + ",100%,70%," + (1 - p) * 0.8 + ")";
      ctx.lineWidth = 3 * (1 - p) + 0.5;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r + p * g.r * 2.4, 0, 6.28); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    for (var f = floats.length - 1; f >= 0; f--) {
      var ft = floats[f];
      ft.age++;
      if (ft.age > ft.life) { floats.splice(f, 1); continue; }
      var fp = ft.age / ft.life;
      ctx.textAlign = "center";
      ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "hsla(" + ft.hue + ",100%,72%," + (1 - fp) + ")";
      ctx.fillText(ft.text, ft.x, ft.y - fp * 26);
    }
  }

  function consume() {
    for (var i = 0; i < run.events.length; i++) {
      var e = run.events[i];
      if (e.t === "boom") {
        spark(e.x, e.y, e.boss ? 90 : 18, e.boss ? 340 : 20, e.boss ? 2.2 : 1);
        ring(e.x, e.y, e.r, e.boss ? 340 : 30);
        shake = Math.min(14, shake + (e.boss ? 12 : 2.4));
        if (e.boss) { flash = 0.55; }
        sfx(e.boss ? "bossboom" : "boom");
      } else if (e.t === "spark") {
        spark(e.x, e.y, 3, 190, 0.6);
        sfx("spark");
      } else if (e.t === "shot") {
        sfx("shot");
      } else if (e.t === "flak") {
        sfx("flak");
      } else if (e.t === "hurt") {
        spark(e.x, e.y, 44, 200, 1.9);
        ring(e.x, e.y, 16, 200);
        shake = 13; flash = 0.4;
        sfx("hurt");
      } else if (e.t === "pickup") {
        floatText(e.x, e.y, e.kind === "life" ? "+1 LIFE" : "POWER UP", e.kind === "life" ? 140 : 165);
        spark(e.x, e.y, 16, 160, 0.9);
        sfx(e.kind === "life" ? "life" : "power");
      } else if (e.t === "wave") {
        waveLabel = e.n % CONFIG.BOSS_EVERY === 0 ? "WARLORD INBOUND" : "WAVE " + e.n;
        waveBanner = 96;
        sfx(e.n % CONFIG.BOSS_EVERY === 0 ? "warlord" : "wave");
      }
    }

    // The streak has no event of its own — it is a number that goes up — so the
    // sound follows the number rather than asking the simulation for a new one.
    if (run.combo > comboHeard) { sfx("combo", run.combo); }
    comboHeard = run.combo;
  }

  function banner() {
    if (waveBanner <= 0) { return; }
    waveBanner--;
    var p = waveBanner / 96;
    var a = p > 0.75 ? (1 - p) * 4 : p < 0.25 ? p * 4 : 1;
    ctx.save();
    ctx.textAlign = "center";
    ctx.globalAlpha = a;
    ctx.shadowColor = "rgba(255,120,160,.8)"; ctx.shadowBlur = 18;
    ctx.font = "800 26px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = waveLabel.indexOf("WARLORD") === 0 ? "#ff8fb0" : "#dbe8ff";
    ctx.fillText(waveLabel, VW / 2, VH / 2 - 40);
    ctx.restore();
  }

  // ---- loop ---------------------------------------------------------------
  var acc = 0;
  var last = 0;
  var STEP = 1000 / 60;
  var tick = 0;

  function frame(now) {
    if (!last) { last = now; }
    acc += Math.min(now - last, 250);
    last = now;
    tick++;

    while (acc >= STEP) {
      acc -= STEP;
      if (mode === "play") {
        var mask = currentMask();
        pushTick(mask);
        stepRun(run, mask);
        consume();
        if (run.over) { finish(); break; }
      }
    }

    ctx.save();
    if (shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.86;
    }

    // Surface space: the sky, edge to edge.
    bg(tick);

    // Field space: everything the simulation knows about, in its own units, so
    // the drawing code below is unchanged whatever size the frame is.
    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    if (run && (mode === "play" || mode === "paused" || mode === "over")) {
      ctx.globalCompositeOperation = "lighter";
      for (var s = 0; s < run.shots.length; s++) {
        var sh = run.shots[s];
        var sg = ctx.createLinearGradient(sh.x, sh.y - 12, sh.x, sh.y + 6);
        sg.addColorStop(0, "rgba(190,255,255,0)");
        sg.addColorStop(0.5, "rgba(150,240,255,.95)");
        sg.addColorStop(1, "rgba(60,140,255,0)");
        ctx.fillStyle = sg;
        ctx.fillRect(sh.x - 2, sh.y - 12, 4, 18);
      }
      for (var k = 0; k < run.flak.length; k++) {
        var fl = run.flak[k];
        var fgd = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, 9);
        fgd.addColorStop(0, "rgba(255,255,255,.95)");
        fgd.addColorStop(0.4, "rgba(255,90,200,.85)");
        fgd.addColorStop(1, "rgba(255,40,160,0)");
        ctx.fillStyle = fgd;
        ctx.beginPath(); ctx.arc(fl.x, fl.y, 9, 0, 6.28); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      for (var d = 0; d < run.drops.length; d++) {
        var dp = run.drops[d];
        var hue = dp.kind === "life" ? 140 : 172;
        ctx.save();
        ctx.translate(dp.x, dp.y);
        ctx.rotate(tick * 0.04);
        ctx.shadowColor = "hsla(" + hue + ",100%,70%,.9)"; ctx.shadowBlur = 14;
        ctx.fillStyle = "hsl(" + hue + ",95%,62%)";
        ctx.fillRect(-7, -7, 14, 14);
        ctx.restore();
        ctx.fillStyle = "#04101a";
        ctx.textAlign = "center";
        ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(dp.kind === "life" ? "+" : "P", dp.x, dp.y + 3.5);
      }

      for (var f2 = 0; f2 < run.foes.length; f2++) { foeArt(run.foes[f2], tick); }
      if (run.respawn === 0 && !run.over) { ship(run.px, CONFIG.PLAYER_Y, run.invuln, tick); }
      drawEffects();
      hud(tick);
      banner();
    }

    if (mode === "title") { title(tick); }
    if (mode === "over") { gameOver(tick); }
    if (mode === "paused") {
      ctx.fillStyle = "rgba(3,5,15,.6)";
      ctx.fillRect(0, 0, VW, VH);
      ctx.textAlign = "center";
      ctx.font = "800 26px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#dbe8ff";
      ctx.fillText("PAUSED", VW / 2, VH / 2);
      ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(170,200,240,.75)";
      ctx.fillText("P to resume", VW / 2, VH / 2 + 24);
    }

    ctx.restore();

    // Back in surface space for everything that belongs to the screen rather
    // than to the game: the walls, the hit flash, and the light the whole
    // picture sits inside.
    fieldEdges();

    if (flash > 0.01) {
      ctx.fillStyle = "rgba(255,235,245," + flash + ")";
      ctx.fillRect(0, 0, SW, SH);
      flash *= 0.82;
    }

    var vg = ctx.createRadialGradient(SW / 2, SH / 2, Math.min(SW, SH) * 0.34, SW / 2, SH / 2, Math.max(SW, SH) * 0.72);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, SW, SH);

    ctx.restore();
    window.requestAnimationFrame(frame);
  }

  window.requestAnimationFrame(frame);
})();
`;

export async function webview(ctx, api) {
  const board = await readBoard(api);
  const best = (await api.kv.get("best")) ?? 0;

  const boot = {
    board,
    best,
    canScore: Boolean(ctx.user),
    notice: ctx.user ? "" : "Playing as a guest — scores are not saved.",
  };

  return {
    html: PAGE_HTML,
    css: PAGE_CSS,
    js: [
      "window.__SKY_RAID__ = " + JSON.stringify(boot) + ";",
      simulationSource(),
      PAGE_JS,
    ].join("\n"),
  };
}

export async function onMessage(ctx, api) {
  if (!ctx.user) {
    return { blocks: null, state: null, effects: [], result: { error: "anonymous" } };
  }

  const method = ctx.method;
  const params = ctx.params ?? {};

  if (method === "start") {
    // A run number that only ever goes up, so no two runs by the same player are
    // ever handed the same seed — and a replay can only be spent once.
    const runNo = ((await api.kv.get("runs")) ?? 0) + 1;
    const seed = seedFor(ctx.user.id, runNo, ctx.install_id);

    return {
      blocks: null,
      state: null,
      effects: [
        { type: "kv.set", key: "runs", value: runNo },
        { type: "kv.set", key: "open", value: { seed, runNo } },
      ],
      result: { seed },
    };
  }

  if (method === "submit") {
    const open = await api.kv.get("open");
    const seed = params.seed >>> 0;

    // The seed has to be one this handler issued and has not already settled.
    if (!open || (open.seed >>> 0) !== seed) {
      return { blocks: null, state: null, effects: [], result: { rejected: true } };
    }

    const outcome = replay(seed, params.ticks);
    if (!outcome) {
      return {
        blocks: null,
        state: null,
        effects: [{ type: "kv.delete", key: "open" }],
        result: { rejected: true },
      };
    }

    const best = (await api.kv.get("best")) ?? 0;
    const record = outcome.score > best;
    const board = placeOnBoard(await readBoard(api), ctx.user.username, outcome.score, outcome.wave);
    const rank = board.findIndex((row) => row.name === ctx.user.username) + 1;

    const effects = [
      { type: "kv.delete", key: "open" },
      { type: "kv.shared.set", key: BOARD_KEY, value: board },
    ];
    if (record) {
      effects.push({ type: "kv.set", key: "best", value: outcome.score });
    }

    return {
      blocks: null,
      state: null,
      effects,
      result: {
        // The score the page is told is the one this handler computed, not the
        // one it was sent. They are the same only for an honest run.
        score: outcome.score,
        wave: outcome.wave,
        best: record ? outcome.score : best,
        record,
        rank: rank > 0 ? rank : null,
        board,
      },
    };
  }

  return { blocks: null, state: null, effects: [], result: { error: "unknown_method" } };
}

/**
 * What the site shows if the webview surface is ever unavailable. An arcade
 * cabinet with the power off should still say whose high scores are on it.
 */
export async function render(ctx, api) {
  const board = await readBoard(api);
  const rows = board.slice(0, 5).map((row, i) => ({
    type: "text",
    value: `${i + 1}. ${row.name} — ${row.score}`,
    size: "small",
  }));

  return {
    blocks: {
      type: "vstack",
      gap: "small",
      padding: "medium",
      align: "center",
      children: [
        { type: "text", value: "Sky raid", weight: "bold", size: "large" },
        {
          type: "text",
          value: "This game draws its own screen, which this site has turned off.",
          align: "center",
        },
        { type: "divider" },
        { type: "text", value: "Leaderboard", weight: "medium" },
        ...(rows.length ? rows : [{ type: "text", value: "Nobody has flown yet.", size: "small" }]),
      ],
    },
    state: {},
    effects: [],
  };
}
