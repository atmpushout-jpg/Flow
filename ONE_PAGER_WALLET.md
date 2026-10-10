# Flow - Give Your Users Better Swap Prices, Earn Nothing Unless They Win

## The pitch in one sentence
Flow auctions every swap to competing market makers in ~200ms. Your users get a better net price than going direct. We only earn 25% of the improvement we find them. No improvement, no fee.

## Why your users win
- Better execution: private auction beats public baseline by 10-15 bps in testing
- MEV protection: intents never touch the public mempool before the auction
- Gasless UX: paymaster-sponsored fills (on roadmap), one-tap swaps via smart wallets
- They always net better than baseline, or the auction does not fill

## Why you win
- Zero integration cost: one HTTP endpoint, no SDK lock-in
- Differentiation: "our swaps beat Uniswap direct" is a real claim with receipts
- Revenue share optional: we can split our 25% improvement fee with you
- No custody: you never hold user funds, settlement is onchain

## How integration works
1. User signs a swap intent in your app (EIP-712, 30s expiry)
2. You POST it to our auctioneer: `POST /intent`
3. We return the winning bid + baseline proof in <200ms
4. Winner fills onchain via `FlowIntentRouter.fillIntent()`
5. User receives tokens, we take 25% of the improvement only

Code: 20 lines to sign, 10 lines to POST. We provide the reference client.

## Fee model (launch)
- Base fee: 0
- We keep: 25% of (winning price - baseline price), capped at 10 bps
- User keeps: 75% of every improvement, always nets better than baseline
- Example: $1,000 swap, baseline 0.5 ETH, winner 0.50075 ETH. User nets 0.50056 ETH (+11.25 bps vs baseline). We earn ~$0.38.

## What we have
- Working prototype on Base Sepolia (testnet, fake funds)
- Live Uniswap V3 baseline quoter on Base mainnet
- Local auction simulation: 5/5 fills, correct winner selection, fee math verified
- Full test plan with 6 failure cases

## What we need from you
- Route a slice of your swap flow (even 5%) through our auctioneer for 2 weeks
- We handle the auction infra, you keep your UX
- Shared dashboard: every fill shows baseline vs executed price, publicly verifiable

## Ask
Pilot integration. No exclusivity, no cost, cancel anytime. If we do not beat baseline consistently, you drop us.

Contact: [your details]
Repo: [link to prototype]
