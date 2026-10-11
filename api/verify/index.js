// POST /api/verify — contract safety check for AI agents (Agent-shield revival).
//
// Read-only. Never touches funds. Dependency-free: stdlib fetch + raw JSON-RPC
// only (no ethers, no ../_lib), so it runs on any Vercel Node runtime as-is.
//
// x402 pay-per-call gate: skipped unless X402_ENABLED=true (same as /api/quote).
//
// Request:  { "address": "0x...", "chain": "base" }   ("token" accepted as an
//             alias for "address"; chain optional, default "base")
//
// Response: verdict (safe|caution|danger), score 0-100, plain-English summary,
// flags[], agentAdvice (APPROVE|REVIEW_MANUALLY|DO_NOT_APPROVE), and details.

const x402 = require("../_x402");

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

const CHAINS = {
  base:     { id: 8453,  rpc: "https://mainnet.base.org" },
  ethereum: { id: 1,     rpc: "https://ethereum.publicnode.com" },
  optimism: { id: 10,    rpc: "https://mainnet.optimism.io" },
  arbitrum: { id: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
  polygon:  { id: 137,   rpc: "https://polygon-bor.publicnode.com" },
};
const CHAIN_BY_ID = Object.fromEntries(
  Object.entries(CHAINS).map(([k, v]) => [String(v.id), k])
);

function resolveChain(raw) {
  if (raw === undefined || raw === null || raw === "") return { key: "base", ...CHAINS.base };
  const s = String(raw).trim().toLowerCase();
  if (CHAINS[s]) return { key: s, ...CHAINS[s] };
  if (CHAIN_BY_ID[s]) { const k = CHAIN_BY_ID[s]; return { key: k, ...CHAINS[k] }; }
  return null;
}

// ---------------------------------------------------------------------------
// Selectors, slots, constants
// ---------------------------------------------------------------------------

const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",          // owner()
  facetAddresses: "0x52ef6b2c", // facetAddresses() — EIP-2535 DiamondLoupe
  beaconImpl: "0x5c60da1b",     // implementation() — beacon
};

// keccak("eip1967.proxy.implementation") - 1
const SLOT_IMPL   = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// keccak("eip1967.proxy.admin") - 1
const SLOT_ADMIN  = "0xb53127684a568b3173ae13b9f721aed496e2571a";
// keccak("eip1967.proxy.beacon") - 1
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef434657833a9a72a5a9f8cd2edc9780a6ec319a";
// keccak("org.zeppelinos.proxy.implementation")
const SLOT_ZEPPELINOS = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

const ZERO = "0x0000000000000000000000000000000000000000";

// Aerodrome Slipstream quoter (same address as api/_lib.js) for the
// buy/sell honeypot simulation. Selector = keccak(
// "quoteExactInputSingle((address,address,uint256,int24,uint160))")[:4].
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const AERO_SEL = "0x9e7defe6";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

// Well-known tokens: skip the honeypot simulation (no honeypot risk, and
// quoting WETH->WETH style pairs is meaningless).
const CANONICAL = new Set(
  [
    WETH_BASE,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
    "0xd9aaec86b65d86f6a484f7a7db8703bf0ce5f2da", // USDbC (Base)
    "0x50c5725949a6f0c72a27a4a927ab0bf511600031", // DAI (Base)
    "0xcbB7C0000aB88B473b1f5fd9fd5b056d7fe061a12", // cbBTC (Base)
  ].map((a) => a.toLowerCase())
);

// ---------------------------------------------------------------------------
// HTTP + RPC helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

async function rpc(rpcUrl, method, params) {
  const { ok, json } = await fetchJson(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    9000
  );
  if (!ok || !json || json.error) {
    throw new Error((json && json.error && json.error.message) || `rpc ${method} failed`);
  }
  return json.result;
}

const ethCall = (rpcUrl, to, data) =>
  rpc(rpcUrl, "eth_call", [{ to, data }, "latest"]);

// ---------------------------------------------------------------------------
// ABI decoding (minimal, no libraries)
// ---------------------------------------------------------------------------

const strip0x = (h) => (h && h.startsWith("0x") ? h.slice(2) : h || "");

function addrFromWord(w) {
  const hex = strip0x(w);
  if (hex.length < 40) return ZERO;
  return "0x" + hex.slice(-40).toLowerCase();
}

function bigFromWord(w) {
  const hex = strip0x(w);
  if (!hex) return 0n;
  return BigInt("0x" + hex);
}

