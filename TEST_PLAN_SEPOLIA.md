# Flow - Base Sepolia Test Plan (Fake Money Only)

Goal: prove the auction settles correctly on a live testnet with fake funds before you spend anything on audit or distribution.

## Prerequisites
- A fresh test wallet (never use a mainnet wallet)
- Base Sepolia ETH for gas (faucet below)
- Node 20+, the files in this repo

## Network Details
- Chain: Base Sepolia
- Chain ID: 84532
- RPC: https://sepolia.base.org
- Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet (or Alchemy Base Sepolia faucet)
- USDC (test): 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals)
- WETH: 0x4200000000000000000000000000000000000006
- QuoterV2: 0xC5290058841028F1614F3A6F0F5816cAd0df5E27
- SwapRouter02: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4

## Step 0 - Prove it locally first
1. `forge build` must compile clean.
2. `forge test` must show 17/17 passing. Do not touch testnet until this is green.
3. `node offchain/test-eip712.js` must show `[PASS] hashes match`.

## Step 1 - Fund the test wallet
1. Create a new wallet in your test environment.
2. Get Base Sepolia ETH from the faucet.
3. Verify: `cast balance <address> --rpc-url https://sepolia.base.org`

## Step 2 - Deploy FlowIntentRouter
1. `cp .env.example .env` and fill in `AUCTIONEER`, `FEE_RECIPIENT`, `PRIVATE_KEY` (throwaway testnet key only).
2. Deploy with the script:
   `forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast`
3. Record the deployed address as `ROUTER_ADDRESS`.
4. Verify on Sepolia Basescan.

## Step 3 - Configure the auctioneer
1. `cd offchain && npm install`
2. Set env:
   - `CHAIN_ID=84532`
   - `RPC_URL=https://sepolia.base.org`
   - `ROUTER_ADDRESS=<deployed>`
   - `AUCTIONEER_PK=<test auctioneer private key, no real funds>`
3. Update `QUOTER_V2` in `auctioneer.ts` to the Sepolia quoter: `0xC5290058841028F1614F3A6F0F5816cAd0df5E27`
4. Start: `npx ts-node auctioneer.ts`
5. Check `:8787/health` returns ok.

## Step 4 - Prepare test tokens
1. Get test USDC: mint or faucet. If no faucet, deploy a mock ERC20 with 6 decimals.
2. Get test WETH: wrap Sepolia ETH or mint mock.
3. For the user wallet: hold USDC, approve the router for USDC spend.
4. For each mock searcher: hold WETH, approve the router for WETH spend, and call `depositBond()` with 0.01 ETH.

## Step 5 - Run a happy-path auction
1. User signs an intent via EIP-712 `signTypedData` (NOT `personal_sign`): domain `FlowIntentRouter/0`, chain 84532, verifyingContract = router address. $10 USDC -> WETH, 60s expiry, minAmountOut = 95% of quoter baseline.
2. POST the intent to `:8787/intent`.
3. Expect: `status: filled`, a winner, `baselineOut`, `intentHash`, `auctionSig`.
4. Winner calls `fillIntent()` on the router with the returned values.
5. Verify:
   - User received WETH >= minAmountOut
   - `filled[intentHash]` is true
   - Fee recipient received the 25% improvement fee
   - Event `IntentFilled` emitted with correct amounts

## Step 6 - Failure cases (must all revert or be rejected)
The hardened contract uses custom errors, not strings:
1. Expired intent: submit with expiry in the past. Expect revert `IntentExpired()`.
2. Replay: submit the same intent twice. Expect revert `BadNonce()` (nonce is consumed on first fill, checked before the filled flag).
3. Bad user sig: tamper with one byte. Expect revert `BadUserSignature()`.
4. Bad auction sig: fill from a non-winning bidder. Expect revert `BadAuctionSignature()`.
5. Below minAmountOut: winner bids below min. Auctioneer must filter it, no fill.
6. Unbonded filler: filler with zero bond tries to fill. Expect revert `FillerNotBonded()`.

## Step 7 - Measure
Record for 20 test swaps:
- Baseline vs winning amountOut (improvement in bps)
- Protocol fee per swap in USD terms
- Time from intent POST to fill confirmation (target <5s on Sepolia)
- Gas used per fill

## Success Criteria
- 20/20 happy-path fills succeed
- 6/6 failure cases behave correctly
- Median improvement > 5 bps over baseline
- Median intent-to-fill < 5 seconds
- No stuck funds: router holds zero balance after each fill except accrued fees

## Cleanup
- Do not reuse test keys on mainnet
- Document the measured improvement and fee numbers; these are your pitch to wallets
- Do not deploy to Base mainnet without an audit

## What This Proves
If this passes, you have proven settlement works. You have NOT proven profitability. Profit needs real distribution and real volume, which is the next phase.
