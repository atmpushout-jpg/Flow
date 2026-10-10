# Edge test: can a new auction router earn its fee on Base?

Status: draft test plan for step 1 of the 3-step plan (prove the edge on paper).
Not run yet. Costs $0.

## Why this test exists

The "auction bots for order flow" design is already live on Base:

- **UniswapX** — Uniswap's intent-based execution layer — runs RFQ auctions on
  Base (chainId 8453). Users sign intents; fillers compete in auctions to fill
  them. (Uniswap docs changelog, posted June 13, 2026)
- **1inch Fusion** — intent-based trading, resolvers fill orders via Dutch
  auctions — supports Base (chainId 8453).

So the question is not "does the idea work" — it works for them. The real
question is: **can your version beat the existing auction routers by enough
margin to charge a take?** If not, no code will fix it. This test answers that
before you spend anything.

## The test (one weekend, $0)

1. **Collect 1,000 real Base swaps.** Read recent `Swap` events from the top
   Uniswap v3 and Aerodrome pools on Base with any free public RPC
   (`eth_getLogs`). Save: token pair, amountIn, block number.
2. **Reconstruct the direct baseline** for each swap: call a free quoter
   (1inch swap API free tier, or Uniswap v3 `QuoterV2` via RPC at that block)
   for the classic-route amountOut.
3. **Get the auction competitors' answers** for the same swaps: request quotes
   from the Uniswap API with `UNISWAPX_V3` in the protocols field, and from the
   1inch Fusion quote endpoint. These run the exact model Flow proposes, live.
4. **Compute the net edge** per swap: `(auctionOut − baselineOut) /
   baselineOut`, in bps, then subtract Flow's intended ~8 bps take. Look at the
   **median and the distribution** — not just the average.
5. **Decide**: if median net edge vs. the best existing auction router is
   **below 10 bps**, stop — there is no gap to monetize, and building the
   protocol will not create one. If it is **above 10 bps** on a meaningful
   share of swaps, there is a real edge, and the data shows which pairs and
   sizes it lives in.

## Honest caveats

- Quote APIs give indicative prices; real fills differ (slippage, faded fills).
  This measures *quoted* edge, not *filled* edge. Paper-trading real fills
  comes after.
- Free API tiers have rate limits; batch the 1,000 swaps and cache aggressively.
- To watch the competition's auctions live, Uniswap publishes open orders:
  `GET https://api.uniswap.org/v2/orders?orderStatus=open&chainId=8453&orderType=Dutch_V3`
  (max 50 per response, poll at most 4 req/s).

## Sources (checked 2026-10-10)

- UniswapX RFQ auctions on Base/Arbitrum:
  https://github.com/uniswap/docs/blob/HEAD/content/changelog/active-notifications/uniswapx-rfq-auctions-on-base-and-arbitrum.mdx
- UniswapX fillers overview (Base runs Dutch V3 auctions):
  https://developers.uniswap.org/docs/liquidity/uniswapx/filling/overview
- 1inch Fusion supports Base (chain 8453):
  https://github.com/velocity-bpa/n8n-nodes-1inch
- 1inch chain support incl. Base:
  https://eco.com/support/en/articles/13314092-best-dex-aggregators-in-2026-1inch-jupiter-paraswap-and-more
