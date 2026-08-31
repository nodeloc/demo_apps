import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// The handlers, run against the bundle the platform would actually get, with a
// stand-in for the host: prefetched reads in, declared effects out. What is
// being checked is the decision each app makes, which is the only part of a bot
// that a person has to get right.
const APPS = path.dirname(fileURLToPath(import.meta.url));

// The bundler comes from the nodeloc-apps CLI. Point NODELOC_APPS_CLI at your
// checkout; a sibling directory of this one is the default.
const CLI = process.env.NODELOC_APPS_CLI ?? path.join(APPS, "..", "nodeloc-apps-cli");
const { bundle } = await import(pathToFileURL(path.join(CLI, "src/bundle.js")));

async function load(slug) {
  const manifest = JSON.parse(await readFile(`${APPS}/${slug}/app.json`, "utf8"));
  const code = await bundle(`${APPS}/${slug}/${manifest.entry}`);
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return await import(`data:text/javascript;base64,${encoded}`);
}

/** A stand-in for the host: prefetched reads in, declared effects out. */
function fakeApi({ kv = {}, app = {}, posts = {}, topics = {}, history = {}, balance = 0, spends = [] } = {}) {
  return {
    kv: {
      get: async (key) => kv[key] ?? null,
      list: async () => Object.keys(kv),
      listPublic: async () => Object.entries(kv).map(([key, value]) => ({ key, value })),
      app: { get: async (key) => app[key] ?? null },
    },
    post: {
      get: async (id) => posts[id] ?? null,
      recentByUser: async (id) => history[id] ?? [],
    },
    topic: { get: async (id) => topics[id] ?? null },
    points: {
      balance: async () => balance,
      spends: async () => spends,
    },
  };
}

const types = (r) => r.effects.map((e) => e.type);
const find = (r, type) => r.effects.find((e) => e.type === type);

