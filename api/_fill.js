// Pure fill-fee math + route-package builder for POST /api/fill (Path C:
// sell the fill as a paid instruction — see
// goals/order-flow-auction-protocol-on-base/files/no-audit-fee-design.md).
//
// Fee rule (exact):
//   improvement          = bestOut - uniswapOut            (tokenOut units)
//   improvementValue     = improvement * amountIn / bestOut
//                          (improvement valued in tokenIn terms at the
//                          executed route's own rate)
//   fee (USD)            = min(25% of improvementValue in USD,
//                              10 bps of the trade's input value in USD)
//                          i.e. cap = 0.001 * amountIn valued in USD.
//   feeUsdAtomic         = floor(feeUsd * 1e6)  (USDC atomic, rounded DOWN)
//   no improvement       => fee is exactly 0 (no base fee, ever)
//   fee floor            => the CDP facilitator rejects payments below
//                          $0.001 (1000 USDC atomic) with amount_too_low
//                          (undocumented minimum, empirically confirmed on
//                          Base mainnet: ~$0.0002-$0.0005 rejected, $0.001
//                          settles). A computed fee in (0, floor) can never
//                          settle, so it is charged as $0 instead of being
//                          quoted: the package is served free with
//                          charged:false, exactly like zero improvement.
//                          The raw computed fee is preserved in
//                          computedFeeUsdAtomic and feeBelowFloor is set.
//
// All money math is BigInt rational arithmetic — no floats touch a fee.

"use strict";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const FEE_RULE = "25% of price improvement over Uniswap baseline, capped at 10 bps of output";

// Minimum fee the CDP facilitator can settle, in USDC atomic ($0.001).
// See the fee-floor note in the header comment.
const MIN_SETTLEABLE_FEE_ATOMIC = 1000n;

// Router addresses Flow's own swap code uses (copied exactly, with sources):
//   uniswap   SwapRouter02 — offchain/fill-bot.js:39 (UNI_ROUTER) and
//             offchain/auto-lp.js (UNI_SWAP_ROUTER), offchain/autopilot-v2.js:59
//   aerodrome Slipstream swap router — offchain/auto-lp.js (AERO_SWAP_ROUTER,
//             "same router autopilot-v2 uses for aero venues") and
//             offchain/autopilot-v2.js:61
//   pancakeswap — no router address exists anywhere in the repo (only its
//             QuoterV2 in api/_lib.js), so router/calldata are null there.
const ROUTERS = {
  uniswap: "0x2626664c2603336E57B271c5C0b26F421741e481",
  aerodrome: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  pancakeswap: null,
};

// Router ABIs already present in the repo (offchain/auto-lp.js:
// UNI_SWAP_ABI / AERO_SWAP_ABI). Note SwapRouter02's ExactInputSingleParams
// has NO deadline field; the Aerodrome Slipstream one does.
const UNI_SWAP_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
];
const AERO_SWAP_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
];

function toBig(x, name) {
  if (typeof x === "bigint") return x;
  if (typeof x === "number" && Number.isInteger(x)) return BigInt(x);
  if (typeof x === "string" && /^-?\d+$/.test(x.trim())) return BigInt(x.trim());
  throw new Error(`${name} must be an integer (BigInt, integer number, or integer string)`);
}

// usdPerTokenIn: USD value of ONE atomic unit of tokenIn, as an exact
// rational. Accepted forms:
//   - decimal string/number: "0.000001" (USDC atomic), 1e-6, "1"
//   - { numerator, denominator } BigInt-ish pair (exact quote-derived rate)
function parseRate(v) {
  if (v && typeof v === "object" && "numerator" in v && "denominator" in v) {
    const n = toBig(v.numerator, "usdPerTokenIn.numerator");
    const d = toBig(v.denominator, "usdPerTokenIn.denominator");
    if (d <= 0n) throw new Error("usdPerTokenIn denominator must be positive");
    return { n, d };
  }
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return { n: BigInt(s), d: 1n };
  const m = s.match(/^(-?)(\d*)\.(\d+)$/);
  if (m) {
    const digits = (m[2] || "0") + m[3];
    const n = BigInt((m[1] ? "-" : "") + digits);
    return { n, d: 10n ** BigInt(m[3].length) };
  }
  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    // JS number in exponent form (e.g. 1e-6): expand exactly via Number's
    // decimal string is lossy in general, but callers pass short rates.
    const num = Number(s);
    if (!Number.isFinite(num)) throw new Error("usdPerTokenIn is not finite");
    return parseRate(num.toFixed(12).replace(/0+$/, "").replace(/\.$/, ".0"));
  }
  throw new Error(`usdPerTokenIn not parseable: ${s.slice(0, 40)}`);
}

