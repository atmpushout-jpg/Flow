// Gigabyte Space — shared store, validation, and operator auth for
// the Space ticket rail (ask-the-cast speaker queue). State lives in
// Upstash under the sp:* namespace. Same Upstash REST pattern,
// hash-only operator key discipline, and bootstrap posture as
// api/_exchange.js (px:*), fully separate namespace.
//
//   sp:state       JSON space state ({ tickets: [...], seq: n })
//   sp:opkeyhash   sha256 hex of the operator key (hash only)
//
// Path C holds throughout: this module moves NO funds. The $0.50
// ticket payment settles payer→payee over the existing x402 rail
// (api/_x402.js) before a ticket is written; the store only records
// the queue. The ticket buys a question answered on air — presence
// in the queue, never a verdict, never credibility.

const crypto = require("crypto");

const KEY_STATE = "sp:state";
const KEY_OPKEYHASH = "sp:opkeyhash";
const STORE_TIMEOUT_MS = 8000;

// The price is FINAL (Atm's standing word — the same $0.50 as the
// Arena seat). Changing it is a pricing decision, not a code tweak.
const TICKET_PRICE_USD = 0.5;

const TICKET_STATES = ["queued", "called", "done"];
// Forward-only state machine: a ticket never un-calls or un-dones.
const TRANSITIONS = {
  queued: ["called", "done"],
  called: ["done"],
  done: [],
};

// ---------------------------------------------------------------------------
// Store (Upstash REST, same shape as _exchange.js)
// ---------------------------------------------------------------------------

function storeConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function cmd(...parts) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error("upstash env not configured");
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

const store = {
  get: (key) => cmd("GET", key),
  set: (key, value) => cmd("SET", key, value),
  setNx: async (key, value) => (await cmd("SET", key, value, "NX")) === "OK",
};

// ---------------------------------------------------------------------------
// Operator-key auth (hash-only storage, timing-safe compare —
// the Exchange push-key pattern verbatim)
// ---------------------------------------------------------------------------

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey), "utf8").digest("hex");
}

function keyMatches(rawKey, storedHashHex) {
  if (typeof rawKey !== "string" || !rawKey || typeof storedHashHex !== "string") return false;
  const a = Buffer.from(hashKey(rawKey), "hex");
  const b = Buffer.from(storedHashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function operatorAuthed(req) {
  const storedHash = await store.get(KEY_OPKEYHASH);
  if (!storedHash) return { ok: false, status: 503, error: "operator key not bootstrapped yet" };
  const presented = req.headers["x-space-key"];
  if (!keyMatches(presented, storedHash)) {
    return { ok: false, status: 401, error: "bad or missing x-space-key" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// State access — no seed file: before the first ticket the state is
// simply empty, and an empty queue is the honest queue.
// ---------------------------------------------------------------------------

function emptyState() {
  return { tickets: [], seq: 0, updated_at: null };
}

async function loadState() {
  if (storeConfigured()) {
    try {
      const raw = await store.get(KEY_STATE);
      if (raw) return { state: JSON.parse(raw), source: "store" };
    } catch { /* fall through to empty */ }
  }
  return { state: emptyState(), source: "empty" };
}

async function loadStateForWrite() {
  const raw = await store.get(KEY_STATE);
  if (raw) return JSON.parse(raw);
  return emptyState();
}

async function saveState(state) {
  state.updated_at = new Date().toISOString();
  await store.set(KEY_STATE, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Input hygiene — the ticket fields are read out ON AIR and rendered
// on the public floor page, so they are cleaned at the door.
// ---------------------------------------------------------------------------

// X handles: letters, digits, underscore; 1–15 chars; a leading @ is
// accepted and stripped.
function sanitizeHandle(raw) {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/^@+/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

// Display name: control characters stripped, collapsed whitespace,
// max 50 chars.
function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
  return n || null;
}

// The question: max 500 chars (the ticket body contract), control
// characters stripped. Required and non-empty.
function sanitizeQuestion(raw) {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!q || q.length > 500) return null;
  return q;
}

// ---------------------------------------------------------------------------
// Queue views
// ---------------------------------------------------------------------------

// 1-based position among currently-queued tickets, in purchase
// order; null for tickets no longer queued.
function queuePosition(state, ticketId) {
  let pos = 0;
  for (const t of state.tickets || []) {
    if (t.state !== "queued") continue;
    pos += 1;
    if (t.id === ticketId) return pos;
  }
  return null;
}

// The public shape of a ticket: everything the floor page and the
// cast need — nothing here is secret (the payer address is public
// on-chain in the settlement anyway).
function publicTicket(state, t) {
  return {
    id: t.id,
    handle: t.handle,
    name: t.name,
    question: t.question,
    state: t.state,
    position: t.state === "queued" ? queuePosition(state, t.id) : null,
    paid_at: t.paid_at,
    tx: t.tx,
    test: t.test === true,
  };
}

function findTicket(state, id) {
  return (state.tickets || []).find((t) => t.id === id) || null;
}

module.exports = {
  KEY_STATE,
  KEY_OPKEYHASH,
  TICKET_PRICE_USD,
  TICKET_STATES,
  TRANSITIONS,
  store,
  storeConfigured,
  hashKey,
  keyMatches,
  operatorAuthed,
  emptyState,
  loadState,
  loadStateForWrite,
  saveState,
  sanitizeHandle,
  sanitizeName,
  sanitizeQuestion,
  queuePosition,
  publicTicket,
  findTicket,
};
