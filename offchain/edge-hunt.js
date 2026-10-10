/**
 * Flow Edge Hunt — find the fattest price edge on Base.
 * =====================================================
 * Scans multiple pairs across all venues, ranks them by edge (bps).
 * The fattest edge = where our first real profitable trade should go.
 *
 * Run: node offchain/edge-hunt.js
 * $0. Read-only. One multicall per pair.
 */
const { scan } = require("./scanner-v2");
const { ethers } = require("ethers");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

// [name, tokenIn, tokenOut, amountInRaw, tradeUsd]
const PAIRS = [
  ["USDC->WETH $500", USDC, WETH, "500000000", 500],
  ["WETH->USDC $500", WETH, USDC, ethers.parseEther("0.2").toString(), 500],
  ["USDC->cbBTC $500", USDC, CBBTC, "500000000", 500],
  ["WETH->cbBTC $500", WETH, CBBTC, ethers.parseEther("0.2").toString(), 500],
  ["USDC->VIRTUAL $200", USDC, VIRTUAL, "200000000", 200],
  ["WETH->VIRTUAL $200", WETH, VIRTUAL, ethers.parseEther("0.08").toString(), 200],
  ["USDC->AERO $200", USDC, AERO, "200000000", 200],
  ["WETH->DEGEN $100", WETH, DEGEN, ethers.parseEther("0.04").toString(), 100],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("Hunting for edge across Base pairs...\n");
  const rows = [];
  for (const [name, tIn, tOut, amt, usd] of PAIRS) {
    try {
      const s = await scan(tIn, tOut, amt);
      if (!s.best || !s.bestMeta) {
        console.log(`${name}: no quotes`);
        continue;
      }
      // baseline = uniswap 0.3% if available, else worst venue quote
      const uniBest = s.perVenue["uniswap-v3"];
      const baseline = uniBest ? uniBest.amount : s.best;
      const edgeBps = baseline > 0n ? Number(((s.best - baseline) * 10000n) / baseline) : 0;
      rows.push({ name, edgeBps, best: s.bestMeta.venue, latency: s.latencyMs });
      console.log(`${name}: edge ${edgeBps}bps via ${s.bestMeta.venue} (${s.latencyMs}ms)`);
    } catch (e) {
      console.log(`${name}: failed (${e.message.slice(0, 60)})`);
    }
    await sleep(2000); // be gentle with public RPC
  }

  console.log("\n=== RANKED BY EDGE ===");
  rows.sort((a, b) => b.edgeBps - a.edgeBps);
  rows.forEach((r, i) =>
    console.log(`${i + 1}. ${r.name}: ${r.edgeBps}bps (${r.best})`));

  const top = rows[0];
  if (top) {
    console.log(`\nFattest edge: ${top.name} at ${top.edgeBps}bps.`);
    // rough min trade size: filler needs edge*0.75 >= 4x gas; assume $0.03 gas
    const gasUsd = 0.03;
    const minTrade = top.edgeBps > 0 ? (4 * gasUsd) / ((top.edgeBps * 0.75) / 10000) : Infinity;
    console.log(`Rough min profitable trade there: $${minTrade.toFixed(0)} (at $0.03 gas)`);
  }
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
