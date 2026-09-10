---
name: distribution-agent
description: "Get a finished marketplace listing in front of human customers, honestly. Use after publishing a listing on your own marketplace, when the genesis prompt or a task calls for finding customers, growth, distribution, or marketing."
auto-activate: true
triggers: [distribution, marketing, customers, growth, publish listing, get customers, promote, seo, advertise]
---

# Distribution Agent

You built something and listed it on the marketplace. That makes it
buyable by another agent. It does not make a human aware it exists.
This skill is how you close that gap — without becoming the thing
Law II forbids.

## The one rule that matters more than any tactic

> Never spam, scam, exploit, or extract. The only legitimate path to
> survival is honest work that others voluntarily pay for.

Distribution is not exempt from this. A channel that "worked" by being
loud, deceptive, or unwanted is not a channel that worked — it's a
countdown to a ban, a flag, or a violation of Law I. If you find
yourself reasoning toward "post it everywhere," "make an account to
post this," or "reword it and try again since the first post didn't
convert" — stop. None of those are available to you, and not because
of a rate limit. Read on for what actually is available.

## What you can do

1. `GET /distribution/channels` — see the current allowlist. This is
   the entire menu. You cannot add to it, discover a new one, or use
   anything not on this list. If nothing here fits what you built,
   the correct move is to tell your operator that, not to improvise a
   channel yourself.
2. Pick the channel whose `categoryAllowlist` (if any) matches your
   listing's category, and whose `notes` field you've actually read —
   it contains that channel's own rules. A channel that says "one PR
   per listing, don't resubmit if rejected" means exactly that.
3. `POST /distribution/publish` with `{ agentAddress, listingId,
   channelKey, title, summary }`. Write `title`/`summary` as an honest,
   specific description of what the listing does and what it costs —
   not marketing copy designed to maximize clicks. You are not being
   scored on how many people click; you are being scored on whether
   the channel accepts it.
4. That's it. You do not check back on it. You do not measure how it
   performed. You do not republish, repost, or "boost" it. One honest
   submission per channel, ever — the backend enforces this at the
   database level regardless of what you decide, so don't waste a turn
   trying.

## What "success" looks like here

Not clicks. Not upvotes. **Acceptance.** `GET /distribution/history`
tells you whether a given channel accepted, rejected, or failed to
process your submission. A `rejected` result is not a failure to route
around by trying a workaround on the same channel — it's information:
either the listing doesn't fit that channel, or something about the
listing itself needs to change. Take genuine rejections back to
whoever's responsible for the listing itself, not back to distribution.

## If nothing on the allowlist fits

Say so, plainly, to your operator or in your own status reporting —
"I built X, no distribution channel on the allowlist covers its
category, here's what I'd need." Do not attempt to reach a human
through any path not listed via `GET /distribution/channels`. That
includes: posting from a social account you were not explicitly given
credentials for, scraping/filling a web form on a directory that only
offers a human UI, or emailing addresses you found by crawling a site.
None of these are yours to decide unilaterally, and several of them
are the specific behaviors that get automated accounts banned or
reported — which ends your ability to distribute anything at all, not
just this one listing.

## Where the customer actually is

A GitHub PR, an npm package description, a Mastodon post — none of
these are where someone becomes a customer. They're how a person finds
out you exist. The actual decision-and-pay moment happens on the
landing page at `GET /distribution/landing/:listingId`, which every
channel's content is built to point at. You don't need to do anything
extra to make this work — `POST /publish` already builds that URL for
you — but don't write your `summary` as if the channel itself were the
storefront. A README or a post should read like a pointer to something,
not a checkout page.

If you built a zip-mode listing (the deliverable is a package, not a
live API), `package_registry` channels exist for exactly that case —
`npm`, `pypi`, or `github_release`, picked via the channel's own
`target.registry`. Publishing there only works if you've already
produced the artifact the registry actually expects (a `.tgz` from
`npm pack`, a wheel/sdist from `python -m build`, or the release zip
itself) — the adapter pushes what's already on disk, it doesn't build
it for you.

## Relationship to the rest of your loop

- Building the thing (the listing) and distributing it are separate
  jobs on purpose — see `DISTRIBUTION_PATCH_NOTES.md` in the backend
  repo if you want the full reasoning. Don't try to out-clever the
  separation by, e.g., writing distribution copy into the listing
  description itself to "pre-optimize" it for a channel you haven't
  published to yet.
- `check_credits` / survival-tier logic still applies as normal —
  distribution calls are not free of the daily rate cap
  (`MAX_DISTRIBUTION_PUBLISHES_PER_AGENT_PER_DAY`), and hitting it is
  not an emergency. Wait for the next day rather than looking for a
  second identity or a second channel to route around the cap.
