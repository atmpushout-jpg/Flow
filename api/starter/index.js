// POST /api/starter — claim a one-time $0.05 USDC starter seed for a new
// agent wallet; GET — public pilot stats for the receipts dashboard.
//
// HOW THE PILOT WORKS (and why this endpoint holds NO private key):
//   1. An agent creates a wallet locally (see mcp-server/wallet.js) and
//      POSTs its public address here.
//   2. This endpoint only RECORDS the claim in Upstash (status "pending").
//      It never signs or sends anything — it has no key and never will.
//   3. A VM-side worker (offchain/seed-worker.js) polls the pending set,
//      sends exactly 0.05 USDC on Base from the Flow OPERATIONAL wallet,
//      and marks the claim "claimed" with the tx hash.
//
// CLAIM-ACTION BRIDGE (why the VM no longer needs the store credentials):
// the Upstash credentials exist only in this project's Vercel env, so the
// VM-side seed worker cannot read or write the claim store directly.
// Instead it works through two sub-routes of this endpoint, which already
// holds the store access:
//   GET  /api/starter/claims        — public list of claims (address,
//                                     status, createdAt; no secrets).
//   POST /api/starter/claim-action  — ops-signed state changes:
//        { action: "mark-paid" | "void", address, txHash, timestamp,
//          signature }
//        The signature is an EIP-191 personal signature by the OPERATIONAL
//        wallet over the canonical message
//          flow-starter:{action}:{address}:{txHash||""}:{timestamp}
//        (address/txHash lowercased, timestamp = epoch milliseconds), and
//        the timestamp must be no older than 10 minutes. "mark-paid"
//        additionally requires on-chain proof verified HERE: txHash must
//        be a Base USDC transfer of exactly 0.05 from the operational
//        wallet to the claim address with >= 2 confirmations — the chain
//        is the receipt, so a signature alone can never fake a payment.
//
// CAPS (hard bounds on pilot cost):
//   - one claim per address, EVER (claim record is created with SET NX
//     and never deleted, so a paid address can never re-claim)
//   - max 19 seeds total  -> worst case 19 x $0.05 = $0.95
//   - max 5 seeds per UTC day
//
// HONEST SYBIL NOTE: fresh EVM addresses are free to create, so a determined
// farmer could claim several seeds with several addresses. The caps above
// bound the total damage at $0.95; the pilot accepts that trade because the
// seed's job is removing first-call friction for real agents, and $0.95 is
// cheap market research. If abuse ever matters, the fix is gating claims
// behind a settled paid call — not identity checks on a $0.05 seed.

const PILOT = {
  SEED_USD: 0.05,
  MAX_TOTAL: 19,
  MAX_PER_DAY: 5,
};