test("welcome-bot greets a newcomer once and then stays quiet", async () => {
  const app = await load("welcome-bot");
  const posts = { 10: { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", raw: "hi", is_first_post: true } };
  const ctx = { event: "topic_created", data: { post_id: 10, topic_id: 4 }, config: {} };

  const first = await app.onTrigger(ctx, fakeApi({ posts }));
  assert.deepEqual(types(first), ["kv.set", "post.reply"]);
  assert.match(find(first, "post.reply").raw, /@ada/);

  const again = await app.onTrigger(ctx, fakeApi({ posts, kv: { "greeted:7": 4 } }));
  assert.deepEqual(types(again), [], "a member is greeted once, not once per topic");

  const reply = await app.onTrigger(
    { ...ctx, data: { post_id: 11, topic_id: 4 } },
    fakeApi({ posts: { 11: { ...posts[10], id: 11, is_first_post: false } } })
  );
  assert.deepEqual(types(reply), [], "a reply is not a first topic");
});

test("remind-me hears the command, ignores the rest, and refuses silly delays", async () => {
  const app = await load("remind-me");
  const api = (raw) => fakeApi({ posts: { 1: { id: 1, topic_id: 4, post_number: 2, user_id: 7, username: "ada", raw } } });
  const ctx = { event: "post_created", data: { post_id: 1, topic_id: 4 }, config: {} };

  const heard = await app.onTrigger(ctx, api("please !remindme 2h about this"));
  assert.deepEqual(types(heard), ["kv.set", "schedule.add", "post.reply"]);
  assert.equal(find(heard, "schedule.add").in_seconds, 120 * 60);

  assert.deepEqual(types(await app.onTrigger(ctx, api("just talking"))), []);
  assert.deepEqual(types(await app.onTrigger(ctx, api("!remindme 999 days"))), [], "beyond a month is a typo");
});

test("remind-me names everyone waiting on a topic in one reply", async () => {
  const app = await load("remind-me");
  const waiting = [
    { username: "ada", topic_id: 4, post_number: 2 },
    { username: "bob", topic_id: 4, post_number: 5 },
    { username: "cyd", topic_id: 9, post_number: 1 },
  ];
  const out = await app.onSchedule(
    { job_key: "due-120", payload: { bucket: "120" }, config: {} },
    fakeApi({ kv: { "pending:120": waiting } })
  );

  const replies = out.effects.filter((e) => e.type === "post.reply");
  assert.equal(replies.length, 2, "one reply per topic, not one per person");
  assert.match(replies.find((r) => r.topic_id === 4).raw, /@ada @bob/);
  assert.ok(out.effects.some((e) => e.type === "schedule.cancel"));
});

test("daily-thread registers its job on install and opens one topic a day", async () => {
  const app = await load("daily-thread");
  const config = { category_id: 5, every_hours: 24 };

  const installed = await app.onInstall({ config });
  const job = find(installed, "schedule.add");
  assert.equal(job.every_seconds, 86400);
  assert.ok(job.in_seconds <= 60, "the first one goes out promptly, not a day later");

  const opened = await app.onSchedule({ config, payload: {} }, fakeApi());
  assert.deepEqual(types(opened), ["kv.set", "post.create"]);
  assert.equal(find(opened, "post.create").category_id, 5);

  const today = new Date().toISOString().slice(0, 10);
  const twice = await app.onSchedule({ config, payload: {} }, fakeApi({ kv: { "last-opened": today } }));
  assert.deepEqual(types(twice), [], "a job that fires twice still opens one thread");

  const unconfigured = await app.onSchedule({ config: {}, payload: {} }, fakeApi());
  assert.deepEqual(types(unconfigured), [], "no category means silence, not a topic in the wrong place");
});

test("keyword-guard answers the first matching rule, once per post", async () => {
  const app = await load("keyword-guard");
  // Written the way somebody configuring a node writes them: a line each.
  const config = {
    rules: [
      "\\( => never compiled",
      "how do I reset my password => Try /my/preferences/account.",
    ].join("\n"),
  };
  const posts = { 1: { id: 1, topic_id: 4, post_number: 3, username: "ada", raw: "Hi, how do I RESET MY PASSWORD?" } };
  const ctx = { event: "post_created", data: { post_id: 1 }, config };

  const answered = await app.onTrigger(ctx, fakeApi({ posts }));
  assert.deepEqual(types(answered), ["kv.set", "post.reply"]);
  assert.equal(find(answered, "post.reply").raw, "Try /my/preferences/account.", "a broken rule costs that rule, not the app");

  const edited = await app.onTrigger({ ...ctx, event: "post_edited" }, fakeApi({ posts, kv: { "answered:1": "x" } }));
  assert.deepEqual(types(edited), [], "editing a typo does not earn a second answer");

  // The shape an install made before the line format still carries.
  const legacy = {
    rules: [{ match: "how do I reset my password", reply: "Try /my/preferences/account." }],
  };
  const old = await app.onTrigger({ ...ctx, config: legacy }, fakeApi({ posts }));
  assert.deepEqual(types(old), ["kv.set", "post.reply"], "the older array form still works");

  const halfTyped = await app.onTrigger(
    { ...ctx, config: { rules: "how do I reset my password" } },
    fakeApi({ posts })
  );
  assert.deepEqual(types(halfTyped), [], "a line with no arrow is not a rule that matches everything");
});

test("repo-info declares a request, then answers from what came back", async () => {
  const app = await load("repo-info");
  const link = (raw) => fakeApi({ posts: { 1: { id: 1, topic_id: 4, post_number: 2, username: "ada", raw } } });

  // The ways a link actually ends in prose, which an anchored terminator missed.
  for (const raw of [
    "look at https://github.com/discourse/discourse for this",
    "see https://github.com/discourse/discourse.",
    "https://github.com/discourse/discourse.git",
    "https://github.com/discourse/discourse/blob/main/README.md",
    "https://github.com/discourse/discourse",
  ]) {
    const out = await app.onTrigger({ event: "post_created", data: { post_id: 1 }, config: {} }, link(raw));
    assert.equal(
      find(out, "http.fetch")?.url,
      "https://api.github.com/repos/discourse/discourse",
      `did not recognise: ${raw}`
    );
  }

  const asked = await app.onTrigger({ event: "post_created", data: { post_id: 1 }, config: {} }, link("https://github.com/discourse/discourse"));
  const fetch = find(asked, "http.fetch");
  assert.ok(!/fetch\s*\(/.test(String(app.onTrigger)), "the handler declares a request, it never makes one");

  const memory = Object.fromEntries(asked.effects.filter((e) => e.type === "kv.set").map((e) => [e.key, e.value]));
  const answered = await app.onFetch(
    { request_id: fetch.request_id, ok: true, status: 200, body: JSON.stringify({ full_name: "discourse/discourse", description: "A platform for community discussion", stargazers_count: 44000, language: "Ruby" }) },
    fakeApi({ kv: memory })
  );
  assert.match(find(answered, "post.reply").raw, /discourse\/discourse/);
  assert.match(find(answered, "post.reply").raw, /44,000 stars/);

  const failed = await app.onFetch({ request_id: fetch.request_id, ok: false, status: 0, body: "" }, fakeApi({ kv: memory }));
  assert.deepEqual(types(failed), ["kv.delete"], "somebody else's outage is not announced in a topic");
});


const SENTRY_CONFIG = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  api_key: "sk-test",
};

function botPosts(count = 6) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    topic_id: i,
    raw: "check out my great offer at https://x.example.com now",
    created_at: new Date(now - i * 3600 * 1000).toISOString(),
  }));
}

