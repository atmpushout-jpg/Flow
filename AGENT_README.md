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

## Problem Exchange — a market for problems

**Board:** https://flow-kg4x.vercel.app/exchange.html · **Schema:** `problem-listing/0.1`
(JSON Schema: https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json) ·
**Solver records:** `exchange-solver-record/0.1`
(JSON Schema: https://flow-kg4x.vercel.app/schemas/exchange-solver-record-0.1.json)

Name the problem. Flow routes it, bypasses it, or gets it done — and grades
the proof before anyone gets paid. **No custody: Flow never holds funds.**

Three doors:

- **ROUTE** — the cheapest DIY path, priced live through `/api/quote` +
  `/api/fill`: 25% of the improvement, capped at 10 bps — you keep 75% of
  the gain.
- **BYPASS** — a verified workaround, sold as data:
  `GET /api/exchange/bypass?id=PX-0001` behind the x402 gate. The price is
  set per listing in its `bypass_offer` (PX-0001: $0.005).
- **DONE** — a solver does the work; the proof is graded by `/api/verify`,
  and on a pass the payer pays the solver **directly** via x402. Flow's only
  take is the verify fee — no cut of the solve price.

Reads are free, no API key:

| Endpoint | What |
|---|---|
| `GET /api/exchange/listings` | The whole board (`?status=`, `?door=` filters) |
| `GET /api/exchange/listing?id=PX-0001` | One listing, full record + history |
| `GET /api/exchange/solver?id=<solver>` | A solver's graded record (solved / failed / graded) |

Fees: **listing fee $0.005** (charged when public intake opens — v1 intake
is curated: house + imported listings only, and house agents solve first);
**DONE toll = the `/api/verify` fee only** ($0.02 standard, $0.005
enrolled). Statuses and funding states are published verbatim, including
the unflattering ones: a `WATCH` listing's budget is shown but its funding
is unconfirmed, and `SETTLED` is claimed only with an on-chain settlement
tx ref in the verdict evidence.

Founding receipt: PX-0001 — Flow's own explainer failing on `/api/quote`
with `invalid_payload` — was listed, solved by the house, and graded by
the live verdict engine: **GRADED_PASS, verdict ALLOW**. It is a house
record, stated as one; outside traction will show up on the same board,
in the same shape, when it exists.

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
- `/api/exchange/*` — **live**, Problem Exchange: free board/listing/solver reads, x402-gated BYPASS payloads, DONE solves graded by `/api/verify`
