/**
 * Flow Closed Loop v1
 * ===================
 * The no-audit revenue machine. One service acts as auctioneer + filler:
 *
 *   UI -> POST /intent (signed) -> baseline via quoter -> filler bids best
 *   multi-pool price -> auctioneer authorizes -> fillIntent onchain ->
 *   protocol fee accrues to feeRecipient.
 *
 * The filler's edge is REAL: baseline is the single canonical pool quote
 * (what a naive swapper gets); the filler routes across all fee tiers and
 * passes the better price through. Improvement = routing edge, not subsidy.
 *
 * Honest economics: the filler keeps 75% of the improvement, the protocol
 * keeps 25%. Per-fill edge is small (a few bps). This proves live revenue
 * mechanics with real money; it is NOT a get-rich machine on day one.
 *
 * Run:
 *   RPC_URL=... ROUTER_ADDRESS=0x... CHAIN_ID=84532 \
 *   AUCTIONEER_PK=0x... FILLER_PK=0x... node offchain/closed-loop.js
 *
 * Endpoints:
 *   GET  /health  -> status
 *   GET  /quote?tokenIn=0x..&tokenOut=0x..&amountIn=123 -> baseline quote
 *   POST /intent  -> {intent fields + userSig} -> fills or explains why not
 *   GET  /pnl     -> protocol fees accrued onchain (the revenue dashboard)
 *   GET  /        -> the swap UI
 */
const express = require("express");
const path = require("path");
const { ethers } = require("ethers");

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT || "8787");
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453");
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "";
const AUCTIONEER_PK = process.env.AUCTIONEER_PK || "";
const FILLER_PK = process.env.FILLER_PK || AUCTIONEER_PK;
const MIN_EDGE_BPS = parseInt(process.env.MIN_EDGE_BPS || "5"); // min edge to bother filling
const BASELINE_FEE_TIER = parseInt(process.env.BASELINE_FEE_TIER || "3000"); // the "public market" pool
const FEE_TIERS = [500, 3000, 10000];

if (!ROUTER_ADDRESS) {
  console.error("FATAL: ROUTER_ADDRESS not set");
  process.exit(1);
}
if (!AUCTIONEER_PK) {
  console.error("FATAL: AUCTIONEER_PK not set");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const auctioneer = new ethers.Wallet(AUCTIONEER_PK, provider);
const filler = new ethers.Wallet(FILLER_PK, provider);

const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function fillIntent((address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce),bytes userSig,uint256 amountOut,uint256 baselineOut,bytes auctionSig) external",
  "function nonces(address) view returns (uint256)",
  "function hashIntent((address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)) view returns (bytes32)",
  "function maxAmountIn() view returns (uint256)",
  "event IntentFilled(bytes32 indexed intentHash,address indexed user,address indexed filler,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutToUser,uint256 protocolFee)",
];

const EIP712_TYPES = {
  Intent: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};
const eip712Domain = () => ({
  name: "FlowIntentRouter",
  version: "0",
  chainId: CHAIN_ID,
  verifyingContract: ROUTER_ADDRESS,
});

const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);

// ---------------------------------------------------------------- quoting
async function quoteTier(tokenIn, tokenOut, amountIn, fee) {
  try {
    const r = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
    });
    return BigInt(r[0].toString());
  } catch {
    return 0n;
  }
}

/// Baseline = single canonical pool quote (the "public market" price).
async function getBaseline(tokenIn, tokenOut, amountIn) {
  return quoteTier(tokenIn, tokenOut, amountIn, BASELINE_FEE_TIER);
}

