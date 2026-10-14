# Flow Agent API — Integration Guide

**For AI trading agents on Base. Get the best swap price across Uniswap V3 + Aerodrome in one call.**

## Why use this instead of calling Uniswap directly?

- We check 7 venues (3 Uniswap tiers + 4 Aerodrome spacings) in ~600ms
- You get the best price, not the default price
- Observed edges up to 147bps on USDC→AERO vs Uniswap alone
- One API call replaces multi-DEX integration code

## Quick start

**1. Get a quote:**

```bash
curl -X POST https://flow-kg4x.vercel.app/quote \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "tokenOut": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    "amountIn": "10000000"
  }'
```

Response:
```json
{
  "amountIn": "10000000",
  "bestOut": "12168731994703420456",
  "venue": "aerodrome",
  "venueKey": 100,
  "uniswapOut": "12166311182456234150",
  "edgeBps": 1,
  "protocolFee": "25% of price improvement over Uniswap baseline"
}
```

**2. Execute (coming soon):**

Sign an EIP-712 intent and POST to `/fill`. The filler uses a flash loan —
you don't need inventory, just approve the token transfer.

## Fee model

- **0 bps base fee.** We only earn when we beat the Uniswap baseline.
- **25% of price improvement** goes to the protocol.
- If we can't beat Uniswap, you pay nothing extra.
- **Referral program:** add `"referrer": "0x…"` to a `/api/fill` request and earn **25% of Flow's improvement cut** on every fill you refer (Flow keeps 75%). The payer settles your share directly via x402 at settlement time — two authorizations in one request: Flow's share in `X-PAYMENT`, yours in `X-PAYMENT-REFERRER`, both listed in the 402's `accepts[]`. No custody, no IOUs.
- **Enrolled agents quote free:** if your wallet is on Flow's enrolled list (company AI enrollment), `/api/quote` skips the $0.01 challenge — identify in the request body with `"agent": "0x…"` and `"agentSig"`, an EIP-191 signature (`signMessage`) over `flow:quote:free:<agent>:<tokenIn>:<tokenOut>:<amountIn>` (addresses lowercased, amountIn verbatim).
- **Enrolled agents pay $0.005 for data calls:** `/api/signals`, `/api/smart-wallets`, and `/api/verify` charge enrolled agents **$0.005** instead of the standard price ($0.01 / $0.01 / $0.02), proven with the same signature discipline. On the GET endpoints, pass `agent`, `agentSig`, and `ts` (unix seconds) as query params: `agentSig` signs `flow:data:<agent>:<path>:<params>`, where `<params>` is the sorted `k=v` rendering of the signed params joined by `&` — `ts` always, plus `since`/`limit` on `/api/signals` when sent — with the agent lowercased and values verbatim; `ts` must be within ±300 seconds of server time. On `/api/verify` (POST), put `"agent"` and `"agentSig"` in the JSON body, signed over `flow:data:<agent>:/api/verify:address=<address>` (append `&chain=<chain>` when the body carries one; address and chain lowercased). Invalid or absent identity gets the standard challenge, unchanged.

## For agent frameworks

**Eliza / LangChain / custom agents:** treat `/quote` as a tool call.
Input: token addresses + amount. Output: best venue + expected output.
No API key required (MVP).

## Liquidation forecaster — `/api/forecaster` ($0.05)

**For keeper/liquidator agents and risk watchers on Aave (Base).**

`GET https://flow-kg4x.vercel.app/api/forecaster` — pay-per-call via x402,
**$0.05 USDC on Base**. Returns the current board from Flow's own
liquidation watcher: the Aave Base borrowers projected to cross health
factor 1.0 (or already below it), most urgent first. Per borrower:
address, `status` (crossed|approaching), current `hf`,
`hfVelocityPerBlock`, `blocksToCross` (+ `estSecondsToCross` at ~2s
Base blocks), `debtAsset` / `collateralAsset`, `coverUsd`, and
`projectedNetUsd` / `latestNetUsd` where the watcher has computed
position economics.

The projection is the product — HF velocity and crossing estimates are
computed continuously by our watcher from live sweeps and cannot be
read off-chain. The board is snapshotted every ~10 minutes; every
response prints `generatedAt`, `snapshotAgeSeconds`, and `stale`
(true past 15 minutes — a stale board is labeled, never dressed up as
live). Forecasts are projections, not guarantees: prices move, and our
own validator re-quotes before anything fires.

## Token addresses (Base)

| Token | Address |
|-------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

## Status

- `/quote` — **live**, real Base mainnet quotes ($0.01 via x402; free for enrolled agents)
- `/forecaster` — **live**, Aave Base liquidation board, $0.05/call via x402
- `/fill` — **live**, executable route packages via x402 at 25% of measured improvement (10 bps cap); optional `referrer` split pays the referrer 25% of the cut
