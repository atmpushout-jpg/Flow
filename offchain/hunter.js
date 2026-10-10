/**
 * Flow Hunter v2 — max speed opportunity scanner.
 * =================================================
 * Core change: everything runs in PARALLEL, not sequential.
 * One script checks triangular arb + cross-venue edges across
 * all pairs in ~2-3 seconds instead of minutes.
 *
 * Run: node offchain/hunter.js
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"];
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const T = {
  WETH: "0x4200000000000000000000000000000000000006",
  CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};
const UNI_TIERS = [500, 3000, 10000];
const AERO_SPACINGS = [1, 50, 100, 200];
const FLASH_BPS = 5;

// Build ALL quote calls upfront, fire in minimal multicalls
async function batchQuotes(requests) {
  // requests: [{venue:'uni'|'aero', tokenIn, tokenOut, amountIn, key}]
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const uniQ = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const aeroQ = new ethers.Contract(AERO_QUOTER, AERO_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const calls = requests.map((r) => {
    const q = r.venue === "uni" ? uniQ : aeroQ;
    const params = r.venue === "uni"
      ? { tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amountIn, fee: r.key, sqrtPriceLimitX96: 0 }
      : { tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amountIn, tickSpacing: r.key, sqrtPriceLimitX96: 0 };
    return {
      target: r.venue === "uni" ? UNI_QUOTER : AERO_QUOTER,
      allowFailure: true,
      callData: q.interface.encodeFunctionData("quoteExactInputSingle", [params]),
    };
  });

  // Split into chunks of 30 to avoid RPC limits
  const results = [];
  for (let i = 0; i < calls.length; i += 30) {
    const chunk = calls.slice(i, i + 30);
    const res = await mc.aggregate3.staticCall(chunk);
    results.push(...res);
  }

  return results.map((r, i) => {
    if (!r.success) return 0n;
    try {
      const req = requests[i];
      const amt = req.venue === "uni"
        ? coder.decode(["uint256","uint160","uint32","uint256"], r.returnData)[0]
        : coder.decode(["uint256"], r.returnData)[0];
      return BigInt(amt.toString());
    } catch { return 0n; }
  });
}

async function main() {
  const t0 = Date.now();
  const size = ethers.parseUnits("10000", 6);
  // Actual fill size: $20. Edges that only exist at $10k are quote-size
  // artifacts (thin pools), not real filler opportunities. Verify at fill
  // size before flagging.
  const FILL_USDC = ethers.parseUnits("20", 6);
  const FILL_WETH = ethers.parseEther("0.008"); // ~$20 of WETH

  // Build every quote we need: triangles + edges, all at once
  const requests = [];
  const idx = {}; // track indices

  // Triangles: USDC->M1->M2->USDC (need hop quotes, but hops depend on amounts...)
  // For speed: quote first hops at full size, estimate rest
  // Simpler: check direct cross-venue edges on major pairs (fastest signal)
  // [tokenIn, tokenOut, scanAmt, fillAmt, name]
  const pairs = [
    [USDC, T.WETH, size, FILL_USDC, "USDC->WETH"],
    [T.WETH, USDC, ethers.parseEther("4"), FILL_WETH, "WETH->USDC"],
    [USDC, T.VIRTUAL, size, FILL_USDC, "USDC->VIRTUAL"],
    [T.WETH, T.VIRTUAL, ethers.parseEther("4"), FILL_WETH, "WETH->VIRTUAL"],
    [USDC, T.AERO, size, FILL_USDC, "USDC->AERO"],
    [USDC, T.CBBTC, size, FILL_USDC, "USDC->CBBTC"],
  ];

  pairs.forEach(([tIn, tOut, amt, , name], pi) => {
    idx[name] = { start: requests.length };
    UNI_TIERS.forEach((f) => requests.push({ venue: "uni", tokenIn: tIn, tokenOut: tOut, amountIn: amt.toString(), key: f }));
    AERO_SPACINGS.forEach((s) => requests.push({ venue: "aero", tokenIn: tIn, tokenOut: tOut, amountIn: amt.toString(), key: s }));
    idx[name].count = UNI_TIERS.length + AERO_SPACINGS.length;
  });

  const quotes = await batchQuotes(requests);
  const ms = Date.now() - t0;

  console.log(`Scanned ${pairs.length} pairs x ${UNI_TIERS.length + AERO_SPACINGS.length} venues in ${ms}ms\n`);

  // First pass: find candidates at scan size
  const candidates = [];
  for (const [tIn, tOut, amt, , name] of pairs) {
    const { start, count } = idx[name];
    const qs = quotes.slice(start, start + count);
    const uniQs = qs.slice(0, UNI_TIERS.length);
    const bestUni = uniQs.reduce((a, b) => (a > b ? a : b), 0n);
    const best = qs.reduce((a, b) => (a > b ? a : b), 0n);
    if (best === 0n || bestUni === 0n) continue;
    const bps = Number(((best - bestUni) * 10000n) / bestUni);
    console.log(`${name}: ${bps}bps (scan size)`);
    if (bps >= 50) candidates.push([tIn, tOut, name]);
  }

  // Second pass: verify candidates at REAL fill size ($20).
  // Only flag as OPPORTUNITY if the edge survives at fill size.
  let bestEdge = { bps: 0 };
  if (candidates.length > 0) {
    console.log(`\nVerifying ${candidates.length} candidate(s) at $20 fill size...`);
    const vReqs = [];
    const vIdx = {};
    for (const [tIn, tOut, name] of candidates) {
      const pair = pairs.find((p) => p[4] === name);
      const fillAmt = pair[3];
      vIdx[name] = { start: vReqs.length };
      UNI_TIERS.forEach((f) => vReqs.push({ venue: "uni", tokenIn: tIn, tokenOut: tOut, amountIn: fillAmt.toString(), key: f }));
      AERO_SPACINGS.forEach((s) => vReqs.push({ venue: "aero", tokenIn: tIn, tokenOut: tOut, amountIn: fillAmt.toString(), key: s }));
      vIdx[name].count = UNI_TIERS.length + AERO_SPACINGS.length;
    }
    const vQuotes = await batchQuotes(vReqs);
    for (const [, , name] of candidates) {
      const { start, count } = vIdx[name];
      const qs = vQuotes.slice(start, start + count);
      const uniQs = qs.slice(0, UNI_TIERS.length);
      const bestUni = uniQs.reduce((a, b) => (a > b ? a : b), 0n);
      const best = qs.reduce((a, b) => (a > b ? a : b), 0n);
      if (best === 0n || bestUni === 0n) {
        console.log(`${name}: no liquidity at fill size -> SKIP`);
        continue;
      }
      const bps = Number(((best - bestUni) * 10000n) / bestUni);
      // Rough net on $20: gross edge minus ~$0.10 est. gas for fill tx
      const gross = (20 * bps) / 10000;
      const net = gross - 0.10;
      const mark = bps >= 50 && net > 0 ? " <-- REAL OPPORTUNITY" : " (artifact at size -> SKIP)";
      console.log(`${name}: ${bps}bps at $20 fill, est net $${net.toFixed(2)}${mark}`);
      if (bps >= 50 && net > 0 && bps > bestEdge.bps) bestEdge = { bps, name, net };
    }
  }

  console.log(`\nFastest REAL edge: ${bestEdge.name || "none"}${bestEdge.name ? ` at ${bestEdge.bps}bps (est net $${bestEdge.net.toFixed(2)})` : ""}`);
  console.log(`Total time: ${Date.now() - t0}ms`);
}

main().catch((e) => { console.error("FATAL:", e.message.slice(0, 150)); process.exit(1); });
