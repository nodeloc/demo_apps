# Remind me

Write `!remindme 2h` in any post and the bot brings the thread back up when the
time is out.

## Using it

```
!remindme 30m
!remindme 6h
!remindme 3d
```

The bot replies straight away to say it heard you, and again when the time
arrives — as a public reply that mentions you, so the site's own notifications
reach you the way any mention does. Anything longer than a month is ignored,
which is almost always a typo.

## Why a reply rather than a private message

A background run may only notify the member whose action woke it, and by the
time a reminder fires that action is hours old. A mention reaches the same
person through machinery the forum already has, and everyone else in the topic
can see the thread being raised rather than wondering why it moved.

## Several people, one reply

Reminders due in the same minute share one scheduled job, and people waiting on
the same topic are named in a single reply. Ten people waiting on one thread get
one post between them, not ten.

## Where to install it

Against the whole site. Installed against one category it still works, but
`!remindme` will silently do nothing everywhere else, which reads as broken.
