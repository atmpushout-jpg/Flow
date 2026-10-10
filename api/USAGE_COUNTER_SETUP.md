# Fix: make API usage visible (shared counter)

## What was wrong
`/api/stats` always showed 0 because on Vercel each API route runs in its
own isolated process. The quote counter lived in the `/api/quote` process's
memory, which `/api/stats` could never see. The dashboard's "Total Quotes
Served" read a `stats/total.json` file that nothing ever updated — also 0.

## The fix (already coded, needs 5 minutes from you to activate)
Counts now live in a tiny free shared database (Upstash Redis) instead of
memory. No new code libraries, no cost, no signup that needs a card.

**Step 1 — Create the free database (2 min)**
1. Go to upstash.com and sign up free.
2. Create a Redis database (any region, free tier is fine).
3. On its details page copy two values: **REST URL** and **REST TOKEN**.

**Step 2 — Paste them into Vercel (2 min)**
1. Open your Vercel dashboard → the Flow project → Settings → Environment Variables.
2. Add `UPSTASH_REDIS_REST_URL` = the REST URL you copied.
3. Add `UPSTASH_REDIS_REST_TOKEN` = the REST token you copied.
4. Redeploy (Deployments → ⋯ → Redeploy).

**Step 3 — Check it worked (1 min)**
1. Open `https://flow-kg4x.vercel.app/api/stats` — it should say `"store": "upstash"`.
2. Hit the quote API once, refresh `/api/stats` — the number goes up.
3. The Mission Control dashboard's "Total Quotes Served" starts climbing too.

## If you skip the env vars
Everything keeps working exactly like before (per-instance approximate
counters). Quotes never break if the database is down — the code falls back
to memory and keeps serving.
