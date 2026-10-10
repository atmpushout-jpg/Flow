/**
 * Flow Agent API — best execution for AI trading agents on Base.
 * ==============================================================
 * AI agents POST swap requests, get the best cross-venue price,
 * sign an intent, and we fill it via flash loan. 25% of the price
 * improvement goes to the protocol, 75% of the edge goes to better
 * pricing for the agent.
 *
 * Endpoints:
 *   POST /quote  {tokenIn, tokenOut, amountIn} -> {bestOut, venues, edgeBps}
 *   POST /fill   {intent, userSig} -> {txHash, amountOut}
 *   GET  /health -> {status, blockNumber}
 *
 * Run: node offchain/agent-api.js
 * Env: PORT (default 3000), RPC_URL
 */
const express = require("express");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const app = express();
app.use(express.json());

// --- Venue config (same as hunter.js) ---
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"];
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

const UNI_TIERS = [500, 3000, 10000];
const AERO_SPACINGS = [1, 50, 100, 200];

async function getBestQuote(tokenIn, tokenOut, amountIn) {
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const uniQ = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const aeroQ = new ethers.Contract(AERO_QUOTER, AERO_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

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
  let best = { amountOut: 0n, venue: null, key: null };
  let bestUni = 0n;

  results.forEach((r, i) => {
    if (!r.success) return;
    try {
      const amt = BigInt(coder.decode(
        meta[i].venue === "uniswap" ? ["uint256","uint160","uint32","uint256"] : ["uint256"],
        r.returnData
      )[0].toString());
      if (meta[i].venue === "uniswap" && amt > bestUni) bestUni = amt;
      if (amt > best.amountOut) {
        best = { amountOut: amt, venue: meta[i].venue, key: meta[i].key };
      }
    } catch {}
  });

  const edgeBps = bestUni > 0n ? Number(((best.amountOut - bestUni) * 10000n) / bestUni) : 0;

  return {
    amountIn: amountIn.toString(),
    bestOut: best.amountOut.toString(),
    venue: best.venue,
    venueKey: best.key,
    uniswapOut: bestUni.toString(),
    edgeBps,
  };
}

// --- Routes ---

app.get("/health", async (req, res) => {
  try {
    const block = await provider.getBlockNumber();
    res.json({ status: "ok", blockNumber: block, chain: "base" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.post("/quote", async (req, res) => {
  const { tokenIn, tokenOut, amountIn } = req.body;
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "Missing tokenIn, tokenOut, or amountIn" });
  }
  try {
    const quote = await getBestQuote(tokenIn, tokenOut, amountIn);
    res.json({
      ...quote,
      protocolFee: "25% of price improvement over Uniswap baseline",
      note: "POST /fill with a signed EIP-712 intent to execute.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message.slice(0, 200) });
  }
});

app.post("/fill", async (req, res) => {
  // MVP: accepts intent, returns instructions.
  // Full execution wires to FlowFlashFiller once mainnet-deployed.
  const { intent, userSig } = req.body;
  if (!intent || !userSig) {
    return res.status(400).json({ error: "Missing intent or userSig" });
  }
  res.json({
    status: "queued",
    message: "Intent received. Onchain execution activates after FlowFlashFiller mainnet deployment.",
    intentHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(intent))).slice(0, 18) + "...",
  });
});

app.listen(PORT, () => {
  console.log(`Flow Agent API live on port ${PORT}`);
  console.log(`  POST /quote — best cross-venue price`);
  console.log(`  POST /fill  — submit signed intent`);
  console.log(`  GET  /health — status`);
});
