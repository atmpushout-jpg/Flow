// GET /api/forecaster — the Aave-on-Base "about to tip" board.
//
// What it sells: the current output of Flow's liquidation watcher —
// the Aave Base borrowers our trigger projects to cross health factor
// 1.0 (or that are already below it), each with current HF, HF
// velocity, projected blocks to crossing, debt/collateral assets,
// cover size, and the projected liquidation net from the watcher's
// own pre-stage economics. Derived data: the projection (velocity +
// crossing estimate + net) is computed by our watcher from live
// sweeps; it cannot be read off-chain for free.
//
// Data path (same fallback order as /api/signals):
//   (1) Upstash Redis flow:forecaster when the env vars are set;
//   (2) the GitHub data plane — offchain/forecaster-publish.js commits
//       offchain/forecaster-state.json to main every ~10 min and this
//       endpoint reads it back via raw.githubusercontent.com;
//   (3) the bundled repo file as of the last deploy.
//
// Receipts doctrine: every response prints generatedAt (when the
// watcher snapshot was computed), snapshotAgeSeconds, and stale —
// stale is true once the snapshot is older than 15 minutes, and a
// stale board is labeled, never dressed up as live. Forecasts are
// projections, not facts: HF moves with prices, and a projected
// crossing is an estimate from recent HF velocity.
//
// x402 pay-per-call gate: $0.05 (per-endpoint priceUsd in
// RESOURCE_META). Skipped unless X402_ENABLED=true (house pattern).
// Settlement happens only after the board is actually served — a
// request that finds no data returns 503 WITHOUT settling, so the
// payer is never charged for an empty answer.

const fs = require("fs");
const path = require("path");
const x402 = require("../_x402");

const REDIS_KEY = "flow:forecaster";
const STORE_TIMEOUT_MS = 1200;
const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/flow-executor/Flow/main/offchain/forecaster-state.json";
const GITHUB_TIMEOUT_MS = 2500;
const GITHUB_CACHE_MS = 30 * 1000;
const STALE_MS = 15 * 60 * 1000;

const DESCRIPTION =
  "Use when an agent runs liquidations, keeps Aave positions, or watches liquidation risk on Base and needs to know which borrowers are about to tip. Flow forecaster board: the Aave Base borrowers our liquidation watcher currently projects to cross health factor 1.0 (or that are already below it), each with current health factor, HF velocity per block, projected blocks to crossing, debt and collateral assets, cover size in USD, and the projected liquidation net from the watcher's pre-stage economics. Computed continuously from live sweeps and snapshotted every ~10 minutes; every response prints the snapshot time, its age in seconds, and a stale flag once the snapshot is older than 15 minutes.";

const RESOURCE_META = {
  path: "/api/forecaster",
  // Forecaster pricing: $0.05 — a derived, continuously computed board
  // (not a raw chain read). Quotes stay $0.01, verdicts $0.02.
  priceUsd: 0.05,
  description: DESCRIPTION,
  bazaarInput: {
    type: "http",
    method: "GET",
    queryParams: {},
  },
  bazaarOutput: {
    generatedAt: "2026-10-14T20:57:00.000Z",
    snapshotAgeSeconds: 42,
    stale: false,
    count: 1,
    positions: [
      {
        borrower: "0x12314a83c193f7b5aeabdbd69da59d328329d111",
        status: "crossed",
        hf: 0.903328,
        blocksToCross: 0,
        debtAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        collateralAsset: "0x4200000000000000000000000000000000000006",
        coverUsd: 0.0047,
        projectedNetUsd: -0.01,
      },
    ],
  },
};

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
      path.join(__dirname, "..", "..", "offchain", "forecaster-state.json"),
      "utf8"
    );
    return { data: JSON.parse(raw), source: "bundled" };
  } catch {
    return { data: null, source: "none" };
  }
}

module.exports = async (req, res) => {
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
  if (!data || !Array.isArray(data.positions)) {
    // No board anywhere: refuse WITHOUT settling (mirrors /api/signals),
    // so an authorized payment is never captured for an empty answer.
    await x402.releaseBuilderKey(gate);
    return res.status(503).json({
      error:
        "forecaster board not available yet — the watcher publishes a fresh snapshot every ~10 minutes; try again shortly",
    });
  }

  const generatedMs = new Date(data.generatedAt || 0).getTime();
  const ageSec = Number.isFinite(generatedMs)
    ? Math.max(0, Math.round((Date.now() - generatedMs) / 1000))
    : null;
  const stale = ageSec === null ? true : ageSec * 1000 > STALE_MS;

  const body = {
    service: data.service || "Flow forecaster — Aave on Base liquidation board",
    generatedAt: data.generatedAt || null,
    snapshotAgeSeconds: ageSec,
    stale,
    source,
    count: Number.isFinite(data.count) ? data.count : data.positions.length,
    positions: data.positions,
    boardRule: data.boardRule || undefined,
    baseBlockTimeSecAssumption: data.baseBlockTimeSecAssumption || undefined,
    ledgerTip: data.ledgerTip || undefined,
    note:
      "Forecasts are projections, not facts: health factors move with prices, blocks-to-crossing is estimated from recent HF velocity (estSecondsToCross assumes ~2s Base blocks), and projected nets are the watcher's pre-stage estimates at computation time, before any validator re-quote. Borrower positions are public on-chain Aave Base data. If stale is true, this snapshot is older than 15 minutes — treat it as history, not a live board.",
  };

  // Settle the authorized payment now that the resource has executed.
  // (Builder-key gates already reserved their test call — no settle.)
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
      settled: true,
      transaction: settled.response.transaction || null,
      payer: settled.response.payer || gate.payer || null,
    };
  }

  return res.status(200).json(body);
};
