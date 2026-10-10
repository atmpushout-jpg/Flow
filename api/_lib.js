// Shared quote logic for Vercel serverless functions.
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";

const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"];
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

const UNI_TIERS = [500, 3000, 10000];
const AERO_SPACINGS = [1, 50, 100, 200];

let _provider = null;
function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
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
  const aeroQ = new ethers.Contract(AERO_QUOTER, AERO_ABI, p);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // Fetch block number in parallel with quotes for freshness tracking
  const blockPromise = p.getBlockNumber();

  const calls = [];
  const meta = [];
  UNI_TIERS.forEach((fee) => {
    calls.push({
      target: UNI_QUOTER, allowFailure: true,
      callData: uniQ.interface.encodeFunctionData("quoteExactInputSingle",
        [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }]),
    });
    meta.push({ venue: "uniswap", key: fee });
  });
  AERO_SPACINGS.forEach((ts) => {
    calls.push({
      target: AERO_QUOTER, allowFailure: true,
      callData: aeroQ.interface.encodeFunctionData("quoteExactInputSingle",
        [{ tokenIn, tokenOut, amountIn, tickSpacing: ts, sqrtPriceLimitX96: 0 }]),
    });
    meta.push({ venue: "aerodrome", key: ts });
  });

  const results = await mc.aggregate3.staticCall(calls);
  const blockNumber = await blockPromise;
  let best = { amountOut: 0n, venue: null, key: null };
  let bestUni = 0n;
  let secondBest = 0n;

  results.forEach((r, i) => {
    if (!r.success) return;
    try {
      const amt = BigInt(coder.decode(
        meta[i].venue === "uniswap" ? ["uint256","uint160","uint32","uint256"] : ["uint256"],
        r.returnData
      )[0].toString());
      if (meta[i].venue === "uniswap" && amt > bestUni) bestUni = amt;
      if (amt > best.amountOut) {
        secondBest = best.amountOut;
        best = { amountOut: amt, venue: meta[i].venue, key: meta[i].key };
      } else if (amt > secondBest) {
        secondBest = amt;
      }
    } catch {}
  });

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

module.exports = { getBestQuote, provider };
