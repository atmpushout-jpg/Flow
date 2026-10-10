# Flow - Private Order Flow Auction Protocol (Prototype Spec)

## Overview
Flow is a prototype intent-based swap router for Base. Users sign swap intents. An offchain auctioneer auctions each intent to whitelisted searcher bots in ~200ms. The winning bot fills the intent at a better price than a public baseline. The protocol keeps an auction premium.

This is an educational prototype. NOT audited. DO NOT deploy with real funds.

## Actors
- User: holds a smart wallet on Base, signs intents.
- Router (onchain): validates intents, settles fills, enforces fees.
- Auctioneer (offchain): runs the micro-auction, selects winner.
- Searchers/Bots: bid for the right to fill intents. Must be whitelisted and bonded.
- Baseline quoter: public price reference (e.g., Uniswap v3 quoter on Base).

## Intent Structure
```
struct Intent {
  address user;
  address tokenIn;
  address tokenOut;
  uint256 amountIn;
  uint256 minAmountOut; // user slippage protection
  uint256 expiry;       // unix timestamp, short (e.g., 30 seconds)
  uint256 nonce;
  bytes signature;      // EIP-712 signature by user
}
```

## Auction Rules (v0)
1. User signs intent with 30s expiry.
2. Auctioneer receives intent, fetches baseline quote for tokenIn->tokenOut.
3. Auctioneer broadcasts auction to whitelisted searchers with 150ms bid window.
4. Each bid: { bidder, amountOut, premiumBps } where amountOut >= minAmountOut and premiumBps is what they pay the protocol.
5. Winner = highest amountOut to user, tie-break by highest premiumBps.
6. Winner submits fill transaction to Router within expiry.
7. Router verifies: signature valid, not expired, not replayed, amountOut >= minAmountOut, bidder is auction winner (via auctioneer signature).
8. Settlement: user receives tokenOut, bidder keeps spread, protocol takes premium.

Timing target: intent -> auction -> fill in <2s (one Base block).

## Fee Model (v0 - launch)
- Base fee: 0 bps at launch. We only earn when we beat baseline.
- Improvement share: protocol keeps 25% of (winning amountOut - baseline amountOut), capped at 10 bps of amountOut.
- Total take target: ~3-4 bps per swap at typical 12-15 bps improvement.
- Fees accrue to `feeRecipient`. No token, no points in v0.
- Post-traction option: enable 3 bps base fee via `setBaseFeeBps(3)` once distribution is secured.

Example: $1,000 swap, baseline gives 0.5 ETH, winner gives 0.50075 ETH (15 bps better). Improvement = 0.00075 ETH. Protocol keeps 25% = 0.0001875 ETH. User nets 0.5005625 ETH, still 11.25 bps better than baseline.

## Anti-Bypass
- Intents are EIP-712 signed to THIS router only (chainId + verifyingContract).
- Only auctioneer-signed winners can fill. Direct fills without auctioneer signature revert.
- Searchers must post bond (e.g., 1 ETH) slashable for: filling below committed amountOut, griefing, or leaking flow.
- Nonce + expiry prevents replay.
- Rate limits per searcher to prevent DoS.

## Speed Design
- Auctioneer co-located near Base sequencer, WebSocket bids, <100ms quoter.
- Baseline cache updated every block.
- Gas sponsorship via paymaster in production (not in prototype).
- Batch settlement where possible.

## What This Prototype Omits (intentionally)
- Paymaster / gas sponsorship
- Permit2 / session keys
- MEV protection beyond private auction
- Insurance fund
- Decentralized auctioneer set (v0 is single trusted auctioneer)
- Formal verification, audit

## Risks
- Single trusted auctioneer can censor or steal flow. Decentralize before mainnet.
- Searcher collusion to suppress bids.
- Smart contract bugs (reentrancy, signature malleability).
- Oracle/baseline manipulation.
- Regulatory: auctioning order flow may have legal implications in some jurisdictions.

## To $350/day (illustrative, not a promise)
At ~3.75 bps average take (25% of 15 bps improvement): $933,000 daily volume = ~$350/day gross.
At 5 bps (with 3 bps base fee enabled later): $700,000 daily volume = $350/day.
Volume requires distribution (wallet integration). Tech alone does not create volume.
Launch with 0 base fee to maximize volume, then evaluate enabling the base fee.
