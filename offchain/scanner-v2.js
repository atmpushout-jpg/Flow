/**
 * Flow Scanner v2 — Multi-Venue, Multicall-Batched
 * =================================================
 * One batched onchain query across Uniswap V3 + Aerodrome Slipstream
 * (legacy + v3 factories) to find the best execution price for a swap.
 *
 * Then an HONEST profitability check decides: fill via inventory, via
 * flash loan, or skip. The math that matters:
 *
 *   - The protocol earns 25% of (best - baseline) on EVERY fill, no matter
 *     how the filler settles. Flash vs inventory does not change protocol
 *     revenue. It only changes the FILLER's costs.
 *   - Aave V3 flash premium on Base ~= 5 bps. Our typical edge is ~5 bps.
 *     So flash loans REMOVE the inventory need but EAT the edge.
 *     Inventory keeps the full edge but needs capital + rebalancing.
 *   - Rule: fill only if filler net clears gas by 3x (safety factor).
 *
 * Usage as CLI:
 *   node offchain/scanner-v2.js <tokenIn> <tokenOut> <amountInRaw> <tradeUsd>
 *   e.g. node offchain/scanner-v2.js 0x8335... USDC_WETH 20000000 20
 *
 * Usage as module:
 *   const { scan, analyze } = require("./scanner-v2");
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)",
];

// ---- Venues ---------------------------------------------------------------
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_QUOTER_LEGACY = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_QUOTER_V3 = "0x514c8B5f54112481E28028F1166Bd78501089259";

const UNI_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
];
const AERO_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)",
];

const VENUES = [
  { name: "uniswap-v3", quoter: UNI_QUOTER, abi: UNI_ABI, kind: "uni", keys: [500, 3000, 10000] },
  { name: "aero-slipstream", quoter: AERO_QUOTER_LEGACY, abi: AERO_ABI, kind: "aero", keys: [1, 50, 100, 200, 2000] },
  { name: "aero-v3", quoter: AERO_QUOTER_V3, abi: AERO_ABI, kind: "aero", keys: [10, 50, 100, 200] },
];

const FLASH_PREMIUM_BPS = 5; // Aave V3 Base. Verify live via pool.FLASHLOAN_PREMIUM_TOTAL().
const SAFETY_FACTOR = 3;     // net must clear gas by 3x

// ---- Scanner ---------------------------------------------------------------
/**
 * Batch-quote every venue/key in ONE multicall. Returns per-venue bests and
 * the global best. Failed quotes are skipped, never fatal.
 */
async function scan(tokenIn, tokenOut, amountIn) {
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const calls = [];
  const meta = []; // parallel: which venue/key each call belongs to

  for (const v of VENUES) {
    const q = new ethers.Contract(v.quoter, v.abi, provider);
    for (const key of v.keys) {
      const params =
        v.kind === "uni"
          ? { tokenIn, tokenOut, amountIn, fee: key, sqrtPriceLimitX96: 0 }
          : { tokenIn, tokenOut, amountIn, tickSpacing: key, sqrtPriceLimitX96: 0 };
      calls.push({
        target: v.quoter,
        allowFailure: true,
        callData: q.interface.encodeFunctionData("quoteExactInputSingle", [params]),
      });
      meta.push({ venue: v.name, kind: v.kind, key });
    }
  }

  const t0 = Date.now();
  const results = await multicall.aggregate3.staticCall(calls);
  const ms = Date.now() - t0;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const perVenue = {};
  let best = 0n, bestMeta = null;

  results.forEach((r, i) => {
    if (!r.success) return;
    try {
      const m = meta[i];
      const out =
        m.kind === "uni"
          ? coder.decode(["uint256", "uint160", "uint32", "uint256"], r.returnData)[0]
          : coder.decode(["uint256"], r.returnData)[0];
      const amount = BigInt(out.toString());
      if (amount === 0n) return;
      if (!perVenue[m.venue] || amount > perVenue[m.venue].amount) {
        perVenue[m.venue] = { amount, key: m.key };
      }
      if (amount > best) { best = amount; bestMeta = m; }
    } catch { /* malformed returndata: skip */ }
  });

  return { best, bestMeta, perVenue, quotes: calls.length, latencyMs: ms };
}

// ---- Profitability ----------------------------------------------------------
/**
 * Honest fill decision. All args in plain numbers.
 *
 * @param bestOut      best execution (tokenOut raw)
 * @param baselineOut  baseline quote (tokenOut raw)
 * @param tradeUsd     USD value of amountIn (for USDC in, ~= amount)
 * @param ethUsd       ETH price USD (for gas conversion)
 * @param gasPriceWei  current gas price
 * @param gasEstimate  gas units for fillIntent (default 300k)
 * @param inventoryAvailable  does the filler hold tokenOut right now?
 */
