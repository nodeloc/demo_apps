/**
 * Greets a member the first time they open a topic, and never again.
 *
 * "Never again" is the whole app. A greeter that cannot remember who it has
 * already met is a greeter that welcomes the same person every week, which
 * reads as broken rather than friendly — so the remembering is the part worth
 * getting right, not the sentence.
 *
 * Config (set by whoever installs it):
 *   greeting    a template; {username} is replaced. Left blank, the app
 *               greets each newcomer in the language they read the site in.
 *   pin_reply   keep the greeting at the top of the topic.
 *   lock_reply  let nobody reply under the greeting itself.
 */

import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";

const GREETED = "greeted:";

export async function onTrigger(ctx, api) {
  if (ctx.event !== "topic_created") {
    return { effects: [] };
  }

  const post = await api.post.get(ctx.data.post_id);
  // A topic whose first post is missing is a topic being deleted as we read it.
  if (!post || !post.is_first_post) {
    return { effects: [] };
  }

  const key = `${GREETED}${post.user_id}`;
  if (await api.kv.get(key)) {
    return { effects: [] };
  }

  // Their language first, the forum's second. A greeting is addressed to one
  // person, so it is the one thing here worth saying in their own words — and
  // a greeting written by hand is used exactly as written, in any language.
  const t = translator(STRINGS, post.locale, ctx.locale);
  const greeting = ctx.config?.greeting
    ? ctx.config.greeting.replace(/\{username\}/g, post.username)
    : t("greeting", { username: post.username });

  return {
    effects: [
      // Written before the reply rather than after, because the two are
      // committed together: if the reply is refused — a quota, a locked
      // category — the note that we greeted them is rolled back with it, and
      // the next topic gets another try.
      { type: "kv.set", key, value: post.topic_id },
      {
        type: "post.reply",
        topic_id: post.topic_id,
        raw: greeting,
        // Both ride on the reply itself: the post they act on does not exist
        // until it has been written. Either needs the moderate.topic scope,
        // and the bot only reaches it in a node it moderates.
        pin: ctx.config?.pin_reply === true,
        lock: ctx.config?.lock_reply === true,
        collapse: ctx.config?.collapse_reply === true,
      },
    ],
  };
}
