/**
 * 星球探索 — 用能量驱动的宇宙收集游戏。
 *
 * 页面只负责画：星空、动画、图鉴。每一个结果——发现了什么、扣了多少燃料、
 * 谁是首位发现者——都由这里的 handler 在服务端沙箱里决定，页面说什么都不算数。
 *
 * 能量与游戏的边界只有一条：补给。玩家用一次平台确认的 points.spend 把能量
 * 换成燃料（1:1），之后的每次探索烧的都是燃料——这既保住了「普通探索点击直接
 * 执行」的流畅循环，也让每一分能量的离开都经过玩家自己按下的确认框。
 * 游戏从不向外发能量：产出只有图鉴、星尘和荣誉。
 */

import { RARITY, SECTORS, CELESTIALS, EVENTS, ACHIEVEMENTS, SHIP, ECON } from "./data.js";

// ---------------------------------------------------------------------------
// 服务端：状态与规则
// ---------------------------------------------------------------------------

const GAME_KEY = "g";

function freshGame() {
  return {
    f: ECON.STARTER_FUEL, // 燃料
    d: 0, // 星尘
    s: 1, // 飞船等级
    seen: {}, // id -> [次数, 首见毫秒]
    ex: 0, // 总探索次数
    wex: [0, 0], // [周序号, 本周探索次数] —— 排行榜用
    day: null, // { k: "2026-9-1", n: 次数, r: 已发奖 }
    pe: null, // 待抉择事件 { k }
    ref: {}, // 已入账的补给 request_id -> 1
    ach: {}, // 已获成就 key -> 1
    snd: 1, // 音效开关
  };
}

async function loadGame(api) {
  const stored = await api.kv.get(GAME_KEY);
  return stored ? Object.assign(freshGame(), stored) : freshGame();
}

function weekNo(now) {
  return Math.floor((now + 3 * 86400000) / (7 * 86400000)); // 周一为界
}

function dayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();
}

function pickWeighted(pool, weightOf) {
  if (!pool.length) return null;
  const total = pool.reduce((sum, item) => sum + weightOf(item), 0);
  let roll = Math.random() * total;
  for (const item of pool) {
    roll -= weightOf(item);
    if (roll < 0) return item;
  }
  return pool[pool.length - 1];
}

function celestialWeight(c) {
  return c.w ?? RARITY[c.r].w;
}

/** 发现结果里发给页面的完整天体资料——只有确实发现了才会出现在网络上。 */
function celestialView(c, firsts, seen) {
  const record = seen[c.id];
  const first = firsts[c.id];
  return {
    id: c.id,
    sec: c.sec,
    r: c.r,
    t: c.t,
    name: c.name,
    env: c.env,
    dist: c.dist,
    art: c.art,
    desc: c.desc,
    lore: c.lore,
    n: record ? record[0] : 0,
    at: record ? record[1] : null,
    first: first ? { u: first.u, at: first.at } : null,
  };
}

function discoveredViews(g, firsts) {
  return CELESTIALS.filter((c) => g.seen[c.id]).map((c) => celestialView(c, firsts, g.seen));
}

/** 页面开局就能拿到的目录：位置和稀有度可以知道，名字必须自己去发现。 */
function silhouettes() {
  return CELESTIALS.map((c) => ({ id: c.id, sec: c.sec, r: c.r }));
}

async function readShared(api, key, fallback) {
  const rows = await api.kv.listPublic();
  const row = (rows ?? []).find((entry) => entry.key === key);
  return row ? row.value : fallback;
}

/** 排行榜：三张榜各保留前 N。读-改-写按当前值合并，并发丢一次更新是可接受的demo折衷。 */
function placeOnBoard(list, username, value) {
  const rows = (list ?? []).filter((row) => row.u !== username);
  rows.push({ u: username, n: value });
  rows.sort((a, b) => b.n - a.n);
  return rows.slice(0, ECON.BOARD_KEEP);
}

function summarize(g, balance, firsts) {
  return {
    fuel: g.f,
    dust: g.d,
    ship: g.s,
    shipName: SHIP[g.s - 1].name,
    explores: g.ex,
    balance,
    sound: Boolean(g.snd),
    pendingEvent: g.pe ? eventView(g.pe.k) : null,
    day: { n: g.day?.n ?? 0, target: ECON.DAILY_TARGET, done: Boolean(g.day?.r), dust: ECON.DAILY_DUST },
    seenCount: Object.keys(g.seen).length,
    total: CELESTIALS.length,
    ach: Object.keys(g.ach),
    firstsCount: Object.values(firsts).length,
  };
}

function eventView(key) {
  const ev = EVENTS.find((entry) => entry.key === key);
  if (!ev) return null;
  return {
    key: ev.key,
    title: ev.title,
    body: ev.body,
    dist: ev.dist,
    opts: ev.opts.map((o) => ({ key: o.key, label: o.label, sub: o.sub, fuel: o.fuel })),
  };
}

/** 成就检查。返回本次新获得的成就展示信息。 */
function grantAchievements(g, extras) {
  const seenCount = Object.keys(g.seen).length;
  const ratio = seenCount / CELESTIALS.length;
  const earned = {
    first_flight: g.ex >= 1,
    ten_species: seenCount >= 10,
    deep_traveler: g.ex >= 100,
    first_contact: extras.foundCiv || CELESTIALS.some((c) => c.t === "civ" && g.seen[c.id]),
    event_horizon: extras.inWormhole || Boolean(g.ach.event_horizon),
    collector: ratio >= 0.5,
    cosmos: ratio >= 1,
  };

  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (earned[a.key] && !g.ach[a.key]) {
      g.ach[a.key] = 1;
      fresh.push({ icon: a.icon, name: a.name, desc: a.desc });
    }
  }
  return fresh;
}

/** 每日任务记账。跨天自动换页；达标那一次发星尘。 */
function tickDaily(g, now) {
  const key = dayKey(now);
  if (!g.day || g.day.k !== key) g.day = { k: key, n: 0, r: false };
  g.day.n += 1;

  let reward = 0;
  if (!g.day.r && g.day.n >= ECON.DAILY_TARGET) {
    g.day.r = true;
    reward = ECON.DAILY_DUST;
    g.d += reward;
  }
  return reward;
}

/** 把一次天体发现落进游戏状态，返回发给页面的结果块。 */
function applyFind(g, celestial, firsts, recent, username, now) {
  const known = g.seen[celestial.id];
  const fresh = !known;
  let dust = 0;
  let first = false;

  if (fresh) {
    g.seen[celestial.id] = [1, now];
    if (!firsts[celestial.id]) {
      firsts[celestial.id] = { u: username, at: now };
      first = true;
    }
  } else {
    known[0] += 1;
    dust = RARITY[celestial.r].dust;
    g.d += dust;
  }

  recent.unshift({ u: username, c: celestial.id, name: celestial.name, r: celestial.r, first, at: now });
  recent.length = Math.min(recent.length, ECON.RECENT_KEEP);

  return { kind: "find", celestial: celestialView(celestial, firsts, g.seen), fresh, first, dust };
}

function sharedEffects(firsts, recent, boards) {
  return [
    { type: "kv.shared.set", key: "firsts", value: firsts },
    { type: "kv.shared.set", key: "recent", value: recent },
    { type: "kv.shared.set", key: "boards", value: boards },
  ];
}

function saveEffects(g) {
  return [{ type: "kv.set", key: GAME_KEY, value: g }];
}

function reply(result, effects = []) {
  return { blocks: null, state: null, effects, result };
}

// ---------------------------------------------------------------------------
// onMessage：页面的每一个请求
// ---------------------------------------------------------------------------

