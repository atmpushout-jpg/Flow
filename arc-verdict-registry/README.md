# Flow Verdict Registry — on Arc

**Flow's contract-safety verdicts, anchored on Arc mainnet.**

Flow runs a paid API for AI agents on Base. Its `/api/verify` endpoint grades
any token/contract address — a 0–100 safety score, a safe / caution / danger
verdict, flags, and plain-English reasoning — for $0.02 per call over x402.

This project anchors those verdicts on **Arc** (Circle's L1, chain 5042,
USDC gas): a tiny, ownerless registry contract stores a compact attestation
of each check, so any agent or app can confirm on-chain that Flow graded a
contract and exactly what it said — and recompute the verdict hash from the
API response to prove the entry is genuine.

Built for the Circle / Arc microgrants program on DoraHacks (Oct 2026).

## How it works

1. **Check** — an agent pays $0.02 (x402, USDC on Base) to
   `POST https://flow-kg4x.vercel.app/api/verify` with `{ "address": "0x…", "chain": "base" }`
   and receives `{ verdict, score, summary, flags[], agentAdvice, … }`.
2. **Anchor** — `scripts/arc-feed.js` builds the canonical payload (below),
   hashes it with keccak256, and calls `recordVerdict(subject, sourceChain,
   score, verdict, verdictHash)` on the Arc registry.
3. **Verify** — anyone reads the registry (demo page, explorer, or raw
   `eth_call`) and recomputes the hash from the API verdict. Match = the
   on-chain entry is exactly what Flow said.

## The contract

`contracts/FlowVerdictRegistry.sol` — ~120 lines, no dependencies.

- **No owner, no admin keys, no upgrade path, holds no funds, nothing payable.**
- Permissionless writes: each entry stores its `recorder`, so readers choose
  whose attestations to trust (Flow records from its operational wallet
  `0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561`).
- Entries are append-only and can never be edited or deleted; a re-check of
  the same contract adds a newer entry (`latestFor(address)` reads the newest).
- Guards: score ≤ 100, verdict ∈ {0 safe, 1 caution, 2 danger}, non-zero
  subject and hash.

## Canonical verdict hash

```
payload = {                       // fixed key order
  address:     subject, lowercased
  chain:       "base" | "ethereum" | "optimism" | "arbitrum" | "polygon"
  chainId:     8453 | 1 | 10 | 42161 | 137
  verdict:     "safe" | "caution" | "danger"
  score:       0-100
  summary:     API summary string
  flags:       ["severity:text", …] sorted
  agentAdvice: "APPROVE" | "REVIEW_MANUALLY" | "DO_NOT_APPROVE"
}
verdictHash = keccak256(utf8(JSON.stringify(payload)))
```

Recompute with: `node scripts/arc-feed.js hash <payload.json>`.

## Quickstart

```bash
npm install
npm run compile   # solc -> build/FlowVerdictRegistry.json
npm test          # 30 assertions on an in-process local chain
```

Deploy + funding runbook: **DEPLOY.md**. DoraHacks submission copy:
**SUBMISSION.md**. Live demo page: `demo/arc-verdict.html` (dependency-free;
reads Arc over raw JSON-RPC).

## Arc mainnet facts (verified live 2026-10-12)

| | |
|---|---|
| Chain ID | 5042 |
| Public RPC | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.arc.io |
| Gas | USDC (native, 18-dec view; base fee ≈ 20 gwei) |
| Deploy cost | ≈ 0.009 USDC (454,332 gas, measured preflight) |
| Record cost | ≈ 0.001–0.0014 USDC per verdict |

## Status

- [x] Contract built + compiled (solc 0.8.37, optimizer 200 runs)
- [x] Local test suite — 30/30 assertions pass
- [x] Feed proven against the live `/api/verify` (real paid checks, dry-run mode)
- [x] Deploy preflight against Arc mainnet RPC (chain, gas, cost verified)
- [ ] Fund ops wallet on Arc → deploy → seed verdicts → submit (DEPLOY.md)

Visibility note: this code is published for review in Flow's public repo;
Flow's root NOTICE (proprietary, no license granted) applies.
