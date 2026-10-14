// POST /api/fill — Flow sells the fill as a paid instruction (Path C, see
// goals/order-flow-auction-protocol-on-base/files/no-audit-fee-design.md).
//
// Flow quotes across venues, measures the improvement over the Uniswap V3
// baseline (block-pinned), and charges 25% of that improvement capped at
// 10 bps of output value — via x402, BEFORE the route package is released.
// The caller then swaps wallet -> DEX router -> wallet; Flow never holds
// swap funds and runs no contract in the money path. Zero improvement =>
// fee $0, no payment gate, the (baseline) route package is served free.
//
// Referral split: a request may carry `referrer` (an EVM address). When
// it is valid, is not the payee, and its 25% share of the cut clears the
// facilitator's settle floor, the payer settles BOTH shares as two x402
// authorizations at settlement time (75% payee / 25% referrer — see
// _x402.requireSplitPayment). The referrer is paid by an official
// settlement from the payer, never out of the payee wallet, never an IOU.
//
// NOTE on stats: api/_stats.js exposes only quote/error counters, neither
// of which describes a fill, so this handler deliberately does not bump
// them rather than mislabel fills as quotes.
const lib = require("../_lib");
const x402 = require("../_x402");
const fill = require("../_fill");

const USDC = fill.USDC;

function resourceMeta(feeUsd, body) {
  return {
    path: "/api/fill",
    priceUsd: feeUsd,
    description:
      "Flow fill instruction on Base: the executable route package (venue, router, calldata params, min output, expiry block) for a swap whose best quote beats the Uniswap V3 baseline. Priced dynamically at 25% of the measured improvement, capped at 10 bps of output; $0 when there is no improvement.",
    bazaarInput: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: {
        tokenIn: body.tokenIn,
        tokenOut: body.tokenOut,
        amountIn: String(body.amountIn),
      },
    },
    bazaarOutput: {
      venue: "aerodrome",
      venueKey: 100,
      router: fill.ROUTERS.aerodrome,
      expectedOut: "138852000000000000000",
      minOutput: "138157000000000000000",
      fee: { feeUsd: 0.0917, capApplied: false, rule: fill.FEE_RULE },
    },
  };
}

// USD rate for fee conversion. Returns a usdPerTokenIn rate consumable by
// computeFillFee (USD per atomic unit of tokenIn), plus the quote used.
// If tokenOut is already USDC, the main quote IS the conversion quote.
async function usdRate(tokenIn, tokenOut, amountIn, mainQuote, blockTag) {
  if (String(tokenIn).toLowerCase() === USDC.toLowerCase()) return "0.000001";
  let usdQuote = null;
  if (String(tokenOut).toLowerCase() === USDC.toLowerCase()) {
    usdQuote = mainQuote;
  } else {
    usdQuote = await lib.getBestQuote(tokenIn, USDC, amountIn, { blockTag });
  }
  const usdOut = BigInt(usdQuote.bestOut);
  if (usdOut <= 0n) throw new Error("Could not price tokenIn in USD for the fill fee");
  // (usdOut atomic USDC / amountIn atomic tokenIn) * 1e-6 USD per USDC atomic
  return { numerator: usdOut, denominator: BigInt(amountIn) * 1000000n };
}

