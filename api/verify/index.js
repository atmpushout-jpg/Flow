// POST /api/verify — contract safety check for AI agents.
// Read-only. No funds touched. Checks: contract exists, ERC20 sanity,
// honeypot simulation (buy+sell quotes), ownership, tax estimation.
const { ethers } = require("ethers");
const { provider } = require("../_lib");

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];
const OWNABLE_ABI = ["function owner() view returns (address)"];
const ZERO = "0x0000000000000000000000000000000000000000";

// Minimal quoter check: can we get a buy AND sell quote?
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256)"];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function tryQuote(p, tokenIn, tokenOut, amountIn) {
  try {
    const q = new ethers.Contract(AERO_QUOTER, AERO_ABI, p);
    const out = await q.quoteExactInputSingle.staticCall(
      { tokenIn, tokenOut, amountIn, tickSpacing: 50, sqrtPriceLimitX96: 0 },
      { timeout: 8000 }
    );
    return BigInt(out.toString());
  } catch { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { token } = req.body || {};
  if (!token || !ethers.isAddress(token)) {
    return res.status(400).json({ error: "Provide a valid 'token' address" });
  }

  const t0 = Date.now();
  const p = provider();
  const flags = [];
  let score = 100; // start perfect, deduct for red flags
  const info = {};

  // 1. Contract exists?
  const code = await p.getCode(token);
  if (code === "0x") {
    return res.json({ token, verdict: "danger", score: 0,
      flags: ["No contract code at this address"],
      latencyMs: Date.now() - t0 });
  }

  // 2. ERC20 basics
  try {
    const t = new ethers.Contract(token, ERC20_ABI, p);
    const [name, symbol, decimals, supply] = await Promise.all([
      t.name().catch(() => "?"), t.symbol().catch(() => "?"),
      t.decimals().catch(() => 18), t.totalSupply().catch(() => 0n),
    ]);
    info.name = name; info.symbol = symbol; info.decimals = Number(decimals);
    info.totalSupply = supply.toString();
  } catch {
    flags.push("Not a standard ERC20 (basic reads failed)");
    score -= 30;
  }

  // 3. Ownership check
  try {
    const o = new ethers.Contract(token, OWNABLE_ABI, p);
    const owner = await o.owner().catch(() => null);
    if (owner) {
      info.owner = owner;
      if (owner === ZERO) { info.ownershipRenounced = true; }
      else { flags.push("Ownership NOT renounced — owner retains control"); score -= 15; }
    }
  } catch { /* not ownable, fine */ }

  // 4. Honeypot simulation: buy 0.01 WETH worth, then sell it back
  const buyAmt = 10n ** 16n; // 0.01 WETH
  const buyOut = await tryQuote(p, WETH, token, buyAmt);
  if (buyOut === null || buyOut === 0n) {
    flags.push("Cannot buy this token via DEX (no liquidity or blocked)");
    score -= 40;
  } else {
    info.buyQuote = buyOut.toString();
    // Now try selling what we'd get
    const sellOut = await tryQuote(p, token, WETH, buyOut);
    if (sellOut === null || sellOut === 0n) {
      flags.push("HONEYPOT: can buy but CANNOT sell — funds would be trapped");
      score -= 60;
    } else {
      // Tax estimation: compare round-trip vs spot
      // Expected back if no tax: ~buyAmt minus price impact. Rough check:
      const ratio = Number((sellOut * 10000n) / buyAmt) / 100; // % returned
      info.roundTripPct = Math.round(ratio * 100) / 100;
      if (ratio < 70) {
        flags.push(`High sell tax or slippage: only ${info.roundTripPct}% returned on round-trip`);
        score -= 25;
      } else if (ratio < 90) {
        flags.push(`Moderate tax/slippage: ${info.roundTripPct}% returned on round-trip`);
        score -= 10;
      }
    }
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? "safe" : score >= 50 ? "caution" : "danger";

  res.json({
    token, verdict, score, flags, info,
    latencyMs: Date.now() - t0,
    quotedAt: new Date().toISOString(),
  });
};
