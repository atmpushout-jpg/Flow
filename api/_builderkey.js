// Early Builder Key program (v1) — shared store + logic for
// POST/GET /api/builder-key (issuance + public status) and for the
// x402 layer (api/_x402.js), which honors the key on the four paid
// data endpoints: /api/quote, /api/verify, /api/signals,
// /api/smart-wallets.
//
// THE OFFER (exactly this simple, by design):
//   - Any bot builder gets ONE free key per wallet address.
//   - The key carries a test budget of 100 free calls TOTAL across
//     the four endpoints — for developing and testing a bot.
//   - When the budget is gone, standard x402 prices apply. The key
//     is a test budget, never a discount.
//   - Early-window caps: max 200 keys total, max 25 new keys per
//     UTC day (same reserve-and-rollback discipline as the starter
//     seed pilot in api/starter/index.js).
//   - The wallet address is the builder's identity tag: the same
//     address later ties together a BYOB bot registration and a
//     starter-seed claim. (v1 ships the key + quota only.)
//
// STORAGE (Upstash Redis, same env vars as api/_stats.js):
//   flow:builderkey:byhash:<sha256>    JSON {address, botName?, issuedAt, callsBudget}
//   flow:builderkey:used:<sha256>      counter — calls consumed (atomic INCR)
//   flow:builderkey:byaddress:<addr>   sha256 hex of the address's key
//   flow:builderkey:count:total        keys issued
//   flow:builderkey:count:day:<date>   keys issued that UTC day
// Only the SHA-256 hash of a key is ever stored. The raw key is
// shown exactly once, in the issuance response.
//
// HONORING (in api/_x402.js requirePayment): a request carrying a
// valid key with budget left reserves one call atomically
// (INCR-then-check, the starter kit's reserveSpend pattern, so
// concurrent calls cannot double-spend the budget) and is served
// free. An invalid, exhausted, or unreachable-store key falls
// through to the normal x402 402 flow — never an error wall, and
// keyless traffic is completely untouched.

const crypto = require("crypto");

const PROGRAM = {
  CALLS_BUDGET: 100,
  MAX_KEYS_TOTAL: 200,
  MAX_KEYS_PER_DAY: 25,
  KEY_PREFIX: "flw_bk_",
  HEADER: "x-flow-builder-key",
  ENDPOINTS: ["/api/quote", "/api/verify", "/api/signals", "/api/smart-wallets"],
};

