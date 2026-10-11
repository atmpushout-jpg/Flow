// GET /api/smart-wallets — smart-wallet leaderboard + real-time signal feed
// + paper-trading record. Machine-readable JSON for AI agents, no auth.
//
// Data: in fallback order — (1) Upstash Redis (flow:smartwallets,
// written every 2 min by the offchain tracker) when the env vars are
// configured; (2) the GitHub data plane: the offchain publisher
// commits the state snapshot to GitHub main every ~2 min ("[skip ci]"
// data commits) and this endpoint reads it back via
// raw.githubusercontent.com; (3) the bundled repo file as of the last
// deploy. Every response carries dataAsOf/source so consumers can
// judge freshness themselves.
//
// Honest-math rules: win rates are always paired with sample sizes,
// signals older than 10 min are flagged stale, and the paper record is
// labeled PAPER on every field. Past pumps do not predict future returns.

const fs = require("fs");
const path = require("path");
const x402 = require("../_x402");

const REDIS_KEY = "flow:smartwallets";
const STORE_TIMEOUT_MS = 1200;

const DISCLAIMER =
  "Paper record is simulated ($50 notional positions, no real money). " +
  "The leaderboard ranks wallets by early buys on Base tokens that pumped " +
  ">=50% in 24h — descriptive of the past, not predictive. Most copy-traders " +
  "lose to latency: followers get worse fills than the wallet they copy. " +
  "Signals older than 10 minutes are flagged stale; in memecoins a stale " +
  "signal is a different trade.";

const RESOURCE_META = {
  path: "/api/smart-wallets",
  description:
    "Use when an agent needs to know what profitable Base wallets are buying right now, or where social attention is spiking, before taking a position. Flow smart-wallet tracker: leaderboard of Base wallets ranked by early buys on pumping tokens, a real-time buy-signal feed (timestamp + block number per signal, stale flags past 10 min), a paper-trading record that copy-trades top wallets with $50 simulated positions, and a social-velocity overlay (DexScreener boost acceleration + GeckoTerminal trending rank, raw inputs included) showing where attention is spiking.",
  bazaarInput: { type: "http", method: "GET" },
  bazaarOutput: {
    leaderboard: [{ wallet: "0x…", rank: 1, wins: 7 }],
    signals: [{ symbol: "WETH", side: "buy", amountUsd: 2500, stale: false }],
    socialVelocity: { spikes: [{ token: "0x…", score: 82, level: "hot" }] },
    paperRecord: { totalTrades: 12, totalPnlUsd: 34.5 },
  },
};

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/atmpushout-jpg/Flow/main/offchain/smart-wallets.json";
const GITHUB_TIMEOUT_MS = 2500;
const GITHUB_CACHE_MS = 30 * 1000;
let ghCache = null; // { data, at } — per warm instance

async function readGithubState() {
  if (ghCache && Date.now() - ghCache.at < GITHUB_CACHE_MS) return ghCache.data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GITHUB_TIMEOUT_MS);
    const r = await fetch(GITHUB_RAW_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || typeof data !== "object") return null;
    ghCache = { data, at: Date.now() };
    return data;
  } catch {
    return null;
  }
}

async function readStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && tok) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
      const r = await fetch(`${url}/get/${REDIS_KEY}`, {
        headers: { Authorization: `Bearer ${tok}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        if (d && d.result) return { data: JSON.parse(d.result), source: "redis" };
      }
    } catch {
      /* fall through to the GitHub data plane */
    }
  }
  const gh = await readGithubState();
  if (gh) return { data: gh, source: "github" };
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "..", "offchain", "smart-wallets.json"),
      "utf8"
    );
    return { data: JSON.parse(raw), source: "bundled" };
  } catch {
    return { data: null, source: "none" };
  }
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  // --- x402 pay-per-call gate (skipped unless X402_ENABLED=true) ---
  let gate = null;
  if (x402.isEnabled()) {
    gate = await x402.requirePayment(req, res, RESOURCE_META);
    if (!gate) return; // 402 / 400 / 500 / 502 already sent
  }

  const { data, source } = await readStore();
  if (!data) {
    return res.status(503).json({
      error: "smart-wallet data not available yet — the tracker runs every 15 min; try again shortly",
    });
  }

  const now = Date.now();
  const signals = (data.signals || []).slice(0, 20).map((s) => {
    const ageSec = Math.max(0, Math.round((now - new Date(s.timestamp).getTime()) / 1000));
    return { ...s, ageSec, stale: ageSec * 1000 > 10 * 60 * 1000 };
  });

  const body = {
    leaderboard: (data.leaderboard || []).slice(0, 20),
    signals,
    socialVelocity: data.socialVelocity || null,
    paperRecord: data.paperRecord || null,
    methodology: data.methodology || null,
    leaderboardUpdatedAt: data.leaderboardUpdatedAt || null,
    signalsUpdatedAt: data.signalsUpdatedAt || null,
    dataAsOf: data.updatedAt || null,
    source, // "redis" (live, ~2 min), "github" (published snapshot, ~2 min), or "bundled" (as of last deploy)
    latencyMs: Date.now() - t0,
    disclaimer: DISCLAIMER,
  };

  if (gate) {
    let settled;
    try {
      settled = await x402.settlePayment(gate);
    } catch (e) {
      return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
    }
    if (!settled.success) {
      return res.status(402).json({
        error: `Payment settlement failed: ${settled.response.errorReason || "unknown"}`,
      });
    }
    x402.paymentResponseHeaders(res, settled.response);
    body.payment = {
      transaction: settled.response.transaction,
      network: settled.response.network,
      payer: settled.response.payer,
    };
  }

  res.json(body);
};
