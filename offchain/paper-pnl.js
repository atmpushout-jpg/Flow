/**
 * Flow Paper-P&L Tracker v2
 * -------------------------
 * Uses DexScreener's free API (no RPC rate limits) to read REAL 24h volume
 * from Base's USDC/WETH Uniswap V3 pools, then shows what Flow would earn
 * if it were live and routing flow.
 *
 * $0 cost. Read-only. No wallet needed.
 *
 * Run: node ~/workspace/flow-auction-protocol/offchain/paper-pnl.js
 *
 * Flow fee model: 0 base fee, 25% of price improvement.
 * Assumes average 15 bps improvement per swap -> ~3.75 bps take rate.
 */
const https = require("https");

const POOLS = [
  { addr: "0xd0b53D9277642d899DF5C87A3966A349A798F224", fee: 500 },
  { addr: "0x6c561B446416E1A00E8E93E221854d6eA4171372", fee: 3000 },
  { addr: "0x0b1C2DCbBfA744ebD3fC17fF1A96A1E1Eb4B2d69", fee: 10000 },
];
const TAKE_BPS = 3.75;

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "flow-paper-pnl/1.0" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("bad json"));
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  console.log("=== Flow Paper-P&L Tracker ===");
  console.log("Source: DexScreener, live Base USDC/WETH pools\n");

  let totalH24 = 0;
  for (const { addr, fee } of POOLS) {
    try {
      const d = await get(
        `https://api.dexscreener.com/latest/dex/pairs/base/${addr}`
      );
      const pair = d.pairs && d.pairs[0];
      const vol = pair && pair.volume ? pair.volume.h24 || 0 : 0;
      console.log(
        `  Pool ${fee} bps: $${vol.toLocaleString("en-US", { maximumFractionDigits: 0 })} / 24h`
      );
      totalH24 += vol;
    } catch (e) {
      console.log(`  Pool ${fee} bps: API error, skipped`);
    }
  }

  console.log(
    `\nTotal USDC/WETH volume: $${totalH24.toLocaleString("en-US", { maximumFractionDigits: 0 })} / 24h`
  );

  const at = (sharePct) => totalH24 * (sharePct / 100) * (TAKE_BPS / 10000);
  console.log("\nIf Flow were live RIGHT NOW (paper P&L, real volume):");
  for (const share of [0.1, 1, 5]) {
    console.log(`  ${share}% market share -> $${at(share).toFixed(2)}/day`);
  }

  const target = 350;
  const needed = totalH24 > 0 ? (target / totalH24 / (TAKE_BPS / 10000)) * 100 : Infinity;
  console.log(`\nTo hit $${target}/day at current volume: ${needed.toFixed(2)}% market share`);
  console.log("\nNote: USDC/WETH Uniswap V3 only. Full Base DEX volume is larger; this is a floor.");
  console.log("Run this anytime. If the number moves, the opportunity moves with it.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
