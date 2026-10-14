// GET /api/signals — chronological smart-wallet signal FEED for polling
// agents. Distinct from /api/smart-wallets (leaderboard snapshot): this
// returns the signal stream itself — recent buy signals plus
// social-velocity spikes — newest first, each entry carrying timestamp +
// block number + wallet + token + signal score.
//
// Incremental polling: ?since=<unix seconds | unix ms | ISO 8601 | block
// number>. Values >= 1e12 are read as milliseconds, >= 1e9 as unix
// seconds, anything smaller as a Base block number. Only entries strictly
// newer than `since` are returned, so an agent pays one cent per fresh
// view of the stream instead of re-buying the snapshot. Optional
// ?limit=<1..100> (default 50).
//
// Data: the SAME live store /api/smart-wallets reads, in fallback
// order — (1) Upstash Redis flow:smartwallets when the env vars are
// configured; (2) the GitHub data plane: the offchain publisher
// commits the state snapshot to GitHub main every ~2 min ("[skip ci]"
// data commits) and this endpoint reads it back via
// raw.githubusercontent.com; (3) the bundled repo file as of the last
// deploy. Responses carry dataAsOf/source/cursor so consumers can
// judge freshness and chain their next poll.
//
// Honesty rules (same as the tracker): signals older than 10 min are
// flagged stale; scores are labeled with exactly what they measure;
// past pumps do not predict future returns.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const x402 = require("../_x402");
const stats = require("../_stats");
const enrolledMod = require("../_enrolled");

const REDIS_KEY = "flow:smartwallets";
const STORE_TIMEOUT_MS = 1200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const STALE_MS = 10 * 60 * 1000;

const SCORE_METHOD =
  "signalScore (0-100) = the wallet's leaderboard win-rate percentage when " +
  "the wallet is ranked (wins / signals * 100, rounded); unranked wallets " +
  "score a flat 10 baseline (a tracked early buy with no ranked track " +
  "record yet); when a social-velocity spike is attached to the signal, " +
  "the score is the average of the two. Descriptive of the tracked past — " +
  "not a probability of profit.";

const DISCLAIMER =
  "Signals are descriptive of the past, not predictive: the feed lists " +
  "early buys by tracked wallets on Base tokens, and most copy-traders " +
  "lose to latency — followers get worse fills than the wallet they copy. " +
  "Signals older than 10 minutes are flagged stale; in memecoins a stale " +
  "signal is a different trade. Social-velocity spikes measure paid " +
  "promotion and attention (DexScreener boosts, GeckoTerminal trending), " +
  "not quality.";

const DESCRIPTION =
  "Use when an agent is polling for fresh smart-wallet buy signals on Base and needs only what's new since its last check. Flow signal feed: the chronological stream behind the smart-wallet tracker \u2014 recent buy signals from tracked Base wallets plus social-velocity spikes, newest first, each with timestamp, block number, wallet, token, and a labeled signal score. Supports incremental polling via ?since=<unix timestamp or block number>.";

const RESOURCE_META = {
  path: "/api/signals",
  description: DESCRIPTION,
  bazaarInput: {
    type: "http",
    method: "GET",
    queryParams: { since: "1757000000", limit: "50" },
  },
  bazaarOutput: {
    signals: [
      {
        timestamp: "2026-10-11T20:51:19Z",
        blockNumber: 52481266,
        wallet: "0x…",
        token: "0x…",
        symbol: "WETH",
        side: "buy",
        amountUsd: 1139.7,
        signalScore: 62,
        stale: false,
      },
    ],
    socialSpikes: [{ token: "0x…", symbol: "xdp", score: 82, level: "hot" }],
    cursor: { lastTimestamp: "2026-10-11T20:51:19Z", lastBlock: 52481266 },
    dataAsOf: "2026-10-11T20:52:13.737Z",
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

// Parse ?since into { tsMs } or { block }. See header for the value rules.
function parseSince(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 1e12) return { tsMs: n };
    if (n >= 1e9) return { tsMs: n * 1000 };
    return { block: n };
  }
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return { tsMs: ms };
  return { invalid: true };
}