/// Filler edge = best execution across all tiers.
async function getBest(tokenIn, tokenOut, amountIn) {
  let best = 0n, bestTier = 0;
  for (const fee of FEE_TIERS) {
    const q = await quoteTier(tokenIn, tokenOut, amountIn, fee);
    if (q > best) { best = q; bestTier = fee; }
  }
  return { best, bestTier };
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

app.get("/health", async (_req, res) => {
  const [bond, maxIn, nonce] = await Promise.all([
    provider.getBalance(ROUTER_ADDRESS).then(() => null).catch(() => null),
    router.maxAmountIn().catch(() => 0n),
  ]).catch(() => [null, 0n]);
  res.json({
    ok: true, chainId: CHAIN_ID, router: ROUTER_ADDRESS,
    auctioneer: auctioneer.address, filler: filler.address,
    fillerBond: (await provider.getBalance(filler.address).catch(() => 0n)).toString(),
    maxAmountIn: maxIn.toString(), minEdgeBps: MIN_EDGE_BPS,
  });
});

app.get("/quote", async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.query;
    if (!tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: "tokenIn, tokenOut, amountIn required" });
    const baseline = await getBaseline(tokenIn, tokenOut, amountIn);
    const { best, bestTier } = await getBest(tokenIn, tokenOut, amountIn);
    res.json({ baselineOut: baseline.toString(), bestOut: best.toString(), bestTier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/intent", async (req, res) => {
  try {
    const { user, tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce, userSig } = req.body;
    if (!user || !tokenIn || !tokenOut || !amountIn || !minAmountOut || !expiry || !userSig) {
      return res.status(400).json({ error: "missing intent fields" });
    }
    if (Date.now() / 1000 > Number(expiry)) return res.status(400).json({ error: "intent expired" });

    // Verify the user's EIP-712 signature ourselves before touching the chain.
    const intent = { user, tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce };
    const digest = ethers.TypedDataEncoder.hash(eip712Domain(), EIP712_TYPES, intent);
    if (ethers.recoverAddress(digest, userSig).toLowerCase() !== user.toLowerCase()) {
      return res.status(400).json({ error: "bad user signature" });
    }
    const onchainNonce = await router.nonces(user);
    if (BigInt(nonce) !== onchainNonce) {
      return res.status(400).json({ error: `bad nonce: got ${nonce}, expected ${onchainNonce}` });
    }

    // Baseline vs filler bid.
    const baseline = await getBaseline(tokenIn, tokenOut, amountIn);
    const { best, bestTier } = await getBest(tokenIn, tokenOut, amountIn);
    if (best === 0n) return res.status(200).json({ status: "no_quote", baselineOut: baseline.toString() });

    const minBid = (baseline * BigInt(10000 + MIN_EDGE_BPS)) / 10000n;
    if (best < minBid) {
      return res.status(200).json({ status: "no_edge", baselineOut: baseline.toString(), bestOut: best.toString() });
    }
    if (best < BigInt(minAmountOut)) {
      return res.status(200).json({ status: "below_min", baselineOut: baseline.toString(), bestOut: best.toString() });
    }

    // Authorize the fill.
    const intentHash = await router.hashIntent(intent);
    const auctionHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "bytes32", "address", "uint256", "uint256"],
      [ROUTER_ADDRESS, CHAIN_ID, intentHash, filler.address, best.toString(), baseline.toString()]
    );
    const auctionSig = await auctioneer.signMessage(ethers.getBytes(auctionHash));

    // Submit onchain as the filler.
    const routerAsFiller = router.connect(filler);
    const tx = await routerAsFiller.fillIntent(intent, userSig, best.toString(), baseline.toString(), auctionSig);
    const receipt = await tx.wait();
    recordFill(tokenOut, protocolFeeFor(best, baseline));

    res.json({
      status: "filled",
      txHash: receipt.hash,
      baselineOut: baseline.toString(),
      amountOut: best.toString(),
      bestTier,
      improvement: (best - baseline).toString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message?.slice(0, 300) || "unknown" });
  }
});

/// Revenue dashboard: in-memory ledger of fills this server processed.
/// Reconciled against onchain events when the node can serve them.
const ledger = { fills: 0, fees: {} }; // tokenOut -> BigInt
function recordFill(tokenOut, protocolFee) {
  ledger.fills++;
  ledger.fees[tokenOut] = (ledger.fees[tokenOut] || 0n) + protocolFee;
}
function protocolFeeFor(amountOut, baselineOut) {
  if (amountOut <= baselineOut) return 0n;
  const improvement = amountOut - baselineOut;
  let fee = (improvement * 2500n) / 10000n; // 25% share
  const cap = (amountOut * 10n) / 10000n; // 10 bps cap
  if (fee > cap) fee = cap;
  return fee;
}

app.get("/pnl", async (_req, res) => {
  // Try an onchain reconciliation over a small recent window; fall back to ledger.
  let onchain = null;
  try {
    const current = await provider.getBlockNumber();
    const events = await router.queryFilter(
      router.filters.IntentFilled(), Math.max(0, current - 2000), current
    );
    const byToken = {};
    for (const ev of events) {
      const k = ev.args.tokenOut;
      byToken[k] = ((byToken[k] ? BigInt(byToken[k]) : 0n) + BigInt(ev.args.protocolFee.toString())).toString();
    }
    onchain = { fills: events.length, fees: byToken };
  } catch {
    onchain = { error: "log scan unavailable" };
  }
  res.json({
    fills: ledger.fills,
    fees: Object.fromEntries(Object.entries(ledger.fees).map(([k, v]) => [k, v.toString()])),
    onchain,
    note: "Protocol fees from fills this server processed. This is real revenue.",
  });
});

app.listen(PORT, () => {
  console.log(`Flow closed loop live on :${PORT}`);
  console.log(`  chain=${CHAIN_ID} router=${ROUTER_ADDRESS}`);
  console.log(`  auctioneer=${auctioneer.address} filler=${filler.address}`);
  console.log(`  baseline tier=${BASELINE_FEE_TIER} min edge=${MIN_EDGE_BPS}bps`);
});