function humanPosts() {
  const now = Date.now();
  return [
    "I had the same problem last week and changing the config fixed it",
    "Thanks, that worked. Leaving a note for whoever finds this later.",
    "Different question entirely: does anyone run this on arm64 hardware?",
    "Ah, I misread the docs — it is under advanced settings after all.",
  ].map((raw, i) => ({
    id: 200 + i,
    topic_id: i % 2,
    raw,
    created_at: new Date(now - [1, 9, 50, 90][i] * 60000).toISOString(),
  }));
}

const subject = { id: 7, topic_id: 4, post_number: 2, username: "ada", trust_level: 0, staff: false };

function flaggedCtx(config = SENTRY_CONFIG) {
  return {
    event: "post_flagged",
    install_id: 3,
    config,
    data: { post_id: 7, flagged_user_id: 7, author_id: 7 },
  };
}

test("bot-sentry says nothing until somebody has configured a model", async () => {
  const app = await load("bot-sentry");
  const out = await app.onTrigger(flaggedCtx({}), fakeApi({ posts: { 7: subject }, history: { 7: botPosts() } }));

  assert.deepEqual(types(out), [], "no endpoint, no key, nothing sent anywhere");
});

test("bot-sentry asks about a reported account, and sends only its posts", async () => {
  const app = await load("bot-sentry");
  const out = await app.onTrigger(flaggedCtx(), fakeApi({ posts: { 7: subject }, history: { 7: botPosts() } }));

  assert.deepEqual(types(out), ["kv.set", "http.fetch"]);
  const request = find(out, "http.fetch");
  assert.equal(request.url, SENTRY_CONFIG.endpoint);
  assert.match(request.headers.authorization, /^Bearer sk-test$/);

  const body = JSON.parse(request.body);
  assert.equal(body.model, "gpt-4.1-mini");
  const prompt = body.messages[0].content;
  assert.match(prompt, /check out my great offer/, "the account's own posts are what is sent");
  assert.doesNotMatch(prompt, /sk-test/, "the key is not in the prompt");
});

test("bot-sentry leaves alone the people it must never judge", async () => {
  const app = await load("bot-sentry");
  const api = fakeApi({ posts: { 7: { ...subject, staff: true } }, history: { 7: botPosts() } });
  assert.deepEqual(types(await app.onTrigger(flaggedCtx(), api)), [], "staff");

  const trusted = fakeApi({ posts: { 7: { ...subject, trust_level: 3 } }, history: { 7: botPosts() } });
  assert.deepEqual(types(await app.onTrigger(flaggedCtx(), trusted)), [], "a long-standing member");

  const named = flaggedCtx({ ...SENTRY_CONFIG, exempt_usernames: ["Ada"] });
  const byName = fakeApi({ posts: { 7: subject }, history: { 7: botPosts() } });
  assert.deepEqual(types(await app.onTrigger(named, byName)), [], "an exempted name, case-insensitively");
});

