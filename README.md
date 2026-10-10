# Flow - Private Order Flow Auction (Prototype)

Educational prototype for a Base-native intent auction protocol. Bots bid in milliseconds for the right to fill user swap intents. Protocol keeps an auction premium.

## Files
- `SPEC.md` - full protocol spec, auction rules, fee model, risks
- `contracts/FlowIntentRouter.sol` - onchain intent settlement (prototype, NOT audited)
- `offchain/auctioneer.ts` - offchain micro-auction server (prototype)

## What this is
A scaffold to learn from and test on a local fork or Base Sepolia with fake funds. It demonstrates:
- EIP-712 intents
- Auctioneer-signed winner selection
- Base fee + improvement fee split
- Bonded searchers

## What this is NOT
- Not audited, not safe for mainnet or real funds
- No paymaster, no Permit2, no MEV protection beyond the private auction
- Single trusted auctioneer (centralized)
- Demo intent hash in the auctioneer does not match the contract's EIP-712 hash. You must unify them before any testnet use.

## Quickstart (testnet only, fake funds)
1. Install: `npm i` in `offchain/` (needs `ethers`, `express`, `ts-node`, `typescript`)
2. Deploy `FlowIntentRouter.sol` to Base Sepolia with your auctioneer address and fee recipient. Requires OpenZeppelin contracts.
3. Set `AUCTIONEER_PK`, `RPC_URL`, `ROUTER_ADDRESS`, `CHAIN_ID=84532` and run `npx ts-node offchain/auctioneer.ts`
4. Fund test accounts, have searchers post bonds via `depositBond()`, then submit intents to `:8787/intent`.

## Before you even think about mainnet
- Professional audit + bug bounty
- Decentralize the auctioneer set or use a fair sequencing service
- Real baseline quoter (Uniswap v3 / Aerodrome on Base)
- Unify EIP-712 hashing between contract and auctioneer
- Paymaster for gas sponsorship, with spend limits
- Circuit breakers, rate limits, monitoring
- Legal review for order flow auction compliance

## Money reality check
This prototype earns nothing by itself. Revenue = daily volume * take rate. At ~8 bps take, $350/day needs ~$437k in daily volume. Volume needs distribution (a wallet or app routing through you). Bots do not create volume, they compete for it.

Not financial advice. Do not deploy with real user funds without a full security review.
