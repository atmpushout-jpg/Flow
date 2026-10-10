/**
 * Flow Flash Filler Bot
 * =====================
 * Finds cross-venue edges and fills them with $0 inventory.
 *
 * How it works:
 * 1. Scans for pairs where Aerodrome/alt-venue beats Uniswap
 * 2. When edge >= MIN_EDGE_BPS, builds a fill
 * 3. Calls FlowFlashFiller.fillWithFlash onchain
 * 4. Flash loan provides capital, edge becomes profit
 *
 * Modes:
 * - SELF_FILL: operator is the user (proves the loop with own funds)
 * - USER_FILL: real user orders (needs user approvals)
 *
 * Run: OPERATOR_PK=0x... FILLER_CONTRACT=0x... node offchain/fill-bot.js
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const OPERATOR_PK = process.env.OPERATOR_PK || "";
const FILLER_CONTRACT = process.env.FILLER_CONTRACT || "";
const MIN_EDGE_BPS = parseInt(process.env.MIN_EDGE_BPS || "50");
const FILL_SIZE_USD = parseFloat(process.env.FILL_SIZE_USD || "20");

if (!OPERATOR_PK || !FILLER_CONTRACT) {
  console.error("Set OPERATOR_PK and FILLER_CONTRACT.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const operator = new ethers.Wallet(OPERATOR_PK, provider);

const FILLER_ABI = [
  "function fillWithFlash((address user,address tokenIn,uint256 amountIn,address tokenOut,uint256 userAmountOut,address swapTarget,bytes swapCalldata,uint256 minProfit)) external",
];

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"];
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"];

// Pairs to watch: [tokenIn, tokenOut, tokenOutDecimals, label]
const PAIRS = [
  [USDC, "0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18, "USDC->AERO"],
  [USDC, "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", 18, "USDC->VIRTUAL"],
  [USDC, "0x4200000000000000000000000000000000000006", 18, "USDC->WETH"],
];

async function findBestEdge() {
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const uniQ = new ethers.Contract(UNI_QUOTER, UNI_ABI, provider);
  const aeroQ = new ethers.Contract(AERO_QUOTER, AERO_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  let best = null;

  for (const [tIn, tOut, tOutDec, label] of PAIRS) {
    const amountIn = ethers.parseUnits(FILL_SIZE_USD.toString(), 6);

    // Quote Uniswap (baseline) and Aerodrome
    const calls = [];
    const uniFees = [500, 3000, 10000];
    const aeroSpacings = [100, 200];

    uniFees.forEach((fee) => calls.push({
      target: UNI_QUOTER, allowFailure: true,
      callData: uniQ.interface.encodeFunctionData("quoteExactInputSingle",
        [{ tokenIn: tIn, tokenOut: tOut, amountIn, fee, sqrtPriceLimitX96: 0 }]),
      venue: "uni", key: fee,
    }));
    aeroSpacings.forEach((ts) => calls.push({
      target: AERO_QUOTER, allowFailure: true,
      callData: aeroQ.interface.encodeFunctionData("quoteExactInputSingle",
        [{ tokenIn: tIn, tokenOut: tOut, amountIn, tickSpacing: ts, sqrtPriceLimitX96: 0 }]),
      venue: "aero", key: ts,
    }));

    const results = await mc.aggregate3.staticCall(calls.map(c => ({
      target: c.target, allowFailure: c.allowFailure, callData: c.callData,
    })));

    let bestUni = 0n, bestAero = 0n, bestAeroTs = 0;
    results.forEach((r, i) => {
      if (!r.success) return;
      try {
        const amt = BigInt(coder.decode(
          calls[i].venue === "uni" ? ["uint256","uint160","uint32","uint256"] : ["uint256"],
          r.returnData
        )[0].toString());
        if (calls[i].venue === "uni" && amt > bestUni) bestUni = amt;
        if (calls[i].venue === "aero" && amt > bestAero) {
          bestAero = amt; bestAeroTs = calls[i].key;
        }
      } catch {}
    });

    if (bestUni === 0n || bestAero === 0n) continue;
    const bps = Number(((bestAero - bestUni) * 10000n) / bestUni);

    if (bps >= MIN_EDGE_BPS && (!best || bps > best.bps)) {
      best = { label, tIn, tOut, tOutDec, bps, amountIn, bestUni, bestAero, bestAeroTs };
    }
  }

  return best;
}

async function main() {
  console.log(`Scanning for edges >= ${MIN_EDGE_BPS}bps (size: $${FILL_SIZE_USD})...\n`);

  const edge = await findBestEdge();
  if (!edge) {
    console.log("No edge found above threshold. Standing by.");
    return;
  }

  console.log(`Found: ${edge.label} at ${edge.bps}bps`);
  console.log(`  Uniswap: ${ethers.formatUnits(edge.bestUni, edge.tOutDec)}`);
  console.log(`  Aerodrome: ${ethers.formatUnits(edge.bestAero, edge.tOutDec)}`);

  // Build the fill: user gets Uniswap price, we keep the Aerodrome edge
  // For SELF_FILL mode, operator is the user
  const userAmountOut = edge.bestUni; // user gets the public market price
  const expectedProfit = edge.bestAero - edge.bestUni;
  const minProfit = (expectedProfit * 70n) / 100n; // 70% of expected, safety margin

  console.log(`  User gets: ${ethers.formatUnits(userAmountOut, edge.tOutDec)}`);
  console.log(`  Expected profit: ${ethers.formatUnits(expectedProfit, edge.tOutDec)}`);

  // Build Aerodrome swap calldata
  // Note: Aerodrome Slipstream router - using Uniswap-compatible interface for now
  // In production, use the actual Aerodrome router with tickSpacing
  const swapIface = new ethers.Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)"
  ]);

  // For now, demonstrate with Uniswap (Aerodrome router integration next)
  const swapCalldata = swapIface.encodeFunctionData("exactInputSingle", [{
    tokenIn: edge.tIn,
    tokenOut: edge.tOut,
    fee: 3000,
    recipient: FILLER_CONTRACT,
    amountIn: edge.amountIn,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  }]);

  const filler = new ethers.Contract(FILLER_CONTRACT, FILLER_ABI, operator);

  console.log("\nFiring fill...");
  try {
    const tx = await filler.fillWithFlash({
      user: operator.address,
      tokenIn: edge.tIn,
      amountIn: edge.amountIn,
      tokenOut: edge.tOut,
      userAmountOut,
      swapTarget: UNI_ROUTER,
      swapCalldata,
      minProfit,
    });
    console.log("Tx:", tx.hash);
    const rc = await tx.wait();
    console.log("Confirmed in block", rc.blockNumber);
  } catch (e) {
    console.log("Fill failed:", e.message.slice(0, 150));
  }
}

main().catch((e) => { console.error("FATAL:", e.message.slice(0, 150)); process.exit(1); });