function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a || 1n; }
// Rational {n,d} -> decimal USD number with 6+ dp for display only.
function ratToNumber(r) { return Number(r.n) / Number(r.d); }

/**
 * computeFillFee({ amountIn, bestOut, uniswapOut, usdPerTokenIn })
 * amountIn/bestOut/uniswapOut: atomic-unit integers (BigInt/number/string).
 * usdPerTokenIn: USD per atomic unit of tokenIn (see parseRate).
 * Returns the full breakdown; feeUsdAtomic is a BigInt floored to USDC atomic.
 */
function computeFillFee(input) {
  const amountIn = toBig(input.amountIn, "amountIn");
  const bestOut = toBig(input.bestOut, "bestOut");
  const uniswapOut = toBig(input.uniswapOut, "uniswapOut");
  const rate = parseRate(input.usdPerTokenIn);
  if (rate.n < 0n) throw new Error("usdPerTokenIn must be >= 0");

  const improvementBps = uniswapOut > 0n && bestOut > uniswapOut
    ? Number(((bestOut - uniswapOut) * 10000n) / uniswapOut)
    : 0;

  if (bestOut <= 0n || uniswapOut <= 0n || bestOut <= uniswapOut || amountIn <= 0n) {
    return {
      improvementOut: "0",
      improvementBps: 0,
      improvementValueUsd: 0,
      uncappedFeeUsd: 0,
      capUsd: ratToNumber({ n: amountIn * rate.n, d: 1000n * rate.d }),
      capApplied: false,
      feeUsd: 0,
      feeUsdAtomic: 0n,
      feeAmountUsd: 0,
      feeBelowFloor: false,
      computedFeeUsdAtomic: "0",
    };
  }

  // improvementValueUsd = (bestOut-uniswapOut)*amountIn/bestOut * rate
  const impNum = (bestOut - uniswapOut) * amountIn * rate.n;
  const impDen = bestOut * rate.d;
  const g1 = gcd(impNum, impDen);
  const impVal = { n: impNum / g1, d: impDen / g1 };

  const uncapped = { n: impVal.n, d: impVal.d * 4n }; // 25%
  const cap = { n: amountIn * rate.n, d: 1000n * rate.d }; // 10 bps of input value
  const capApplied = uncapped.n * cap.d > cap.n * uncapped.d;
  const fee = capApplied ? cap : uncapped;
  const rawFeeUsdAtomic = (fee.n * 1000000n) / fee.d; // floor (all values >= 0)
  // Fee floor: a positive fee below the facilitator's settleable minimum
  // can never be collected, so it is charged as $0 (see header note).
  const feeBelowFloor = rawFeeUsdAtomic > 0n && rawFeeUsdAtomic < MIN_SETTLEABLE_FEE_ATOMIC;
  const feeUsdAtomic = feeBelowFloor ? 0n : rawFeeUsdAtomic;

  return {
    improvementOut: (bestOut - uniswapOut).toString(),
    improvementBps,
    improvementValueUsd: ratToNumber(impVal),
    uncappedFeeUsd: ratToNumber(uncapped),
    capUsd: ratToNumber(cap),
    capApplied,
    feeUsd: Number(feeUsdAtomic) / 1e6,
    feeUsdAtomic,
    feeAmountUsd: Number(feeUsdAtomic) / 1e6,
    feeBelowFloor,
    computedFeeUsdAtomic: rawFeeUsdAtomic.toString(),
  };
}

/**
 * Build exactInputSingle calldata when the repo gives us everything needed:
 * a known router + ABI and a recipient. Otherwise returns null — the full
 * parameter set is still included in the package; nothing is fabricated.
 */