export async function onMessage(ctx, api) {
  if (!ctx.user) return reply({ error: "anonymous" });

  const method = ctx.method;
  const params = ctx.params ?? {};
  const now = Date.now();
  const g = await loadGame(api);
  const firsts = await readShared(api, "firsts", {});

  if (method === "sync") {
    // 对账：确认过却因故没入账的补给，在这里补上。发货按 request_id 幂等。
    const effects = [];
    const spends = (await api.points.spends()) ?? [];
    let credited = 0;
    for (const spend of spends) {
      if (spend.status === "paid" && spend.request_id.indexOf("fuel-") === 0 && !g.ref[spend.request_id]) {
        g.ref[spend.request_id] = 1;
        g.f += ECON.REFUEL_FUEL;
        credited += ECON.REFUEL_FUEL;
      }
    }
    trimRefs(g);
    if (credited > 0) effects.push(...saveEffects(g));

    const balance = (await api.points.balance()) ?? 0;
    return reply(
      {
        me: summarize(g, balance, firsts),
        sectors: SECTORS,
        catalogue: silhouettes(),
        discovered: discoveredViews(g, firsts),
        recent: await readShared(api, "recent", []),
        boards: await readShared(api, "boards", { wk: 0, ex: [], co: [], fd: [] }),
        econ: { refuelEnergy: ECON.REFUEL_ENERGY, refuelFuel: ECON.REFUEL_FUEL },
        ship: SHIP,
        achievements: ACHIEVEMENTS,
        credited,
      },
      effects,
    );
  }

  if (method === "explore") {
    const sector = SECTORS.find((s) => s.id === params.sector);
    if (!sector) return reply({ error: "bad_sector" });
    if (g.s < sector.ship) return reply({ error: "ship_too_low", need: sector.ship });
    if (g.pe) return reply({ error: "pending_event", event: eventView(g.pe.k) });
    if (g.f < sector.fuel) return reply({ error: "no_fuel", need: sector.fuel, fuel: g.f });

    g.f -= sector.fuel;
    g.ex += 1;

    const wk = weekNo(now);
    if (g.wex[0] !== wk) g.wex = [wk, 0];
    g.wex[1] += 1;

    const dailyDust = tickDaily(g, now);

    const recent = await readShared(api, "recent", []);
    let outcome;
    const eligible = EVENTS.filter((ev) => ev.sec === null || ev.sec === sector.id);
    if (eligible.length && Math.random() * 100 < ECON.EVENT_CHANCE) {
      const ev = pickWeighted(eligible, (entry) => entry.w);
      g.pe = { k: ev.key, sec: sector.id };
      outcome = { kind: "event", event: eventView(ev.key) };
    } else {
      const pool = CELESTIALS.filter((c) => c.sec === sector.id);
      const found = pickWeighted(pool, celestialWeight);
      outcome = applyFind(g, found, firsts, recent, ctx.user.username, now);
      outcome.foundCiv = found.t === "civ";
    }

    const toasts = grantAchievements(g, {
      foundCiv: Boolean(outcome.foundCiv),
      inWormhole: sector.key === "wormhole",
    });

    const boards = await refreshBoards(api, g, firsts, ctx.user.username, wk);

    return reply(
      {
        ...outcome,
        fuel: g.f,
        dust: g.d,
        seenCount: Object.keys(g.seen).length,
        dailyDust,
        day: { n: g.day.n, target: ECON.DAILY_TARGET, done: g.day.r },
        toasts,
        recent,
      },
      [...saveEffects(g), ...sharedEffects(firsts, recent, boards)],
    );
  }

  if (method === "resolveEvent") {
    if (!g.pe) return reply({ error: "no_event" });
    const ev = EVENTS.find((entry) => entry.key === g.pe.k);
    const opt = ev?.opts.find((o) => o.key === params.choice);
    if (!opt) return reply({ error: "bad_choice" });
    if (g.f < opt.fuel) return reply({ error: "no_fuel", need: opt.fuel, fuel: g.f });

    g.f -= opt.fuel;
    const sectorId = g.pe.sec;
    g.pe = null;

    const rolled = pickWeighted(opt.results, (r) => r.w) ?? { t: "nothing", text: "" };
    const recent = await readShared(api, "recent", []);
    const outcome = { kind: "eventResult", text: rolled.text, t: rolled.t };

    if (rolled.t === "dust") {
      g.d += rolled.amount;
      outcome.dust = rolled.amount;
    } else if (rolled.t === "damage") {
      const loss = Math.min(rolled.amount, g.d);
      g.d -= loss;
      outcome.loss = loss;
    } else if (rolled.t === "find") {
      const pool = CELESTIALS.filter((c) => c.sec === sectorId && c.r === rolled.r);
      const found = pool.length ? pickWeighted(pool, celestialWeight) : null;
      if (found) {
        outcome.found = applyFind(g, found, firsts, recent, ctx.user.username, now);
      } else {
        const dust = RARITY[rolled.r].dust;
        g.d += dust;
        outcome.t = "dust";
        outcome.dust = dust;
      }
    }

    const toasts = grantAchievements(g, {
      foundCiv: outcome.found?.celestial.t === "civ",
      inWormhole: false,
    });
    const boards = await refreshBoards(api, g, firsts, ctx.user.username, weekNo(now));

    return reply(
      { ...outcome, fuel: g.f, dust: g.d, seenCount: Object.keys(g.seen).length, toasts, recent },
      [...saveEffects(g), ...sharedEffects(firsts, recent, boards)],
    );
  }

  if (method === "refuel") {
    // 唯一一处能量出口。真正的扣费由平台的确认框决定——这里只是提出请求。
    const requestId = "fuel-" + now + "-" + Math.floor(Math.random() * 1e6);
    return reply({ asked: true }, [
      {
        type: "points.spend",
        request_id: requestId,
        amount: ECON.REFUEL_ENERGY,
        label: "燃料补给 +" + ECON.REFUEL_FUEL,
      },
    ]);
  }

  if (method === "upgrade") {
    const next = SHIP[g.s]; // 下一级即下标 g.s
    if (!next) return reply({ error: "max_level" });
    if (g.f < next.fuel) return reply({ error: "no_fuel", need: next.fuel, fuel: g.f });
    if (g.d < next.dust) return reply({ error: "no_dust", need: next.dust, dust: g.d });

    g.f -= next.fuel;
    g.d -= next.dust;
    g.s = next.lv;

    return reply({ ship: g.s, shipName: next.name, fuel: g.f, dust: g.d }, saveEffects(g));
  }

  if (method === "toggleSound") {
    g.snd = g.snd ? 0 : 1;
    return reply({ sound: Boolean(g.snd) }, saveEffects(g));
  }

  return reply({ error: "unknown_method" });
}

/** 补给对账表只保留最近几笔，防止无限增长。 */
function trimRefs(g) {
  const ids = Object.keys(g.ref);
  if (ids.length > 8) {
    ids.sort();
    for (const id of ids.slice(0, ids.length - 8)) delete g.ref[id];
  }
}

async function refreshBoards(api, g, firsts, username, wk) {
  const boards = await readShared(api, "boards", { wk, ex: [], co: [], fd: [] });
  if (boards.wk !== wk) {
    boards.wk = wk;
    boards.ex = []; // 探索者榜每周清零；收藏与发现是长期荣誉
  }
  boards.ex = placeOnBoard(boards.ex, username, g.wex[1]);
  boards.co = placeOnBoard(boards.co, username, Object.keys(g.seen).length);
  const rareFinds = Object.keys(g.seen).filter((id) => {
    const c = CELESTIALS.find((entry) => entry.id === Number(id));
    return c && c.r >= 1;
  }).length;
  boards.fd = placeOnBoard(boards.fd, username, rareFinds);
  return boards;
}

