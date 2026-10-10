/**
 * Flow Autopilot — the $20 money machine.
 * ========================================
 * Watches for triangular arb gaps. When one clears the profit bar,
 * it fires the flash loan automatically. No human needed.
 *
 * What YOU put up:
 *   1. A fresh wallet with ~$20 ETH on Base (gas money only)
 *   2. That wallet's private key (via secure entry, never in chat)
 *   3. Permission to auto-fire (this script IS that permission)
 *
 * What you DON'T put up: trading capital. Flash loans borrow it.
 *
 * Safety rails:
 *   - Only fires if net profit >= MIN_PROFIT_USD (default $10)
 *   - Only fires if net edge >= 15bps (avoids dust)
 *   - Contract reverts if unprofitable (chain is the final judge)
 *   - Profits sweep to your wallet after each win
 *
 * Run: OPERATOR_PK=0x... ARB_CONTRACT=0x... node offchain/autopilot.js
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const OPERATOR_PK = process.env.OPERATOR_PK || "";
const ARB_CONTRACT = process.env.ARB_CONTRACT || "";
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "10");
const MIN_EDGE_BPS = 15;
const BORROW_USD = parseFloat(process.env.BORROW_USD || "10000");

if (!OPERATOR_PK || !ARB_CONTRACT) {
  console.error("Set OPERATOR_PK and ARB_CONTRACT.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const operator = new ethers.Wallet(OPERATOR_PK, provider);

const ARB_ABI = [
  "function executeArb(address asset,uint256 amount,(address tokenOut,uint24 fee)[] hops,uint256 minProfit) external",
  "function sweep(address token) external",
];

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKENS = {
  WETH: "0x4200000000000000000000000000000000000006",
  CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};
const MIDS = ["WETH", "CBBTC", "VIRTUAL", "AERO"];
const TIERS = [500, 3000, 10000];
const FLASH_BPS = 5;

const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

async function bestHop(tokenIn, tokenOut, amountIn) {
  const q = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const calls = TIERS.map((fee) => ({
    target: UNI_QUOTER, allowFailure: true,
    callData: q.interface.encodeFunctionData("quoteExactInputSingle",
      [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }]),
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
  console.log("Autopilot check...\n");
  const size = ethers.parseUnits(BORROW_USD.toString(), 6);
  let bestOpp = null;

  for (const m1 of MIDS) for (const m2 of MIDS) {
    if (m1 === m2) continue;
    try {
      const h1 = await bestHop(USDC, TOKENS[m1], size);
      if (!h1.best) continue;
      const h2 = await bestHop(TOKENS[m1], TOKENS[m2], h1.best);
      if (!h2.best) continue;
      const h3 = await bestHop(TOKENS[m2], USDC, h2.best);
      if (!h3.best) continue;
      const netBps = Number(((h3.best - size) * 10000n) / size) - FLASH_BPS;
      if (!bestOpp || netBps > bestOpp.netBps)
        bestOpp = { m1, m2, netBps, hops: [h1, h2, h3] };
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!bestOpp) { console.log("No routes quoted. Standing by."); return; }
  console.log(`Best: USDC->${bestOpp.m1}->${bestOpp.m2}->USDC at ${bestOpp.netBps}bps net.`);

  const profitUsd = BORROW_USD * (bestOpp.netBps / 10000);
  if (bestOpp.netBps < MIN_EDGE_BPS || profitUsd < MIN_PROFIT_USD) {
    console.log(`Below bar (need ${MIN_EDGE_BPS}bps + $${MIN_PROFIT_USD}). Standing by.`);
    return;
  }

  // FIRE
  console.log(`\nFIRING: est. profit $${profitUsd.toFixed(2)}`);
  const arb = new ethers.Contract(ARB_CONTRACT, ARB_ABI, operator);
  const hops = [
    { tokenOut: TOKENS[bestOpp.m1], fee: bestOpp.hops[0].bestFee },
    { tokenOut: TOKENS[bestOpp.m2], fee: bestOpp.hops[1].bestFee },
    { tokenOut: USDC, fee: bestOpp.hops[2].bestFee },
  ];
  const minProfit = (size * BigInt(Math.floor(profitUsd * 0.7 * 1e6))) / BigInt(BORROW_USD * 1e6);
  // minProfit = 70% of estimate, in USDC raw (conservative: reverts if worse)

  try {
    const tx = await arb.executeArb(USDC, size, hops, minProfit);
    console.log("Tx sent:", tx.hash);
    const rc = await tx.wait();
    console.log("Confirmed in block", rc.blockNumber);
    // Sweep profit to operator
    const stx = await arb.sweep(USDC);
    await stx.wait();
    console.log(`Profit swept.`);
  } catch (e) {
    console.log("Execution failed (chain rejected it):", e.message.slice(0, 120));
    console.log("Cost: gas only. Capital untouched (flash loan reverted).");
  }
}

main().catch((e) => { console.error("FATAL:", e.message.slice(0, 150)); process.exit(1); });
