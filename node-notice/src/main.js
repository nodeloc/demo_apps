/**
 * Posts a node's standing notice under new topics, and keeps it at the top.
 *
 * The hard part is not the sentence — it is not becoming wallpaper. A notice
 * on every topic is read once and then stops being seen, which is why the
 * default here is to say it to each person once rather than to say it always;
 * the node owner can choose the louder setting when the point is that nobody
 * can claim they were not told.
 *
 * Config (set by whoever installs it):
 *   notice      what to say, in the owner's own words. {username} is replaced.
 *   audience    "newcomers" (once per person) or "everyone" (every topic)
 *   pin         keep it above the replies
 *   skip_staff  say nothing under topics opened by staff
 */

import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";

const TOLD = "told:";

export async function onTrigger(ctx, api) {
  if (ctx.event !== "topic_created") {
    return { effects: [] };
  }

  const notice = ctx.config?.notice?.trim();
  if (!notice) {
    return { effects: [] };
  }

  const post = await api.post.get(ctx.data.post_id);
  // A topic whose first post is missing is a topic being deleted as we read it.
  if (!post || !post.is_first_post) {
    return { effects: [] };
  }

  if (post.staff && ctx.config?.skip_staff !== false) {
    return { effects: [] };
  }

  const everyone = ctx.config?.audience === "everyone";
  const told = `${TOLD}${post.user_id}`;
  if (!everyone && (await api.kv.get(told))) {
    return { effects: [] };
  }

  // The forum's language, not the author's: this one is posted in their topic
  // where everyone who opens it will read it, unlike a greeting addressed to
  // one person.
  const t = translator(STRINGS, ctx.locale);
  const body = [
    notice.replace(/\{username\}/g, post.username),
    "---",
    `*${t("footer")}*`,
  ].join("\n\n");

  const effects = [
    {
      type: "post.reply",
      topic_id: post.topic_id,
      raw: body,
      pin: ctx.config?.pin !== false,
    },
  ];

  // Recorded even in "everyone" mode, so switching the setting down later does
  // not start the count over and tell the regulars all over again.
  //
  // Written alongside the reply rather than after it because the two commit
  // together: if the reply is refused, the note that we told them is rolled
  // back with it and their next topic gets another try.
  if (!(await api.kv.get(told))) {
    effects.unshift({ type: "kv.set", key: told, value: post.topic_id });
  }

  return { effects };
}
