# Daily thread

Opens the same topic every day, in a category you choose.

## Configuring it

Set on the install, by the admin who puts it to work:

| Option | Default | |
|---|---|---|
| `category_id` | — | **Required.** Nothing is posted until it is set. |
| `title` | `Daily thread — {date}` | `{date}` becomes `2026-08-30`. |
| `body` | a short prompt | The opening post. |
| `every_hours` | `24` | Use `168` for a weekly thread. |

## What to expect

The first thread goes out about a minute after install, so you can see it work
rather than take it on faith, and then on the interval you set.

It will not open two threads for the same day. A restart, a clock adjustment or
a job firing twice all resolve to one thread, because the day it last posted is
written down alongside the post itself.

## Where to install it

Against the whole site, or against the category you are posting into — either
works, but a category install can only ever post there, which is a useful thing
to hold it to.
