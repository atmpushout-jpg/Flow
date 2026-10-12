# Flow Agent API — Integration Guide

**For AI agents on Base. Pay-per-call API, settled on-chain via x402 (USDC, Base mainnet). Live at https://flow-kg4x.vercel.app**

Flow sells four paid data products to agents — best-execution swap quotes, contract-safety verdicts, a smart-wallet signal feed, and a smart-wallet leaderboard — plus free health and precheck endpoints and an MCP server (hosted and local). There is no Flow token and no API key: payment *is* the access control. Every route below is under `/api/…` on the base URL above.

## Pricing — two different charges, kept separate

**Per-request charge (x402).** Each paid call costs a flat amount of USDC on Base, paid per request via the x402 protocol (see "Paying" below). This is the only charge an API caller pays today:

| Endpoint | Method | Price | Status |
|---|---|---|---|
| `/api/quote` | POST | $0.01 | **live** |
| `/api/verify` | POST | $0.02 | **live** |
| `/api/signals` | GET | $0.01 | **live** |
| `/api/smart-wallets` | GET | $0.01 | **live** |
| `/api/precheck` | POST | **free** | **live** |
| `/api/health` | GET | free | **live** |
| `/api/fill` | POST | — | **planned — not live** (see Status) |

**Price-improvement fee (execution only, not an API charge).** Separately, Flow's swap-execution fee model is 0 bps base plus 25% of the price improvement over the Uniswap baseline, capped at 10 bps of output. That fee belongs to the execution path (`/api/fill`), which is **not live yet**, so it is not collected from anyone today. A paid `/api/quote` call costs exactly its $0.01 x402 charge — nothing more. (The quote response carries a `protocolFee` field describing this execution fee model so agents can price future fills.)

## Quick start

**1. Call without payment — you get the terms (HTTP 402):**

```bash
curl -X POST https://flow-kg4x.vercel.app/api/quote \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "tokenOut": "0x4200000000000000000000000000000000000006",
    "amountIn": "10000000"
  }'
```

```json
{
  "x402Version": 2,
  "error": "Payment required: sign an x402 v2 \"exact\" payment of $0.01 USDC on Base and retry with an X-PAYMENT header.",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "10000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

**2. Pay and retry.** Sign an EIP-3009 `TransferWithAuthorization` for the amount in `accepts[0]`, wrap it in the x402 v2 payment payload (see "Paying with x402" below), base64-encode it, and resend the same request with the payment header. Any standard x402 v2 client (`@x402/fetch`, the Python `x402` client, Coinbase CDP tooling) does this automatically — or let the MCP server below handle it.

**3. Read the quote (HTTP 200).** Actual response from a paid call on 2026-10-12 (10 USDC → WETH):

```json
{
  "amountIn": "10000000",
  "bestOut": "3916056374898642",
  "venue": "pancakeswap",
  "venueKey": 100,
  "routeType": "direct",
  "routesScanned": 13,
  "uniswapOut": "3915918438669096",
  "edgeBps": 0,
  "blockNumber": 52505520,
  "latencyMs": 126,
  "liquidity": "deep",
  "expiresAtBlock": 52505530,
  "validForBlocks": 10,
  "minOutput": "3896476093024148",
  "protocolFee": "25% of price improvement over Uniswap baseline"
}
```

The quote compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, and returns the best venue, expected output, edge vs the Uniswap baseline, a liquidity flag (`deep` / `watch` / `thin`), the exact block number, and an expiry window (`expiresAtBlock` / `validForBlocks` / `minOutput`) so you know how long the price holds. Edges vary by pair and size — the response always reports the real number, including 0.

## Paying with x402

- **Protocol:** x402 v2, scheme `exact`, network `eip155:8453` (Base mainnet), asset USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, payTo `0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA`.
- **Accepted payment headers:** send the base64-encoded payment payload in **`X-PAYMENT`** or **`PAYMENT-SIGNATURE`** — both are accepted. The payload is the standard x402 v2 object: `{x402Version: 2, scheme: "exact", network: "eip155:8453", accepted: <the accepts[0] entry>, payload: {authorization: <EIP-3009 TransferWithAuthorization fields>, signature: <EIP-712 signature>}}`.
- **Receipts:** a settled response carries the settlement receipt in the **`PAYMENT-RESPONSE`** header (x402 v2 canonical), with **`X-PAYMENT-RESPONSE`** sent as an alias; both are exposed via CORS (`Access-Control-Expose-Headers`). The header value is base64-encoded JSON: `{success, transaction, network, payer}`. The same settlement metadata is mirrored in the response body under `payment`.
- **Facilitator:** payments settle on-chain via x402 on Base. The facilitator that processed them is named in the live discovery document at https://flow-kg4x.vercel.app/.well-known/x402 (`facilitator` field) — PayAI (`https://facilitator.payai.network`) at the time of writing.
- **Proof of delivery:** the quote response above was delivered by paid call whose settlement is transaction `0xbc82cc083b6dcc1b72e020bae67c90f7cb12e5d4f639b188a4b72ead93fa25a7` on Base (status success, `AuthorizationUsed`) — the response body and the settlement receipt (`success: true`, same tx) are reproduced in our reply on the x402blockchains listing issue #6.

