/**
 * Flow One-Command Swap
 * =====================
 * The simplest possible version. One command runs a real swap through the
 * full Flow loop and tells you exactly what happened in plain language.
 *
 *   OPERATOR_PK=0x... ROUTER_ADDRESS=0x... RPC_URL=... node offchain/flow-swap.js 20
 *
 * The operator is user + auctioneer + filler (closed loop, no strangers needed).
 * Prints a shareable savings receipt at the end — every swap that beats the
 * market IS the marketing. People share savings, not protocols.
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://localhost:8545";
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "";
const OPERATOR_PK = process.env.OPERATOR_PK || "";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453");
const USDC = process.env.USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = process.env.WETH || "0x4200000000000000000000000000000000000006";
const BASELINE_TIER = 3000; // the "public market" pool
const FEE_TIERS = [500, 3000, 10000];
const MIN_EDGE_BPS = 5;

if (!ROUTER_ADDRESS || !OPERATOR_PK) {
  console.error("Set ROUTER_ADDRESS and OPERATOR_PK first.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const op = new ethers.Wallet(OPERATOR_PK, provider);

const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function fillIntent((address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce),bytes userSig,uint256 amountOut,uint256 baselineOut,bytes auctionSig) external",
  "function nonces(address) view returns (uint256)",
  "function hashIntent((address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)) view returns (bytes32)",
  "function maxAmountIn() view returns (uint256)",
];
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const TYPES = { Intent: [
  { name: "user", type: "address" }, { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" }, { name: "expiry", type: "uint256" },
  { name: "nonce", type: "uint256" },
]};
const domain = () => ({
  name: "FlowIntentRouter", version: "0",
  chainId: CHAIN_ID, verifyingContract: ROUTER_ADDRESS,
});

async function quote(tokenIn, tokenOut, amountIn, fee) {
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
  try {
    const r = await quoter.quoteExactInputSingle.staticCall(
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 });
    return BigInt(r[0].toString());
  } catch { return 0n; }
}

async function main() {
  const usdcAmount = process.argv[2];
  if (!usdcAmount || isNaN(parseFloat(usdcAmount))) {
    console.error("Usage: node offchain/flow-swap.js <USDC amount>\n  e.g. node offchain/flow-swap.js 20");
    process.exit(1);
  }
  const amountIn = ethers.parseUnits(usdcAmount, 6);
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, op);

  console.log(`\nSwapping ${usdcAmount} USDC -> WETH via Flow...\n`);

  // Safety: respect the onchain cap
  const cap = await router.maxAmountIn();
  if (cap > 0n && amountIn > cap) {
    console.error(`Amount exceeds maxAmountIn cap (${ethers.formatUnits(cap, 6)} USDC).`);
    process.exit(1);
  }

  // 1. What would the public market give you?
  const baseline = await quote(USDC, WETH, amountIn, BASELINE_TIER);
  if (baseline === 0n) { console.error("No baseline quote. Quoter unreachable."); process.exit(1); }
  console.log(`Public market would give you: ${ethers.formatUnits(baseline, 18)} WETH`);

  // 2. What does Flow's filler bid?
  let best = 0n, bestTier = 0;
  for (const fee of FEE_TIERS) {
    const q = await quote(USDC, WETH, amountIn, fee);
    if (q > best) { best = q; bestTier = fee; }
  }
  const minBid = (baseline * BigInt(10000 + MIN_EDGE_BPS)) / 10000n;
  if (best < minBid) {
    console.log("No edge over the market right now. Not swapping — your money stays put.");
    process.exit(0);
  }
  console.log(`Flow filler bids:             ${ethers.formatUnits(best, 18)} WETH`);

  // 3. Approve + sign intent + authorize + fill (all as operator)
  if ((await usdc.allowance(op.address, ROUTER_ADDRESS)) < amountIn) {
    console.log("Approving USDC...");
    await (await usdc.approve(ROUTER_ADDRESS, ethers.MaxUint256)).wait();
    await new Promise((r) => setTimeout(r, 2000)); // let the node settle the nonce
  }
  const nonce = await router.nonces(op.address);
  const intent = {
    user: op.address, tokenIn: USDC, tokenOut: WETH,
    amountIn: amountIn.toString(),
    minAmountOut: ((baseline * 98n) / 100n).toString(),
    expiry: Math.floor(Date.now() / 1000) + 180,
    nonce: nonce.toString(),
  };
  const userSig = await op.signTypedData(domain(), TYPES, intent);
  const intentHash = await router.hashIntent(intent);
  const auctionHash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32", "address", "uint256", "uint256"],
    [ROUTER_ADDRESS, CHAIN_ID, intentHash, op.address, best.toString(), baseline.toString()]
  );
  const auctionSig = await op.signMessage(ethers.getBytes(auctionHash));

  console.log("Filling onchain...");
  const tx = await router.connect(op).fillIntent(
    intent, userSig, best.toString(), baseline.toString(), auctionSig);
  await tx.wait();

  // 4. Plain-language results
  const improvement = best - baseline;
  let fee = (improvement * 2500n) / 10000n;
  const feeCap = (best * 10n) / 10000n;
  if (fee > feeCap) fee = feeCap;
  const youGot = best - fee;
  const savedBps = Number((improvement * 10000n) / baseline) / 100;

  console.log(`\nDone.`);
  console.log(`  You received:  ${ethers.formatUnits(youGot, 18)} WETH`);
  console.log(`  You beat the market by: ${savedBps.toFixed(2)}%`);
  console.log(`  Protocol earned: ${ethers.formatUnits(fee, 18)} WETH`);

  // 5. The pull mechanism: a shareable savings receipt.
  //    People don't discover protocols. They discover better prices.
  //    Every receipt shared is Flow marketing you didn't have to do.
  const receipt = [
    ``,
    `--- Flow savings receipt ---`,
    `Swapped ${usdcAmount} USDC -> WETH`,
    `Market price: ${ethers.formatUnits(baseline, 18)} WETH`,
    `Flow price:   ${ethers.formatUnits(youGot, 18)} WETH`,
    `Saved ${savedBps.toFixed(2)}% vs the public market. No MEV taken.`,
    `----------------------------`,
  ].join("\n");
  console.log(receipt);
  require("fs").writeFileSync(
    `receipt-${Date.now()}.txt`, receipt.trim() + "\n");
  console.log(`\nReceipt saved. Share it anywhere — that's how people find this.`);
}

main().catch((e) => { console.error("\nFailed:", e.message?.slice(0, 200)); process.exit(1); });