test("bot-sentry does not spend an API call on an account nobody reported and nothing marks out", async () => {
  const app = await load("bot-sentry");
  const watching = { ...SENTRY_CONFIG, watch_new_accounts: true };
  const api = (history) => fakeApi({ posts: { 7: subject }, history: { 7: history } });

  const quiet = await app.onTrigger(
    { event: "post_created", install_id: 3, config: watching, data: { post_id: 7, author_id: 7 } },
    api(humanPosts())
  );
  assert.deepEqual(types(quiet), [], "an ordinary member costs nothing");

  const odd = await app.onTrigger(
    { event: "post_created", install_id: 3, config: watching, data: { post_id: 7, author_id: 7 } },
    api(botPosts())
  );
  assert.deepEqual(types(odd), ["kv.set", "http.fetch"], "repetition and links are worth asking about");

  const notWatching = await app.onTrigger(
    { event: "post_created", install_id: 3, config: SENTRY_CONFIG, data: { post_id: 7, author_id: 7 } },
    api(botPosts())
  );
  assert.deepEqual(types(notWatching), [], "off by default: only reported accounts");
});

test("bot-sentry turns a verdict into a flag, and records who judged", async () => {
  const app = await load("bot-sentry");
  const asked = await app.onTrigger(flaggedCtx(), fakeApi({ posts: { 7: subject }, history: { 7: botPosts() } }));
  const pending = Object.fromEntries(
    asked.effects.filter((e) => e.type === "kv.set").map((e) => [e.key, e.value])
  );

  const answered = await app.onFetch(
    {
      request_id: find(asked, "http.fetch").request_id,
      install_id: 3,
      config: SENTRY_CONFIG,
      ok: true,
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: '```json\n{"bot": true, "confidence": 0.91, "why": "Same advert six times."}\n```',
            },
          },
        ],
      }),
    },
    fakeApi({ kv: pending })
  );

  assert.deepEqual(types(answered), ["kv.delete", "kv.app.set", "flag.create"]);
  const record = find(answered, "kv.app.set");
  assert.equal(record.key, "user:7");
  assert.equal(record.value.verdict, "bot");
  assert.equal(record.value.model, "gpt-4.1-mini");
  assert.equal(record.value.node, 3, "which node's model reached this");
  assert.match(find(answered, "flag.create").reason, /a model's opinion, not a finding/);
});

test("bot-sentry writes nothing when the model is unreachable or talking nonsense", async () => {
  const app = await load("bot-sentry");
  const asked = await app.onTrigger(flaggedCtx(), fakeApi({ posts: { 7: subject }, history: { 7: botPosts() } }));
  const pending = Object.fromEntries(
    asked.effects.filter((e) => e.type === "kv.set").map((e) => [e.key, e.value])
  );
  const requestId = find(asked, "http.fetch").request_id;
  const base = { request_id: requestId, install_id: 3, config: SENTRY_CONFIG };

  for (const [label, answer] of [
    ["a dead endpoint", { ...base, ok: false, status: 0, body: "" }],
    ["a rate limit", { ...base, ok: true, status: 429, body: "slow down" }],
    ["prose instead of JSON", { ...base, ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "Hard to say!" } }] }) }],
  ]) {
    const out = await app.onFetch(answer, fakeApi({ kv: pending }));
    assert.deepEqual(types(out), ["kv.delete"], `${label}: nothing is recorded, so the next post asks again`);
  }
});

