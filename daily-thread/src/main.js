/**
 * Opens the same topic every day, so the community has somewhere to be.
 *
 * The interesting part is `onInstall`. Nothing else can start this app: a
 * scheduled handler only fires for a job that already exists, and a job only
 * exists because an effect asked for one. So the first `schedule.add` has to
 * come from the run an install gets, and everything here has to survive being
 * run again — a re-install, a playtest push — without opening a second thread.
 *
 * Config (set by the admin who installs it):
 *   category_id   where to open the topic       (required)
 *   title         a template; {date} is replaced
 *   body          the opening post
 *   every_hours   how often, in hours           (default 24)
 */

import { translator } from "./i18n.js";
import { STRINGS } from "./strings.js";

const JOB = "open-the-thread";
const LAST = "last-opened";

function scheduleEffect(ctx) {
  const hours = Number(ctx.config?.every_hours) || 24;

  return {
    type: "schedule.add",
    job_key: JOB,
    // The first one goes out shortly after install rather than a day later, so
    // whoever installed it can see it work instead of taking it on faith.
    in_seconds: 60,
    every_seconds: Math.max(hours, 1) * 3600,
  };
}

export async function onInstall(ctx) {
  return { effects: [scheduleEffect(ctx)] };
}

export async function onSchedule(ctx, api) {
  const categoryId = Number(ctx.config?.category_id);
  // Nothing to do rather than something wrong: an admin who has not chosen a
  // category yet should get silence, not a topic in the wrong place.
  if (!categoryId) {
    return { effects: [] };
  }

  const today = new Date().toISOString().slice(0, 10);
  // A repeating job that fires twice — a restart, a clock adjustment — must not
  // open the day's thread twice.
  if ((await api.kv.get(LAST)) === today) {
    return { effects: [] };
  }

  // The forum's own language: this is a topic everybody in the node reads, not
  // an answer to one person. A title or body written by hand wins over both.
  const t = translator(STRINGS, ctx.locale);
  const title = (ctx.config?.title || t("title", { date: today })).replace(/\{date\}/g, today);

  return {
    effects: [
      { type: "kv.set", key: LAST, value: today },
      {
        type: "post.create",
        category_id: categoryId,
        title,
        raw: ctx.config?.body || t("body"),
      },
    ],
  };
}
