/**
 * Flow Triangular Arb Scanner
 * ===========================
 * Finds USDC -> X -> Y -> USDC routes where the round trip pays more
 * than it costs. Uses the multi-venue scanner for best execution per hop.
 *
 * With a flash loan, borrow $10k on a 50bps gap = ~$45 net.
 * Your $20 covers ~200-400 attempts worth of gas.
 *
 * Run: node offchain/tri-arb.js
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)",
];

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";

const TOKENS = { USDC, WETH, CBBTC, VIRTUAL, AERO };
const MIDS = ["WETH", "CBBTC", "VIRTUAL", "AERO"];
const TIERS = [500, 3000, 10000];
const FLASH_BPS = 5;

// Triangles: USDC -> MID1 -> MID2 -> USDC
function triangles() {
  const out = [];
  for (const m1 of MIDS)
    for (const m2 of MIDS) {
      if (m1 === m2) continue;
      out.push([TOKENS[m1], TOKENS[m2], m1, m2]);
    }
  return out;
}

async function bestHop(tokenIn, tokenOut, amountIn) {
  // best across Uniswap tiers via one multicall
  const q = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const calls = TIERS.map((fee) => ({
    target: UNI_QUOTER,
    allowFailure: true,
    callData: q.interface.encodeFunctionData("quoteExactInputSingle", [
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 },
    ]),
  }));
  const res = await mc.aggregate3.staticCall(calls);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let best = 0n, bestFee = 0;
  res.forEach((r, i) => {
    if (!r.success) return;
    try {
      const amt = BigInt(coder.decode(["uint256","uint160","uint32","uint256"], r.returnData)[0].toString());
      if (amt > best) { best = amt; bestFee = TIERS[i]; }
    } catch {}
  });
  return { best, bestFee };
}

async function main() {
  const size = ethers.parseUnits(process.argv[2] || "10000", 6); // $10k default
  console.log(`Scanning triangular arb at $${ethers.formatUnits(size, 6)} USDC...\n`);

  const tris = triangles();
  const results = [];
  for (const [m1, m2, n1, n2] of tris) {
    try {
      const h1 = await bestHop(USDC, m1, size);
      if (!h1.best) continue;
      const h2 = await bestHop(m1, m2, h1.best);
      if (!h2.best) continue;
      const h3 = await bestHop(m2, USDC, h2.best);
      if (!h3.best) continue;

      const grossBps = Number(((h3.best - size) * 10000n) / size);
      const netBps = grossBps - FLASH_BPS;
      results.push({ route: `USDC->${n1}->${n2}->USDC`, grossBps, netBps,
        hops: [h1, h2, h3] });
      const mark = netBps > 10 ? "  <-- WORTH A LOOK" : "";
      console.log(`USDC->${n1}->${n2}->USDC: gross ${grossBps}bps, net ${netBps}bps${mark}`);
    } catch (e) {
      console.log(`USDC->${n1}->${n2}->USDC: quote failed`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  results.sort((a, b) => b.netBps - a.netBps);
  const top = results[0];
  console.log(`\nBest: ${top.route} at ${top.netBps}bps net of flash premium.`);
  if (top.netBps > 10) {
    const profitUsd = (Number(size) / 1e6) * (top.netBps / 10000);
    console.log(`Estimated profit on $${ethers.formatUnits(size, 6)}: $${profitUsd.toFixed(2)} (before gas)`);
    console.log(`Hops:`, top.hops.map((h, i) => `fee ${h.bestFee}`).join(" -> "));
  } else {
    console.log("Nothing worth executing right now. The market is efficient.");
  }
}

main().catch((e) => { console.error("FATAL:", e.message.slice(0, 120)); process.exit(1); });