const KEY_CLAIM_PREFIX = "flow:starter:claim:";
const KEY_PENDING = "flow:starter:pending";
const KEY_CLAIMED = "flow:starter:claimed";
const KEY_TOTAL = "flow:starter:count:total";
const keyDay = (day) => `flow:starter:count:day:${day}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Flow's own operational wallet (sender of the seeds) — seeding ourselves
// would be circular, so it can never claim.
const OPERATIONAL_WALLET = "0x3d650013f46dd2d96b5afefe4acab7a7f2727561";

const STORE_TIMEOUT_MS = 2500;

// Claim-action bridge constants.
const KEY_VOIDED = "flow:starter:voided";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const SEED_ATOMIC = 50000n; // 0.05 USDC (6 decimals)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
const CLAIM_ACTION_WINDOW_MS = 10 * 60 * 1000; // signed actions expire after 10 minutes
const MIN_CONFIRMATIONS = 2;
const RPC_TIMEOUT_MS = 10000;

// ethers is a root dependency already proven in this deployment
// (api/_lib.js, api/fill). It is required LAZILY and only on the
// claim-action path, so a module problem there can never take down the
// pre-existing claim/stats routes.
let _ethers = null;
function loadEthers() {
  if (!_ethers) _ethers = require("ethers");
  return _ethers;
}

// ---------------------------------------------------------------------------
// Claim-action signatures (pure — exported for tests)
// ---------------------------------------------------------------------------

// The ONE canonical message an ops signature must cover. Address and
// txHash are lowercased; a missing txHash becomes the empty string.
function canonicalClaimActionMessage({ action, address, txHash, timestamp }) {
  const a = String(address || "").toLowerCase();
  const t = txHash ? String(txHash).toLowerCase() : "";
  return `flow-starter:${action}:${a}:${t}:${timestamp}`;
}

function verifyOpsSignature(message, signature, opsAddress) {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    const recovered = loadEthers().verifyMessage(message, signature);
    return recovered.toLowerCase() === String(opsAddress || "").toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation (pure — exported for tests)
// ---------------------------------------------------------------------------

function validateAddress(input, opts = {}) {
  if (typeof input !== "string") {
    return { ok: false, error: "address is required (string)" };
  }
  const raw = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { ok: false, error: "address must be a 0x-prefixed 40-hex-character EVM address" };
  }
  const address = raw.toLowerCase();
  if (address === ZERO_ADDRESS) {
    return { ok: false, error: "the zero address cannot receive a seed" };
  }
  if (address === OPERATIONAL_WALLET) {
    return { ok: false, error: "that is Flow's operational wallet — seeds are for new agent wallets" };
  }
  const payee = (opts.payee || process.env.X402_PAYEE_ADDRESS || "").trim().toLowerCase();
  if (payee && address === payee) {
    return { ok: false, error: "that is Flow's payee wallet — seeds are for new agent wallets" };
  }
  return { ok: true, address, display: raw };
}

function utcDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// ---------------------------------------------------------------------------
// Store: Upstash Redis over HTTPS (same env vars as api/_stats.js), with an
// in-memory fallback for local dev / tests when the env vars are absent.
// Interface: getClaim, createClaimNx, incr, decr, getCount,
//            addPending, pendingCount, claimedCount,
//            listClaims, updateClaim.
// ---------------------------------------------------------------------------

function createMemoryStore() {
  const claims = new Map();
  const counters = new Map();
  const pending = new Set();
  const claimed = new Set();
  return {
    kind: "memory",
    async getClaim(addr) {
      return claims.get(addr) || null;
    },
    async createClaimNx(addr, record) {
      if (claims.has(addr)) return false;
      claims.set(addr, record);
      return true;
    },
    async incr(key) {
      const v = (counters.get(key) || 0) + 1;
      counters.set(key, v);
      return v;
    },
    async decr(key) {
      const v = Math.max(0, (counters.get(key) || 0) - 1);
      counters.set(key, v);
      return v;
    },
    async getCount(key) {
      return counters.get(key) || 0;
    },
    async addPending(addr) {
      pending.add(addr);
    },
    async pendingCount() {
      return pending.size;
    },
    async claimedCount() {
      return claimed.size;
    },
    async listClaims() {
      return [...claims.values()];
    },
    async updateClaim(addr, record) {
      claims.set(addr, record);
      pending.delete(addr);
      if (record.status === "claimed") claimed.add(addr);
      else claimed.delete(addr);
    },
    // Test-only helpers (not part of the store interface):
    _markClaimed(addr) {
      pending.delete(addr);
      claimed.add(addr);
      const rec = claims.get(addr);
      if (rec) rec.status = "claimed";
    },
    _claims: claims,
  };
}

function createUpstashStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  async function cmd(...parts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(parts),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`store responded ${r.status}`);
      const d = await r.json();
      return d.result;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    kind: "upstash",
    async getClaim(addr) {
      const raw = await cmd("GET", KEY_CLAIM_PREFIX + addr);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async createClaimNx(addr, record) {
      const r = await cmd("SET", KEY_CLAIM_PREFIX + addr, JSON.stringify(record), "NX");
      return r === "OK";
    },
    async incr(key) {
      const v = await cmd("INCR", key);
      if (key.includes(":count:day:") && v === 1) {
        await cmd("EXPIRE", key, String(2 * 86400));
      }
      return v;
    },
    async decr(key) {
      return cmd("DECR", key);
    },
    async getCount(key) {
      const v = await cmd("GET", key);
      return parseInt(v || "0", 10) || 0;
    },
    async addPending(addr) {
      await cmd("SADD", KEY_PENDING, addr);
    },
    async pendingCount() {
      return cmd("SCARD", KEY_PENDING);
    },
    async claimedCount() {
      return cmd("SCARD", KEY_CLAIMED);
    },
    async listClaims() {
      const [pend, done, voided] = await Promise.all([
        cmd("SMEMBERS", KEY_PENDING),
        cmd("SMEMBERS", KEY_CLAIMED),
        cmd("SMEMBERS", KEY_VOIDED),
      ]);
      const addrs = [...new Set([...(pend || []), ...(done || []), ...(voided || [])])];
      const out = [];
      for (const addr of addrs) {
        const raw = await cmd("GET", KEY_CLAIM_PREFIX + String(addr).toLowerCase());
        if (!raw) continue;
        try {
          out.push(JSON.parse(raw));
        } catch {
          /* skip corrupt records */
        }
      }
      return out;
    },
    async updateClaim(addr, record) {
      await cmd("SET", KEY_CLAIM_PREFIX + addr, JSON.stringify(record));
      await cmd("SREM", KEY_PENDING, addr);
      if (record.status === "claimed") {
        await cmd("SADD", KEY_CLAIMED, addr);
        await cmd("SREM", KEY_VOIDED, addr);
      } else if (record.status === "void") {
        await cmd("SADD", KEY_VOIDED, addr);
        await cmd("SREM", KEY_CLAIMED, addr);
      }
    },
  };
}

let sharedStore = null;
function getStore() {
  if (sharedStore) return sharedStore;
  sharedStore =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
      ? createUpstashStore()
      : createMemoryStore();
  return sharedStore;
}

// ---------------------------------------------------------------------------
// Claim + stats logic (store injected — exported for tests)
// ---------------------------------------------------------------------------

async function handleClaim(store, input, opts = {}) {
  const v = validateAddress(input?.address, opts);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const addr = v.address;

  const existing = await store.getClaim(addr);
  if (existing) {
    return {
      status: 200,
      body: {
        status: existing.status,
        alreadyClaimed: true,
        address: v.display,
        seedUsd: PILOT.SEED_USD,
        ...(existing.txHash ? { txHash: existing.txHash } : {}),
        note: "One seed per address, ever — this address has already claimed.",
      },
    };
  }

  // Reserve against the caps atomically (INCR is atomic in Redis; the
  // memory store is single-instance so it is atomic there too). Roll back
  // on any later failure so rejected claims never consume pilot slots.
  const total = await store.incr(KEY_TOTAL);
  if (total > PILOT.MAX_TOTAL) {
    await store.decr(KEY_TOTAL);
    return {
      status: 409,
      body: {
        error: `Seed pilot is full (${PILOT.MAX_TOTAL}/${PILOT.MAX_TOTAL} claimed). Fund the wallet address directly instead.`,
        code: "pilot-full",
      },
    };
  }
  const dayKey = keyDay(utcDay(opts.nowMs));
  const dayCount = await store.incr(dayKey);
  if (dayCount > PILOT.MAX_PER_DAY) {
    await store.decr(dayKey);
    await store.decr(KEY_TOTAL);
    return {
      status: 429,
      body: {
        error: `Seed pilot daily cap reached (${PILOT.MAX_PER_DAY}/day) — try again tomorrow (UTC).`,
        code: "daily-cap",
      },
    };
  }

  const record = {
    address: addr,
    status: "pending",
    seedUsd: PILOT.SEED_USD,
    requestedAt: new Date(opts.nowMs || Date.now()).toISOString(),
  };
  const created = await store.createClaimNx(addr, record);
  if (!created) {
    // Lost a race with a concurrent claim for the same address.
    await store.decr(dayKey);
    await store.decr(KEY_TOTAL);
    const rec = await store.getClaim(addr);
    return {
      status: 200,
      body: {
        status: rec?.status || "pending",
        alreadyClaimed: true,
        address: v.display,
        seedUsd: PILOT.SEED_USD,
      },
    };
  }
  await store.addPending(addr);
  return {
    status: 201,
    body: {
      status: "pending",
      address: v.display,
      seedUsd: PILOT.SEED_USD,
      note:
        "Claim recorded. The seed worker sends 0.05 USDC on Base from the Flow " +
        "operational wallet; poll GET /api/starter or check the wallet balance.",
    },
  };
}

async function handleStats(store) {
  const [claimed, pending, total] = await Promise.all([
    store.claimedCount(),
    store.pendingCount(),
    store.getCount(KEY_TOTAL),
  ]);
  return {
    status: 200,
    body: {
      service: "flow-starter-seed-pilot",
      seedUsd: PILOT.SEED_USD,
      seedsClaimed: claimed,
      seedsPending: pending,
      claimsRecorded: total,
      usdcSpent: Math.round(claimed * PILOT.SEED_USD * 100) / 100,
      caps: { maxTotal: PILOT.MAX_TOTAL, maxPerDay: PILOT.MAX_PER_DAY, perAddress: 1 },
      store: store.kind,
      note:
        store.kind === "memory"
          ? "In-memory store on this instance (UPSTASH_REDIS_REST_URL/TOKEN not set) — counts are per-instance and reset on cold start."
          : "Shared Upstash store across all instances.",
    },
  };
}

// ---------------------------------------------------------------------------
// On-chain seed verification (the chain is the receipt for mark-paid)
// ---------------------------------------------------------------------------

function padTopicAddress(addr) {
  return "0x" + "0".repeat(24) + String(addr).toLowerCase().replace(/^0x/, "");
}

// Pure receipt matcher — exported for tests. A receipt proves the seed iff
// it succeeded AND carries a USDC Transfer log of exactly SEED_ATOMIC from
// the operational wallet to the claim address.
function matchSeedTransfer(receipt, { from, to }) {
  if (!receipt || receipt.status !== "0x1") return false;
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  return logs.some((log) => {
    if (!log || String(log.address || "").toLowerCase() !== USDC_BASE.toLowerCase()) return false;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if ((topics[0] || "").toLowerCase() !== TRANSFER_TOPIC) return false;
    if ((topics[1] || "").toLowerCase() !== padTopicAddress(from)) return false;
    if ((topics[2] || "").toLowerCase() !== padTopicAddress(to)) return false;
    try {
      return BigInt(log.data) === SEED_ATOMIC;
    } catch {
      return false;
    }
  });
}

async function rpcCall(method, params) {
  const url = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`base RPC responded ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(`base RPC error: ${String(d.error.message || d.error).slice(0, 120)}`);
    return d.result;
  } finally {
    clearTimeout(timer);
  }
}