function signalScore(s) {
  let base;
  if (s.unranked || s.walletRank == null) {
    base = 10;
  } else {
    const total = Number(s.walletSignals) || 0;
    const wins = Number(s.walletWins) || 0;
    base = total > 0 ? Math.round((wins / total) * 100) : 10;
  }
  const sv = s.socialVelocity && Number.isFinite(s.socialVelocity.score)
    ? s.socialVelocity.score
    : null;
  return sv === null ? base : Math.round((base + sv) / 2);
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const since = parseSince((req.query || {}).since);
  if (since && since.invalid) {
    return res.status(400).json({
      error:
        "Invalid ?since — use unix seconds, unix milliseconds, an ISO 8601 timestamp, or a Base block number.",
    });
  }
  let limit = parseInt((req.query || {}).limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // --- Enrolled-agent data price: $0.005 instead of $0.01 ------------
  // Identity rides in query params (agent + agentSig + ts — see
  // api/_enrolled.js for the canonical message): a listed agent that
  // proves control of its address gets this endpoint's challenge at
  // ENROLLED_DATA_PRICE_USD. The signature binds the exact view being
  // bought (since/limit verbatim as sent) inside a ±300s window, so a
  // captured signature replays only that one view, briefly. Invalid or
  // absent identity falls through to the standard gate, unchanged.
  let enrolledAgent = null;
  {
    const q = req.query || {};
    const tsNum = Number(q.ts);
    if (
      q.agent &&
      q.agentSig &&
      Number.isFinite(tsNum) &&
      Math.abs(Math.floor(Date.now() / 1000) - tsNum) <= enrolledMod.ENROLLED_DATA_MAX_SKEW_SEC &&
      enrolledMod.isEnrolled(q.agent)
    ) {
      try {
        const params = { ts: String(q.ts) };
        if (q.since !== undefined) params.since = String(q.since);
        if (q.limit !== undefined) params.limit = String(q.limit);
        const msg = enrolledMod.enrolledDataMessage({ agent: q.agent, path: "/api/signals", params });
        const recovered = ethers.verifyMessage(msg, String(q.agentSig));
        if (recovered && recovered.toLowerCase() === String(q.agent).toLowerCase()) {
          enrolledAgent = String(q.agent);
        }
      } catch {
        // Unverifiable signature — fall through to the standard gate.
      }
    }
  }
  const gateMeta = enrolledAgent
    ? { ...RESOURCE_META, priceUsd: enrolledMod.ENROLLED_DATA_PRICE_USD }
    : RESOURCE_META;

  // --- x402 pay-per-call gate (skipped unless X402_ENABLED=true) ---
  let gate = null;
  if (x402.isEnabled()) {
    gate = await x402.requirePayment(req, res, gateMeta);
    if (!gate) return; // 402 / 400 / 500 / 502 already sent
  }

  const { data, source } = await readStore();
  if (!data) {
    return res.status(503).json({
      error: "signal data not available yet — the tracker runs every few minutes; try again shortly",
    });
  }

  const now = Date.now();
  const all = (data.signals || [])
    .map((s) => {
      const tsMs = new Date(s.timestamp).getTime();
      const ageSec = Number.isFinite(tsMs) ? Math.max(0, Math.round((now - tsMs) / 1000)) : null;
      return {
        ...s,
        signalScore: signalScore(s),
        ageSec,
        stale: ageSec === null ? true : ageSec * 1000 > STALE_MS,
        _tsMs: Number.isFinite(tsMs) ? tsMs : 0,
      };
    })
    .sort((a, b) => b._tsMs - a._tsMs || (b.blockNumber || 0) - (a.blockNumber || 0));

  const fresh = since
    ? all.filter((s) =>
        since.block !== undefined
          ? (s.blockNumber || 0) > since.block
          : s._tsMs > since.tsMs
      )
    : all;

  const signals = fresh.slice(0, limit).map(({ _tsMs, ...rest }) => rest);

  const spikes = ((data.socialVelocity && data.socialVelocity.spikes) || []).map((sp) => ({
    ...sp,
    timestamp: (data.socialVelocity && data.socialVelocity.updatedAt) || data.signalsUpdatedAt || null,
  }));

  const newest = all[0] || null;
  const body = {
    signals,
    socialSpikes: spikes,
    returned: signals.length,
    available: all.length,
    sinceApplied: since
      ? since.block !== undefined
        ? { block: since.block }
        : { timestamp: new Date(since.tsMs).toISOString() }
      : null,
    cursor: {
      lastTimestamp: newest ? newest.timestamp : null,
      lastBlock: newest ? newest.blockNumber || null : null,
      hint: "Pass cursor.lastTimestamp (or lastBlock) as ?since= on the next poll to receive only newer entries.",
    },
    signalsUpdatedAt: data.signalsUpdatedAt || null,
    dataAsOf: data.updatedAt || null,
    source, // "redis" (live, ~2 min), "github" (published snapshot, ~2 min), or "bundled" (as of last deploy)
    latencyMs: Date.now() - t0,
    scoreMethod: SCORE_METHOD,
    disclaimer: DISCLAIMER,
  };

  if (enrolledAgent) {
    body.enrolled = { agent: enrolledAgent, priceUsd: enrolledMod.ENROLLED_DATA_PRICE_USD };
  }

  await stats.trackQuote();

  if (gate && !gate.builderKey) {
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

  if (gate && gate.builderKey) {
    body.builderKey = { callsRemaining: gate.builderKey.callsRemaining };
  }

  res.json(body);
};
