/**
 * Somebody drops a GitHub link; the bot says what is on the other end of it.
 *
 * This is the reference for reaching outside. Note what it does *not* do: there
 * is no `fetch` here and there cannot be. The handler declares an `http.fetch`
 * and returns; the site makes the request, against a host a reviewer approved
 * for this app by name; and the answer arrives as a separate `onFetch` run,
 * carrying back the request_id this one chose.
 *
 * So the work is split in two, and the only thing that survives between the
 * halves is what the first half wrote down.
 */

// Matched loosely and then cleaned up, rather than trying to spell out every
// way a link can end. A URL sitting in prose is followed by a space, a comma or
// a full stop as often as by a slash, and an anchored terminator quietly missed
// all three.
import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";

const REPO = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i;
const ASKED = "asked:";
const SEEN = "seen:";

export async function onTrigger(ctx, api) {
  // Both, because the first post of a topic arrives as `topic_created` and not
  // as `post_created` — and the opening post is where a link is usually shared.
  if (ctx.event !== "post_created" && ctx.event !== "topic_created") {
    return { effects: [] };
  }

  const post = await api.post.get(ctx.data.post_id);
  if (!post) {
    return { effects: [] };
  }

  const match = REPO.exec(post.raw ?? "");
  if (!match) {
    return { effects: [] };
  }

  const owner = match[1];
  const name = match[2].replace(/\.git$/i, "").replace(/\.+$/, "");
  if (!name) {
    return { effects: [] };
  }

  const repo = `${owner}/${name}`;

  // One answer per post, and one per repo per topic: a thread about a project
  // mentions it constantly, and nobody needs the star count six times.
  const seen = `${SEEN}${post.topic_id}:${repo.toLowerCase()}`;
  if (await api.kv.get(seen)) {
    return { effects: [] };
  }

  const requestId = `repo-${post.id}`;

  return {
    effects: [
      { type: "kv.set", key: seen, value: post.id },
      // Where to reply is written down now, because the run that receives the
      // answer is a different one and knows nothing about this post.
      {
        type: "kv.set",
        key: `${ASKED}${requestId}`,
        value: { topic_id: post.topic_id, post_number: post.post_number, repo },
      },
      {
        type: "http.fetch",
        request_id: requestId,
        url: `https://api.github.com/repos/${owner}/${name}`,
        method: "GET",
        headers: { accept: "application/vnd.github+json" },
      },
    ],
  };
}

export async function onFetch(ctx, api) {
  const key = `${ASKED}${ctx.request_id}`;
  const asked = await api.kv.get(key);
  if (!asked) {
    return { effects: [] };
  }

  const done = [{ type: "kv.delete", key }];

  // Somebody else's service being down is not something to announce in a topic.
  if (!ctx.ok || ctx.status !== 200) {
    return { effects: done };
  }

  let repo;
  try {
    repo = JSON.parse(ctx.body);
  } catch {
    return { effects: done };
  }

  if (repo?.full_name == null) {
    return { effects: done };
  }

  return {
    effects: [
      ...done,
      {
        type: "post.reply",
        topic_id: asked.topic_id,
        reply_to_post_number: asked.post_number,
        // The node's language: this is a reply everybody in the topic reads.
        raw: describe(translator(STRINGS, ctx.locale), repo),
      },
    ],
  };
}

function describe(t, repo) {
  const lines = [`**${repo.full_name}** — ${repo.description || t("no_description")}`];
  const facts = [];

  if (typeof repo.stargazers_count === "number") {
    facts.push(t("stars", { count: repo.stargazers_count.toLocaleString("en-US") }));
  }
  if (repo.language) {
    facts.push(repo.language);
  }
  if (repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION") {
    facts.push(repo.license.spdx_id);
  }
  if (repo.pushed_at) {
    facts.push(t("last_push", { date: repo.pushed_at.slice(0, 10) }));
  }
  if (repo.archived) {
    facts.push(t("archived"));
  }

  if (facts.length) {
    lines.push(facts.join(" · "));
  }

  return lines.join("\n\n");
}
