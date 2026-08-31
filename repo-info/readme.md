# Repo info

Somebody drops a GitHub link; the bot says what is on the other end of it —
stars, language, licence, when it was last touched, and whether it has been
archived.

## Why it is worth reading

This is the reference app for reaching outside the forum, and the shape is not
what you would guess. There is no `fetch` in it, and there cannot be: the
sandbox has no network. The handler *declares* a request and returns. The site
makes it, to a host a reviewer approved for this app by name. The answer comes
back as a separate run of `onFetch`.

Two runs, so nothing survives between them except what the first one wrote
down — which is why the topic to reply into is stored before the request is
declared, not held in a variable.

## Approved host

`api.github.com`, and only that. The bot uses the unauthenticated API, which is
rate-limited per host; on a busy forum you may see it go quiet for a while. It
says nothing when GitHub is unreachable, rather than announcing somebody else's
outage in your topic.

## Noise control

One answer per post, and one per repository per topic. A thread about a project
mentions it constantly and nobody needs the star count six times.

## Where to install it

Wherever links get shared. A development or "show off your project" category is
the usual home.
