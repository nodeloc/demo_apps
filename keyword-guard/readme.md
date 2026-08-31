# Keyword guard

Answers a post that matches a rule with the reply that rule carries. The same
six answers to the same six questions, without the same tired people writing
them out again.

## Writing the rules

One a line, pattern first:

```
how do I (reset|change) my password => You can do it yourself at /my/preferences/account.
(is the site|are you) down => Status is at status.example.com — if it is green there, tell us what you are seeing.
```

They are tried in order and the first match wins. The pattern is a regular
expression and is not case-sensitive. A pattern that will not compile never
matches — a typo costs you that rule, not the app. At most 20 rules are
considered.

## What it will not do

It answers; it never removes, locks or edits. Deciding that a post should not
stand is a moderator's judgement, and this app could not act on it if it wanted
to: nothing it is able to declare reaches anybody else's content.

Each post is answered at most once, no matter how often it is edited afterwards.

## Where to install it

Usually one category — a help or support node, where the same questions actually
recur. Installed site-wide it will answer everywhere, which is rarely what you
want from a canned reply.
