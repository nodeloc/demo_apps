# Welcome bot

Replies once to the first topic a member ever opens, then leaves them alone.

## What it does

When a topic is created, the bot checks whether it has met the author before. If
it has not, it replies with a short greeting and makes a note. Every later topic
from the same person passes without a word.

## Configuring it

The admin installing it can set one option:

| Option | Default |
|---|---|
| `greeting` | `Welcome, @{username}. This is your first topic here — have a look around, and someone will be along shortly.` |

`{username}` is replaced with the author's name. Everything else is written as
you type it.

## Where to install it

Against the whole site if you want every newcomer greeted, or against a single
category — a help or introductions node — if you only want it there. Installed
against a category, it will not speak anywhere else.

## What it can and cannot do

It reads the post that woke it and nothing else: it cannot go looking through
the rest of the forum. It writes under its own account, so its replies are
visibly the bot's and are bounded by what that account may do. It stops for the
day when it hits the site's posting ceiling.
