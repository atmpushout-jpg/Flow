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
//            addPending, pendingCount, claimedCount.
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
// Vercel handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = getStore();
  try {
    if (req.method === "GET") {
      const { status, body } = await handleStats(store);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      let input = req.body;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          return res.status(400).json({ error: "request body must be JSON: {address}" });
        }
      }
      if (!input || typeof input !== "object") {
        return res.status(400).json({ error: "request body must be JSON: {address}" });
      }
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
};
