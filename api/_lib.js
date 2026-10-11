// Shared quote logic for Vercel serverless functions.
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";

const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256,uint160[],uint32[],uint256)",
];
// PancakeSwap V3 QuoterV2 on Base — same QuoterV2 interface as Uniswap.
// Address verified empirically on Base mainnet (2026-10-11): contract code
// present and all four fee tiers return sane USDC->WETH quotes, with its
// 0.01% tier occasionally beating Uniswap's best.
const PANCAKE_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

const WETH = "0x4200000000000000000000000000000000000006";

const UNI_TIERS = [100, 500, 3000, 10000];
const PANCAKE_TIERS = [100, 500, 2500, 10000];
const AERO_SPACINGS = [1, 10, 50, 100, 200];
// Two-hop routes via WETH on Uniswap (tokenIn -> WETH -> tokenOut), tried as
// [feeLeg1, feeLeg2] pairs. Only added when neither side of the pair is WETH
// itself. Verified live: USDC->WETH->VIRTUAL beat the best direct route.
const HOP_FEE_COMBOS = [[100, 500], [500, 500], [500, 3000]];

// Return-data layouts per call kind, for decoding multicall results.
const DECODE_TYPES = {
  "v3-single": ["uint256", "uint160", "uint32", "uint256"],
  "v3-hop": ["uint256", "uint160[]", "uint32[]", "uint256"],
  aero: ["uint256"],
};

let _provider = null;
function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

// Pure ranking over decoded multicall results — extracted so it can be unit
// tested without RPC access. `meta[i]` describes result i:
//   { venue, key, kind, baseline }
// Only direct Uniswap quotes count toward the baseline (bestUni): the edge
// is measured against what a naive Uniswap-only execution would have gotten.
// A two-hop Uniswap route can WIN the quote, but it never inflates the
// baseline it is measured against.
function rankResults(results, meta, coder = ethers.AbiCoder.defaultAbiCoder()) {
  let best = { amountOut: 0n, venue: null, key: null, kind: null };
  let bestUni = 0n;
  let secondBest = 0n;

  results.forEach((r, i) => {
    if (!r.success) return;
    try {
      const amt = BigInt(coder.decode(DECODE_TYPES[meta[i].kind], r.returnData)[0].toString());
      if (meta[i].baseline && amt > bestUni) bestUni = amt;
      if (amt > best.amountOut) {
        secondBest = best.amountOut;
        best = { amountOut: amt, venue: meta[i].venue, key: meta[i].key, kind: meta[i].kind };
      } else if (amt > secondBest) {
        secondBest = amt;
      }
    } catch {}
  });

  return { best, bestUni, secondBest };
}

async function getBestQuote(tokenIn, tokenOut, amountIn, opts = {}) {
  const t0 = Date.now();
  // Expiring quotes: how many blocks this price is valid for (default 10 ≈ 20s on Base)
  const validBlocks = opts.validBlocks || 10;
  // Slippage buffer for minOutput guarantee (default 50 bps = 0.5%)
  const slippageBps = opts.slippageBps || 50;
  const p = provider();
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, p);
  const uniQ = new ethers.Contract(UNI_QUOTER, UNI_ABI, p);
  const pancakeQ = new ethers.Contract(PANCAKE_QUOTER, UNI_ABI, p);
  const aeroQ = new ethers.Contract(AERO_QUOTER, AERO_ABI, p);

  // Fetch block number in parallel with quotes for freshness tracking
  const blockPromise = p.getBlockNumber();

  const calls = [];
  const meta = [];
  const addV3 = (target, quoter, venue, tiers, baseline) => {
    tiers.forEach((fee) => {
      calls.push({
        target, allowFailure: true,
        callData: quoter.interface.encodeFunctionData("quoteExactInputSingle",
          [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }]),
      });
      meta.push({ venue, key: fee, kind: "v3-single", baseline });
    });
  };
  addV3(UNI_QUOTER, uniQ, "uniswap", UNI_TIERS, true);
  addV3(PANCAKE_QUOTER, pancakeQ, "pancakeswap", PANCAKE_TIERS, false);
  AERO_SPACINGS.forEach((ts) => {
    calls.push({
      target: AERO_QUOTER, allowFailure: true,
      callData: aeroQ.interface.encodeFunctionData("quoteExactInputSingle",
        [{ tokenIn, tokenOut, amountIn, tickSpacing: ts, sqrtPriceLimitX96: 0 }]),
    });
    meta.push({ venue: "aerodrome", key: ts, kind: "aero", baseline: false });
  });
  // Two-hop routes via WETH (skipped when WETH is already one side of the pair)
  const inIsWeth = tokenIn.toLowerCase() === WETH.toLowerCase();
  const outIsWeth = tokenOut.toLowerCase() === WETH.toLowerCase();
  if (!inIsWeth && !outIsWeth) {
    HOP_FEE_COMBOS.forEach(([f1, f2]) => {
      const path = ethers.solidityPacked(
        ["address", "uint24", "address", "uint24", "address"],
        [tokenIn, f1, WETH, f2, tokenOut]
      );
      calls.push({
        target: UNI_QUOTER, allowFailure: true,
        callData: uniQ.interface.encodeFunctionData("quoteExactInput", [path, amountIn]),
      });
      meta.push({ venue: "uniswap", key: `${f1}>${f2}`, kind: "v3-hop", baseline: false, via: "WETH" });
    });
  }

  const results = await mc.aggregate3.staticCall(calls);
  const blockNumber = await blockPromise;
  const { best, bestUni, secondBest } = rankResults(results, meta);

  const edgeBps = bestUni > 0n ? Number(((best.amountOut - bestUni) * 10000n) / bestUni) : 0;

  // Thin liquidity warning: if best beats second-best by a lot, the edge
  // may vanish on execution (small pool, high slippage risk)
  const spreadBps = secondBest > 0n ? Number(((best.amountOut - secondBest) * 10000n) / secondBest) : 0;
  const liquidityFlag = spreadBps > 50 ? "thin" : spreadBps > 20 ? "watch" : "deep";

  return {
    amountIn: amountIn.toString(),
    bestOut: best.amountOut.toString(),
    venue: best.venue,
    venueKey: best.key,
    routeType: best.kind === "v3-hop" ? "multihop" : "direct",
    routesScanned: meta.length,
    uniswapOut: bestUni.toString(),
    edgeBps,
    blockNumber,
    quotedAt: new Date().toISOString(),
    latencyMs: Date.now() - t0,
    liquidity: liquidityFlag,
    spreadBps,
    // --- Expiring quote: verifiable freshness bound ---
    // The quote is valid until this block. If current block > expiresAtBlock, re-quote.
    expiresAtBlock: blockNumber + validBlocks,
    validForBlocks: validBlocks,
    // Minimum output after slippage buffer — the worst case you should accept.
    // Enforceable on-chain via the router's minAmountOut.
    minOutput: ((best.amountOut * BigInt(10000 - slippageBps)) / 10000n).toString(),
    minOutputBps: slippageBps,
  };
}

module.exports = {
  getBestQuote,
  provider,
  rankResults,
  VENUES: { UNI_TIERS, PANCAKE_TIERS, AERO_SPACINGS, HOP_FEE_COMBOS, PANCAKE_QUOTER, WETH },
};
