// /.well-known/x402 manifest — x402 discovery metadata for Flow.
// Served via vercel.json rewrite from /.well-known/x402.
// Lists paid endpoints so x402scan and other crawlers can discover them.
const MANIFEST = {
  x402Version: 2,
  serviceName: "Flow",
  description:
    "Best-execution swap quotes for AI agents on Base. Compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, in ~91ms. Also: smart-wallet signals, contract safety checks, and an Aave liquidation forecaster board.",
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
    },
    {
      path: "/api/smart-wallets",
      method: "GET",
      description:
        "Smart-wallet tracker for Base: whale buy signals, wallet leaderboard by hit rate, and a public paper-trading record.",
      priceUsd: 0.01,
    },
    {
      path: "/api/signals",
      method: "GET",
      description:
        "Use when an agent is polling for fresh smart-wallet buy signals on Base and needs only what's new since its last check. Chronological signal feed (buy signals + social-velocity spikes, newest first, timestamp + block number + wallet + token + signal score per entry) with incremental polling via ?since=<unix timestamp or block number>.",
      priceUsd: 0.01,
    },
    {
      path: "/api/verify",
      method: "POST",
      description:
        "Contract safety check for AI agents: verdict, risk score, and plain-English report before approving a token.",
      priceUsd: 0.01,
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
