# Bot sentry

Asks a model whether an account is a machine, and hands the answer to a person.

The model is **yours** — your endpoint, your key, your bill. That is the point:
what counts as a bot is a judgement, judgements differ between nodes, and the
person running a node is the one entitled to make it there.

## Before you install it: what leaves the forum

When this app judges an account, it sends **that account's recent posts** to the
endpoint you configured. Those posts are written by your members, and the
endpoint is a company you chose, not one this forum chose.

Nothing else is sent — no email addresses, no IP addresses, no private
messages, nothing about anybody else. But the posts themselves do leave, and
that is a decision to make deliberately rather than discover later. If you would
not paste a member's posts into a chat window with that provider, do not
configure this app with it.

It sends nothing at all until you set an endpoint, a model and a key.

## Configuring it

| Option | Default | |
|---|---|---|
| `endpoint` | — | An OpenAI-compatible chat completions URL. Nothing runs without it. |
| `model` | — | Model name, as your provider spells it. |
| `api_key` | — | Sent as a bearer token, to that endpoint and nowhere else. |
| `action` | `flag` | `flag` or `off`. There is no `delete` — see below. |
| `watch_new_accounts` | `false` | Also judge first-time posters, not only reported ones. Catches more; costs more. |
| `exempt_trust_level` | `2` | Nobody at this level or above is ever judged. |
| `exempt_usernames` | `[]` | Names never judged, whatever they post. |
| `min_posts` | `3` | Too little to judge from. A model handed one sentence still answers, confidently. |
| `trust_shared` | `false` | Accept a verdict another node reached with its own model. |
| `verdict_days` | `90` | How long a verdict is worth anything. People change; accounts get sold. |

The endpoint's host must be one this app has been approved to reach. The common
providers are approved already; a self-hosted gateway needs its hostname added
in review first.

## It flags. It does not delete.

There is no setting to make it delete, and that is deliberate. A model's mistake
should cost a moderator ten seconds in the review queue, not cost a member their
post. Everything it decides arrives as an ordinary flag, in the queue your node
already has, with the model's reasoning attached — and a note that this is a
model's opinion rather than a finding.

It also never touches staff, and never touches anyone who moderates the node.
That is not a setting either; the platform refuses it underneath this app.

## What it costs

Not every post is sent to your model. Two things stand in the way.

A reported account is always looked at — a person already decided it was worth
someone's attention. An account nobody reported is only looked at if
`watch_new_accounts` is on **and** its posts look unusual on their own: near
identical to each other, almost entirely links, or arriving on a metronome.
Those checks run here, for free, and most posts stop there.

Each question sends at most twelve posts, trimmed to 400 characters each.

## Verdicts are shared, and you decide whether to believe them

A verdict is written where every node running this app can see it, along with
which model reached it and when. That saves everyone the cost of asking twice.

By default your node still asks for itself, because a shared answer also means
somebody else's cheap model deciding about your members. Set `trust_shared` to
`true` if you would rather have the saving.

## When the model is wrong

Deal with the flag the way you deal with any other: dismiss it. Nothing was done
to the member, so there is nothing to undo. If an account was judged wrongly and
the verdict is being reused, ask an admin to clear it — a verdict expires on its
own after `verdict_days` in any case.
