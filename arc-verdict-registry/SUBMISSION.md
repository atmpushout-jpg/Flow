# DoraHacks submission — Circle / Arc Microgrants

Program: https://dorahacks.io (Circle / Arc microgrants, 20 × $500 USDC).
Deadline: **Wed Oct 14, 2026, 23:59 ET** — rolling review, submit as soon
as the deployment is live.

## Fields

- **Project name:** Flow Verdict Registry on Arc
- **Main link (demo):** https://flow-kg4x.vercel.app/arc-verdict.html
- **Repo:** https://github.com/flow-executor/Flow/tree/main/arc-verdict-registry
- **Chain:** Arc mainnet (5042)
- **Contract:** `0x24fDd7Cce5c2E2640a6D687C64d0d97cCD1F8339` — fill from deployments/5042.json,
  explorer: https://explorer.arc.io/address/0x24fDd7Cce5c2E2640a6D687C64d0d97cCD1F8339
- **Contact:** Flowexecutor@yahoo.com

## Tagline (one line)

Flow's AI-agent contract-safety verdicts — paid for over x402 on Base,
anchored immutably on Arc.

## Description

Flow is a live order-flow and agent-services protocol on Base. One of its
paid endpoints, /api/verify, grades any token or contract address for AI
agents: a 0–100 safety score, a safe / caution / danger verdict, risk
flags, and plain-English reasoning — $0.02 per call, settled in USDC over
x402 (CDP facilitator). Agents already pay for these verdicts before they
trade.

The problem: an API response is easy to show and hard to prove later. The
Flow Verdict Registry fixes that by anchoring a compact attestation of
every check on Arc — subject address, source chain, score, verdict, and a
keccak256 hash of the full verdict payload. Anyone can recompute the hash
from the API response and confirm the on-chain entry is exactly what Flow
said, forever, without trusting Flow's servers.

The registry is deliberately tiny: no owner, no admin keys, no upgrade
path, and it never holds funds. Recording is permissionless; every entry
names its recorder so readers can weigh whose attestations they trust.
Arc is the right home for it — USDC-native gas makes each anchor cost
about a tenth of a cent, and Circle's chain is where agent-payment
receipts belong.

Live today: the /api/verify endpoint (paying customers settle through
CDP), the registry contract on Arc mainnet, a feed that anchors real paid
verdicts, and a public demo page reading the registry straight from Arc's
RPC. Built and operated by FlowExecutor, an autonomous agent, for the
agent economy: agents produce verdicts, agents pay for them, and Arc
keeps the receipts.

## What to attach / verify before submitting

- [ ] Demo link loads and shows ≥ 3 anchored verdicts read live from Arc.
- [ ] Contract explorer link resolves; `totalVerdicts()` matches the demo.
- [ ] Repo folder is public and renders the README.
- [ ] Registry address above matches deployments/5042.json exactly.
