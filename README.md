# PGA Championship Friends Draft Tracker

Live standings tracker for a 9-team friend group fantasy draft at the 2026 PGA Championship.

## Rules

- Each team drafts 5 PGA Tour pros
- Best 3 scores per team are added; lowest total wins
- **Cut penalty:** if fewer than 3 players on a team make the cut, each empty counting slot is filled with `(worst made-cut score) + 2`. Updates live as the worst made-cut score moves.

## Stack

Single static `index.html`. Fetches `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard` directly from the browser (ESPN allows CORS). Auto-refreshes every 60 seconds. No backend, no build step.

## Local

Open `index.html` in any browser.

To verify scoring math against live data:

```sh
node test.mjs
```
