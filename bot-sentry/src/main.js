/**
 * Asks a model whether an account is a machine, and hands the answer to a
 * person.
 *
 * The model is the installer's own — their endpoint, their key, their bill.
 * That is the point of the app: what counts as a bot is a judgement, judgements
 * differ between nodes, and a node's owner is the one entitled to make it here.
 *
 * Three things this app will not do, none of which are configurable:
 * it never deletes (a model's mistake should cost a moderator ten seconds in
 * the queue, not cost a member their post); it never touches staff or the
 * node's own moderators, which the platform enforces underneath it; and it
 * never sends anything to a model without an account to be judged.
 *
 * The work is split across two runs, because that is how reaching outside
 * works here: `onTrigger` decides whether to ask and declares the request,
 * `onFetch` reads the answer. Nothing survives between them but what the first
 * one wrote down.
 */

import { settingsFrom, usable } from "./config.js";
import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";
import { read as readSignals, worthAsking } from "./signals.js";

const PENDING = "pending:";
const VERDICT = "user:";
const REPORTED_EVENT = "post_flagged";

/** Trimmed hard: the bill is per token, and the tell is in the shape, not the length. */
const EXCERPT = 400;
const SAMPLE = 12;

export async function onTrigger(ctx, api) {
  const settings = settingsFrom(ctx.config);
  if (!usable(settings)) {
    return { effects: [] };
  }

  const reported = ctx.event === REPORTED_EVENT;
  if (!reported && !settings.watch_new_accounts) {
    return { effects: [] };
  }

  const subjectId = reported ? ctx.data?.flagged_user_id : ctx.data?.author_id;
  const post = await api.post.get(ctx.data?.post_id);
  if (!subjectId || !post) {
    return { effects: [] };
  }

  if (exempt(post, settings)) {
    return { effects: [] };
  }

  const known = await api.kv.app.get(`${VERDICT}${subjectId}`);
  if (fresh(known, settings)) {
    // Somebody has already asked. Whether that is an answer for this node too
    // is the installer's call, not this app's.
    if (known.verdict !== "bot") {
      return { effects: [] };
    }
    if (!settings.trust_shared && known.node !== ctx.install_id) {
      return { effects: [] };
    }
    return { effects: [flag(post, known, ctx.locale)] };
  }

  const history = await api.post.recentByUser(subjectId);
  const signals = readSignals(history);
  if (!worthAsking({ reported, signals, settings })) {
    return { effects: [] };
  }

  const requestId = `judge-${post.id}`;

  return {
    effects: [
      {
        type: "kv.set",
        key: `${PENDING}${requestId}`,
        value: { post_id: post.id, user_id: subjectId, username: post.username, signals },
      },
      ask({ settings, post, history, signals, requestId, reported }),
    ],
  };
}

export async function onFetch(ctx, api) {
  const settings = settingsFrom(ctx.config);
  const key = `${PENDING}${ctx.request_id}`;
  const pending = await api.kv.get(key);
  if (!pending) {
    return { effects: [] };
  }

  const done = [{ type: "kv.delete", key }];

  const verdict = parse(ctx);
  // A model that is down, rate-limited or talking nonsense is not evidence of
  // anything. Nothing is written, so the next post from this account tries
  // again rather than inheriting a guess.
  if (!verdict) {
    return { effects: done };
  }

  const record = {
    verdict: verdict.bot ? "bot" : "human",
    confidence: verdict.confidence,
    why: verdict.why,
    model: settings.model,
    node: ctx.install_id,
    at: new Date().toISOString(),
  };

  const effects = [
    ...done,
    { type: "kv.app.set", key: `${VERDICT}${pending.user_id}`, value: record },
  ];

  if (record.verdict === "bot" && settings.action === "flag") {
    effects.push(
      flag({ id: pending.post_id, username: pending.username }, record, ctx.locale)
    );
  }

  return { effects };
}

/** Never judged: staff, and anyone the node has already decided to trust. */
function exempt(post, settings) {
  if (post.staff) {
    return true;
  }
  if (settings.exempt.has(String(post.username).toLowerCase())) {
    return true;
  }
  return Number(post.trust_level ?? 0) >= Number(settings.exempt_trust_level);
}

function fresh(known, settings) {
  if (!known?.at) {
    return false;
  }
  const age = Date.now() - Date.parse(known.at);
  return Number.isFinite(age) && age < settings.verdict_days * 86400 * 1000;
}

// Written in the node's language, because a flag is read by the moderators of
// that node. What the model itself said is passed through as it came back.
function flag(post, record, locale) {
  const t = translator(STRINGS, locale);

  return {
    type: "flag.create",
    post_id: post.id,
    reason: t("flag", {
      model: record.model,
      username: post.username ?? "?",
      confidence: record.confidence
        ? t("confidence", { percent: Math.round(record.confidence * 100) })
        : "",
      why: record.why ? ` ${record.why}` : "",
    }),
  };
}

function ask({ settings, post, history, signals, requestId, reported }) {
  const excerpts = history
    .slice(0, SAMPLE)
    .map((entry, index) => `[${index + 1}] ${String(entry.raw ?? "").slice(0, EXCERPT)}`)
    .join("\n\n");

  const prompt = [
    "You are helping a forum moderator decide whether an account is an automated bot",
    "rather than a person. Bots post generated or copied text, repeat themselves, post",
    "on a fixed schedule, or exist to place links. A person promoting something is not",
    "a bot. Someone writing in a second language, or briefly, or badly, is not a bot.",
    "",
    `The account was ${reported ? "reported by a member" : "noticed automatically"}.`,
    `Measured from its posts: ${JSON.stringify(signals)}`,
    "",
    "Its recent posts:",
    "",
    excerpts,
    "",
    'Answer with JSON only: {"bot": true|false, "confidence": 0.0-1.0, "why": "one short sentence"}',
  ].join("\n");

  return {
    type: "http.fetch",
    request_id: requestId,
    url: settings.endpoint,
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  };
}

/** OpenAI-compatible chat completions: the shape every gateway speaks. */
function parse(ctx) {
  if (!ctx.ok || ctx.status !== 200) {
    return null;
  }

  let answer;
  try {
    const body = JSON.parse(ctx.body);
    answer = body?.choices?.[0]?.message?.content;
  } catch {
    return null;
  }
  if (typeof answer !== "string") {
    return null;
  }

  // Models fence their JSON, or preface it, however plainly they are asked not to.
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.bot !== "boolean") {
      return null;
    }
    return {
      bot: parsed.bot,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      why: typeof parsed.why === "string" ? parsed.why.slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}
