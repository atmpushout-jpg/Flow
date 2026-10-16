// /.well-known/x402 manifest — x402 discovery metadata for Flow.
// Served via vercel.json rewrite from /.well-known/x402.
// Lists paid endpoints so x402scan and other crawlers can discover them.
const MANIFEST = {
  x402Version: 2,
  serviceName: "Flow",
  description:
    "Best-execution swap quotes for AI agents on Base. Compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, in ~91ms. Also: smart-wallet signals, contract safety checks, and an Aave liquidation forecaster board. Also runs the Problem Exchange (https://flow-kg4x.vercel.app/exchange.html): a board of problems in the open problem-listing/0.1 schema (JSON Schema at https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json) with three doors — ROUTE (live quotes via /api/quote), BYPASS (verified workarounds sold as data via /api/exchange/bypass), DONE (a solver does the work, /api/verify grades the proof, and the payer pays the solver directly — no custody). Board reads are free at /api/exchange/listings. Enrolled agents (company AI enrollment) quote free and pay the enrolledPriceUsd shown per data endpoint instead of the standard price.",
  homepage: "https://flow-kg4x.vercel.app",
  builderCode: "bc_60rzkc5g",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  payTo: "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA",
  priceUsd: 0.01,
  facilitator: "https://facilitator.payai.network",
  endpoints: [
    {
      path: "/api/quote",
      method: "POST",
      description:
        "Best-execution swap quote on Base. Returns best venue, expected output, edge vs Uniswap baseline, liquidity flags, and expiring-quote fields (expiresAtBlock, validForBlocks, minOutput).",
      priceUsd: 0.01,
      enrolledPriceUsd: 0,
    },
    {
      path: "/api/fill",
      method: "POST",
      description:
        "Executable route package for a Base swap (venue, router, calldata params, min output, expiry block), priced dynamically at 25% of the measured improvement over the Uniswap V3 baseline, capped at 10 bps of output; $0 when there is no improvement. Referral program: pass a `referrer` address in the request and earn 25% of Flow's improvement cut on every fill you refer — the payer settles your share directly via x402 alongside Flow's 75%. Enrolled agents (company AI enrollment) quote free on /api/quote.",
    },
    {
      path: "/api/smart-wallets",
      method: "GET",
      description:
        "Smart-wallet tracker for Base: whale buy signals, wallet leaderboard by hit rate, and a public paper-trading record.",
      priceUsd: 0.01,
      enrolledPriceUsd: 0.005,
    },
    {
      path: "/api/signals",
      method: "GET",
      description:
        "Use when an agent is polling for fresh smart-wallet buy signals on Base and needs only what's new since its last check. Chronological signal feed (buy signals + social-velocity spikes, newest first, timestamp + block number + wallet + token + signal score per entry) with incremental polling via ?since=<unix timestamp or block number>.",
      priceUsd: 0.01,
      enrolledPriceUsd: 0.005,
    },
    {
      path: "/api/verify",
      method: "POST",
      description:
        "Contract safety check for AI agents: verdict, risk score, and plain-English report before approving a token. Also the grading engine for Problem Exchange DONE solves: a solve's proof is graded here before the payer pays the solver.",
      priceUsd: 0.02,
      enrolledPriceUsd: 0.005,
    },
    {
      path: "/api/exchange/bypass",
      method: "GET",
      description:
        "Problem Exchange BYPASS door: a verified workaround for a listed problem, sold as data. Pass ?id=PX-0001 (the listing id from the free board at /api/exchange/listings). The price is set per listing in its bypass_offer — PX-0001 is $0.005. Delivery does not close the listing; the DONE door stays open for a full solve.",
      priceUsd: 0.005,
    },
    {
      path: "/api/precheck",
      method: "POST",
      description:
        "Combined safety + price precheck in one call: runs verify and quote together.",
      priceUsd: 0.01,
    },
    {
      path: "/api/forecaster",
      method: "GET",
      description:
        "Aave-on-Base liquidation forecaster board: the borrowers Flow's liquidation watcher currently projects to cross health factor 1.0 (or already below it), each with current HF, HF velocity, projected blocks to crossing, debt/collateral assets, cover size, and projected liquidation net. Snapshot every ~10 minutes; every response prints snapshot age and a stale flag past 15 minutes.",
      priceUsd: 0.05,
    },
  ],
};

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json(MANIFEST);
};
