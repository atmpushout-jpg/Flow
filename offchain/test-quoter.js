/**
 * Test live Uniswap V3 QuoterV2 on Base mainnet
 * Run: node ~/workspace/flow-auction-protocol/offchain/test-quoter.js
 */
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

const ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const quoter = new ethers.Contract(QUOTER_V2, ABI, provider);

  // $1000 USDC -> WETH, USDC has 6 decimals
  const amountIn = 1000_000000n;
  console.log("Quoting $1000 USDC -> WETH on Base...");
  console.log("RPC:", RPC);

  for (const fee of [500, 3000, 10000]) {
    try {
      const params = { tokenIn: USDC, tokenOut: WETH, amountIn: amountIn.toString(), fee, sqrtPriceLimitX96: 0 };
      const res = await quoter.quoteExactInputSingle.staticCall(params);
      const amountOut = BigInt(res[0].toString());
      const eth = Number(amountOut) / 1e18;
      console.log(`  fee ${fee}: ${amountOut} wei = ~${eth.toFixed(6)} WETH`);
    } catch (e) {
      console.log(`  fee ${fee}: FAILED - ${e.message.slice(0, 120)}`);
    }
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
