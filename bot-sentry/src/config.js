/**
 * What the person who installed this decided.
 *
 * Every default here is the cautious one. An app that helps moderate is
 * installed by someone who has not read its source, so the version that runs
 * before they have configured anything must be the version that does least:
 * it flags rather than deletes, it judges nobody it was not asked about, and
 * with no endpoint set it does nothing at all.
 */

export const DEFAULTS = {
  // "off" | "flag" — deleting is deliberately not offered here. This app
  // decides using somebody else's model, and a model's mistake should cost a
  // moderator ten seconds in the queue, not cost a member their post.
  action: "flag",

  // Judge accounts that were reported, and nothing else. Turning this on judges
  // first-time posters too, which is where most bots are caught — and where
  // most of the API bill comes from.
  watch_new_accounts: false,

  // Nobody with this trust level or above is ever judged. Neither are staff or
  // the node's own moderators, and that is not configurable.
  exempt_trust_level: 2,

  // Too few posts to say anything from. Asking a model to judge one sentence
  // produces confident answers about nothing.
  min_posts: 3,

  // Whether to accept a verdict another node's install reached with its own
  // model. Off by default: shared answers save money, and they also mean
  // somebody else's cheap model deciding about your members.
  trust_shared: false,

  // How long a verdict is worth anything. People change; accounts get sold.
  verdict_days: 90,
};

export function settingsFrom(config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };

  return {
    ...settings,
    endpoint: typeof settings.endpoint === "string" ? settings.endpoint : null,
    model: typeof settings.model === "string" ? settings.model : null,
    apiKey: typeof settings.api_key === "string" ? settings.api_key : null,
    exempt: new Set((settings.exempt_usernames ?? []).map((name) => String(name).toLowerCase())),
  };
}

export function usable(settings) {
  return Boolean(settings.endpoint && settings.model && settings.apiKey && settings.action !== "off");
}
