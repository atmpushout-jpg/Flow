// POST /api/precheck — THE HYBRID: contract safety + best price in one call.
// For AI agents about to swap: "Is this safe AND am I getting a good price?"
// Read-only. No funds touched. No audit needed.
const { getBestQuote } = require("../_lib");
// Direct internal import of the verify engine — NOT an HTTP call to /api/verify.
// This bypasses the x402 payment gate (internal composition shouldn't pay),
// and it's faster (no HTTP round-trip). The gate lives in verify's HTTP
// handler; analyze() itself is pure logic.
const { analyze, resolveChain } = require("../verify")._internals;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { tokenIn, tokenOut, amountIn } = req.body || {};
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "Missing tokenIn, tokenOut, or amountIn" });
  }

  const t0 = Date.now();

  // Run safety check + price quote in parallel.
  // Safety runs IN-PROCESS via analyze() — never over HTTP — so flipping
  // X402_ENABLED=true can never 402 this internal call.
  const verifyP = (async () => {
    try {
      const chain = resolveChain("base");
      return await analyze(tokenOut, chain);
    } catch (e) {
      return { verdict: "unknown", score: 50, flags: ["Verify unavailable: " + e.message.slice(0, 80)] };
    }
  })();

  const quoteP = getBestQuote(tokenIn, tokenOut, amountIn).catch((e) => ({ error: e.message.slice(0, 100) }));

  const [safety, quote] = await Promise.all([verifyP, quoteP]);

  // Combined verdict: worst of the two
  const safeToProceed = safety.verdict === "safe" && !quote.error;
  const recommendation =
    safety.verdict === "danger" ? "DO NOT SWAP — contract failed safety check"
    : safety.verdict === "caution" ? "Proceed with caution — review safety flags first"
    : quote.error ? "Could not price this swap"
    : `Safe to swap via ${quote.venue} (${quote.edgeBps}bps edge, ${quote.liquidity} liquidity)`;

  res.json({
    safety: { verdict: safety.verdict, score: safety.score, flags: safety.flags || [] },
    price: quote.error ? { error: quote.error } : {
      venue: quote.venue, bestOut: quote.bestOut, edgeBps: quote.edgeBps,
      liquidity: quote.liquidity, blockNumber: quote.blockNumber,
    },
    recommendation,
    safeToProceed,
    latencyMs: Date.now() - t0,
  });
};
