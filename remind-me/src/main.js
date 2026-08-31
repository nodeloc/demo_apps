/**
 * "!remindme 2h" — the bot says it heard you, and comes back when it is time.
 *
 * The reminder arrives as a public reply that mentions you, not as a private
 * notification. That is deliberate: a background run may only notify the member
 * whose action woke it, and by the time a reminder fires that member's action
 * is hours old. A mention reaches the same person through the site's own
 * notifications, and has the side benefit that everybody else in the topic can
 * see the thread being brought back up rather than wondering why.
 *
 * Each pending reminder is one scheduled job, and an install may only hold a
 * few at a time, so this keeps one job per due-minute bucket and stores the
 * people waiting under it.
 */

import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";

const COMMAND = /!remindme\s+(\d{1,3})\s*(m|min|mins|h|hr|hrs|d|day|days)\b/i;
const PENDING = "pending:";
const MAX_SECONDS = 30 * 24 * 60 * 60;

const UNITS = { m: 60, min: 60, mins: 60, h: 3600, hr: 3600, hrs: 3600, d: 86400, day: 86400, days: 86400 };

function parseDelay(raw) {
  const match = COMMAND.exec(raw ?? "");
  if (!match) {
    return null;
  }

  const seconds = Number(match[1]) * UNITS[match[2].toLowerCase()];
  // A reminder further out than a month is almost always a typo, and it would
  // hold a scheduled job hostage for the whole time.
  return seconds > 0 && seconds <= MAX_SECONDS ? seconds : null;
}

/** One job per minute of the clock, so many reminders share a handful of jobs. */
function bucketFor(seconds) {
  return String(Math.ceil(seconds / 60));
}

export async function onTrigger(ctx, api) {
  // Both, because the first post of a topic arrives as `topic_created` and not
  // as `post_created` — an app that watches only the latter silently ignores
  // every opening post on the forum.
  if (ctx.event !== "post_created" && ctx.event !== "topic_created") {
    return { effects: [] };
  }

  const post = await api.post.get(ctx.data.post_id);
  if (!post) {
    return { effects: [] };
  }

  const seconds = parseDelay(post.raw);
  if (seconds === null) {
    return { effects: [] };
  }

  const t = translator(STRINGS, post.locale, ctx.locale);
  const bucket = bucketFor(seconds);
  const key = `${PENDING}${bucket}`;
  const waiting = (await api.kv.get(key)) ?? [];

  return {
    effects: [
      {
        type: "kv.set",
        key,
        // The asker's language is written down with them: the run that fires
        // the reminder is a different one and knows nothing about them.
        value: [
          ...waiting,
          {
            username: post.username,
            topic_id: post.topic_id,
            post_number: post.post_number,
            locale: post.locale,
          },
        ],
      },
      {
        type: "schedule.add",
        job_key: `due-${bucket}`,
        in_seconds: Number(bucket) * 60,
        payload: { bucket },
      },
      {
        type: "post.reply",
        topic_id: post.topic_id,
        // Answered in the language of whoever typed the command.
        raw: t("noted", { username: post.username, when: describe(t, seconds) }),
        reply_to_post_number: post.post_number,
      },
    ],
  };
}

export async function onSchedule(ctx, api) {
  const bucket = ctx.payload?.bucket;
  if (!bucket) {
    return { effects: [] };
  }

  const key = `${PENDING}${bucket}`;
  const waiting = (await api.kv.get(key)) ?? [];
  if (waiting.length === 0) {
    return { effects: [{ type: "schedule.cancel", job_key: `due-${bucket}` }] };
  }

  // Grouped by topic so ten people waiting on one thread get one reply between
  // them rather than ten, which is the difference between a reminder and a
  // pile-on.
  const byTopic = new Map();
  for (const entry of waiting) {
    const group = byTopic.get(entry.topic_id) ?? [];
    group.push(entry);
    byTopic.set(entry.topic_id, group);
  }

  // One reply per topic, so it is written in the language most of the people
  // waiting on that topic read — with the forum's own as the tie-break.
  const replies = [...byTopic.entries()].map(([topic_id, entries]) => {
    const t = translator(STRINGS, commonest(entries.map((entry) => entry.locale)), ctx.locale);
    const names = [...new Set(entries.map((entry) => entry.username))];

    return {
      type: "post.reply",
      topic_id,
      raw: t("due", { names: names.map((name) => `@${name}`).join(" ") }),
    };
  });

  return {
    effects: [
      { type: "kv.delete", key },
      { type: "schedule.cancel", job_key: `due-${bucket}` },
      ...replies,
    ],
  };
}

function describe(t, seconds) {
  if (seconds >= 86400) {
    return t("days", { n: Math.round(seconds / 86400) });
  }
  if (seconds >= 3600) {
    return t("hours", { n: Math.round(seconds / 3600) });
  }
  return t("minutes", { n: Math.round(seconds / 60) });
}

/** Whichever language most of them read. Ties go to whoever asked first. */
function commonest(locales) {
  const counts = new Map();
  for (const locale of locales.filter(Boolean)) {
    counts.set(locale, (counts.get(locale) ?? 0) + 1);
  }

  let best = null;
  for (const [locale, count] of counts) {
    if (best === null || count > counts.get(best)) {
      best = locale;
    }
  }
  return best;
}
