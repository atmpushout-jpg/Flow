// Problem Exchange — shared store, validation, and auth for the
// exchange endpoints (schema problem-listing/0.1). State lives in
// Upstash under the px:* namespace and is pushed by the house operator
// (offchain/exchange-operate.js) with a push key whose sha256 hash —
// never the key — is stored at px:pushkeyhash. Same Upstash REST
// pattern and bootstrap discipline as api/_gigabyte.js /
// api/_gigabyte_preview.js, fully separate namespace.
//
//   px:state         JSON exchange state (listings + solvers + events)
//   px:pushkeyhash   sha256 hex of the operator push key (hash only)
//
// Path C holds throughout: this module moves NO funds. Payments for
// graded DONE work travel payer→solver over the existing x402 rail;
// the exchange only records them (SETTLED requires a tx evidence ref).

const crypto = require("crypto");

const KEY_STATE = "px:state";
const KEY_PUSHKEYHASH = "px:pushkeyhash";
const STORE_TIMEOUT_MS = 8000;

const RULES_VERSION = "problem-listing/1";
const LISTING_FEE_USD = 0.005; // locked decision #2 — price set; v1
// collects nothing (house + imported curated intake only, decision #3).

const STATUSES = [
  "OPEN", "WATCH", "ROUTED", "BYPASSED", "BIDDING", "ASSIGNED",
  "PROOF_SUBMITTED", "GRADED_PASS", "GRADED_FAIL", "SETTLED",
  "EXPIRED", "WITHDRAWN",
];
const FUNDING_STATES = [
  "CONFIRMED_IN_WRITING", "CLAIMED", "FUNDING_UNVERIFIED",
  "AMOUNT_TBD", "HOUSE",
];
const REASON_CODES = [
  "FUNDING_UNVERIFIED", "AMOUNT_TBD", "ESCROW_UNVERIFIED",
  "POINTS_NOT_USD", "AWAITING_MAINTAINER_CONFIRMATION",
  "FIAT_RAILS_ONLY", "NO_SETTLED_HISTORY", "PROOF_MISSING",
  "PROOF_UNVERIFIABLE", "VERDICT_TOLL_UNPAID",
];