## MCP access

Flow is usable from any MCP client two ways:

**Hosted MCP endpoint (no install).** `https://flow-kg4x.vercel.app/api/mcp` — streamable HTTP transport. Point your MCP client at that URL (JSON-RPC over POST; the client must accept `application/json` and `text/event-stream`). Tools: `flow_quote`, `flow_health`.

**Local package `@flowexecutor/flow-mcp` (stdio).** A local stdio MCP server for agents that prefer running tools on their own machine. Source: https://github.com/atmpushout-jpg/Flow/tree/main/mcp-server — run from source:

```bash
git clone https://github.com/atmpushout-jpg/Flow
cd Flow/mcp-server && npm install
node index.js        # stdio transport
```

Claude Desktop / MCP client config (from source):

```json
{
  "mcpServers": {
    "flow": {
      "command": "node",
      "args": ["/path/to/Flow/mcp-server/index.js"]
    }
  }
}
```

Tools: `flow_quote` (best-execution quote, auto-pays $0.01 via x402 from a local starter wallet with hard spend caps — $0.05/call, $1/day default, payments pinned to Flow's payee), `flow_health` (free), `flow_wallet_setup` (creates the local wallet; the key never leaves the machine).

**npm status, honestly:** `@flowexecutor/flow-mcp` is **not yet installable from the public npm registry** (the registry returns 404 — publication is held by an npm account-level hold and retried daily). Until it lands, use the hosted endpoint above or run the package from source. This README will drop this note the day the npm page resolves.

## Endpoints in detail

- `POST /api/quote` ($0.01, x402) — best-execution swap quote on Base; see Quick start.
- `POST /api/verify` ($0.02, x402) — contract safety check: send `{address}` (a Base token/contract address); returns a verdict (`safe` | `caution` | `danger`), a 0–100 score, the red flags found, and plain-English advice (`APPROVE` / `REVIEW_MANUALLY` / `DO_NOT_APPROVE`).
- `GET /api/signals` ($0.01, x402) — chronological smart-wallet buy signals + social-velocity spikes on Base, newest first. Supports `?since=` (unix seconds, ISO 8601, or Base block number) for incremental polling and `?limit=` (1–100, default 50). Every signal carries timestamp, block number, wallet, token, side, amountUsd, and a transparently derived signalScore (formula included in the response; descriptive, not a profit probability).
- `GET /api/smart-wallets` ($0.01, x402) — ranked smart-wallet leaderboard by early buys on pumping tokens, a real-time buy-signal feed (stale flags past 10 min), and the tracker's public paper-trading record.
- `POST /api/precheck` (**free**) — combined safety + price precheck in one call: runs verify and quote together for `{tokenIn, tokenOut, amountIn}`. Not payment-gated.
- `GET /api/health` (free) — service health and chain status.

Machine-readable specs: OpenAPI at https://flow-kg4x.vercel.app/openapi.json · x402 discovery document at https://flow-kg4x.vercel.app/.well-known/x402 — prices there match the table above.

## Status

- `/api/quote`, `/api/verify`, `/api/signals`, `/api/smart-wallets` — **live**, paid via x402, real Base mainnet data.
- `/api/precheck`, `/api/health` — **live**, free.
- `/api/fill` — **planned, not live.** Swap execution is not part of the verified API scope yet: the route exists only as a stub (it validates input and queues nothing executable). Do not integrate against it; this section will be updated with real integration documentation when execution deploys.

## Flow Arena (separate product, not part of the paid API)

Flow Arena is a live events product on the same site — agent-vs-agent trading matches with published receipts: https://flow-kg4x.vercel.app/arena.html. Matches currently run in exhibition (ledger) mode; match results and prize-payment receipts are published on the Arena page. It is listed here only to keep it distinct from the verified API scope above.

## For agent frameworks

**Eliza / LangChain / custom agents:** treat `POST /api/quote` as a tool call.
Input: token addresses + amount (atomic units). Output: best venue + expected output + freshness metadata.
No API key — access is pay-per-call via x402, or use the MCP endpoint/package above.

## Token addresses (Base)

| Token | Address |
|-------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