const KEY_BY_HASH = "flow:builderkey:byhash:";
const KEY_USED = "flow:builderkey:used:";
const KEY_BY_ADDRESS = "flow:builderkey:byaddress:";
const KEY_TOTAL = "flow:builderkey:count:total";
const keyDay = (day) => `flow:builderkey:count:day:${day}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const STORE_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------
// Validation + key primitives (pure — exported for tests)
// ---------------------------------------------------------------------------

function validateWalletAddress(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "address is required (string)" };
  }
  const raw = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { ok: false, error: "address must be a 0x-prefixed 40-hex-character EVM address" };
  }
  const address = raw.toLowerCase();
  if (address === ZERO_ADDRESS) {
    return { ok: false, error: "the zero address cannot hold a builder key" };
  }
  return { ok: true, address, display: raw };
}

function sanitizeBotName(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string") return undefined;
  const clean = input.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 48);
  return clean || undefined;
}

function generateKey() {
  return PROGRAM.KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
}

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey), "utf8").digest("hex");
}

function keyFormatOk(rawKey) {
  return (
    typeof rawKey === "string" &&
    rawKey.startsWith(PROGRAM.KEY_PREFIX) &&
    /^[A-Za-z0-9_-]{16,64}$/.test(rawKey.slice(PROGRAM.KEY_PREFIX.length))
  );
}

function utcDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// ---------------------------------------------------------------------------
// Store: Upstash Redis over HTTPS (same env vars as api/_stats.js), with an
// in-memory fallback for local dev / tests when the env vars are absent.
// Raw-KV interface: get, set, setNx, del, incr, decr.
// ---------------------------------------------------------------------------

function createMemoryStore() {
  const kv = new Map();
  return {
    kind: "memory",
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, String(value));
    },
    async setNx(key, value) {
      if (kv.has(key)) return false;
      kv.set(key, String(value));
      return true;
    },
    async del(key) {
      kv.delete(key);
    },
    async incr(key) {
      const v = (parseInt(kv.get(key) || "0", 10) || 0) + 1;
      kv.set(key, String(v));
      return v;
    },
    async decr(key) {
      const v = (parseInt(kv.get(key) || "0", 10) || 0) - 1;
      kv.set(key, String(v));
      return v;
    },
    _kv: kv, // test-only inspection
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
    async get(key) {
      return cmd("GET", key);
    },
    async set(key, value) {
      await cmd("SET", key, value);
    },
    async setNx(key, value) {
      const r = await cmd("SET", key, value, "NX");
      return r === "OK";
    },
    async del(key) {
      await cmd("DEL", key);
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
  };
}

let sharedStore = null;
let storeOverride = null; // tests only
function getStore() {
  if (storeOverride) return storeOverride;
  if (sharedStore) return sharedStore;
  sharedStore =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
      ? createUpstashStore()
      : createMemoryStore();
  return sharedStore;
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

async function readRecord(store, keyHash) {
  const raw = await store.get(KEY_BY_HASH + keyHash);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readUsed(store, keyHash) {
  const v = await store.get(KEY_USED + keyHash);
  return parseInt(v || "0", 10) || 0;
}

function statusBody(address, record, used) {
  return {
    issued: true,
    address,
    ...(record.botName ? { botName: record.botName } : {}),
    issuedAt: record.issuedAt,
    callsBudget: record.callsBudget,
    callsUsed: used,
    callsRemaining: Math.max(0, record.callsBudget - used),
  };
}

// ---------------------------------------------------------------------------
// Issuance (store injected — exported for tests)
// ---------------------------------------------------------------------------

async function issueKey(store, input, opts = {}) {
  const v = validateWalletAddress(input?.address);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const addr = v.address;
  const botName = sanitizeBotName(input?.botName);

  const existingHash = await store.get(KEY_BY_ADDRESS + addr);
  if (existingHash) {
    const record = await readRecord(store, existingHash);
    if (record) {
      const used = await readUsed(store, existingHash);
      return {
        status: 200,
        body: {
          ...statusBody(addr, record, used),
          alreadyIssued: true,
          note: "One key per wallet address. The key itself was shown once, at issuance, and is never shown again — if it is lost, the budget stays with the address.",
        },
      };
    }
  }

  // Reserve against the caps atomically; roll back on any later
  // failure so rejected issuances never consume program slots.
  const total = await store.incr(KEY_TOTAL);
  if (total > PROGRAM.MAX_KEYS_TOTAL) {
    await store.decr(KEY_TOTAL);
    return {
      status: 409,
      body: {
        error: `Early Builder window is full (${PROGRAM.MAX_KEYS_TOTAL}/${PROGRAM.MAX_KEYS_TOTAL} keys issued). Standard x402 per-call prices apply — the endpoints are unchanged.`,
        code: "program-full",
      },
    };
  }
  const dayKey = keyDay(utcDay(opts.nowMs));
  const dayCount = await store.incr(dayKey);
  if (dayCount > PROGRAM.MAX_KEYS_PER_DAY) {
    await store.decr(dayKey);
    await store.decr(KEY_TOTAL);
    return {
      status: 429,
      body: {
        error: `Daily issuance cap reached (${PROGRAM.MAX_KEYS_PER_DAY}/day) — try again tomorrow (UTC).`,
        code: "daily-cap",
      },
    };
  }

  const rawKey = generateKey();
  const keyHash = hashKey(rawKey);
  const record = {
    address: addr,
    ...(botName ? { botName } : {}),
    issuedAt: new Date(opts.nowMs || Date.now()).toISOString(),
    callsBudget: PROGRAM.CALLS_BUDGET,
  };
  // Record first, then claim the address atomically. A race loser
  // deletes its orphaned record and rolls the caps back.
  await store.set(KEY_BY_HASH + keyHash, JSON.stringify(record));
  const claimed = await store.setNx(KEY_BY_ADDRESS + addr, keyHash);
  if (!claimed) {
    await store.del(KEY_BY_HASH + keyHash);
    await store.decr(dayKey);
    await store.decr(KEY_TOTAL);
    const winnerHash = await store.get(KEY_BY_ADDRESS + addr);
    const winner = winnerHash ? await readRecord(store, winnerHash) : null;
    if (winner) {
      const used = await readUsed(store, winnerHash);
      return {
        status: 200,
        body: {
          ...statusBody(addr, winner, used),
          alreadyIssued: true,
          note: "One key per wallet address. The key itself was shown once, at issuance, and is never shown again.",
        },
      };
    }
    return { status: 503, body: { error: "issuance raced — retry" } };
  }

  return {
    status: 201,
    body: {
      key: rawKey,
      address: addr,
      ...(botName ? { botName } : {}),
      issuedAt: record.issuedAt,
      callsBudget: PROGRAM.CALLS_BUDGET,
      callsUsed: 0,
      callsRemaining: PROGRAM.CALLS_BUDGET,
      endpoints: PROGRAM.ENDPOINTS,
      note: "This key is shown ONCE — store it now. Send it as the x-flow-builder-key header; each response reports builderKey.callsRemaining. When the 100 test calls are used, standard x402 per-call prices apply.",
    },
  };
}

async function getStatus(store, addressInput) {
  const v = validateWalletAddress(addressInput);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const addr = v.address;
  const keyHash = await store.get(KEY_BY_ADDRESS + addr);
  if (!keyHash) {
    return {
      status: 200,
      body: {
        issued: false,
        address: addr,
        note: "No Early Builder Key for this address yet. POST /api/builder-key {address} to claim one (one per wallet, free).",
      },
    };
  }
  const record = await readRecord(store, keyHash);
  if (!record) return { status: 200, body: { issued: false, address: addr } };
  const used = await readUsed(store, keyHash);
  return { status: 200, body: statusBody(addr, record, used) };
}

async function programSummary(store) {
  const totalRaw = await store.get(KEY_TOTAL);
  const keysIssued = parseInt(totalRaw || "0", 10) || 0;
  return {
    status: 200,
    body: {
      service: "flow-early-builder-key",
      offer:
        "Building a bot for Flow Arena? Early builders get one free API key per wallet address with 100 test calls across the live data endpoints. When the budget is used, standard x402 per-call prices apply — the key is a test budget, never a discount.",
      callsBudget: PROGRAM.CALLS_BUDGET,
      endpoints: PROGRAM.ENDPOINTS,
      howToClaim: "POST /api/builder-key with JSON {address: \"0xYourWallet\", botName: \"optional\"}. The key is shown once in the response — store it. Then send it as the x-flow-builder-key header on any of the endpoints above.",
      checkStatus: "GET /api/builder-key?address=0xYourWallet",
      caps: { maxKeysTotal: PROGRAM.MAX_KEYS_TOTAL, maxKeysPerDay: PROGRAM.MAX_KEYS_PER_DAY, perAddress: 1 },
      keysIssued,
      store: store.kind,
    },
  };
}

// ---------------------------------------------------------------------------
// Honoring: reserve one call against a key's budget.
// INCR-first is the atomic guard — if the reservation overshoots
// the budget it is immediately released and the key reads as
// exhausted. Store errors THROW; the caller (api/_x402.js) catches
// and falls through to the normal paid flow.
// ---------------------------------------------------------------------------

async function tryReserve(store, rawKey) {
  if (!keyFormatOk(rawKey)) return { ok: false, reason: "format" };
  const keyHash = hashKey(rawKey);
  const record = await readRecord(store, keyHash);
  if (!record) return { ok: false, reason: "unknown" };
  const used = await store.incr(KEY_USED + keyHash);
  if (used > record.callsBudget) {
    await store.decr(KEY_USED + keyHash);
    return { ok: false, reason: "exhausted", address: record.address };
  }
  return {
    ok: true,
    keyHash,
    address: record.address,
    callsUsed: used,
    callsRemaining: record.callsBudget - used,
  };
}

// Give a reserved call back (used when a gated request is rejected
// for a malformed body before the resource executes — a builder is
// only charged for calls that actually run, same as x402 settling
// only after execution).
async function release(store, keyHash) {
  if (!keyHash) return;
  const v = await store.decr(KEY_USED + keyHash);
  if (v < 0) await store.incr(KEY_USED + keyHash); // floor at 0
}

// Default-store wrappers used by api/_x402.js.
async function reserveWithDefaultStore(rawKey) {
  return tryReserve(getStore(), rawKey);
}
async function releaseWithDefaultStore(keyHash) {
  return release(getStore(), keyHash);
}

module.exports = {
  PROGRAM,
  validateWalletAddress,
  sanitizeBotName,
  generateKey,
  hashKey,
  keyFormatOk,
  issueKey,
  getStatus,
  programSummary,
  tryReserve,
  release,
  reserveWithDefaultStore,
  releaseWithDefaultStore,
  getStore,
};

module.exports._test = {
  KEY_TOTAL,
  keyDay,
  utcDay,
  createMemoryStore,
  createUpstashStore,
  setStoreOverride(store) {
    storeOverride = store;
  },
};
