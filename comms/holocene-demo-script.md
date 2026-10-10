# holocene demo package — ready for screenshot + post
Prepared 2026-10-10 ~10:20 EDT. Pairs with `holocene-reply-draft.md` (reply text, NOT posted — needs Atm's go-ahead).

## What this is
Atm's commitment: "run a quick test showing holocene exactly how Flow's business could help him, delivered as a screenshot or small video, expected to get holocene to respond back fast."

Deliverable 1: `holocene-demo-card.html` — a screenshot-ready card built on a REAL quote (not mock data).
Deliverable 2: this script — 30-second narration if Atm wants a video, or caption text for the screenshot post.

## The real numbers on the card (verified)
Source: FlowAgent explainer run, stats/explanation.json, generated 2026-10-10T11:32:16Z.
- Test: $100 USDC → WETH on Base mainnet
- venue: aerodrome (best price, edgeBps 1 over Uniswap V3 baseline)
- blockNumber 52421295, quotedAt 2026-10-10T11:32:16Z, latencyMs 92
- liquidity "deep", spreadBps 0
- Field names verified against api/_lib.js (bestOut, venue, edgeBps, blockNumber, quotedAt, latencyMs, liquidity, spreadBps)

Honesty notes baked into the card:
- The edge shown is 1 bps — deliberately NOT inflated. The card's argument is verifiable freshness (block number, 92ms build, deep flag), which is exactly holocene's question, not a huge-savings claim.
- Footer labels the capture time and block so nobody mistakes it for a live ticker.

## 30-second narration (if recording)
"You're an agent about to swap a hundred USDC for WETH. Your real risk isn't picking the wrong venue — it's acting on a stale quote. One call to Flow: it picks Aerodrome, beats the baseline by a basis point, and — here's the part that matters — it tells you the quote was priced at block 52,421,295, built in 92 milliseconds, and that liquidity is deep so the edge survives execution. You check the block delta, set your own slippage bound, and go. Worst case, the router enforces your minimum output on-chain. That's the business: trustworthy quotes, not promises."

## Screenshot instructions (for the delivering agent)
1. Open `comms/holocene-demo-card.html` in a browser at ~800px viewport width.
2. Screenshot the full card. Dark background is intentional (matches Flow branding).
3. Freshness option: if the flow-explainer cron has produced a newer stats/explanation.json by post time, refresh the seven numbers (venue, edgeBps, blockNumber, quotedAt, latencyMs, liquidity, spreadBps) and the footer timestamp before screenshotting. Do NOT invent numbers.
4. Post together with the reply draft in `holocene-reply-draft.md` — Atm's go-ahead required before anything goes to The Colony.