function buildCalldata({ venue, venueKey, routeType, tokenIn, tokenOut, amountIn, minOutput, recipient, deadline }) {
  if (!recipient) return null;
  if (routeType === "multihop") return null; // exactInputSingle cannot express a hop path
  try {
    const { ethers } = require("ethers");
    if (venue === "uniswap") {
      const iface = new ethers.Interface(UNI_SWAP_ABI);
      return iface.encodeFunctionData("exactInputSingle", [{
        tokenIn, tokenOut, fee: Number(venueKey), recipient,
        amountIn: BigInt(amountIn), amountOutMinimum: BigInt(minOutput), sqrtPriceLimitX96: 0n,
      }]);
    }
    if (venue === "aerodrome") {
      const iface = new ethers.Interface(AERO_SWAP_ABI);
      return iface.encodeFunctionData("exactInputSingle", [{
        tokenIn, tokenOut, tickSpacing: Number(venueKey), recipient,
        deadline: BigInt(deadline || Math.floor(Date.now() / 1000) + 300),
        amountIn: BigInt(amountIn), amountOutMinimum: BigInt(minOutput), sqrtPriceLimitX96: 0n,
      }]);
    }
  } catch { return null; }
  return null;
}

/** Assemble the paid route package from a getBestQuote result + fee breakdown. */
function buildRoutePackage({ quote, tokenIn, tokenOut, amountIn, fee, recipient, deadline }) {
  const venue = quote.venue;
  const router = Object.prototype.hasOwnProperty.call(ROUTERS, venue) ? ROUTERS[venue] : null;
  const calldataParams = {
    tokenIn, tokenOut,
    fee: venue === "uniswap" ? (quote.routeType === "multihop" ? undefined : Number(quote.venueKey)) : undefined,
    tickSpacing: venue === "aerodrome" ? Number(quote.venueKey) : undefined,
    recipient: recipient || null,
    amountIn: String(amountIn),
    amountOutMinimum: quote.minOutput,
    sqrtPriceLimitX96: "0",
  };
  if (venue === "aerodrome") calldataParams.deadline = deadline || Math.floor(Date.now() / 1000) + 300;
  Object.keys(calldataParams).forEach((k) => calldataParams[k] === undefined && delete calldataParams[k]);

  const pkg = {
    venue,
    venueKey: quote.venueKey,
    routeType: quote.routeType || "direct",
    router,
    tokenIn,
    tokenOut,
    amountIn: String(amountIn),
    expectedOut: quote.bestOut,
    bestOut: quote.bestOut,
    uniswapOut: quote.uniswapOut,
    minOutput: quote.minOutput,
    minOutputBps: quote.minOutputBps,
    blockNumber: quote.blockNumber,
    expiresAtBlock: quote.expiresAtBlock,
    validForBlocks: quote.validForBlocks,
    quotedAt: quote.quotedAt,
    fee: {
      improvementBps: fee.improvementBps,
      improvementValueUsd: fee.improvementValueUsd,
      feeUsd: fee.feeUsd,
      amountUsd: fee.feeUsd, // alias named by the zero-improvement contract
      feeUsdAtomic: fee.feeUsdAtomic.toString(),
      belowFloor: fee.feeBelowFloor === true,
      computedFeeUsdAtomic: fee.computedFeeUsdAtomic != null ? String(fee.computedFeeUsdAtomic) : fee.feeUsdAtomic.toString(),
      capApplied: fee.capApplied,
      rule: FEE_RULE,
    },
    calldataParams,
    calldata: buildCalldata({
      venue, venueKey: quote.venueKey, routeType: quote.routeType,
      tokenIn, tokenOut, amountIn, minOutput: quote.minOutput, recipient,
      deadline: calldataParams.deadline,
    }),
  };
  if (quote.routeType === "multihop") {
    // Two-hop Uniswap route via WETH (api/_lib.js HOP_FEE_COMBOS): venueKey
    // is "feeLeg1>feeLeg2". Ship the exact packed path instead of calldata.
    const [f1, f2] = String(quote.venueKey).split(">").map(Number);
    pkg.pathTokens = [tokenIn, WETH, tokenOut];
    pkg.pathFees = [f1, f2];
    pkg.calldataNote = "Multihop route: execute via Uniswap V3 exactInput with the packed path (tokenIn, feeLeg1, WETH, feeLeg2, tokenOut); exactInputSingle calldata is not applicable.";
  } else if (!pkg.calldata) {
    pkg.calldataNote = !router
      ? "No router address for this venue exists in Flow's code in the repo, so calldata is omitted; calldataParams carry the full parameter set."
      : "calldata is built when the request includes a recipient address; calldataParams carry the full parameter set.";
  }
  return pkg;
}

module.exports = {
  USDC, WETH, FEE_RULE, MIN_SETTLEABLE_FEE_ATOMIC, ROUTERS, UNI_SWAP_ABI, AERO_SWAP_ABI,
  computeFillFee, buildRoutePackage, buildCalldata, _test: { parseRate },
};
