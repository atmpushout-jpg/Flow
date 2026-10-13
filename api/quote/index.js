const { getBestQuote } = require("../_lib");
const x402 = require("../_x402");
const stats = require("../_stats");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // --- x402 pay-per-call gate (skipped unless X402_ENABLED=true) ---
  let gate = null;
  if (x402.isEnabled()) {
    gate = await x402.requirePayment(req, res);
    if (!gate) return; // 402 / 400 / 500 / 502 already sent
  }

  const { tokenIn, tokenOut, amountIn, slippageBps, validBlocks } = req.body || {};
  if (!tokenIn || !tokenOut || !amountIn) {
    await x402.releaseBuilderKey(gate); // malformed body — a builder-key call is not consumed
    return res.status(400).json({ error: "Missing tokenIn, tokenOut, or amountIn" });
  }
  try {
    const quote = await getBestQuote(tokenIn, tokenOut, amountIn, { slippageBps, validBlocks });
    await stats.trackQuote();
    const snap = await stats.snapshot();
    const body = {
      ...quote,
      protocolFee: "25% of price improvement over Uniswap baseline",
      instanceQuotes: snap.quotesServed,
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
        // Do not hand over the quote when settlement failed.
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
  } catch (e) {
    stats.trackError();
    res.status(500).json({ error: (e.message || "quote failed").slice(0, 200) });
  }
};