// Decodes a Solidity `string` return. Falls back to bytes32 for old tokens.
function decodeAbiString(data) {
  try {
    const hex = strip0x(data);
    if (!hex) return null;
    if (hex.length === 64) {
      const s = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "");
      return s || null;
    }
    if (hex.length < 128) return null;
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 512) return null;
    const s = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
    return s || null;
  } catch {
    return null;
  }
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");

// ---------------------------------------------------------------------------
// Sourcify (free, no API key): verified source + proxy resolution
// ---------------------------------------------------------------------------

async function sourcifyLookup(chainId, address, fields) {
  const q = fields ? `?fields=${fields}` : "";
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}${q}`;
  const { ok, status, json } = await fetchJson(url, {}, 20000);
  if (status === 404) return null; // not verified
  if (!ok || !json) throw new Error(`sourcify lookup failed (http ${status})`);
  return json;
}

// ---------------------------------------------------------------------------
// Source-code privilege scan (heuristic pattern matching on verified source)
// ---------------------------------------------------------------------------

const PRIVILEGE_CHECKS = [
  { id: "selfdestruct", sev: "critical", deduct: 40,
    re: /selfdestruct\s*\(/i,
    text: "SELFDESTRUCT is present — the contract can be destroyed, permanently trapping funds." },
  { id: "blacklist", sev: "high", deduct: 20,
    re: /blacklist/i,
    text: "BLACKLIST capability found — the owner can block addresses (including yours) from moving tokens." },
  { id: "mint", sev: "high", deduct: 15,
    re: /function\s+mint\s*\(/i,
    text: "MINT function found — the owner can create new tokens out of thin air, diluting holders." },
  { id: "pause", sev: "high", deduct: 15,
    re: /\bPausable\b|function\s+_?pause\s*\(/i,
    text: "PAUSE capability found — a single key can freeze all transfers/trading." },
  { id: "tax", sev: "medium", deduct: 10,
    re: /\b(buyTax|sellTax|_taxFee|taxFee|transferTax|liquidityFee|marketingFee|devFee|_liquidityFee|_marketingFee)\b/i,
    text: "Transfer TAXES are coded in — expect to lose a cut on every buy and sell." },
  { id: "feeSetter", sev: "medium", deduct: 10,
    re: /function\s+set\w*(Fee|Tax)\s*\(/i,
    text: "The owner can CHANGE fees/taxes after launch — today's 2% could become 50%." },
  { id: "limits", sev: "medium", deduct: 8,
    re: /\b(maxTxAmount|maxWalletAmount|maxTransactionAmount|tradingEnabled|enableTrading|tradingActive)\b/i,
    text: "Transfer LIMITS or a trading ON/OFF switch are coded in — the owner can gate who trades." },
  { id: "delegatecall", sev: "medium", deduct: 8,
    re: /\.delegatecall\s*\(/i,
    text: "Uses delegatecall — execution is delegated to external code; the target must be verified too." },
  { id: "upgradeable", sev: "low", deduct: 0,
    re: /UUPSUpgradeable|upgradeTo\s*\(|\bInitializable\b/i,
    text: "Upgradeable code pattern (UUPS/initializable) seen in the source." },
];

function analyzeSources(sources) {
  const files = Object.entries(sources || {}).filter(([p]) => p.endsWith(".sol"));
  let combined = files.map(([, f]) => (f && f.content) || "").join("\n");
  if (combined.length > 500000) combined = combined.slice(0, 500000); // bound memory
  const hits = [];
  for (const c of PRIVILEGE_CHECKS) {
    if (c.re.test(combined)) {
      hits.push({ id: c.id, severity: c.sev, deduct: c.deduct, text: c.text });
    }
  }
  return { files: files.length, chars: combined.length, hits };
}

// ---------------------------------------------------------------------------
// Proxy detection (Sourcify first, on-chain slots as fallback)
// ---------------------------------------------------------------------------

async function detectProxyOnchain(rpcUrl, address, code) {
  // 1. EIP-1167 minimal proxy (bytecode pattern)
  const c = strip0x(code).toLowerCase();
  if (
    c.startsWith("363d3d373d3d3d363d73") &&
    c.length >= 90 &&
    c.includes("5af43d82803e903d91602b57fd5bf3")
  ) {
    return {
      isProxy: true,
      type: "EIP-1167 minimal proxy",
      implementation: "0x" + c.slice(20, 60).toLowerCase(),
    };
  }
  // 2. EIP-1967 implementation slot
  try {
    const impl = addrFromWord(await rpc(rpcUrl, "eth_getStorageAt", [address, SLOT_IMPL, "latest"]));
    if (impl !== ZERO) {
      let admin;
      try {
        const a = addrFromWord(await rpc(rpcUrl, "eth_getStorageAt", [address, SLOT_ADMIN, "latest"]));
        if (a !== ZERO) admin = a;
      } catch { /* no admin slot */ }
      return { isProxy: true, type: "EIP-1967 proxy", implementation: impl, admin };
    }
  } catch { /* fall through */ }
  // 3. ZeppelinOS legacy implementation slot
  try {
    const zimpl = addrFromWord(await rpc(rpcUrl, "eth_getStorageAt", [address, SLOT_ZEPPELINOS, "latest"]));
    if (zimpl !== ZERO) return { isProxy: true, type: "ZeppelinOS proxy", implementation: zimpl };
  } catch { /* fall through */ }
  // 4. EIP-1967 beacon proxy
  try {
    const beacon = addrFromWord(await rpc(rpcUrl, "eth_getStorageAt", [address, SLOT_BEACON, "latest"]));
    if (beacon !== ZERO) {
      let impl;
      try {
        const w = await ethCall(rpcUrl, beacon, SEL.beaconImpl);
        const a = addrFromWord(w);
        if (a !== ZERO) impl = a;
      } catch { /* beacon without implementation() */ }
      return { isProxy: true, type: "EIP-1967 beacon proxy", beacon, implementation: impl };
    }
  } catch { /* fall through */ }
  // 5. EIP-2535 diamond
  try {
    const r = await ethCall(rpcUrl, address, SEL.facetAddresses);
    const hex = strip0x(r);
    if (hex.length >= 128) {
      const n = parseInt(hex.slice(64, 128), 16);
      if (Number.isFinite(n) && n > 0 && n < 10000) {
        return { isProxy: true, type: "EIP-2535 diamond", facets: n };
      }
    }
  } catch { /* not a diamond */ }
  return { isProxy: false };
}

// ---------------------------------------------------------------------------
// Honeypot simulation via Aerodrome Slipstream quoter (Base only)
// ---------------------------------------------------------------------------

function encAddr(a) {
  return strip0x(a).toLowerCase().padStart(64, "0");
}
function encU256(v) {
  return BigInt(v).toString(16).padStart(64, "0");
}
// NOTE: quoteExactInputSingle takes a single all-static tuple, so the tuple
// is encoded INLINE (no 0x20 offset word). Verified byte-for-byte against
// ethers v6 encodeFunctionData in local tests.
function aeroCalldata(tokenIn, tokenOut, amountIn, tickSpacing) {
  return (
    "0x" +
    strip0x(AERO_SEL) +
    encAddr(tokenIn) +
    encAddr(tokenOut) +
    encU256(amountIn) +
    encU256(BigInt(tickSpacing)) + // int24, positive values encode the same
    encU256(0n) // sqrtPriceLimitX96 = no limit
  );
}

// Uniswap V3 QuoterV2 (same address as api/_lib.js). Selector = keccak(
// "quoteExactInputSingle((address,address,uint256,uint24,uint160))")[:4].
// Returns (amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate);
// amountOut is the first word.
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_SEL = "0xc6a5026a";
function uniCalldata(tokenIn, tokenOut, amountIn, fee) {
  return (
    "0x" +
    strip0x(UNI_SEL) +
    encAddr(tokenIn) +
    encAddr(tokenOut) +
    encU256(amountIn) +
    encU256(BigInt(fee)) + // uint24
    encU256(0n)
  );
}

async function quoterQuote(rpcUrl, to, data) {
  try {
    const res = await ethCall(rpcUrl, to, data);
    // Both quoters return a multi-word tuple; amountOut is the FIRST word.
    const v = bigFromWord("0x" + strip0x(res).slice(0, 64));
    return v > 0n ? v : null;
  } catch {
    return null; // revert / no pool for these params
  }
}

const bestOf = (arr) => arr.reduce((m, v) => (v && (!m || v > m) ? v : m), null);

async function honeypotSim(rpcUrl, token) {
  const buyAmt = 10n ** 16n; // 0.01 WETH
  // Try both venues in parallel: Aerodrome (tick spacings) + Uniswap (fees).
  const buyCalls = [];
  for (const s of [1, 50, 100, 200]) buyCalls.push(quoterQuote(rpcUrl, AERO_QUOTER, aeroCalldata(WETH_BASE, token, buyAmt, s)));
  for (const f of [100, 500, 3000, 10000]) buyCalls.push(quoterQuote(rpcUrl, UNI_QUOTER, uniCalldata(WETH_BASE, token, buyAmt, f)));
  const buyOut = bestOf(await Promise.all(buyCalls));
  if (!buyOut) return { tested: true, canBuy: false, venues: ["aerodrome", "uniswap"] };
  const sellCalls = [];
  for (const s of [1, 50, 100, 200]) sellCalls.push(quoterQuote(rpcUrl, AERO_QUOTER, aeroCalldata(token, WETH_BASE, buyOut, s)));
  for (const f of [100, 500, 3000, 10000]) sellCalls.push(quoterQuote(rpcUrl, UNI_QUOTER, uniCalldata(token, WETH_BASE, buyOut, f)));
  const sellOut = bestOf(await Promise.all(sellCalls));
  if (!sellOut) {
    return { tested: true, canBuy: true, canSell: false, buyOut: buyOut.toString(), venues: ["aerodrome", "uniswap"] };
  }
  const roundTripPct = Number((sellOut * 10000n) / buyAmt) / 100;
  return {
    tested: true,
    canBuy: true,
    canSell: true,
    buyOut: buyOut.toString(),
    sellOut: sellOut.toString(),
    roundTripPct,
    venues: ["aerodrome", "uniswap"],
  };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function analyze(address, chain) {
  const t0 = Date.now();
  const flags = [];
  let score = 100;
  const details = { address, chain: chain.key, chainId: chain.id };
  const flag = (severity, text, deduct = 0) => {
    flags.push({ severity, text });
    score -= deduct;
  };

  // 1. Does a contract exist here?
  const code = await rpc(chain.rpc, "eth_getCode", [address, "latest"]);
  details.isContract = !!(code && code !== "0x");
  if (!details.isContract) {
    return {
      address, chain: chain.key, verdict: "caution", score: 60,
      agentAdvice: "REVIEW_MANUALLY",
      summary:
        `${short(address)} on ${chain.key} is a regular wallet (EOA), not a smart contract. ` +
        `There is no code to audit or exploit — but also no on-chain guarantees about who controls it. ` +
        `Do not send funds here unless you trust the recipient off-chain.`,
      flags: [{ severity: "info", text: "Address is an EOA (regular wallet), not a contract." }],
      details,
      latencyMs: Date.now() - t0,
      checkedAt: new Date().toISOString(),
    };
  }

  // 2. ERC20 metadata + Sourcify lookup in parallel
  const [meta, lookup] = await Promise.all([
    (async () => {
      const [n, s, d, ts] = await Promise.all([
        ethCall(chain.rpc, address, SEL.name).then(decodeAbiString).catch(() => null),
        ethCall(chain.rpc, address, SEL.symbol).then(decodeAbiString).catch(() => null),
        ethCall(chain.rpc, address, SEL.decimals).then((r) => Number(bigFromWord(r))).catch(() => null),
        ethCall(chain.rpc, address, SEL.totalSupply).then((r) => bigFromWord(r).toString()).catch(() => null),
      ]);
      return { name: n, symbol: s, decimals: Number.isFinite(d) ? d : null, totalSupply: ts };
    })(),
    sourcifyLookup(chain.id, address, "sources,proxyResolution").catch(() => null),
  ]);
  Object.assign(details, meta);

  const verified = !!(lookup && (lookup.match === "exact_match" || lookup.match === "match"));
  details.sourceVerified = verified;
  details.verificationMatch = (lookup && (lookup.match || lookup.creationMatch || lookup.runtimeMatch)) || null;
  if (!verified) {
    flag("high",
      "Source code is NOT verified — the real logic cannot be inspected. Treat every owner privilege as unknown and dangerous.",
      25);
  }

  // 3. Proxy detection (Sourcify first, on-chain slots as fallback)
  let proxy = { isProxy: false };
  if (lookup && lookup.proxyResolution && lookup.proxyResolution.isProxy) {
    const pr = lookup.proxyResolution;
    const impl = pr.implementations && pr.implementations[0] && pr.implementations[0].address;
    proxy = { isProxy: true, type: pr.proxyType || "proxy", implementation: impl || undefined, via: "sourcify" };
  } else {
    proxy = { ...(await detectProxyOnchain(chain.rpc, address, code)), via: "onchain" };
  }
  details.proxy = proxy;
  if (proxy.isProxy) {
    flag("medium",
      `UPGRADEABLE proxy detected (${proxy.type}). Whoever holds the upgrade keys can swap the code behind this address at any time.`,
      10);
  }

  // 4. Privilege scan — against the IMPLEMENTATION source when proxied,
  //    otherwise the contract's own source.
  let logicSources = null;
  if (proxy.isProxy && proxy.implementation) {
    const implLookup = await sourcifyLookup(chain.id, proxy.implementation, "sources").catch(() => null);
    const implVerified = !!(implLookup && (implLookup.match === "exact_match" || implLookup.match === "match"));
    details.proxy.implementationVerified = implVerified;
    if (!implVerified) {
      flag("high",
        "The proxy's IMPLEMENTATION contract source is NOT verified — the code that actually runs is hidden.",
        10);
    } else {
      logicSources = implLookup.sources;
    }
  } else if (verified) {
    logicSources = lookup.sources;
  }
  const scan = analyzeSources(logicSources);
  details.sourceFiles = scan.files;
  // Well-known tokens (USDC, WETH, ...): mint/pause/blacklist are the
  // issuer's documented, regulated controls — report them as context,
  // not as danger deductions.
  const isCanonical = CANONICAL.has(address.toLowerCase());
  details.privileges = scan.hits.map((h) => ({
    id: h.id,
    severity: isCanonical ? "info" : h.severity,
    text: isCanonical ? `Known token — issuer's documented control: ${h.text}` : h.text,
  }));
  for (const h of scan.hits) {
    if (isCanonical) flags.push({ severity: "info", text: `Known token — issuer's documented control: ${h.text}` });
    else flag(h.severity, h.text, h.deduct);
  }
  if (!logicSources) {
    details.privilegeScan = "skipped — no verified source available for the logic contract";
  }

  // 5. Ownership
  let owner = null;
  try {
    const w = await ethCall(chain.rpc, address, SEL.owner);
    const a = addrFromWord(w);
    if (a !== ZERO) owner = a;
  } catch { /* no owner() */ }
  details.owner = owner;
  if (owner) {
    if (owner === ZERO) {
      details.ownershipRenounced = true;
    } else {
      const oc = await rpc(chain.rpc, "eth_getCode", [owner, "latest"]).catch(() => "0x");
      const ownerIsContract = !!(oc && oc !== "0x");
      details.ownerIsContract = ownerIsContract;
      if (ownerIsContract) {
        flags.push({ severity: "info", text: `Owner is a contract (${short(owner)}) — possibly a multisig. Better than a single key, but verify what it is.` });
      } else {
        flag("medium",
          `Ownership is NOT renounced — a single externally-owned key (${short(owner)}) controls this contract.`,
          10);
      }
    }
  } else {
    flags.push({ severity: "info", text: "No owner() function found — the contract may be ownerless or use a custom access scheme." });
  }
  if (proxy.admin && proxy.admin !== owner) {
    details.proxyAdmin = proxy.admin;
    flags.push({ severity: "info", text: `The proxy ADMIN (${short(proxy.admin)}) is a separate address — they alone can upgrade the code.` });
  }

  // 6. Honeypot simulation (Base only, skip canonical tokens)
  if (chain.key === "base" && !CANONICAL.has(address.toLowerCase())) {
    const sim = await honeypotSim(chain.rpc, address);
    details.honeypot = sim;
    if (!sim.canBuy) {
      flag("medium",
        "No Aerodrome pool found for a buy quote — the token may trade on Uniswap only, or have no DEX liquidity at all.",
        15);
    } else if (!sim.canSell) {
      flag("critical",
        "HONEYPOT SIGNAL: this token can be BOUGHT but NOT sold — funds would be trapped.",
        60);
    } else {
      const rt = sim.roundTripPct;
      if (rt < 70) {
        flag("high", `Extreme round-trip loss: only ${rt}% of a buy comes back on sell (huge tax or razor-thin liquidity).`, 25);
      } else if (rt < 90) {
        flag("medium", `Noticeable round-trip loss: ${rt}% comes back on sell — taxes and/or slippage are eating value.`, 10);
      } else {
        flags.push({ severity: "info", text: `Buy/sell simulation healthy: ${rt}% round-trip on 0.01 WETH.` });
      }
    }
  } else {
    details.honeypot = {
      tested: false,
      reason: chain.key !== "base" ? "honeypot simulation is Base-only for now" : "canonical token — simulation skipped",
    };
  }

  // 7. Verdict + plain-English summary
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? "safe" : score >= 50 ? "caution" : "danger";
  const agentAdvice = verdict === "safe" ? "APPROVE" : verdict === "caution" ? "REVIEW_MANUALLY" : "DO_NOT_APPROVE";

  const label = details.symbol ? `${details.name || "Token"} (${details.symbol})` : `Contract ${short(address)}`;
  const s = [];
  s.push(`${label} on ${chain.key} ${verified ? `has verified source code (${details.verificationMatch}).` : "has NO verified source code."}`);
  if (proxy.isProxy) {
    s.push(`It is an upgradeable ${proxy.type}${proxy.implementation ? ` (logic at ${short(proxy.implementation)})` : ""}, so its code can be changed by the upgrade key holder.`);
  }
  const privIds = details.privileges.map((p) => p.id);
  if (privIds.length && isCanonical) {
    s.push(`As a centralized, regulated token, the issuer retains documented powers: ${privIds.join(", ")}.`);
  } else if (privIds.length) {
    s.push(`The code grants dangerous powers: ${privIds.join(", ")}.`);
  } else if (verified || details.proxy.implementationVerified) {
    s.push("No mint, pause, blacklist, or tax powers were found in the published code.");
  }
  if (details.honeypot && details.honeypot.tested) {
    if (details.honeypot.canBuy && !details.honeypot.canSell) {
      s.push("CRITICAL: it can be bought but not sold — this looks like a honeypot.");
    } else if (details.honeypot.canSell) {
      s.push(`A buy/sell simulation returned ${details.honeypot.roundTripPct}% round-trip.`);
    } else {
      s.push("No DEX pool was found to test buying and selling.");
    }
  }
  s.push(`Verdict: ${verdict.toUpperCase()} (${score}/100).`);
  if (verdict !== "safe") s.push("This is a heuristic pre-screen, not an audit — when in doubt, do not approve.");

  return {
    address,
    chain: chain.key,
    verdict,
    score,
    agentAdvice,
    summary: s.join(" "),
    flags,
    details,
    latencyMs: Date.now() - t0,
    checkedAt: new Date().toISOString(),
    disclaimer: "Heuristic pre-screen based on public on-chain data and verified source (where available). Not a security audit. Scores can miss novel attack patterns.",
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const RESOURCE_META = {
  path: "/api/verify",
  // Verdict pricing: $0.02 — the price the ecosystem's top-selling safety
  // verdict (ax1.vc q-verdict) proved at ~10k calls/day. Quotes stay $0.01.
  priceUsd: 0.02,
  description:
    "Flow contract safety verification for AI agents: send a token or contract address on Base and get a verdict (safe|caution|danger), a 0-100 safety score, the red flags found, and plain-English agent advice (APPROVE / REVIEW_MANUALLY / DO_NOT_APPROVE) before approving or swapping.",
  bazaarInput: {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  },
  bazaarOutput: { verdict: "safe", score: 100, agentAdvice: "APPROVE" },
};

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // --- x402 pay-per-call gate (skipped unless X402_ENABLED=true) ---
  let gate = null;
  if (x402.isEnabled()) {
    gate = await x402.requirePayment(req, res, RESOURCE_META);
    if (!gate) return; // 402 / 400 / 500 / 502 already sent
  }

  const { address: rawAddress, token: rawToken, chain: rawChain } = req.body || {};
  const address = rawAddress || rawToken;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "Provide a valid EVM 'address' (0x + 40 hex chars)" });
  }
  const chain = resolveChain(rawChain);
  if (!chain) {
    return res.status(400).json({ error: `Unknown chain '${rawChain}'. Supported: ${Object.keys(CHAINS).join(", ")} (or chain id)` });
  }

  try {
    const report = await analyze(address, chain);

    // Settle the authorized payment now that the resource has executed.
    if (gate) {
      let settled;
      try {
        settled = await x402.settlePayment(gate);
      } catch (e) {
        return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
      }
      if (!settled.success) {
        return res.status(402).json({
          error: `Payment settlement failed: ${settled.response.errorReason || "unknown"}`,
        });
      }
      x402.paymentResponseHeaders(res, settled.response);
      report.payment = {
        transaction: settled.response.transaction,
        network: settled.response.network,
        payer: settled.response.payer,
      };
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ error: (e.message || "verify failed").slice(0, 200) });
  }
}

module.exports = handler;
// Test hooks (do not affect the Vercel handler).
module.exports._internals = {
  analyze, analyzeSources, detectProxyOnchain, honeypotSim, resolveChain,
  decodeAbiString, aeroCalldata, uniCalldata, PRIVILEGE_CHECKS, CHAINS, CANONICAL,
};