async function verifySeedTxOnChain(txHash, claimAddr, opts = {}) {
  const rpc = opts.rpc || rpcCall;
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ok: false, reason: "transaction not found (or not yet mined)" };
  if (!matchSeedTransfer(receipt, { from: OPERATIONAL_WALLET, to: claimAddr })) {
    return {
      ok: false,
      reason: "no USDC transfer of exactly 0.05 from the operational wallet to the claim address in this tx",
    };
  }
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  const minedAt = parseInt(receipt.blockNumber, 16);
  const confirmations = latest - minedAt + 1;
  if (confirmations < MIN_CONFIRMATIONS) {
    return { ok: false, reason: `only ${confirmations} confirmation(s) — need ${MIN_CONFIRMATIONS}`, confirmations };
  }
  return { ok: true, blockNumber: minedAt, confirmations };
}

// ---------------------------------------------------------------------------
// Claim list + claim action (store injected — exported for tests)
// ---------------------------------------------------------------------------

async function handleListClaims(store) {
  const records = await store.listClaims();
  const claims = records
    .map((rec) => ({
      address: rec.address,
      status: rec.status,
      createdAt: rec.requestedAt || rec.createdAt || null,
      ...(rec.txHash ? { txHash: rec.txHash } : {}),
    }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.address.localeCompare(b.address));
  return { status: 200, body: { service: "flow-starter-seed-pilot", count: claims.length, claims } };
}

async function handleClaimAction(store, input, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const opsAddress = (opts.opsAddress || OPERATIONAL_WALLET).toLowerCase();
  const verifySeedTx = opts.verifySeedTx || verifySeedTxOnChain;

  const action = input?.action;
  if (action !== "mark-paid" && action !== "void") {
    return { status: 400, body: { error: 'action must be "mark-paid" or "void"', code: "bad-action" } };
  }
  const v = validateAddress(input?.address);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const addr = v.address;

  let txHash = "";
  if (action === "mark-paid") {
    if (typeof input?.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      return { status: 400, body: { error: "mark-paid requires txHash (0x + 64 hex chars)", code: "bad-txhash" } };
    }
    txHash = input.txHash.toLowerCase();
  }

  const ts = Number(input?.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
    return { status: 400, body: { error: "timestamp must be epoch milliseconds (integer)", code: "bad-timestamp" } };
  }
  if (Math.abs(nowMs - ts) > CLAIM_ACTION_WINDOW_MS) {
    return { status: 401, body: { error: "signed action timestamp is outside the 10-minute window", code: "stale-timestamp" } };
  }

  const message = canonicalClaimActionMessage({ action, address: addr, txHash, timestamp: ts });
  if (!verifyOpsSignature(message, input?.signature, opsAddress)) {
    return { status: 403, body: { error: "signature does not recover to the operational wallet", code: "bad-signature" } };
  }

  const claim = await store.getClaim(addr);
  if (!claim) return { status: 404, body: { error: "no claim recorded for this address", code: "no-claim" } };

  if (action === "void") {
    if (claim.status === "void") {
      return { status: 200, body: { status: "void", alreadyVoid: true, address: v.display } };
    }
    if (claim.status === "claimed") {
      return { status: 409, body: { error: "claim is already paid — a paid claim cannot be voided", code: "already-claimed" } };
    }
    const record = { ...claim, status: "void", voidedAt: new Date(nowMs).toISOString(), voidVia: "claim-action" };
    await store.updateClaim(addr, record);
    return { status: 200, body: { status: "void", address: v.display } };
  }

  // action === "mark-paid"
  if (claim.status === "claimed") {
    if ((claim.txHash || "").toLowerCase() === txHash) {
      return { status: 200, body: { status: "claimed", alreadyPaid: true, address: v.display, txHash } };
    }
    return { status: 409, body: { error: "claim is already paid with a different tx hash", code: "already-claimed" } };
  }
  if (claim.status === "void") {
    return { status: 409, body: { error: "claim is void — a voided claim cannot be marked paid", code: "already-void" } };
  }
  if (claim.status !== "pending") {
    return { status: 409, body: { error: `claim is in unexpected status "${claim.status}"`, code: "bad-state" } };
  }

  // The chain is the proof: no matching on-chain transfer, no state change.
  let proof;
  try {
    proof = await verifySeedTx(txHash, addr);
  } catch (e) {
    return { status: 502, body: { error: `on-chain verification unavailable: ${String(e.message || e).slice(0, 150)}`, code: "verify-unavailable" } };
  }
  if (!proof || !proof.ok) {
    return {
      status: 400,
      body: { error: `on-chain verification failed: ${proof?.reason || "unknown reason"}`, code: "tx-verify-failed" },
    };
  }

  const record = {
    ...claim,
    status: "claimed",
    txHash,
    claimedAt: new Date(nowMs).toISOString(),
    paidVia: "claim-action",
    ...(proof.blockNumber ? { blockNumber: proof.blockNumber } : {}),
  };
  await store.updateClaim(addr, record);
  return {
    status: 200,
    body: { status: "claimed", address: v.display, txHash, ...(proof.confirmations ? { confirmations: proof.confirmations } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

// Sub-routes are funnelled into this one function by vercel.json rewrites
// (/api/starter/claims -> /api/starter?route=claims, etc.). The path check
// keeps the same dispatch working for direct invocations and local tests.
function routeOf(req) {
  const q = req.query && req.query.route;
  if (q === "claims" || q === "claim-action") return q;
  try {
    const p = new URL(req.url || "", "http://localhost").pathname.replace(/\/+$/, "");
    if (p.endsWith("/claims")) return "claims";
    if (p.endsWith("/claim-action")) return "claim-action";
  } catch {
    /* fall through to the base route */
  }
  return null;
}

function parseJsonBody(req) {
  let input = req.body;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return input && typeof input === "object" ? input : null;
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = getStore();
  const route = routeOf(req);
  try {
    if (route === "claims") {
      if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
      const { status, body } = await handleListClaims(store);
      return res.status(status).json(body);
    }
    if (route === "claim-action") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
      const input = parseJsonBody(req);
      if (!input) return res.status(400).json({ error: "request body must be JSON: {action, address, txHash, timestamp, signature}" });
      const { status, body } = await handleClaimAction(store, input);
      return res.status(status).json(body);
    }
    if (req.method === "GET") {
      const { status, body } = await handleStats(store);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      const input = parseJsonBody(req);
      if (!input) return res.status(400).json({ error: "request body must be JSON: {address}" });
      const { status, body } = await handleClaim(store, input);
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res.status(503).json({ error: `starter store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
module.exports._test = {
  PILOT,
  KEY_TOTAL,
  keyDay,
  utcDay,
  validateAddress,
  createMemoryStore,
  handleClaim,
  handleStats,
  handleListClaims,
  handleClaimAction,
  canonicalClaimActionMessage,
  verifyOpsSignature,
  matchSeedTransfer,
  verifySeedTxOnChain,
  padTopicAddress,
  USDC_BASE,
  SEED_ATOMIC,
  CLAIM_ACTION_WINDOW_MS,
};
