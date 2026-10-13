# DEPLOY RUNBOOK — Flow Verdict Registry → Arc mainnet

Target: contract live on Arc mainnet (chain 5042), demo page reading it,
DoraHacks submission filed. **Deadline discipline: submissions close Wed
Oct 14, 2026, 23:59 ET and review is rolling — submit the moment it's live.
STOP LINE: if not live by end of Tue Oct 13 ET, drop the sprint.**

All node commands run from this directory with the VM proxy env (Arc/Base
egress needs it):

```bash
cd ~/workspace/flow-auction-protocol/arc-verdict-registry
set -a; . /etc/flow-bots-proxy.env; set +a; export NODE_USE_ENV_PROXY=1
```

Money rules: only the **operational wallet**
`0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561` (key `~/.config/flowexecutor_wallet_key`)
is ever a source. Never Atm's payee wallet. Hard cap: **$5 total value
moved** for this sprint; the plan below moves **$2**.

---

## Step 0 — Preflight (2 min, no spend)

```bash
npm install && npm run compile && npm test     # expect: 30/30 pass
node scripts/deploy.js                          # preflight only
```

Expect: chainId 5042, deployer = ops wallet, gas ≈ 20 gwei, deploy gas
≈ 454,332, cost ≈ **0.009 USDC**, balance 0.0 (until Step 1).

## Step 1 — Fund the ops wallet on Arc: bridge $2 USDC from Base (CCTP)

The ops wallet holds USDC on Base; Arc gas is USDC, so bridge via Circle
CCTP v2 (Base → Arc). First **confirm the current contract addresses and
Arc's CCTP domain id on Circle's official CCTP reference**
(developers.circle.com/cctp — "Contract addresses" / "Domain identifiers")
at deploy time; do not copy addresses from any third-party page.

1. On **Base**: `approve` 2,000,000 (2 USDC, 6-dec) from the ops wallet to
   CCTP **TokenMessengerV2** (Base).
2. On **Base**: `depositForBurn(2000000, ARC_DOMAIN, mintRecipient = ops
   wallet bytes32, USDC_BASE 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)`.
   Keep the tx hash.
3. Poll Circle's Iris attestation API until status `complete`:
   `GET https://iris-api.circle.com/v2/messages/{BASE_DOMAIN}?transactionHash={tx}`
   (Base domain id from the same official reference).
4. On **Arc**: `MessageTransmitterV2.receiveMessage(message, attestation)`
   with the bytes returned by Iris.
5. Re-run `node scripts/deploy.js` — native balance must now show ≈ 2 USDC
   (minus nothing; bridging moves the full amount, fees are the two chains'
   gas: a few cents of Base ETH + the Arc-side claim in USDC).

Fallbacks if CCTP stalls > 30 min: Circle **Gateway** (Arc domain 26,
deposit on Base then transfer to Arc) or a reputable bridge UI in the
browser. Do not improvise a third chain hop.

## Step 2 — Deploy (2 min, ≈ 0.009 USDC)

```bash
node scripts/deploy.js --send
```

Writes `deployments/5042.json` (address, tx, block) and regenerates
`demo/config.js` + `demo/arc-verdict.live.html` (single-file demo with the
address inlined). The script refuses unless: chain is 5042, the key derives
the ops wallet, and balance ≥ 0.05 USDC.

Verify: open `https://explorer.arc.io/address/<registry>` — contract
present; call `totalVerdicts()` (explorer Read tab or the demo page) → 0.
Optional: verify source on the explorer with solc `0.8.37`, optimizer on,
200 runs, source = `contracts/FlowVerdictRegistry.sol`.

## Step 3 — Seed the first verdicts (≈ 5 min, $0.02 each + ~0.0013 USDC gas)

Each run pays Flow's own `/api/verify` from the ops wallet (a self-payment —
**not** external revenue) and anchors the result on Arc:

```bash
node scripts/arc-feed.js check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --chain base --send   # USDC
node scripts/arc-feed.js check 0x4200000000000000000000000000000000000006 --chain base --send   # WETH
node scripts/arc-feed.js check 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf --chain base --send # cbBTC (address corrected 2026-10-12: the original string here had 41 hex chars; this one is CoinGecko-listed and verified on-chain — symbol cbBTC)
```

Expect three `RECORDED on Arc mainnet` blocks with explorer tx links, and
`feed-log.jsonl` entries with `arcTx` set. Demo page should then show 3 rows.

## Step 4 — Publish repo + demo (parent/bridge step)

Upload this folder to the public repo **flow-executor/Flow** at path
`arc-verdict-registry/` (GitHub bridge, RAW content, read back to verify),
and upload `demo/arc-verdict.live.html` to the repo root as
**`arc-verdict.html`**. Verify:

- https://flow-kg4x.vercel.app/arc-verdict.html renders 3 live entries from Arc.
- Repo folder renders with README on GitHub.

## Step 5 — Submit to DoraHacks (immediately after Step 4 verifies)

Use the copy in **SUBMISSION.md**. Main link: the live demo page. Put the
repo link + explorer contract link in the description. Pseudonymous
submission is allowed; verification only matters if conditionally selected.
If the form demands a human attestation or an account step that can't be
done by the agent, that is the one owner gate — flag it with the exact
screen, don't work around it.

## Costs recap (measured, not estimated)

| Item | Cost |
|---|---|
| Bridge float moved | $2.00 USDC (stays in ops wallet on Arc) |
| Contract deploy | ≈ 0.009 USDC |
| Each verdict record | ≈ 0.001–0.0014 USDC |
| Each /api/verify seed call | $0.02 (ops → Flow payee, self-payment) |
| Base-side bridge gas | a few cents of ops ETH |

## If something breaks

- Deploy tx fails → read the error, fix locally, re-run preflight; the
  contract is ownerless/immutable, so a bad deploy costs only its gas
  (≈ 0.009 USDC) and redeploying is safe.
- Wrong state published → nothing on-chain can be edited; the fix is a new
  entry or a fresh deploy. Never re-run a `--send` feed blindly: check
  `feed-log.jsonl` and the registry count first ( duplicates are harmless
  but cost gas).
- Not live by end of Tue Oct 13 ET → **stop**, per the sprint plan.