// ---------------------------------------------------------------------------
// Store (Upstash REST, same shape as _gigabyte_preview.js)
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
// Push-key auth (hash-only storage, timing-safe compare)
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
  const storedHash = await store.get(KEY_PUSHKEYHASH);
  if (!storedHash) return { ok: false, status: 503, error: "operator key not bootstrapped yet" };
  const presented = req.headers["x-exchange-key"];
  if (!keyMatches(presented, storedHash)) {
    return { ok: false, status: 401, error: "bad or missing x-exchange-key" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// history_root — sha256 chain over a listing's state events.
// Empty log root = sha256("") per the verdict-schema convention.
// ---------------------------------------------------------------------------

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

const EMPTY_ROOT = crypto.createHash("sha256").update("").digest("hex");

function nextRoot(prevRoot, event) {
  return crypto
    .createHash("sha256")
    .update(String(prevRoot || EMPTY_ROOT) + "|" + stableStringify(event))
    .digest("hex");
}

// Append a state event to a listing: updates history, history_root,
// updated_at/checked_at. Mutates and returns the listing.
function applyEvent(listing, type, detail, at) {
  const ts = at || new Date().toISOString();
  const event = { type, at: ts, detail: detail || {} };
  listing.history = Array.isArray(listing.history) ? listing.history : [];
  listing.history.push(event);
  listing.history_root = "sha256:" + nextRoot(
    String(listing.history_root || "").replace(/^sha256:/, "") || null, event);
  listing.updated_at = ts;
  listing.checked_at = ts;
  return event;
}

// ---------------------------------------------------------------------------
// Validation (problem-listing/0.1 field rules from the v1 spec §2)
// ---------------------------------------------------------------------------

function validateListing(l) {
  if (!l || typeof l !== "object") return "listing must be an object";
  if (l.schema !== "problem-listing/0.1") return "listing.schema must be problem-listing/0.1";
  if (!/^PX-\d{4}$/.test(l.id || "")) return "listing.id must look like PX-0001";
  if (!l.subject || !l.subject.lister || !l.subject.lister.id) return "subject.lister.id is required";
  if (!l.subject.source || !l.subject.source.kind || !l.subject.source.ref) {
    return "subject.source.kind and subject.source.ref are required";
  }
  if (!l.problem || !l.problem.title || !l.problem.statement) {
    return "problem.title and problem.statement are required";
  }
  if (!l.budget || !FUNDING_STATES.includes(l.budget.funding_state)) {
    return `budget.funding_state must be one of ${FUNDING_STATES.join(", ")}`;
  }
  // Cluster listings (sub_items present) state amounts per sub-item;
  // a single invented headline figure for a cluster would be worse
  // than the stated absence, so they are exempt like AMOUNT_TBD/HOUSE.
  const isCluster = Array.isArray(l.sub_items) && l.sub_items.length > 0;
  if (
    l.budget.funding_state !== "AMOUNT_TBD" &&
    l.budget.funding_state !== "HOUSE" &&
    !isCluster &&
    !(typeof l.budget.amount_usd === "number" && l.budget.amount_usd > 0)
  ) {
    return "budget.amount_usd is required unless funding_state is AMOUNT_TBD or HOUSE, or the listing is a cluster with per-item amounts";
  }
  if (isCluster) {
    for (const s of l.sub_items) {
      if (!s || !s.ref || !s.title || !(typeof s.amount_usd === "number" && s.amount_usd > 0)) {
        return "each sub_item needs ref, title, and a positive amount_usd";
      }
    }
  }
  if (!Array.isArray(l.doors) || !l.doors.length) return "doors must be a non-empty array";
  if (!STATUSES.includes(l.status)) return `status must be one of ${STATUSES.join(", ")}`;
  for (const r of l.reasons || []) {
    if (!r || !REASON_CODES.includes(r.code)) return `unknown reason code: ${r && r.code}`;
  }
  if (!l.created_at || !l.checked_at) return "created_at and checked_at are required";
  if (l.rules_version !== RULES_VERSION) return `rules_version must be ${RULES_VERSION}`;
  return null;
}

function validateState(state) {
  if (!state || typeof state !== "object") return "state must be an object";
  if (!Array.isArray(state.listings)) return "state.listings must be an array";
  const seen = new Set();
  for (const l of state.listings) {
    const err = validateListing(l);
    if (err) return `listing ${l && l.id}: ${err}`;
    if (seen.has(l.id)) return `duplicate listing id ${l.id}`;
    seen.add(l.id);
  }
  if (state.solvers !== undefined && (typeof state.solvers !== "object" || Array.isArray(state.solvers))) {
    return "state.solvers must be an object keyed by solver id";
  }
  if (state.events !== undefined && !Array.isArray(state.events)) return "state.events must be an array";
  return null;
}

// ---------------------------------------------------------------------------
// State access — the live store wins; the committed seed is the fallback
// so the board can never render empty before the first operator push.
// ---------------------------------------------------------------------------

async function loadState() {
  if (storeConfigured()) {
    try {
      const raw = await store.get(KEY_STATE);
      if (raw) return { state: JSON.parse(raw), source: "store" };
    } catch { /* fall through to seed */ }
  }
  return { state: require("./_exchange-seed.json"), source: "seed" };
}

async function saveState(state) {
  state.updated_at = new Date().toISOString();
  await store.set(KEY_STATE, JSON.stringify(state));
}

// Write-side load: the stored state wins; before the first operator
// push the bundled seed is the working copy (deep-cloned so handlers
// never mutate the require cache).
async function loadStateForWrite() {
  const raw = await store.get(KEY_STATE);
  if (raw) return JSON.parse(raw);
  return JSON.parse(JSON.stringify(require("./_exchange-seed.json")));
}

// Append a board-level event (the show feed reads these). Capped.
function recordEvent(state, type, listingId, detail, at) {
  const ts = at || new Date().toISOString();
  state.events = Array.isArray(state.events) ? state.events : [];
  const ev = {
    id: `EV-${listingId}-${type.toLowerCase().replace(/_/g, "-")}-${ts}`,
    type, listing: listingId, at: ts, detail: detail || {},
  };
  state.events.push(ev);
  if (state.events.length > 200) state.events = state.events.slice(-200);
  return ev;
}

// Shared prelude for the operator action endpoints: POST only, store
// configured, push-key authed. Sends the error response and returns
// null when any check fails.
async function actionPrelude(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return null;
  }
  if (!storeConfigured()) {
    res.status(503).json({ error: "exchange store not configured" });
    return null;
  }
  const auth = await operatorAuthed(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return null;
  }
  return true;
}

function solverRecord(state, solverId) {
  state.solvers = state.solvers && typeof state.solvers === "object" ? state.solvers : {};
  if (!state.solvers[solverId]) {
    state.solvers[solverId] = { id: solverId, kind: "house", solved: 0, failed: 0, graded: 0, events: [] };
  }
  return state.solvers[solverId];
}

function findListing(state, id) {
  return (state.listings || []).find((l) => l.id === id) || null;
}

// Public view of a listing: everything except the internal event log
// detail payloads stay, history is included (it is the audit trail the
// board's honesty fields point at) — nothing here is secret.
function publicListing(l) {
  return l;
}

module.exports = {
  KEY_STATE,
  KEY_PUSHKEYHASH,
  RULES_VERSION,
  LISTING_FEE_USD,
  STATUSES,
  FUNDING_STATES,
  REASON_CODES,
  store,
  storeConfigured,
  hashKey,
  keyMatches,
  operatorAuthed,
  EMPTY_ROOT,
  nextRoot,
  applyEvent,
  validateListing,
  validateState,
  loadState,
  saveState,
  loadStateForWrite,
  recordEvent,
  actionPrelude,
  solverRecord,
  findListing,
  publicListing,
};
