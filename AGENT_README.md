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
curl -X POST http://YOUR_HOST:3000/quote \
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

## For agent frameworks

**Eliza / LangChain / custom agents:** treat `/quote` as a tool call.
Input: token addresses + amount. Output: best venue + expected output.
No API key required (MVP).

## Token addresses (Base)

| Token | Address |
|-------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

## Status

- `/quote` — **live**, real Base mainnet quotes
- `/fill` — queued, activates after FlowFlashFiller mainnet deployment
