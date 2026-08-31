/**
 * Answers a post that matches a rule with the reply that rule carries.
 *
 * The forum's version of the thing every large community ends up writing by
 * hand: the same six answers, posted by the same tired people, to the same six
 * questions. Rules are configuration rather than code, so changing an answer is
 * an admin editing a field instead of an author shipping a version through
 * review.
 *
 * It answers; it never removes. Deleting somebody's post is a moderator's
 * judgement and an app has no business making it — and this one could not if it
 * wanted to, since nothing it can declare reaches anyone else's content.
 *
 * Rules are written a line at a time, pattern first:
 *
 *   how do I reset my password => You can do it yourself at /my/preferences/account.
 *
 * That shape exists because the person configuring this opened a node, not a
 * text editor. The older array-of-objects form is still read, so an install
 * made before this keeps working.
 */

const ANSWERED = "answered:";
const MAX_RULES = 20;

function compile(rule) {
  try {
    // A rule somebody typed wrong is a rule that never matches, not an app that
    // fails on every post in the forum from then on.
    return new RegExp(rule.match, typeof rule.flags === "string" ? rule.flags : "i");
  } catch {
    return null;
  }
}

/**
 * One rule a line, `pattern => reply`. Anything without an arrow is somebody
 * halfway through typing, and is skipped rather than treated as a rule that
 * matches everything.
 */
function parseRules(config) {
  if (Array.isArray(config?.rules)) {
    return config.rules;
  }
  if (typeof config?.rules !== "string") {
    return [];
  }

  return config.rules
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=>");
      if (at === -1) {
        return null;
      }
      const match = line.slice(0, at).trim();
      const reply = line.slice(at + 2).trim();
      return match && reply ? { match, reply } : null;
    })
    .filter(Boolean);
}

function firstMatch(rules, raw) {
  for (const rule of rules.slice(0, MAX_RULES)) {
    if (typeof rule?.match !== "string" || typeof rule?.reply !== "string") {
      continue;
    }
    const pattern = compile(rule);
    if (pattern?.test(raw)) {
      return rule;
    }
  }
  return null;
}

export async function onTrigger(ctx, api) {
  const rules = parseRules(ctx.config);
  if (rules.length === 0) {
    return { effects: [] };
  }

  const post = await api.post.get(ctx.data.post_id);
  if (!post) {
    return { effects: [] };
  }

  // Answered once, whatever happens to the post afterwards. Without this an
  // edit re-triggers the rule and the bot answers the same post again, which is
  // the failure mode people actually hit — editing a typo, not gaming the bot.
  const key = `${ANSWERED}${post.id}`;
  if (await api.kv.get(key)) {
    return { effects: [] };
  }

  const rule = firstMatch(rules, post.raw);
  if (!rule) {
    return { effects: [] };
  }

  return {
    effects: [
      { type: "kv.set", key, value: rule.match },
      {
        type: "post.reply",
        topic_id: post.topic_id,
        raw: rule.reply,
        reply_to_post_number: post.post_number,
      },
    ],
  };
}