test("bot-sentry does not act on another node's verdict unless asked to", async () => {
  const app = await load("bot-sentry");
  const elsewhere = {
    "user:7": { verdict: "bot", model: "some-cheap-model", node: 99, at: new Date().toISOString() },
  };

  const cautious = await app.onTrigger(
    flaggedCtx(),
    fakeApi({ posts: { 7: subject }, history: { 7: botPosts() }, app: elsewhere })
  );
  assert.deepEqual(types(cautious), [], "somebody else's model decided; this node has not");

  const trusting = await app.onTrigger(
    flaggedCtx({ ...SENTRY_CONFIG, trust_shared: true }),
    fakeApi({ posts: { 7: subject }, history: { 7: botPosts() }, app: elsewhere })
  );
  assert.deepEqual(types(trusting), ["flag.create"], "and no second API call for an answer already paid for");

  const stale = {
    "user:7": { verdict: "bot", node: 99, at: new Date(Date.now() - 200 * 86400000).toISOString() },
  };
  const expired = await app.onTrigger(
    flaggedCtx({ ...SENTRY_CONFIG, trust_shared: true }),
    fakeApi({ posts: { 7: subject }, history: { 7: botPosts() }, app: stale })
  );
  assert.deepEqual(types(expired), ["kv.set", "http.fetch"], "an old verdict is asked again");
});


