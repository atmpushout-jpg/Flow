// GET /api/dashboard — aggregated dashboard data in one same-origin call.
// Avoids CORS issues from client-side fetches to raw.githubusercontent.com.
const { getBestQuote } = require("../_lib");
const stats = require("../_stats");

const GH_RAW = "https://raw.githubusercontent.com/atmpushout-jpg/Flow/main/stats/";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

// Probe set for the hero "best live edge" metric. The first entry is the
// canonical $100 USDC -> WETH quote that drives the venue/speed/liquidity
// cards; the rest widen the scan to pairs where venue dispersion actually
// shows up. Each probe is quoted live at request time through the same
// engine /api/quote uses — nothing here is cached or carried over.
const PROBES = [
  { pair: "USDC → WETH", tokenIn: USDC, tokenOut: WETH, amountIn: "100000000" },
  { pair: "USDC → cbBTC", tokenIn: USDC, tokenOut: CBBTC, amountIn: "100000000" },
  { pair: "USDC → AERO", tokenIn: USDC, tokenOut: AERO, amountIn: "100000000" },
  { pair: "USDC → VIRTUAL", tokenIn: USDC, tokenOut: VIRTUAL, amountIn: "100000000" },
  { pair: "USDC → DEGEN", tokenIn: USDC, tokenOut: DEGEN, amountIn: "100000000" },
  { pair: "WETH → cbBTC", tokenIn: WETH, tokenOut: CBBTC, amountIn: "50000000000000000" },
];

async function fetchJson(url) {
  try {
    const r = await fetch(url + "?t=" + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function runProbe(probe) {
  try {
    const q = await getBestQuote(probe.tokenIn, probe.tokenOut, probe.amountIn);
    return { ...probe, quote: q };
  } catch (e) {
    return { ...probe, quote: null, error: (e.message || "quote failed").slice(0, 100) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  // Live quotes across the whole probe set, in parallel.
  const probed = await Promise.all(PROBES.map(runProbe));

  // Canonical quote (drives the venue / speed / liquidity cards)
  const first = probed[0];
  const quote = first.quote || { error: first.error || "quote failed" };

  // Per-pair summary + best live edge across everything scanned. A pair only
  // ranks when it produced a quote with a measurable Uniswap baseline
  // (edgeBps is 0 by construction when no baseline exists, so such pairs can
  // never fabricate an edge). When every pair is at 0 the metric stays an
  // honest 0 with no pair/venue attached.
  const probes = probed.map((p) => p.quote
    ? {
        pair: p.pair,
        venue: p.quote.venue,
        venueKey: p.quote.venueKey,
        routeType: p.quote.routeType,
        edgeBps: p.quote.edgeBps,
        liquidity: p.quote.liquidity,
        bestOut: p.quote.bestOut,
        blockNumber: p.quote.blockNumber,
      }
    : { pair: p.pair, error: p.error || "quote failed" });

  // Thin-liquidity guard: a probe whose winner beats the runner-up by a wide
  // spread ("thin") is NOT ranked for the hero metric. Those numbers are
  // typically a dust baseline pool making a normal route look like a huge
  // edge — a phantom, not an executable one (observed live: USDC -> DEGEN
  // "7,406 bps" that way). Thin probes still appear in `probes` below with
  // their flag; they just can't headline. `thinExcluded` counts them.
  let thinExcluded = 0;
  let bestEdge = {
    edgeBps: 0,
    pair: null,
    venue: null,
    venueKey: null,
    routeType: null,
    liquidity: null,
    pairsScanned: PROBES.length,
    thinExcluded: 0,
    blockNumber: first.quote ? first.quote.blockNumber : null,
  };
  for (const p of probes) {
    if (typeof p.edgeBps !== "number") continue;
    if (p.liquidity === "thin") {
      if (p.edgeBps > 0) thinExcluded++;
      continue;
    }
    if (p.edgeBps > bestEdge.edgeBps) {
      bestEdge = {
        edgeBps: p.edgeBps,
        pair: p.pair,
        venue: p.venue,
        venueKey: p.venueKey,
        routeType: p.routeType,
        liquidity: p.liquidity,
        pairsScanned: PROBES.length,
        thinExcluded: 0, // finalized after the loop
        blockNumber: p.blockNumber,
      };
    }
  }
  bestEdge.thinExcluded = thinExcluded;

  // Usage totals: read from the shared counter in this same process
  // (stats/total.json on GitHub was never updated by any automation, so it
  // always read 0 — replaced by the live shared snapshot). Shape kept
  // compatible with dashboard.html ("totalQuotes").
  const snap = await stats.snapshot();
  const total = {
    totalQuotes: snap.quotesServed,
    errors: snap.errors,
    store: snap.store,
    lastUpdated: new Date().toISOString(),
    note: snap.note,
  };

  const explanation = await fetchJson(GH_RAW + "explanation.json");

  res.json({ quote, bestEdge, probes, explanation, total, at: new Date().toISOString() });
};

// Exported for tests.
module.exports.PROBES = PROBES;
