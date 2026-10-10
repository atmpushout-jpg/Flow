# Flow Closed Loop — Mainnet Runbook

**Status: built and proven on a Base mainnet fork. NOT yet on mainnet.**

This is the no-audit revenue path: you run the swap UI, you run the
auctioneer, you run the filler. No permission needed from anyone.

---

## 1. Read this first — honest risks

- **The contract is NOT audited.** v0.2 fixed the known minAmountOut bug and
  added a per-fill cap, and 20 tests pass (19 unit + 1 mainnet fork). But
  unaudited code can still lose money. Only put in what you can lose.
- **Blast radius is capped, not zero.** `maxAmountIn` bounds each fill
  (default 25 USDC in the deploy script). A bug could still drain up to the
  cap per fill, plus the filler's inventory and bond.
- **The filler runs at a small expected loss per fill.** Its edge (multi-pool
  routing vs single-pool baseline) is real but thin — a few bps. The protocol
  keeps 25% of the improvement; the filler funds the other 75% from tighter
  quoting. This proves live revenue mechanics. It is not a profit machine on
  day one. Real profit needs real searcher competition or real volume.
- **Keys.** The testnet key in `.env` is burned (it appeared in tool output).
  Mainnet MUST use a fresh key from a hardware wallet. Never reuse it.
- **You are the entire operation.** If the server goes down, fills stop. If
  inventory runs dry, fills stop. There is no monitoring yet — check `/pnl`.

---

## 2. What was proven (Base mainnet fork, real liquidity)

- `$20 USDC -> 0.0080215 WETH` filled through the full loop:
  UI intent -> EIP-712 verify -> quoter baseline -> best-tier bid ->
  auctioneer auth -> `fillIntent` onchain.
- Baseline (0.3% pool): `0.00801722 WETH`. Best (0.05% pool): `0.00802157 WETH`.
  Improvement: ~5.4 bps. Protocol fee: `1088161595995 wei` WETH (~$0.0027).
- `/pnl` tracks every fill and fee.

---

## 3. Mainnet launch steps

### 3a. Fresh key (do this on YOUR machine, not here)
1. Generate a fresh seed on a hardware wallet. This key is operator =
   auctioneer = filler = feeRecipient (closed loop).
2. Fund it with ~$150 on Base: ~$100 inventory (split USDC/WETH),
   ~$5 for the searcher bond, rest for gas.

### 3b. Deploy v0.2
```
forge create --broadcast --rpc-url <YOUR_RPC> \
  --private-key <FRESH_KEY> \
  contracts/FlowIntentRouter.sol:FlowIntentRouter \
  --constructor-args <YOUR_ADDR> <YOUR_ADDR>
```
Then, as owner:
```
cast send <ROUTER> "setMaxAmountIn(uint256)" 25000000 ...
cast send <ROUTER> "depositBond()" --value 1ether ...
```

### 3c. Fund the filler
- WETH inventory: wrap ETH or buy WETH on a DEX, send to operator.
- USDC inventory: buy USDC (for when someone swaps WETH->USDC later;
  v1 UI is USDC->WETH only, so WETH is the critical side).
- Approve the router to pull both tokens (unlimited approve is fine here —
  it's your own contract and your own key).

### 3d. Start the server (on a machine that stays up)
```
RPC_URL=<YOUR_RPC> ROUTER_ADDRESS=<ROUTER> CHAIN_ID=8453 \
AUCTIONEER_PK=<FRESH_KEY> PORT=8787 node offchain/closed-loop.js
```
Point `web/index.html` CONFIG at mainnet (chainId 8453, router address,
real USDC/WETH) and serve it. Any static host works.

### 3e. First real swap
Do a $5 test swap yourself through the UI. Check `/pnl`. If the fee
is there, the machine is earning.

---

## 4. Operating

- **Watch `/pnl`** — fills, fees accrued. That's your revenue number.
- **Rebalance inventory** — every fill moves inventory (WETH out, USDC in).
  When WETH runs low, swap USDC back to WETH on a DEX. Until you automate
  this, do it by hand every few fills.
- **Tune `MIN_EDGE_BPS`** (default 5) — higher = fewer fills, more edge per
  fill. Lower = more fills, thinner edge.
- **Raise `maxAmountIn`** only after small fills behave for days.
- **Emergency stop** — `setAuctioneer` to an address nobody controls, or
  `withdrawBond` + drain inventory. Fills halt immediately.

## 5. What turns this from demo to business

1. More pairs (WETH->USDC direction, then long tail).
2. Real outside searchers bonding and bidding (needs the audit eventually).
3. A wallet or frontend routing real user flow (needs the audit eventually).
4. The audit itself — this loop's `/pnl` history is the pitch deck for it.

Until then: small, real, and yours.