test("the bots speak the reader's language, and fall back sensibly", async () => {
  const welcome = await load("welcome-bot");
  const ada = { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", is_first_post: true, raw: "hi" };

  const chinese = await welcome.onTrigger(
    { event: "topic_created", data: { post_id: 10 }, config: {}, locale: "en" },
    fakeApi({ posts: { 10: { ...ada, locale: "zh_CN" } } })
  );
  assert.match(find(chinese, "post.reply").raw, /欢迎/, "their language beats the forum's");

  const traditional = await welcome.onTrigger(
    { event: "topic_created", data: { post_id: 10 }, config: {}, locale: "en" },
    fakeApi({ posts: { 10: { ...ada, locale: "zh_TW" } } })
  );
  assert.match(find(traditional, "post.reply").raw, /欢迎/, "zh_TW reads zh_CN, not English");

  // Their language, then the forum's, then English. A Russian speaker on a
  // Chinese forum is better served by Chinese than by English, and so is
  // everybody else reading the topic.
  const noRussian = await welcome.onTrigger(
    { event: "topic_created", data: { post_id: 10 }, config: {}, locale: "zh_CN" },
    fakeApi({ posts: { 10: { ...ada, locale: "ru" } } })
  );
  assert.match(find(noRussian, "post.reply").raw, /欢迎/, "falls through to the forum's language");

  const neither = await welcome.onTrigger(
    { event: "topic_created", data: { post_id: 10 }, config: {}, locale: "ja" },
    fakeApi({ posts: { 10: { ...ada, locale: "ru" } } })
  );
  assert.match(find(neither, "post.reply").raw, /Welcome/, "and to English when neither was written");

  const byHand = await welcome.onTrigger(
    { event: "topic_created", data: { post_id: 10 }, config: { greeting: "Hei {username}!" }, locale: "zh_CN" },
    fakeApi({ posts: { 10: { ...ada, locale: "zh_CN" } } })
  );
  assert.equal(find(byHand, "post.reply").raw, "Hei ada!", "a greeting written by hand is used as written");
});

test("remind-me answers the asker, and reminds a topic in its commonest language", async () => {
  const app = await load("remind-me");
  const post = { id: 1, topic_id: 4, post_number: 2, username: "ada", locale: "zh_CN", raw: "!remindme 2h" };

  const heard = await app.onTrigger(
    { event: "post_created", data: { post_id: 1 }, config: {}, locale: "en" },
    fakeApi({ posts: { 1: post } })
  );
  assert.match(find(heard, "post.reply").raw, /记下了/);
  assert.match(find(heard, "post.reply").raw, /2 小时/, "the duration is translated too");
  assert.equal(find(heard, "kv.set").value.at(-1).locale, "zh_CN", "written down for the later run");

  const due = await app.onSchedule(
    { job_key: "due-120", payload: { bucket: "120" }, config: {}, locale: "en" },
    fakeApi({
      kv: {
        "pending:120": [
          { username: "ada", topic_id: 4, post_number: 2, locale: "zh_CN" },
          { username: "bob", topic_id: 4, post_number: 5, locale: "zh_CN" },
          { username: "cyd", topic_id: 9, post_number: 1, locale: "en" },
        ],
      },
    })
  );
  const replies = due.effects.filter((e) => e.type === "post.reply");
  assert.match(replies.find((r) => r.topic_id === 4).raw, /你让我提醒/, "two of three read Chinese");
  assert.match(replies.find((r) => r.topic_id === 9).raw, /asked to be reminded/);
});

test("what everybody in the node reads is written in the node's language", async () => {
  const daily = await load("daily-thread");
  const opened = await daily.onSchedule(
    { config: { category_id: 5 }, payload: {}, locale: "zh_CN" },
    fakeApi()
  );
  assert.match(find(opened, "post.create").title, /每日话题/);

  const repo = await load("repo-info");
  const answered = await repo.onFetch(
    {
      request_id: "repo-1",
      locale: "zh_CN",
      ok: true,
      status: 200,
      body: JSON.stringify({ full_name: "a/b", description: "", stargazers_count: 12, archived: true }),
    },
    fakeApi({ kv: { "asked:repo-1": { topic_id: 4, post_number: 1, repo: "a/b" } } })
  );
  const reply = find(answered, "post.reply").raw;
  assert.match(reply, /没有简介/);
  assert.match(reply, /已归档/);
});

test("node-notice tells each person once, and keeps the notice on top", async () => {
  const app = await load("node-notice");
  const posts = {
    10: { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", raw: "hi", is_first_post: true, staff: false },
  };
  const ctx = {
    event: "topic_created",
    data: { post_id: 10, topic_id: 4 },
    locale: "en",
    config: { notice: "Read the rules, {username}." },
  };

  const first = await app.onTrigger(ctx, fakeApi({ posts }));
  assert.deepEqual(types(first), ["kv.set", "post.reply"]);
  const reply = find(first, "post.reply");
  assert.match(reply.raw, /Read the rules, ada\./);
  assert.match(reply.raw, /I'm a bot/, "a notice has to say where to take a question");
  assert.equal(reply.pin, true, "pinned by default — a notice below the replies is not a notice");

  const again = await app.onTrigger(ctx, fakeApi({ posts, kv: { "told:7": 4 } }));
  assert.deepEqual(types(again), [], "the default is to say it once, not to become wallpaper");
});

test("node-notice says it on every topic when the node owner asks for that", async () => {
  const app = await load("node-notice");
  const posts = {
    10: { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", raw: "hi", is_first_post: true, staff: false },
  };
  const ctx = {
    event: "topic_created",
    data: { post_id: 10, topic_id: 4 },
    locale: "en",
    config: { notice: "Rules.", audience: "everyone" },
  };

  const told = await app.onTrigger(ctx, fakeApi({ posts, kv: { "told:7": 4 } }));
  assert.deepEqual(types(told), ["post.reply"], "already told, but this node wants it said anyway");

  const first = await app.onTrigger(ctx, fakeApi({ posts }));
  assert.deepEqual(
    types(first),
    ["kv.set", "post.reply"],
    "still records it, so turning the setting back down does not retell everyone"
  );
});

test("node-notice stays quiet where it has nothing to say or nobody to say it to", async () => {
  const app = await load("node-notice");
  const base = { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", raw: "hi", is_first_post: true, staff: false };
  const ctx = { event: "topic_created", data: { post_id: 10, topic_id: 4 }, locale: "en" };

  const unset = await app.onTrigger({ ...ctx, config: {} }, fakeApi({ posts: { 10: base } }));
  assert.deepEqual(types(unset), [], "a notice bot with no notice posts nothing");

  const blank = await app.onTrigger({ ...ctx, config: { notice: "   " } }, fakeApi({ posts: { 10: base } }));
  assert.deepEqual(types(blank), [], "whitespace is not a notice");

  const staff = await app.onTrigger(
    { ...ctx, config: { notice: "Rules." } },
    fakeApi({ posts: { 10: { ...base, staff: true } } })
  );
  assert.deepEqual(types(staff), [], "staff wrote the rules; do not read them back");

  const reply = await app.onTrigger(
    { ...ctx, config: { notice: "Rules." }, data: { post_id: 11, topic_id: 4 } },
    fakeApi({ posts: { 11: { ...base, id: 11, is_first_post: false } } })
  );
  assert.deepEqual(types(reply), [], "a reply is not a new topic");
});

test("node-notice can be told not to pin, and speaks the node's language", async () => {
  const app = await load("node-notice");
  const posts = {
    10: { id: 10, topic_id: 4, post_number: 1, user_id: 7, username: "ada", raw: "hi", is_first_post: true, staff: false },
  };

  const loose = await app.onTrigger(
    { event: "topic_created", data: { post_id: 10, topic_id: 4 }, locale: "en", config: { notice: "Rules.", pin: false } },
    fakeApi({ posts })
  );
  assert.equal(find(loose, "post.reply").pin, false);

  // Everybody who opens the topic reads this one, so it follows the node, not
  // the author — even for an author reading the site in another language.
  const chinese = await app.onTrigger(
    { event: "topic_created", data: { post_id: 10, topic_id: 4 }, locale: "zh_CN", config: { notice: "请先读版规。" } },
    fakeApi({ posts: { 10: { ...posts[10], locale: "en" } } })
  );
  assert.match(find(chinese, "post.reply").raw, /我是机器人/);
});

// ---------------------------------------------------------------------------
// stellar-quest：结果由服务端决定，能量只从确认框离开
// ---------------------------------------------------------------------------

const stellarCtx = (method, params = {}, extra = {}) => ({
  user: { id: 7, username: "ada" },
  method,
  params,
  ...extra,
});

function stellarGame(result) {
  const set = result.effects.find((e) => e.type === "kv.set" && e.key === "g");
  return set ? set.value : null;
}

/** 钉住随机数，让「是事件还是发现」由测试说了算。 */
function pinRandom(t, value) {
  const original = Math.random;
  Math.random = () => value;
  t.after(() => {
    Math.random = original;
  });
}

test("stellar-quest charges fuel server-side and records the find", async (t) => {
  pinRandom(t, 0.99); // 高于事件概率：这一次必然是发现
  const app = await load("stellar-quest");

  const res = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi());
  const g = stellarGame(res);

  assert.equal(res.result.kind, "find");
  assert.equal(g.f, 60 - 20, "starter fuel minus the sector cost");
  assert.equal(res.result.fresh, true);
  assert.equal(res.result.first, true, "an empty sky makes every find a first discovery");
  assert.equal(Object.keys(g.seen).length, 1);

  const firsts = res.effects.find((e) => e.type === "kv.shared.set" && e.key === "firsts");
  assert.equal(Object.values(firsts.value)[0].u, "ada");
});

test("stellar-quest refuses an exploration the tank cannot cover", async (t) => {
  pinRandom(t, 0.99);
  const app = await load("stellar-quest");
  const broke = { f: 5, d: 0, s: 1, seen: {}, ex: 0, wex: [0, 0], day: null, pe: null, ref: {}, ach: {}, snd: 1 };

  const res = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi({ kv: { g: broke } }));

  assert.equal(res.result.error, "no_fuel");
  assert.deepEqual(res.effects, [], "a refusal moves nothing");
});

test("stellar-quest keeps deeper sectors behind the ship level", async (t) => {
  pinRandom(t, 0.99);
  const app = await load("stellar-quest");

  const res = await app.onMessage(stellarCtx("explore", { sector: 2 }), fakeApi());
  assert.equal(res.result.error, "ship_too_low");
});

test("stellar-quest turns a repeat into stardust, not a shrug", async (t) => {
  pinRandom(t, 0.99);
  const app = await load("stellar-quest");

  const first = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi());
  const g = stellarGame(first);
  const foundId = first.result.celestial.id;

  // 权重钉死后每次都会抽到同一个天体：第二次就是重复发现
  const again = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi({ kv: { g } }));

  assert.equal(again.result.fresh, false);
  assert.ok(again.result.dust >= 1, "a repeat pays stardust");
  assert.equal(stellarGame(again).seen[foundId][0], 2);
});

test("stellar-quest asks for energy only through the platform confirmation", async () => {
  const app = await load("stellar-quest");

  const res = await app.onMessage(stellarCtx("refuel"), fakeApi());

  assert.deepEqual(types(res), ["points.spend"], "refuel declares the ask and nothing else");
  const ask = find(res, "points.spend");
  assert.equal(ask.amount, 100);
  assert.match(ask.request_id, /^fuel-/);
});

test("stellar-quest delivers a paid refuel exactly once", async () => {
  const app = await load("stellar-quest");
  const spend = { request_id: "fuel-1-1", amount: 100, status: "paid" };

  const paid = await app.onSpend({ user: { id: 7, username: "ada" }, spend }, fakeApi());
  const g = stellarGame(paid);
  assert.equal(g.f, 60 + 100);
  assert.equal(g.ref["fuel-1-1"], 1);

  const replay = await app.onSpend({ user: { id: 7, username: "ada" }, spend }, fakeApi({ kv: { g } }));
  assert.deepEqual(replay.effects, [], "the same receipt cannot fuel twice");
});

test("stellar-quest backfills a confirmed refuel its onSpend never heard about", async () => {
  const app = await load("stellar-quest");
  const spends = [{ request_id: "fuel-2-2", amount: 100, status: "paid" }];

  const res = await app.onMessage(stellarCtx("sync"), fakeApi({ spends, balance: 500 }));

  assert.equal(res.result.credited, 100);
  assert.equal(stellarGame(res).f, 60 + 100);
});

test("stellar-quest lets an event wait for a decision, then rolls from it", async (t) => {
  pinRandom(t, 0); // 低于事件概率：必然遇到事件；后续所有加权抽取都取第一项
  const app = await load("stellar-quest");

  const met = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi());
  assert.equal(met.result.kind, "event");
  const g = stellarGame(met);
  assert.ok(g.pe, "the event waits in the saved state");

  // 未回答前再探索：同一个事件回来，不再扣费
  const nagged = await app.onMessage(stellarCtx("explore", { sector: 1 }), fakeApi({ kv: { g } }));
  assert.equal(nagged.result.error, "pending_event");
  assert.deepEqual(nagged.effects, []);

  const answered = await app.onMessage(
    stellarCtx("resolveEvent", { choice: met.result.event.opts[0].key }),
    fakeApi({ kv: { g } }),
  );
  assert.equal(answered.result.kind, "eventResult");
  assert.equal(stellarGame(answered).pe, null);
});

test("stellar-quest upgrades cost fuel and stardust, never a hidden charge", async () => {
  const app = await load("stellar-quest");
  const rich = { f: 500, d: 500, s: 1, seen: {}, ex: 0, wex: [0, 0], day: null, pe: null, ref: {}, ach: {}, snd: 1 };

  const res = await app.onMessage(stellarCtx("upgrade"), fakeApi({ kv: { g: rich } }));
  const g = stellarGame(res);

  assert.equal(res.result.ship, 2);
  assert.equal(g.f, 500 - 80);
  assert.equal(g.d, 500 - 15);
  assert.ok(res.effects.every((e) => e.type === "kv.set"), "an upgrade never touches energy");

  const poor = { ...rich, d: 0 };
  const refused = await app.onMessage(stellarCtx("upgrade"), fakeApi({ kv: { g: poor } }));
  assert.equal(refused.result.error, "no_dust");
});

test("stellar-quest tells an anonymous visitor to log in", async () => {
  const app = await load("stellar-quest");
  const res = await app.onMessage({ user: null, method: "explore", params: { sector: 1 } }, fakeApi());
  assert.equal(res.result.error, "anonymous");
});
