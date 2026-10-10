/**
 * Flow Auctioneer (Prototype)
 * ----------------------------
 * Offchain micro-auction for swap intents on Base.
 * Educational scaffold. NOT production-ready.
 *
 * Flow:
 *  1. Receive signed intent via HTTP/WebSocket.
 *  2. Fetch baseline quote (stubbed here; wire to Uniswap v3 quoter on Base).
 *  3. Broadcast to whitelisted searchers, collect bids for BID_WINDOW_MS.
 *  4. Pick winner = highest amountOut, tie-break highest premium.
 *  5. Sign auction authorization so the router accepts the winner's fill.
 *
 * Run: `npx ts-node offchain/auctioneer.ts`
 * Env: AUCTIONEER_PK, RPC_URL, ROUTER_ADDRESS, CHAIN_ID
 */

import { ethers } from "ethers";
import express from "express";

// ---- Config ----
const BID_WINDOW_MS = 150;
const PORT = 8787;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "8453"); // Base mainnet
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0xROUTER";
const AUCTIONEER_PK = process.env.AUCTIONEER_PK || "";
if (!AUCTIONEER_PK) {
  console.warn("WARNING: AUCTIONEER_PK not set. Running in demo mode (no real signatures).");
}
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://mainnet.base.org");
const auctioneerWallet = AUCTIONEER_PK ? new ethers.Wallet(AUCTIONEER_PK, provider) : null;

// Whitelisted searchers (bonded). In prod, read from onchain bond registry.
const SEARCHERS: { id: string; url: string }[] = [
  // { id: "searcher1", url: "http://searcher1:9000/bid" },
];

interface Intent {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  expiry: number;
  nonce: number;
  userSig: string;
}

interface Bid {
  bidder: string;
  amountOut: string; // wei as string
  premiumBps: number;
}

// Verified Base mainnet addresses (from public docs)
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// Real baseline quoter via Uniswap V3 QuoterV2 on Base.
// Tries each fee tier, returns the best amountOut. Falls back to minAmountOut on failure.
async function getBaselineOut(intent: Intent): Promise<bigint> {
  try {
    const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
    let best = 0n;
    for (const fee of FEE_TIERS) {
      try {
        // quoteExactInputSingle is non-view in QuoterV2, must use staticCall
        const params = {
          tokenIn: intent.tokenIn,
          tokenOut: intent.tokenOut,
          amountIn: intent.amountIn,
          fee: fee,
          sqrtPriceLimitX96: 0,
        };
        const result = await quoter.quoteExactInputSingle.staticCall(params);
        const amountOut = BigInt(result[0].toString());
        if (amountOut > best) best = amountOut;
      } catch {
        // tier may not exist, skip
      }
    }
    if (best > 0n) return best;
    console.warn("Quoter returned 0, falling back to minAmountOut");
    return BigInt(intent.minAmountOut);
  } catch (e) {
    console.warn("Quoter failed, falling back to minAmountOut:", (e as Error).message);
    return BigInt(intent.minAmountOut);
  }
}

async function requestBids(intent: Intent, baselineOut: bigint): Promise<Bid[]> {
  // Fan out to searchers with a hard timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BID_WINDOW_MS);

  const results = await Promise.allSettled(
    SEARCHERS.map(async (s) => {
      const res = await fetch(s.url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, baselineOut: baselineOut.toString() }),
      });
      return (await res.json()) as Bid;
    })
  );
  clearTimeout(timer);

  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<Bid>).value)
    .filter((b) => BigInt(b.amountOut) >= BigInt(intent.minAmountOut));
}

function pickWinner(bids: Bid[]): Bid | null {
  if (!bids.length) return null;
  return bids.sort((a, b) => {
    const diff = BigInt(b.amountOut) - BigInt(a.amountOut);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return b.premiumBps - a.premiumBps;
  })[0];
}

async function signAuction(
  intentHash: string,
  filler: string,
  amountOut: string,
  baselineOut: string
): Promise<string> {
  if (!auctioneerWallet) return "0xDEMO";
  const auctionHash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32", "address", "uint256", "uint256"],
    [ROUTER_ADDRESS, CHAIN_ID, intentHash, filler, amountOut, baselineOut]
  );
  return await auctioneerWallet.signMessage(ethers.getBytes(auctionHash));
}

// EIP-712 domain and types. MUST match FlowIntentRouter.sol:
//   EIP712("FlowIntentRouter", "0")
//   INTENT_TYPEHASH = keccak256("Intent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)")
const EIP712_DOMAIN = {
  name: "FlowIntentRouter",
  version: "0",
  chainId: 0, // set at startup from CHAIN_ID
  verifyingContract: "0x0000000000000000000000000000000000000000", // set at startup from ROUTER_ADDRESS
};

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

function eip712Domain() {
  return { ...EIP712_DOMAIN, chainId: CHAIN_ID, verifyingContract: ROUTER_ADDRESS };
}

/**
 * Computes the EIP-712 intent hash. Uses ethers TypedDataEncoder.hash which
 * produces exactly what _hashTypedDataV4 returns in FlowIntentRouter.hashIntent.
 * Users sign this via signTypedData (NOT personal_sign).
 */
function eip712IntentHash(intent: Intent): string {
  return ethers.TypedDataEncoder.hash(eip712Domain(), EIP712_TYPES, {
    user: intent.user,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    amountIn: intent.amountIn,
    minAmountOut: intent.minAmountOut,
    expiry: intent.expiry,
    nonce: intent.nonce,
  });
}

const app = express();
app.use(express.json());

app.post("/intent", async (req, res) => {
  const intent = req.body as Intent;
  try {
    if (Date.now() / 1000 > intent.expiry) {
      res.status(400).json({ error: "intent expired" });
      return;
    }
    const baselineOut = await getBaselineOut(intent);
    const bids = await requestBids(intent, baselineOut);
    const winner = pickWinner(bids);
    if (!winner) {
      res.status(200).json({ status: "no_bids", baselineOut: baselineOut.toString() });
      return;
    }
    const intentHash = eip712IntentHash(intent);
    const auctionSig = await signAuction(intentHash, winner.bidder, winner.amountOut, baselineOut.toString());
    res.json({
      status: "filled",
      winner,
      baselineOut: baselineOut.toString(),
      intentHash,
      auctionSig,
      router: ROUTER_ADDRESS,
      chainId: CHAIN_ID,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, searchers: SEARCHERS.length }));

app.listen(PORT, () => {
  console.log(`Flow auctioneer (prototype) listening on :${PORT}`);
  console.log(`Chain ${CHAIN_ID}, router ${ROUTER_ADDRESS}, bid window ${BID_WINDOW_MS}ms`);
});
