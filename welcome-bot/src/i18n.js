/**
 * Saying the same thing in whatever language the reader has.
 *
 * `ctx.locale` is the forum's own language for anything an app posts, because
 * a post is read by everybody in the topic. Where an app is answering one
 * person — a greeting, a reminder — `post.locale` carries theirs, and that is
 * the better one to use.
 *
 * Fallback runs exact, then the same language written for anywhere else, then
 * English. An app that wrote `zh_CN` should not leave a `zh_TW` reader with
 * English: Simplified is much closer to what they read than that.
 */

export function translator(strings, ...locales) {
  const table = strings[pick(strings, locales)] ?? strings.en ?? {};
  const fallback = strings.en ?? {};

  return (key, vars = {}) => {
    const line = table[key] ?? fallback[key] ?? key;
    return line.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : whole
    );
  };
}

function pick(strings, locales) {
  const available = Object.keys(strings);

  for (const locale of locales.filter(Boolean).map(String)) {
    if (available.includes(locale)) {
      return locale;
    }

    const language = locale.split(/[-_]/)[0];
    const near = available.find((key) => key.split(/[-_]/)[0] === language);
    if (near) {
      return near;
    }
  }

  return "en";
}