async function quoteAndFee(body, blockTag) {
  const quote = await lib.getBestQuote(body.tokenIn, body.tokenOut, body.amountIn, {
    slippageBps: body.slippageBps,
    validBlocks: body.validBlocks,
    blockTag,
  });
  if (!quote || !quote.venue || BigInt(quote.bestOut || "0") <= 0n) {
    throw new Error("No route quoted for this pair and size");
  }
  const rate = await usdRate(body.tokenIn, body.tokenOut, body.amountIn, quote, blockTag);
  const fee = fill.computeFillFee({
    amountIn: body.amountIn,
    bestOut: quote.bestOut,
    uniswapOut: quote.uniswapOut,
    usdPerTokenIn: rate,
  });
  return { quote, fee };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const body = req.body || {};
  const { tokenIn, tokenOut, amountIn } = body;
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "Missing tokenIn, tokenOut, or amountIn" });
  }
  // amountIn must be an integer atomic amount for the fee math.
  try { BigInt(amountIn); } catch {
    return res.status(400).json({ error: "amountIn must be an integer amount in smallest units" });
  }

  // Optional referral attribution (see header note). Format-checked here
  // so a malformed address fails before any quote or facilitator work.
  let referrer = null;
  if (body.referrer != null) {
    if (typeof body.referrer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.referrer.trim())) {
      return res.status(400).json({ error: "referrer must be a valid EVM address" });
    }
    referrer = body.referrer.trim();
  }

  const validBlocks = body.validBlocks != null ? Number(body.validBlocks) : 10;
  if (!Number.isInteger(validBlocks) || validBlocks <= 0) {
    return res.status(400).json({ error: "validBlocks must be a positive integer" });
  }

  // --- Optional block pin (the 402 -> paid retry passes the first quote's
  // blockNumber so the dynamic fee reproduces exactly). Expired/future
  // pins are rejected BEFORE any quote, gate, or facilitator call.
  let pinnedBlock;
  if (body.blockNumber != null) {
    pinnedBlock = Number(body.blockNumber);
    if (!Number.isInteger(pinnedBlock) || pinnedBlock <= 0) {
      return res.status(400).json({ error: "blockNumber must be a positive integer block number" });
    }
    let currentBlock;
    try {
      currentBlock = await lib.provider().getBlockNumber();
    } catch (e) {
      return res.status(500).json({ error: (e.message || "block lookup failed").slice(0, 200) });
    }
    if (pinnedBlock > currentBlock) {
      return res.status(400).json({ error: "blockNumber is in the future" });
    }
    if (currentBlock > pinnedBlock + validBlocks) {
      return res.status(409).json({
        error: "quote expired: the pinned block is older than the validity window; request a fresh fill quote",
      });
    }
  }

  let first;
  try {
    first = await quoteAndFee(body, pinnedBlock);
  } catch (e) {
    return res.status(500).json({ error: (e.message || "quote failed").slice(0, 200) });
  }
  const { quote, fee } = first;

  // --- Zero improvement: no charge, no gate, no facilitator call. -------
  if (fee.feeUsdAtomic === 0n) {
    const pkg = fill.buildRoutePackage({ quote, tokenIn, tokenOut, amountIn, fee, recipient: body.recipient });
    return res.json({
      ...pkg,
      charged: false,
      ...(referrer
        ? { referral: { referrer, applied: false, reason: "No fill fee was charged on this fill, so there is no cut to split." } }
        : {}),
      reason: fee.feeBelowFloor
        ? "The measured improvement prices a fill fee below the $0.001 minimum the payment facilitator can settle, so no payment was required (charged: false) and the route package is served free. The route package is the best route."
        : "No improvement over the Uniswap baseline at this block, so the fill fee is $0 and no payment was required. The route package is the best (baseline) route.",
    });
  }

  const feeUsd = fee.feeUsd;

  // --- Referral split of the cut ---------------------------------------
  // 25% of the charged cut to the referrer, 75% to the payee; both shares
  // settled by the payer via x402 (see the header note). The split needs
  // the referrer share itself to clear the facilitator's $0.001 settle
  // floor — below that, the whole cut settles to the payee and the
  // response's referral note says so. A referrer equal to the payee is a
  // no-op (the payee cannot refer itself).
  const cfg = x402.getConfig({ priceUsd: feeUsd });
  let split = null;
  let referralNote = null;
  if (referrer) {
    if (cfg.payTo && referrer.toLowerCase() === cfg.payTo.toLowerCase()) {
      referralNote = "referrer is the payee; the full cut settles to the payee as usual.";
    } else {
      const referrerAtomic = fee.feeUsdAtomic / 4n; // floor(25%)
      if (referrerAtomic >= fill.MIN_SETTLEABLE_FEE_ATOMIC) {
        split = {
          referrer,
          grossAtomic: fee.feeUsdAtomic,
          referrerAtomic,
          payeeAtomic: fee.feeUsdAtomic - referrerAtomic,
        };
      } else {
        referralNote =
          "The referrer share of this cut would fall below the $0.001 minimum the payment facilitator can settle, so the full cut settles to the payee.";
      }
    }
  }

  const meta = resourceMeta(feeUsd, body);
  let splitRequirements = null;
  if (split) {
    splitRequirements = [
      x402.paymentRequirementFor(meta, split.payeeAtomic, cfg.payTo),
      x402.paymentRequirementFor(meta, split.referrerAtomic, split.referrer),
    ];
    meta.accepts = splitRequirements; // the 402 challenge carries both shares
  }

  // --- x402 gate at the DYNAMIC fee (skipped unless X402_ENABLED=true) --
  let gate = null;
  if (x402.isEnabled()) {
    if (split) {
      gate = await x402.requireSplitPayment(req, res, meta, splitRequirements);
      if (!gate) return; // 402 / 400 / 500 / 502 already sent
    } else {
      gate = await x402.requirePayment(req, res, meta);
      if (!gate) return; // 402 / 400 / 500 / 502 already sent

      if (gate.builderKey) {
        // Early Builder Keys cover only the four data endpoints, not fill.
        await x402.releaseBuilderKey(gate);
        return x402.send402(
          res, req,
          "Flow fill is a priced product (25% of measured improvement, capped at 10 bps) and is not covered by Early Builder Keys.",
          meta
        );
      }
    }
  }

  // --- Re-quote pinned at the first quote's block and confirm the fee is
  // unchanged and unexpired BEFORE settling anything.
  let pkg;
  try {
    const again = await quoteAndFee(body, quote.blockNumber);
    if (again.fee.feeUsdAtomic !== fee.feeUsdAtomic) {
      // Do not settle a payment authorized for a different fee.
      return res.status(409).json({
        error: "quote changed: the re-quoted fill fee no longer matches the authorized fee; no payment was settled — request a fresh fill quote",
      });
    }
    let currentBlock = again.quote.blockNumber;
    try { currentBlock = await lib.provider().getBlockNumber(); } catch {}
    if (currentBlock > again.quote.expiresAtBlock) {
      return res.status(409).json({
        error: "quote expired before settlement; no payment was settled — request a fresh fill quote",
      });
    }
    pkg = fill.buildRoutePackage({
      quote: again.quote, tokenIn, tokenOut, amountIn, fee: again.fee, recipient: body.recipient,
    });
  } catch (e) {
    if (gate) await x402.releaseBuilderKey(gate);
    return res.status(500).json({ error: (e.message || "quote failed").slice(0, 200) });
  }

  const out = { ...pkg, charged: !!gate };
  if (referrer && !split) {
    out.referral = { referrer, applied: false, reason: referralNote };
  }
  if (split && !gate) {
    out.referral = {
      referrer,
      applied: false,
      reason: "The x402 gate is disabled on this deployment, so no fee was charged and no split settled.",
    };
  }

  // Settle the authorized payment(s) now that the package is built.
  if (gate && gate.split) {
    let results;
    try {
      results = await x402.settleSplitPayment(gate);
    } catch (e) {
      return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
    }
    const byPayTo = {};
    for (const r of results) byPayTo[String(r.requirements.payTo).toLowerCase()] = r;
    const payeeResult = byPayTo[String(cfg.payTo).toLowerCase()];
    const refResult = byPayTo[split.referrer.toLowerCase()];
    if (!payeeResult || !payeeResult.success || !refResult || !refResult.success) {
      // Do not hand over the route package on a partial split. Any share
      // that DID settle is named here so the payer holds its receipt.
      return res.status(402).json({
        error: "Referral-split settlement did not complete; the route package was not released.",
        settledShares: results
          .filter((r) => r.success)
          .map((r) => ({
            payTo: r.requirements.payTo,
            amountAtomic: String(r.requirements.amount),
            transaction: r.response.transaction,
          })),
      });
    }
    x402.paymentResponseHeaders(res, payeeResult.response);
    out.payment = {
      transaction: payeeResult.response.transaction,
      network: payeeResult.response.network,
      payer: payeeResult.response.payer,
    };
    out.referral = {
      referrer: split.referrer,
      applied: true,
      rule: "25% of Flow's improvement cut to the referrer, 75% to Flow; both shares settled by the payer via x402 at settlement time.",
      grossCutAtomic: split.grossAtomic.toString(),
      grossCutUsd: Number(split.grossAtomic) / 1e6,
      referrerShareAtomic: split.referrerAtomic.toString(),
      referrerShareUsd: Number(split.referrerAtomic) / 1e6,
      referrerTransaction: refResult.response.transaction,
      payeeShareAtomic: split.payeeAtomic.toString(),
      payeeShareUsd: Number(split.payeeAtomic) / 1e6,
      payeeTransaction: payeeResult.response.transaction,
    };
  } else if (gate) {
    let settled;
    try {
      settled = await x402.settlePayment(gate);
    } catch (e) {
      return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
    }
    if (!settled.success) {
      // Do not hand over the route package when settlement failed.
      return res.status(402).json({
        error: `Payment settlement failed: ${settled.response.errorReason || "unknown"}`,
      });
    }
    x402.paymentResponseHeaders(res, settled.response);
    out.payment = {
      transaction: settled.response.transaction,
      network: settled.response.network,
      payer: settled.response.payer,
    };
  }

  return res.json(out);
};
