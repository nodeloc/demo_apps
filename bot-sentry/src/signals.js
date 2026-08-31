/**
 * What can be told from the posts themselves, before anybody's model is asked.
 *
 * Two reasons this exists. An API call costs its owner money on every post the
 * forum receives, and most posts are obviously nothing. And a model handed a
 * single sentence will still answer confidently, so the cheapest way to avoid a
 * confident wrong answer is not to ask.
 *
 * Nothing here decides anything. It decides whether the question is worth
 * asking, and it hands the model what it noticed.
 */

const MINUTE = 60 * 1000;

/** How alike two posts are, by the words they share. Cheap and good enough. */
function overlap(a, b) {
  const left = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const right = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / Math.min(left.size, right.size);
}

function repetition(posts) {
  if (posts.length < 2) {
    return 0;
  }

  let worst = 0;
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      worst = Math.max(worst, overlap(posts[i].raw ?? "", posts[j].raw ?? ""));
    }
  }
  return worst;
}

/** Posting on a metronome is the one thing people almost never do. */
function regularity(posts) {
  const times = posts
    .map((post) => Date.parse(post.created_at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 4) {
    return null;
  }

  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push((times[i] - times[i - 1]) / MINUTE);
  }

  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean <= 0) {
    return null;
  }

  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
  // Coefficient of variation: near zero means every gap is the same gap.
  return { meanMinutes: Math.round(mean), spread: Math.sqrt(variance) / mean };
}

export function read(posts) {
  const sample = posts.slice(0, 25);

  return {
    posts: sample.length,
    repetition: Number(repetition(sample).toFixed(2)),
    cadence: regularity(sample),
    linkRatio: Number(
      (sample.filter((post) => /https?:\/\//.test(post.raw ?? "")).length / Math.max(sample.length, 1)).toFixed(2)
    ),
    distinctTopics: new Set(sample.map((post) => post.topic_id)).size,
  };
}

/**
 * Whether this is worth asking about at all.
 *
 * A reported account always is — somebody has already decided it is worth
 * somebody's attention, and that somebody was a person. An account nobody
 * reported has to look unusual first.
 */
export function worthAsking({ reported, signals, settings }) {
  if (signals.posts < settings.min_posts) {
    return false;
  }
  if (reported) {
    return true;
  }

  return (
    signals.repetition >= 0.6 ||
    signals.linkRatio >= 0.8 ||
    (signals.cadence !== null && signals.cadence.spread < 0.15)
  );
}