// ---------------------------------------------------------------------------
// onSpend：一笔补给被玩家亲手确认了
// ---------------------------------------------------------------------------

export async function onSpend(ctx, api) {
  const spend = ctx.spend ?? {};
  const g = await loadGame(api);

  // 发货按 request_id 幂等：同一笔确认无论送达多少次，燃料只加一次。
  if (spend.status === "paid" && spend.request_id && !g.ref[spend.request_id]) {
    g.ref[spend.request_id] = 1;
    g.f += ECON.REFUEL_FUEL;
    trimRefs(g);
    return { blocks: null, state: null, effects: saveEffects(g) };
  }

  return { blocks: null, state: null, effects: [] };
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: #05070f; color: #cfd6e4; overflow: hidden;
  font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
#app { position: relative; height: 100%; display: flex; flex-direction: column; overflow: hidden; }

/* —— 星空底 —— */
#space { position: absolute; inset: 0; overflow: hidden;
  background: radial-gradient(120% 90% at 70% -10%, #101a33 0%, #05070f 55%),
              radial-gradient(80% 60% at 15% 100%, rgba(64,42,110,.35) 0%, transparent 60%); }
.stars { position: absolute; inset: -50%; background-repeat: repeat; opacity: .8; }
.stars.s1 { background-image: radial-gradient(1px 1px at 20px 30px, #9db4dd 50%, transparent 51%),
  radial-gradient(1px 1px at 120px 90px, #6f83ad 50%, transparent 51%),
  radial-gradient(1.5px 1.5px at 200px 160px, #cdd9f2 50%, transparent 51%);
  background-size: 260px 220px; animation: drift 240s linear infinite; }
.stars.s2 { background-image: radial-gradient(1px 1px at 60px 140px, #7d92bb 50%, transparent 51%),
  radial-gradient(1px 1px at 180px 40px, #b7c6e6 50%, transparent 51%);
  background-size: 340px 300px; animation: drift 380s linear infinite reverse; }
@keyframes drift { to { transform: translate(260px, 220px); } }
.nebula { position: absolute; width: 60vmax; height: 40vmax; border-radius: 50%;
  filter: blur(60px); opacity: .16; pointer-events: none; }
#space.warping .stars { animation-duration: 2.5s; opacity: 1; }

/* —— 顶栏 —— */
header { position: relative; z-index: 5; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; font-size: 14px; }
header .title { font-weight: 700; letter-spacing: .12em; color: #e8edf7; }
header .grow { flex: 1; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px;
  background: rgba(20,28,50,.55); border: 1px solid rgba(120,150,220,.18); font-size: 13px;
  backdrop-filter: blur(6px); white-space: nowrap; }
.pill b { color: #ffd977; font-weight: 600; }
.pill .dust { color: #b9a6ff; }
#sndBtn { cursor: pointer; background: none; border: none; color: #8ea0c4; font-size: 15px; padding: 4px; }

/* —— 主体 —— */
main { position: relative; z-index: 2; flex: 1; overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch; padding: 0 14px 92px; max-width: 1280px; width: 100%; margin: 0 auto; }
.view { display: none; animation: fadein .25s ease; }
.view.on { display: block; }
@keyframes fadein { from { opacity: 0; transform: translateY(6px); } }

/* —— 探索页 —— */
#secName { text-align: center; margin-top: 8px; font-size: 20px; font-weight: 700; color: #e8edf7; letter-spacing: .2em; }
#secSub { text-align: center; margin-top: 6px; font-size: 13px; color: #8ea0c4; }
#stage { position: relative; height: min(46vh, 380px); display: flex; align-items: center; justify-content: center; }
#stageMsg { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; font-size: 13px;
  color: #9fb2d8; letter-spacing: .35em; opacity: 0; transition: opacity .3s; }
#stageMsg.on { opacity: 1; }

/* 程序化星球 */
.planet { position: relative; width: min(52vw, 240px); height: min(52vw, 240px); border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, hsl(var(--h) 55% 62%), hsl(var(--h) 60% 30%) 58%, hsl(var(--h) 65% 12%) 100%);
  box-shadow: inset -18px -22px 50px rgba(0,0,10,.75), 0 0 40px hsla(var(--h),70%,60%,.14);
  animation: spin 90s linear infinite; }
@keyframes spin { to { filter: hue-rotate(0deg); } }
.planet::before { content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: repeating-linear-gradient(-12deg, transparent 0 14px, hsla(var(--a),60%,60%,.14) 14px 22px);
  animation: bands 60s linear infinite; }
@keyframes bands { to { background-position: 0 340px; } }
.planet.k-moon::before, .planet.k-rock::before { background:
  radial-gradient(12% 12% at 68% 38%, rgba(0,0,12,.35) 40%, transparent 60%),
  radial-gradient(8% 8% at 34% 62%, rgba(0,0,12,.3) 40%, transparent 60%),
  radial-gradient(6% 6% at 52% 26%, rgba(0,0,12,.3) 40%, transparent 60%); animation: none; }
.planet.k-ice { background: radial-gradient(circle at 32% 30%, hsl(var(--h) 30% 88%), hsl(var(--h) 45% 55%) 60%, hsl(var(--h) 55% 22%)); }
.planet.k-ocean::before { background: radial-gradient(30% 22% at 60% 40%, hsla(var(--a),50%,80%,.35) 0%, transparent 70%),
  radial-gradient(24% 16% at 30% 64%, hsla(var(--a),50%,85%,.28) 0%, transparent 70%); animation: none; }
.planet.k-lava::before { background: radial-gradient(circle at 60% 70%, hsla(20,90%,55%,.5), transparent 45%),
  repeating-linear-gradient(64deg, transparent 0 26px, hsla(14,90%,50%,.28) 26px 28px); animation: none; }
.planet.k-crystal::before { background: conic-gradient(from 20deg,
  transparent 0 40deg, hsla(var(--a),80%,75%,.28) 40deg 55deg, transparent 55deg 130deg,
  hsla(var(--a),80%,80%,.22) 130deg 150deg, transparent 150deg 260deg, hsla(var(--a),80%,75%,.25) 260deg 285deg, transparent 285deg); animation: none; }
.planet.k-ringed::after, .planet.k-gas.ringed::after { content: ""; position: absolute; left: -34%; right: -34%; top: 42%; height: 16%;
  border-radius: 50%; border: 2px solid hsla(var(--a),60%,70%,.55); transform: rotate(-16deg);
  box-shadow: 0 0 14px hsla(var(--a),70%,60%,.25); }
.planet.k-wreck { border-radius: 18% 42% 30% 46%; animation: none;
  background: linear-gradient(140deg, hsl(var(--h) 15% 38%), hsl(var(--h) 12% 14%) 70%); }
.planet.k-wreck::before { background: repeating-linear-gradient(90deg, transparent 0 18px, rgba(0,0,0,.35) 18px 20px); animation: none; }
.planet.k-station { border-radius: 12%; transform: rotate(8deg); animation: none;
  background: linear-gradient(160deg, hsl(var(--h) 25% 55%), hsl(var(--h) 20% 18%)); }
.planet.k-station::before { border-radius: 0; background:
  repeating-linear-gradient(0deg, transparent 0 22px, rgba(10,14,26,.6) 22px 26px),
  radial-gradient(10% 10% at 80% 20%, hsla(var(--a),90%,60%,.9) 30%, transparent 60%); animation: none; }
.planet.k-nebula { filter: blur(6px); opacity: .9;
  background: radial-gradient(circle at 40% 40%, hsla(var(--h),70%,65%,.9), hsla(var(--a),60%,40%,.4) 60%, transparent 75%); }
.planet.k-wormhole { background: conic-gradient(from 0deg, hsl(var(--h) 70% 55%), #05070f 30%, hsl(var(--a) 70% 60%) 55%, #05070f 80%, hsl(var(--h) 70% 55%));
  animation: swirl 7s linear infinite; box-shadow: 0 0 60px hsla(var(--h),80%,60%,.35), inset 0 0 50px #05070f; }
@keyframes swirl { to { transform: rotate(360deg); } }
.planet.k-pulse { animation: pulse 3s ease-in-out infinite; }
@keyframes pulse { 50% { transform: scale(1.035); } }
.planet.k-civ::before { background:
  radial-gradient(3% 3% at 30% 40%, hsla(var(--a),90%,70%,.95) 40%, transparent 60%),
  radial-gradient(2.5% 2.5% at 55% 60%, hsla(var(--a),90%,70%,.9) 40%, transparent 60%),
  radial-gradient(2% 2% at 68% 35%, hsla(var(--a),90%,70%,.85) 40%, transparent 60%),
  radial-gradient(2% 2% at 42% 72%, hsla(var(--a),90%,70%,.8) 40%, transparent 60%); animation: none; }
.planet.k-shard { border-radius: 4% 60% 12% 55%; animation: pulse 5s ease-in-out infinite;
  background: linear-gradient(150deg, hsla(var(--h),60%,70%,.85), hsla(var(--a),70%,45%,.5)); }
.planet.k-relic { border-radius: 50%; animation: pulse 6s ease-in-out infinite;
  background: radial-gradient(circle at 50% 50%, hsl(48 80% 70%) 0 8%, transparent 9%),
  conic-gradient(from 10deg, transparent 0 40deg, hsla(48,70%,60%,.5) 41deg 43deg, transparent 44deg 100deg,
  hsla(48,70%,60%,.5) 101deg 103deg, transparent 104deg 200deg, hsla(48,70%,60%,.5) 201deg 203deg, transparent 204deg),
  radial-gradient(circle at 40% 40%, hsl(260 40% 25%), #0a0c18 70%); }
.r-glow-1 { box-shadow: 0 0 46px hsla(200,90%,70%,.35), inset -18px -22px 50px rgba(0,0,10,.7) !important; }
.r-glow-2 { box-shadow: 0 0 60px hsla(280,90%,70%,.45), inset -18px -22px 50px rgba(0,0,10,.7) !important; }
.r-glow-3 { box-shadow: 0 0 90px hsla(45,95%,65%,.55), inset -18px -22px 50px rgba(0,0,10,.65) !important; }

/* 雷达扫描 */
#radar { position: absolute; width: 240px; height: 240px; border-radius: 50%; pointer-events: none; opacity: 0; }
#radar.on { opacity: 1; }
#radar::before, #radar::after { content: ""; position: absolute; inset: 0; border-radius: 50%;
  border: 1px solid rgba(120,180,255,.35); animation: ring 1.4s ease-out infinite; }
#radar::after { animation-delay: .7s; }
@keyframes ring { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.25); opacity: 0; } }

/* 结果卡 */
#found { text-align: center; margin-top: 6px; min-height: 118px; }
#found .tag { display: inline-block; font-size: 11px; letter-spacing: .3em; color: #8ea0c4; margin-bottom: 6px; }
#found .tag.r1 { color: #6db8ff; } #found .tag.r2 { color: #c39bff; } #found .tag.r3 { color: #ffd977; }
#found h2 { font-size: 24px; color: #f0f4fb; font-weight: 700; }
#found h2 .new { font-size: 10px; vertical-align: super; color: #7dffb0; letter-spacing: .2em; margin-left: 6px; }
#found .desc { margin: 8px auto 0; max-width: 480px; font-size: 13px; color: #a9b8d6; line-height: 1.7; }
#found .gain { margin-top: 8px; font-size: 13px; color: #b9a6ff; }
#found .firstBy { margin-top: 6px; font-size: 11px; letter-spacing: .18em; color: #ffd977; }

/* 主按钮 */
#exploreBar { text-align: center; margin: 14px 0 6px; }
.btn { cursor: pointer; border: none; border-radius: 12px; font-size: 15px; font-weight: 600;
  padding: 13px 34px; min-height: 48px; color: #0b1020; background: linear-gradient(160deg, #9db8ff, #6d8dff);
  box-shadow: 0 0 24px rgba(109,141,255,.35); transition: transform .15s, box-shadow .15s, opacity .15s; }
.btn:active { transform: scale(.97); }
.btn[disabled] { opacity: .45; cursor: default; box-shadow: none; }
.btn.ghost { background: rgba(24,32,56,.7); color: #cfd6e4; border: 1px solid rgba(120,150,220,.25); box-shadow: none; }
.btn.small { padding: 9px 18px; min-height: 40px; font-size: 13px; }
#exploreCost { margin-top: 8px; font-size: 12px; color: #8ea0c4; }
#skipBtn { position: absolute; right: 10px; bottom: 10px; z-index: 6; display: none; }
#skipBtn.on { display: block; }

/* 星域地图 */
#sectors { display: flex; gap: 10px; overflow-x: auto; padding: 12px 2px 6px; scroll-snap-type: x mandatory; }
.secCard { scroll-snap-align: center; flex: 0 0 190px; padding: 14px; border-radius: 14px; cursor: pointer;
  background: rgba(16,24,44,.62); border: 1px solid rgba(120,150,220,.16); transition: border-color .2s; }
.secCard.on { border-color: rgba(150,180,255,.6); box-shadow: 0 0 18px rgba(110,140,255,.15); }
.secCard.locked { opacity: .5; cursor: default; }
.secCard h4 { font-size: 14px; color: #e2e8f4; }
.secCard p { margin-top: 5px; font-size: 11px; color: #8ea0c4; }

/* 侧栏块 */
.panelRow { display: grid; gap: 12px; margin-top: 14px; }
@media (min-width: 900px) { .panelRow { grid-template-columns: 1fr 1fr; } }
.panel { background: rgba(14,20,38,.6); border: 1px solid rgba(120,150,220,.13); border-radius: 14px; padding: 13px 15px; }
.panel h5 { font-size: 12px; letter-spacing: .22em; color: #8ea0c4; margin-bottom: 9px; }
.taskLine { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.taskLine .bar { flex: 1; height: 5px; border-radius: 4px; background: rgba(120,150,220,.15); overflow: hidden; }
.taskLine .bar i { display: block; height: 100%; background: linear-gradient(90deg,#6d8dff,#b9a6ff); transition: width .4s; }
.recentLine { display: flex; gap: 8px; font-size: 12px; color: #a9b8d6; padding: 4px 0; align-items: baseline; }
.recentLine b { color: #dfe6f5; font-weight: 600; }
.recentLine .fd { color: #ffd977; font-size: 10px; letter-spacing: .16em; }
.recentLine time { margin-left: auto; color: #6b7b9d; font-size: 11px; white-space: nowrap; }

/* —— 图鉴 —— */
.pageHead { margin: 14px 2px 4px; }
.pageHead h2 { font-size: 18px; color: #e8edf7; }
.pageHead .sub { margin-top: 6px; font-size: 13px; color: #8ea0c4; display: flex; align-items: center; gap: 10px; }
.pageHead .bar { flex: 1; max-width: 260px; height: 5px; border-radius: 4px; background: rgba(120,150,220,.15); overflow: hidden; }
.pageHead .bar i { display: block; height: 100%; background: linear-gradient(90deg,#6d8dff,#b9a6ff); }
#filters { display: flex; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
.chip { cursor: pointer; font-size: 12px; padding: 6px 14px; border-radius: 999px; border: 1px solid rgba(120,150,220,.2);
  background: rgba(16,24,44,.5); color: #a9b8d6; }
.chip.on { color: #0b1020; background: #9db8ff; border-color: transparent; }
#grid { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); margin-top: 10px; }
@media (min-width: 640px) { #grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 1000px) { #grid { grid-template-columns: repeat(5, 1fr); } }
.card { position: relative; border-radius: 14px; padding: 16px 10px 12px; text-align: center; cursor: pointer;
  background: rgba(14,20,38,.65); border: 1px solid rgba(120,150,220,.13); }
.card .planet { width: 74px; height: 74px; margin: 0 auto; animation: none; }
.card h4 { margin-top: 10px; font-size: 13px; color: #e2e8f4; font-weight: 600; }
.card .meta { margin-top: 4px; font-size: 11px; color: #8ea0c4; }
.card.unknown { cursor: default; }
.card.unknown .planet { background: radial-gradient(circle at 35% 32%, #1a2340, #0b101f 70%); box-shadow: inset -10px -12px 30px rgba(0,0,8,.8); }
.card.unknown h4 { color: #5b6a8a; letter-spacing: .3em; }
.card .rdot { position: absolute; top: 10px; right: 12px; font-size: 10px; letter-spacing: .1em; color: #6b7b9d; }
.card .rdot.r1 { color: #6db8ff; } .card .rdot.r2 { color: #c39bff; } .card .rdot.r3 { color: #ffd977; }

/* —— 飞船 —— */
#shipView .shipArt { text-align: center; font-size: 84px; margin: 22px 0 8px; filter: drop-shadow(0 0 22px rgba(109,141,255,.4)); animation: hover 4s ease-in-out infinite; }
@keyframes hover { 50% { transform: translateY(-8px); } }
.kv { display: flex; justify-content: space-between; padding: 7px 0; font-size: 13px; border-bottom: 1px dashed rgba(120,150,220,.12); }
.kv span:first-child { color: #8ea0c4; }

/* —— 排行 —— */
.boardRow { display: flex; align-items: center; gap: 10px; padding: 8px 4px; font-size: 13px; border-bottom: 1px dashed rgba(120,150,220,.1); }
.boardRow .rank { width: 26px; text-align: center; }
.boardRow b { color: #e2e8f4; font-weight: 600; flex: 1; }
.boardRow .val { color: #8ea0c4; }

/* —— 底部导航 —— */
nav { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; display: flex;
  background: rgba(8,11,22,.88); backdrop-filter: blur(10px); border-top: 1px solid rgba(120,150,220,.12);
  padding-bottom: env(safe-area-inset-bottom); }
nav button { flex: 1; background: none; border: none; color: #6b7b9d; font-size: 12px; padding: 9px 0 10px; cursor: pointer; }
nav button .ic { display: block; font-size: 17px; margin-bottom: 2px; }
nav button.on { color: #cdd9f7; }

/* —— 覆盖层 —— */
.overlay { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center;
  background: rgba(4,6,14,.72); backdrop-filter: blur(4px); padding: 20px; }
.overlay.on { display: flex; }
.sheet { width: 100%; max-width: 420px; max-height: 84vh; overflow-y: auto; border-radius: 16px; padding: 20px;
  background: #0d1326; border: 1px solid rgba(120,150,220,.22); animation: fadein .22s ease; }
.sheet h3 { font-size: 17px; color: #eef2fa; }
.sheet .body { margin-top: 10px; font-size: 13px; color: #a9b8d6; line-height: 1.8; }
.sheet .opts { display: flex; flex-direction: column; gap: 9px; margin-top: 14px; }
.optBtn { cursor: pointer; text-align: left; border-radius: 11px; padding: 11px 14px; min-height: 48px;
  background: rgba(24,32,56,.7); border: 1px solid rgba(120,150,220,.22); color: #dfe6f5; font-size: 14px; }
.optBtn small { display: block; margin-top: 2px; color: #8ea0c4; font-size: 11px; }
.optBtn:active { transform: scale(.98); }
.sheet .foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }

/* 成就 toast */
#toasts { position: absolute; top: 52px; right: 12px; z-index: 30; display: flex; flex-direction: column; gap: 8px; }
.toast { background: rgba(13,19,38,.95); border: 1px solid rgba(150,180,255,.3); border-radius: 12px;
  padding: 10px 14px; font-size: 13px; color: #dfe6f5; animation: toastIn .3s ease; max-width: 240px; }
.toast small { display: block; color: #8ea0c4; font-size: 11px; margin-top: 2px; }
@keyframes toastIn { from { opacity: 0; transform: translateX(20px); } }

/* 传说时刻 */
#app.legendary #space { filter: brightness(.45); transition: filter 1s; }
`;

const PAGE_HTML = `
<div id="app">
  <div id="space"><div class="stars s1"></div><div class="stars s2"></div>
    <div class="nebula" style="background:#3b2f77;top:-10%;left:55%"></div>
    <div class="nebula" style="background:#173a5e;bottom:-15%;left:-15%"></div></div>
  <header>
    <span class="title">星球探索</span><span class="grow"></span>
    <span class="pill">⚡ <b id="hEnergy">–</b></span>
    <span class="pill">🛢 <b id="hFuel">–</b></span>
    <span class="pill dust">✨ <b id="hDust">–</b></span>
    <button id="sndBtn">🔊</button>
  </header>
  <main>
    <section id="vExplore" class="view on">
      <div id="secName"></div><div id="secSub"></div>
      <div id="stage"><div id="radar"></div><div id="planetSlot"></div>
        <div id="stageMsg"></div></div>
      <div id="found"></div>
      <div id="exploreBar">
        <button id="exploreBtn" class="btn">开始探索</button>
        <div id="exploreCost"></div>
      </div>
      <div id="sectors"></div>
      <div class="panelRow">
        <div class="panel"><h5>今日任务</h5>
          <div class="taskLine"><span>探索 <span id="taskN">0</span> / <span id="taskT">3</span> 次</span>
            <div class="bar"><i id="taskBar" style="width:0%"></i></div><span id="taskR">✨ ×3</span></div></div>
        <div class="panel"><h5>最近发现</h5><div id="recent"></div></div>
      </div>
    </section>
    <section id="vDex" class="view">
      <div class="pageHead"><h2>宇宙图鉴</h2>
        <div class="sub"><span id="dexCount"></span><div class="bar"><i id="dexBar"></i></div><span id="dexPct"></span></div></div>
      <div id="filters"></div><div id="grid"></div>
    </section>
    <section id="vShip" class="view">
      <div class="pageHead"><h2>飞船</h2></div>
      <div class="shipArt">🚀</div>
      <div class="panel" id="shipPanel"></div>
    </section>
    <section id="vBoard" class="view">
      <div class="pageHead"><h2>排行榜</h2><div class="sub">每周一刷新探索者榜</div></div>
      <div id="filtersB"></div><div class="panel" id="boardPanel"></div>
    </section>
  </main>
  <nav>
    <button data-v="Explore" class="on"><span class="ic">🚀</span>探索</button>
    <button data-v="Dex"><span class="ic">🌌</span>图鉴</button>
    <button data-v="Ship"><span class="ic">🛰</span>飞船</button>
    <button data-v="Board"><span class="ic">🏆</span>排行</button>
  </nav>
  <button id="skipBtn" class="btn ghost small">跳过</button>
  <div id="ovEvent" class="overlay"><div class="sheet" id="evSheet"></div></div>
  <div id="ovFuel" class="overlay"><div class="sheet" id="fuelSheet"></div></div>
  <div id="ovCel" class="overlay"><div class="sheet" id="celSheet"></div></div>
  <div id="toasts"></div>
</div>`;

const PAGE_JS = `
var S = window.__STELLAR__;      // { me, sectors, catalogue, discovered, recent, boards, econ, ship, achievements }
var RN = ["普通", "稀有", "史诗", "传说"];
var busy = false, curSector = null, animTimers = [], skipped = false;

function $(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement("i"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function call(m, p) { return window.community.call(m, p || {}); }
function known(id) { return S.discovered.some(function (c) { return c.id === id; }); }
function celOf(id) { return S.discovered.find(function (c) { return c.id === id; }); }

// —— 音效：两枚极轻的合成音，不加载任何资源 ——
var actx = null;
function blip(freq, dur, gain) {
  if (!S.me.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    var o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = "sine";
    g.gain.setValueAtTime(gain || 0.04, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
  } catch (e) {}
}

// —— 数字平滑变化 ——
function tween(el, to) {
  var from = parseInt(el.textContent.replace(/[^0-9-]/g, ""), 10); if (isNaN(from)) from = to;
  var t0 = null;
  function step(ts) {
    if (!t0) t0 = ts;
    var k = Math.min((ts - t0) / 400, 1);
    el.textContent = Math.round(from + (to - from) * k).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function refreshHeader() {
  tween($("hEnergy"), S.me.balance); tween($("hFuel"), S.me.fuel); tween($("hDust"), S.me.dust);
  $("sndBtn").textContent = S.me.sound ? "🔊" : "🔇";
}

function planetHtml(art, rarity, size) {
  var cls = "planet k-" + art.k + (rarity ? " r-glow-" + rarity : "");
  var st = "--h:" + art.h + ";--a:" + art.a + ";" + (size ? "width:" + size + "px;height:" + size + "px;" : "");
  return '<div class="' + cls + '" style="' + st + '"></div>';
}

// —— 导航 ——
document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("on"); });
    document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); $("v" + b.dataset.v).classList.add("on");
    if (b.dataset.v === "Dex") drawDex();
    if (b.dataset.v === "Ship") drawShip();
    if (b.dataset.v === "Board") drawBoard("ex");
  };
});

// —— 探索页 ——
function drawSectors() {
  $("sectors").innerHTML = S.sectors.map(function (s) {
    var locked = S.me.ship < s.ship;
    var seen = S.discovered.filter(function (c) { return c.sec === s.id; }).length;
    var total = S.catalogue.filter(function (c) { return c.sec === s.id; }).length;
    return '<div class="secCard' + (curSector === s.id ? " on" : "") + (locked ? " locked" : "") +
      '" data-s="' + s.id + '"><h4>' + (locked ? "🔒 " : "") + esc(s.name) + "</h4><p>" +
      (locked ? "需要飞船 Lv." + s.ship : "🛢 " + s.fuel + " · 已发现 " + seen + " / " + total) + "</p></div>";
  }).join("");
  document.querySelectorAll(".secCard").forEach(function (el) {
    el.onclick = function () {
      var s = S.sectors.find(function (x) { return x.id === Number(el.dataset.s); });
      if (S.me.ship < s.ship) return;
      curSector = s.id; drawExplore();
    };
  });
}

function drawExplore() {
  var s = S.sectors.find(function (x) { return x.id === curSector; });
  $("secName").textContent = s.name; $("secSub").textContent = s.sub;
  drawCost(s);
  $("exploreBtn").textContent = S.me.explores > 0 ? "继续探索" : "开始探索";
  var last = S.discovered.filter(function (c) { return c.sec === s.id; }).slice(-1)[0];
  $("planetSlot").innerHTML = last ? planetHtml(last.art, 0) :
    '<div class="planet" style="--h:' + s.hue + ';--a:' + ((s.hue + 60) % 360) + '"></div>';
  $("found").innerHTML = "";
  drawSectors(); drawTask(); drawRecent();
}

function drawCost(s) {
  var seen = S.discovered.filter(function (c) { return c.sec === s.id; }).length;
  var total = S.catalogue.filter(function (c) { return c.sec === s.id; }).length;
  $("exploreCost").textContent = "🛢 消耗 " + s.fuel + " 燃料 · 本星域已发现 " + seen + " / " + total;
}

function drawTask() {
  $("taskN").textContent = S.me.day.n > S.me.day.target ? S.me.day.target : S.me.day.n;
  $("taskT").textContent = S.me.day.target;
  $("taskR").textContent = S.me.day.done ? "✅ 已完成" : "✨ ×" + S.me.day.dust;
  $("taskBar").style.width = Math.min(100, (S.me.day.n / S.me.day.target) * 100) + "%";
}

function ago(t) {
  var m = Math.max(1, Math.round((Date.now() - t) / 60000));
  return m < 60 ? m + " 分钟前" : Math.round(m / 60) + " 小时前";
}

function drawRecent() {
  $("recent").innerHTML = (S.recent || []).slice(0, 6).map(function (r) {
    return '<div class="recentLine"><b>' + esc(r.u) + "</b>发现「" + esc(r.name) + "」" +
      (r.first ? '<span class="fd">FIRST</span>' : "") + "<time>" + ago(r.at) + "</time></div>";
  }).join("") || '<div class="recentLine">宇宙仍在等待第一位探索者。</div>';
}

// —— 探索动画 ——
function clearAnim() { animTimers.forEach(clearTimeout); animTimers = []; }
function phase(fn, ms) { animTimers.push(setTimeout(fn, ms)); }

function playExploration(res) {
  var total = res.first || (res.celestial && res.celestial.r === 3) ? 4200 : 2400;
  skipped = false;
  $("skipBtn").classList.add("on");
  $("skipBtn").onclick = function () { skipped = true; clearAnim(); settle(res); };
  $("found").innerHTML = "";
  $("planetSlot").innerHTML = "";
  $("space").classList.add("warping"); blip(180, .4);
  $("stageMsg").textContent = "正在离开泊位……"; $("stageMsg").classList.add("on");
  phase(function () { $("stageMsg").textContent = "正在穿越星域……"; blip(260, .3); }, 700);
  phase(function () {
    $("space").classList.remove("warping");
    $("radar").classList.add("on"); blip(520, .2, .03);
    $("stageMsg").textContent = "正在扫描未知区域……";
  }, Math.min(1500, total * .45));
  phase(function () { if (!skipped) settle(res); }, total);
}

function settle(res) {
  clearAnim();
  $("skipBtn").classList.remove("on");
  $("radar").classList.remove("on");
  $("stageMsg").classList.remove("on");
  $("space").classList.remove("warping");
  if (res.kind === "event") { showEvent(res.event); return; }
  var c = res.celestial;
  if (c.r === 3 && res.fresh) { $("app").classList.add("legendary"); setTimeout(function () { $("app").classList.remove("legendary"); }, 2600); }
  blip(c.r >= 2 ? 880 : 660, .5, .05);
  $("planetSlot").innerHTML = planetHtml(c.art, c.r);
  var tag = res.fresh ? (c.r === 3 ? "传说级发现" : c.r === 2 ? "史诗发现" : c.r === 1 ? "发现稀有天体" : "发现新天体") : "再次发现";
  var gain = res.fresh ? "+1 图鉴" : "你的探测器再次记录到了这种天体。 +" + res.dust + " ✨";
  $("found").innerHTML =
    '<span class="tag r' + c.r + '">' + tag + "</span>" +
    "<h2>" + esc(c.name) + (res.fresh ? '<span class="new">NEW</span>' : "") + "</h2>" +
    '<div class="desc">' + esc(c.desc) + "</div>" +
    '<div class="gain">' + gain + "</div>" +
    (res.first ? '<div class="firstBy">FIRST DISCOVERED BY ' + esc(S.me.username || "你") + "</div>" : "");
  S.me.explores += 1;
  $("exploreBtn").textContent = "继续探索";
  drawCost(S.sectors.find(function (x) { return x.id === curSector; }));
  drawSectors(); drawTask(); drawRecent();
}

// —— 探索请求 ——
$("exploreBtn").onclick = function () {
  if (busy) return;
  var s = S.sectors.find(function (x) { return x.id === curSector; });
  if (S.me.fuel < s.fuel) { showFuelSheet(s.fuel); return; }
  busy = true; $("exploreBtn").disabled = true;
  var started = Date.now();
  call("explore", { sector: curSector }).then(function (res) {
    busy = false; $("exploreBtn").disabled = false;
    if (res.error === "no_fuel") { showFuelSheet(res.need); return; }
    if (res.error === "pending_event") { showEvent(res.event); return; }
    if (res.error) { toast("⚠️", "探索信号中断", "请稍后重试。"); return; }
    applyState(res);
    if (res.kind === "find") { S.discovered = upsertCel(S.discovered, res.celestial); }
    S.recent = res.recent || S.recent;
    (res.toasts || []).forEach(function (a) { toast(a.icon, a.name, a.desc); });
    if (res.dailyDust) toast("✨", "今日任务完成", "星尘 ×" + res.dailyDust + " 已入账。");
    playExploration(res);
  }, function () {
    busy = false; $("exploreBtn").disabled = false;
    toast("⚠️", "探索信号中断", "与探索中心的连接暂时中断，请稍后重试。");
  });
};

function upsertCel(list, c) {
  var rest = list.filter(function (x) { return x.id !== c.id; }); rest.push(c); return rest;
}

function applyState(res) {
  if (typeof res.fuel === "number") S.me.fuel = res.fuel;
  if (typeof res.dust === "number" && res.kind !== "find") S.me.dust = res.dust;
  if (res.kind === "find" || res.kind === "eventResult") S.me.dust = res.dust;
  if (typeof res.seenCount === "number") S.me.seenCount = res.seenCount;
  if (res.day) { S.me.day.n = res.day.n; S.me.day.done = res.day.done; }
  refreshHeader();
}

// —— 事件 ——
function showEvent(ev) {
  $("evSheet").innerHTML = "<h3>📡 " + esc(ev.title) + '</h3><div class="body">' + esc(ev.body) +
    "<br>距离：" + esc(ev.dist) + '</div><div class="opts">' +
    ev.opts.map(function (o) {
      return '<button class="optBtn" data-k="' + o.key + '">' + esc(o.label) +
        "<small>" + esc(o.sub) + "</small></button>";
    }).join("") + "</div>";
  $("ovEvent").classList.add("on");
  document.querySelectorAll("#evSheet .optBtn").forEach(function (b) {
    b.onclick = function () {
      if (busy) return; busy = true;
      call("resolveEvent", { choice: b.dataset.k }).then(function (res) {
        busy = false;
        if (res.error === "no_fuel") { $("ovEvent").classList.remove("on"); showFuelSheet(res.need); return; }
        if (res.error) { toast("⚠️", "信号中断", "请重试。"); return; }
        $("ovEvent").classList.remove("on");
        applyState(res);
        (res.toasts || []).forEach(function (a) { toast(a.icon, a.name, a.desc); });
        S.recent = res.recent || S.recent;
        if (res.found) {
          S.discovered = upsertCel(S.discovered, res.found.celestial);
          settle(res.found);
          toast("📡", "调查结果", res.text);
        } else {
          $("found").innerHTML = '<span class="tag">调查结果</span><div class="desc">' + esc(res.text) + "</div>" +
            (res.dust ? '<div class="gain">+' + res.dust + " ✨</div>" : "") +
            (res.loss ? '<div class="gain">-' + res.loss + " ✨</div>" : "");
          drawTask(); drawRecent();
        }
      }, function () { busy = false; toast("⚠️", "信号中断", "请重试。"); });
    };
  });
}

// —— 燃料 ——
function showFuelSheet(need) {
  $("fuelSheet").innerHTML = "<h3>燃料不足</h3>" +
    '<div class="body">本次探索需要 🛢 ' + need + "，当前 🛢 " + S.me.fuel +
    "。<br><br>补给站可以把社区能量转化为燃料（1 : 1）。确认补给后，站点会向你出示一次正式的付款确认。" +
    "<br>在社区参与讨论也可以获得更多能量。</div>" +
    '<div class="foot"><button class="btn ghost small" id="fuelNo">知道了</button>' +
    '<button class="btn small" id="fuelYes">补给 ⚡' + S.econ.refuelEnergy + " → 🛢" + S.econ.refuelFuel + "</button></div>";
  $("ovFuel").classList.add("on");
  $("fuelNo").onclick = function () { $("ovFuel").classList.remove("on"); };
  $("fuelYes").onclick = function () {
    $("fuelYes").disabled = true;
    call("refuel", {}).then(function () { $("ovFuel").classList.remove("on"); },
      function () { $("fuelYes").disabled = false; });
  };
}

// 平台确认框的结果从这里回来
window.community.onSpend = function (ev) {
  if (ev.status === "paid") {
    call("sync", {}).then(function (res) { boot(res); toast("🛢", "补给完成", "燃料 +" + S.econ.refuelFuel + " 已入舱。"); });
  } else if (ev.status === "declined") {
    toast("🛢", "补给已取消", "没有产生任何扣费。");
  } else if (ev.status === "dry_run") {
    toast("🧪", "演练模式", "正式上架后补给才会真实到账。");
  }
};

// —— 图鉴 ——
var dexFilter = -1;
function drawDex() {
  var seen = S.me.seenCount, total = S.me.total;
  $("dexCount").textContent = seen + " / " + total;
  $("dexPct").textContent = "完成度 " + Math.round((seen / total) * 1000) / 10 + "%";
  $("dexBar").style.width = (seen / total) * 100 + "%";
  $("filters").innerHTML = ["全部", "普通", "稀有", "史诗", "传说"].map(function (n, i) {
    return '<span class="chip' + (dexFilter === i - 1 ? " on" : "") + '" data-r="' + (i - 1) + '">' + n + "</span>";
  }).join("");
  document.querySelectorAll("#filters .chip").forEach(function (c) {
    c.onclick = function () { dexFilter = Number(c.dataset.r); drawDex(); };
  });
  var rows = S.catalogue.filter(function (c) { return dexFilter < 0 || c.r === dexFilter; });
  if (!S.me.seenCount) {
    $("grid").innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 10px;color:#8ea0c4">' +
      '<div style="font-size:40px">🌌</div><h3 style="color:#dfe6f5;margin:10px 0 6px">宇宙仍是一片未知</h3>' +
      "开始第一次探索，发现属于你的第一颗星球。</div>";
    return;
  }
  $("grid").innerHTML = rows.map(function (c) {
    var got = celOf(c.id);
    if (!got) return '<div class="card unknown"><span class="rdot r' + c.r + '">' + RN[c.r] + "</span>" +
      '<div class="planet"></div><h4>？？？</h4><div class="meta">尚未发现</div></div>';
    return '<div class="card" data-id="' + c.id + '"><span class="rdot r' + c.r + '">' + RN[c.r] + "</span>" +
      planetHtml(got.art, 0, 74) + "<h4>" + esc(got.name) + '</h4><div class="meta">发现次数：' + got.n + "</div></div>";
  }).join("");
  document.querySelectorAll("#grid .card[data-id]").forEach(function (el) {
    el.onclick = function () { showCel(celOf(Number(el.dataset.id))); };
  });
}

function showCel(c) {
  var secName = S.sectors.find(function (s) { return s.id === c.sec; }).name;
  $("celSheet").innerHTML =
    '<div style="text-align:center">' + planetHtml(c.art, c.r, 130) + "</div>" +
    '<h3 style="text-align:center;margin-top:12px">' + esc(c.name) +
    ' <span class="rdot r' + c.r + '" style="font-size:11px">' + RN[c.r] + "</span></h3>" +
    '<div class="body">' +
    '<div class="kv"><span>星域</span><span>' + esc(secName) + "</span></div>" +
    '<div class="kv"><span>环境</span><span>' + esc(c.env) + "</span></div>" +
    '<div class="kv"><span>距离</span><span>' + c.dist + " 光年</span></div>" +
    '<div class="kv"><span>首次发现</span><span>' + new Date(c.at).toLocaleDateString() + "</span></div>" +
    '<div class="kv"><span>发现次数</span><span>' + c.n + "</span></div>" +
    (c.first ? '<div class="kv"><span>FIRST DISCOVERED BY</span><span>' + esc(c.first.u) + "</span></div>" : "") +
    '<p style="margin-top:12px">' + esc(c.lore) + "</p></div>" +
    '<div class="foot"><button class="btn ghost small" id="celClose">关闭</button></div>';
  $("ovCel").classList.add("on");
  $("celClose").onclick = function () { $("ovCel").classList.remove("on"); };
}

// —— 飞船 ——
function drawShip() {
  var cur = S.ship[S.me.ship - 1], next = S.ship[S.me.ship];
  $("shipPanel").innerHTML =
    '<div class="kv"><span>当前飞船</span><span>' + esc(cur.name) + " · Lv." + cur.lv + " / " + S.ship.length + "</span></div>" +
    '<div class="kv"><span>当前能力</span><span>' + esc(cur.note) + "</span></div>" +
    (next
      ? '<div class="kv"><span>下一等级 Lv.' + next.lv + "</span><span>" + esc(next.note) + "</span></div>" +
        '<div class="kv"><span>升级需要</span><span>🛢 ' + next.fuel + " · ✨ " + next.dust + "</span></div>" +
        '<div style="text-align:center;margin-top:14px"><button class="btn" id="upBtn">升级飞船</button></div>'
      : '<div class="body" style="text-align:center;margin-top:10px">这已经是能触碰到边界的船了。</div>');
  var b = $("upBtn");
  if (b) b.onclick = function () {
    if (busy) return;
    var msg = "确认升级到 Lv." + next.lv + "？将消耗 🛢 " + next.fuel + " 与 ✨ " + next.dust + "。";
    b.textContent = msg; b.onclick = function () {
      busy = true; b.disabled = true;
      call("upgrade", {}).then(function (res) {
        busy = false; b.disabled = false;
        if (res.error === "no_fuel") { toast("🛢", "燃料不足", "还需要 🛢 " + res.need + "。"); drawShip(); return; }
        if (res.error === "no_dust") { toast("✨", "星尘不足", "还需要 ✨ " + res.need + "。"); drawShip(); return; }
        if (res.error) { toast("⚠️", "信号中断", "请重试。"); return; }
        S.me.ship = res.ship; S.me.fuel = res.fuel; S.me.dust = res.dust; S.me.shipName = res.shipName;
        refreshHeader(); drawShip(); drawSectors();
        toast("🚀", "升级完成", res.shipName + " 已就绪。");
        blip(700, .4, .05);
      }, function () { busy = false; b.disabled = false; toast("⚠️", "信号中断", "请重试。"); });
    };
  };
}

// —— 排行 ——
function drawBoard(which) {
  $("filtersB").innerHTML = [["ex", "探索者"], ["co", "收藏家"], ["fd", "发现者"]].map(function (t) {
    return '<span class="chip' + (which === t[0] ? " on" : "") + '" data-b="' + t[0] + '">' + t[1] + "</span>";
  }).join("");
  document.querySelectorAll("#filtersB .chip").forEach(function (c) {
    c.onclick = function () { drawBoard(c.dataset.b); };
  });
  var medals = ["🥇", "🥈", "🥉"];
  var rows = (S.boards[which] || []);
  $("boardPanel").innerHTML = rows.map(function (r, i) {
    return '<div class="boardRow"><span class="rank">' + (medals[i] || i + 1) + "</span><b>" + esc(r.u) +
      '</b><span class="val">' + r.n + (which === "co" ? " / " + S.me.total : "") + "</span></div>";
  }).join("") || '<div class="body">本周还没有人出航。</div>';
}

// —— toast ——
function toast(icon, name, desc) {
  var el = document.createElement("div");
  el.className = "toast"; el.innerHTML = icon + " <b>" + esc(name) + "</b><small>" + esc(desc) + "</small>";
  $("toasts").appendChild(el);
  setTimeout(function () { el.remove(); }, 4200);
}

// —— 音效开关 ——
$("sndBtn").onclick = function () {
  call("toggleSound", {}).then(function (res) { S.me.sound = res.sound; refreshHeader(); });
};

// —— 启动 ——
function boot(res) {
  S = res; S.me.username = window.__STELLAR_USER__;
  if (curSector === null || S.sectors.every(function (s) { return s.id !== curSector; })) {
    curSector = S.sectors[0].id;
  }
  refreshHeader(); drawExplore();
  if (res.credited) toast("🛢", "补给对账", "上次确认的燃料 +" + res.credited + " 已补入。");
}
boot(S);
`;

export async function webview(ctx, api) {
  if (!ctx.user) {
    return {
      html: '<div style="display:flex;height:100%;align-items:center;justify-content:center;text-align:center;color:#8ea0c4;background:#05070f;font-family:system-ui"><div><div style="font-size:42px">🌌</div><p style="margin-top:12px">登录后即可开始你的宇宙探索。</p></div></div>',
      css: "html,body{margin:0;height:100%}",
      js: "",
    };
  }

  const g = await loadGame(api);
  const firsts = await readShared(api, "firsts", {});
  const balance = (await api.points.balance()) ?? 0;

  const boot = {
    me: summarize(g, balance, firsts),
    sectors: SECTORS,
    catalogue: silhouettes(),
    discovered: discoveredViews(g, firsts),
    recent: await readShared(api, "recent", []),
    boards: await readShared(api, "boards", { wk: 0, ex: [], co: [], fd: [] }),
    econ: { refuelEnergy: ECON.REFUEL_ENERGY, refuelFuel: ECON.REFUEL_FUEL },
    ship: SHIP,
    achievements: ACHIEVEMENTS,
  };

  return {
    html: PAGE_HTML,
    css: PAGE_CSS,
    js:
      "window.__STELLAR__ = " + JSON.stringify(boot) + ";\n" +
      "window.__STELLAR_USER__ = " + JSON.stringify(ctx.user.username) + ";\n" +
      PAGE_JS,
  };
}

/** webview 被站点关闭时的降级卡片：至少让图鉴的进度还看得见。 */
export async function render(ctx, api) {
  const g = ctx.user ? await loadGame(api) : freshGame();
  const seen = Object.keys(g.seen).length;

  return {
    blocks: {
      type: "vstack",
      gap: "small",
      padding: "medium",
      align: "center",
      children: [
        { type: "text", value: "星球探索", weight: "bold", size: "large" },
        { type: "text", value: "这个游戏需要绘制自己的界面，而本站点当前已将其关闭。", align: "center" },
        { type: "divider" },
        {
          type: "text",
          value: ctx.user ? "你的图鉴：" + seen + " / " + CELESTIALS.length : "登录后开始探索。",
          size: "small",
        },
      ],
    },
    state: {},
    effects: [],
  };
}