function analyze({
  bestOut, baselineOut, tradeUsd, ethUsd,
  gasPriceWei, gasEstimate = 300000, inventoryAvailable = true,
}) {
  const edge = bestOut - baselineOut;
  const edgeBps = baselineOut > 0n ? Number((edge * 10000n) / baselineOut) : 0;
  const gasCostUsd = (Number(gasPriceWei) * gasEstimate * ethUsd) / 1e18;
  const gasBps = tradeUsd > 0 ? (gasCostUsd / tradeUsd) * 10000 : Infinity;

  // Filler keeps 75% of the edge; protocol takes 25% regardless of settlement.
  const fillerShareBps = edgeBps * 0.75;

  const netInventoryBps = fillerShareBps - gasBps;
  const netFlashBps = fillerShareBps - FLASH_PREMIUM_BPS - gasBps;

  const clears = (net) => net > 0 && net >= SAFETY_FACTOR * gasBps;

  let decision = "SKIP", via = null, netBps = 0;
  if (inventoryAvailable && clears(netInventoryBps)) {
    decision = "FILL"; via = "inventory"; netBps = netInventoryBps;
  } else if (clears(netFlashBps)) {
    decision = "FILL"; via = "flash"; netBps = netFlashBps;
  }

  return {
    edgeBps: +edgeBps.toFixed(2),
    gasBps: +gasBps.toFixed(2),
    flashPremiumBps: FLASH_PREMIUM_BPS,
    fillerNetInventoryBps: +netInventoryBps.toFixed(2),
    fillerNetFlashBps: +netFlashBps.toFixed(2),
    decision, via, netBps: +netBps.toFixed(2),
    note:
      decision === "SKIP"
        ? `Edge too thin: filler net ${netBps}bps doesn't clear gas ${gasBps}bps x${SAFETY_FACTOR}.`
        : `Filler net ${netBps}bps via ${via} clears gas x${SAFETY_FACTOR}. Protocol earns 25% of edge either way.`,
  };
}

async function ethUsd() {
  // ETH/USD via DexScreener (free, no key). Fallback: 2500.
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/pairs/base/0x6c561B446416E1A00E8E93E221854d6eA4171372");
    const d = await r.json();
    return parseFloat(d.pairs[0].priceUsd) || 2500;
  } catch { return 2500; }
}

// ---- CLI ---------------------------------------------------------------------
async function cli() {
  const [tokenIn, tokenOut, amountRaw, tradeUsd] = process.argv.slice(2);
  if (!tokenIn || !tokenOut || !amountRaw) {
    console.log("Usage: node offchain/scanner-v2.js <tokenIn> <tokenOut> <amountInRaw> [tradeUsd]");
    process.exit(1);
  }
  console.log(`Scanning ${VENUES.length} venues, one batched call...\n`);
  const s = await scan(tokenIn, tokenOut, amountRaw);

  console.log(`Quotes attempted: ${s.quotes} | latency: ${s.latencyMs}ms\n`);
  console.log("Best per venue:");
  for (const [name, q] of Object.entries(s.perVenue)) {
    const mark = s.bestMeta && `${s.bestMeta.venue}` === name ? "  <-- BEST" : "";
    console.log(`  ${name} (key ${q.key}): ${q.amount}${mark}`);
  }
  if (!s.best) { console.log("\nNo quotes returned."); return; }

  // Baseline = Uniswap 0.3% pool (the "public market"), as in v1.
  const uni = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const b = await uni.quoteExactInputSingle.staticCall(
    { tokenIn, tokenOut, amountIn: amountRaw, fee: 3000, sqrtPriceLimitX96: 0 }).catch(() => [0n]);
  const baseline = BigInt(b[0].toString());

  const [gasPrice, eusd] = await Promise.all([
    provider.getFeeData().then((f) => f.gasPrice || 1000000n),
    ethUsd(),
  ]);
  const a = analyze({
    bestOut: s.best, baselineOut: baseline,
    tradeUsd: parseFloat(tradeUsd || "0"), ethUsd: eusd,
    gasPriceWei: gasPrice, inventoryAvailable: true,
  });

  console.log(`\nBaseline (uni 0.3%): ${baseline}`);
  console.log(`Best execution:      ${s.best} (${s.bestMeta.venue}, key ${s.bestMeta.key})`);
  console.log(`\nProfitability:`);
  console.log(`  edge: ${a.edgeBps}bps | gas: ${a.gasBps}bps | flash premium: ${a.flashPremiumBps}bps`);
  console.log(`  filler net (inventory): ${a.fillerNetInventoryBps}bps`);
  console.log(`  filler net (flash):     ${a.fillerNetFlashBps}bps`);
  console.log(`  => ${a.decision}${a.via ? ` via ${a.via}` : ""}`);
  console.log(`  ${a.note}`);
}

if (require.main === module) cli().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
module.exports = { scan, analyze, VENUES, FLASH_PREMIUM_BPS };
