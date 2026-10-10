# FlowIntentRouter - Audit Brief

## Project Summary
Flow is a private order-flow auction protocol for Base. Users sign EIP-712 swap intents. An offchain auctioneer auctions each intent to bonded searcher bots (~200ms). The winning searcher fills the intent onchain via `FlowIntentRouter.fillIntent`. The protocol earns 25% of the price improvement over a baseline quote (0 base fee at launch).

## Scope
- `contracts/FlowIntentRouter.sol` (single contract, ~300 lines)
- `test/FlowIntentRouter.t.sol` (12 Foundry tests, all passing)
- Offchain `offchain/auctioneer.ts` is out of scope for the smart-contract audit but reviewers should understand its role as the trusted auctioneer.

## Trust Model
- **Auctioneer: trusted.** It designates fill winners and reports baselines. It can censor flow, favor searchers, or misreport baselines to inflate fees. Decentralizing the auctioneer set is post-audit roadmap, not in scope.
- **Searchers: untrusted but bonded.** Must hold ETH bond to fill. Bond is slashable by owner for misbehavior.
- **Users: trust the contract code only.** Intents are EIP-712 signed to this contract + chain ID.
- **Owner: trusted.** Can rotate auctioneer/fee recipient, set fees (capped), slash bonds. No token rescue backdoor (removed in v0.1).

## Key Invariants (for reviewers to verify)
1. A filled intent can never be filled twice (nonce + filled mapping).
2. User never receives less than `minAmountOut` net of protocol fee. NOTE: the protocol fee is taken from `amountOut`, so `userReceives = amountOut - improvementFee` where `amountOut >= minAmountOut`. If improvementFee pushes user below minAmountOut, that is by design but should be flagged if undesirable.
3. Filler cannot profit without delivering `amountOut` of tokenOut first (pulled via transferFrom).
4. Auctioneer signature binds: router address, chain ID, intent hash, filler address, amountOut, baselineOut. A signature for one filler cannot be replayed by another.
5. `baselineOut` is supplied by the filler (via auctioneer sig). A malicious auctioneer can inflate it to reduce the improvement fee, or deflate it to increase fees. This is a known trusted-auctioneer limitation.

## Known Limitations (acknowledged, not bugs)
- Single trusted auctioneer (centralization).
- Baseline is auctioneer-reported; no onchain verification.
- No slippage protection on the improvement fee vs minAmountOut interaction (see invariant 2).
- Bonds are in ETH only; no ERC-20 bonds.
- No pause/circuit breaker. Consider adding for mainnet.
- `fillIntent` pulls `tokenIn` from user via `transferFrom`; requires prior approval (Permit2 integration is roadmap).

## Test Coverage
12 Foundry tests, all passing (`forge test`):
- Happy path: fill succeeds, correct fee math, zero-improvement no-fee case
- Reverts: expired intent, replay, bad user sig, bad auction sig (wrong filler), below minAmountOut, unbonded filler
- Admin: bond withdraw, slash, fee caps, zero-address guards

## What We Want From the Audit
1. Signature verification correctness (EIP-712 + auction sig binding).
2. Reentrancy analysis on the fill flow (CEI + nonReentrant present, but verify token callback risk with malicious ERC-20s).
3. Fee math edge cases (rounding, zero amounts, dust).
4. Any way for a filler to extract value without delivering.
5. Any way for the owner to extract user funds beyond stated fees.

## Out of Scope
- Offchain auctioneer implementation
- Tokenomics / fee sustainability
- Front-end / wallet integration code
