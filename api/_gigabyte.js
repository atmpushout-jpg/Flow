// GIGABYTE live-room relay — shared store + validation for
// GET /api/gigabyte-state, GET /api/gigabyte-audio, POST /api/gigabyte-push.
//
// The show itself runs on the house VM (offchain/gigabyte-live). A VM
// pusher (offchain/gigabyte-live/push-relay.js) forwards the show state
// and each spoken line's MP3 here because the free tunnel domains are
// filtered on some networks; this site is the door that opens.
//
// STORAGE (Upstash Redis, same env vars as api/_stats.js / _builderkey.js):
//   gigabyte:state          JSON show state (full overwrite per push)
//   gigabyte:audio:<id>     base64 MP3 for one transcript line (6h TTL)
//   gigabyte:pushkeyhash    sha256 hex of the push key (hash only, ever)
//   gigabyte:session        startedAt of the current show session
//   gigabyte:lastline       composite "<session>:<lastId>" watermark —
//                           the session flip and its reset are one
//                           write, so the two can never desync
//
// AUTH: the push key itself lives ONLY in a 600-perm file on the VM
// (~/.config/gigabyte_push_key). It was bootstrapped by hash: the first
// push claimed gigabyte:pushkeyhash with sha256(key) via SET NX, in the
// same request that carried the first real payload. The key value is
// never committed, never stored, and never logged — only its hash is.

const crypto = require("crypto");

const KEY_STATE = "gigabyte:state";
const KEY_PUSHKEYHASH = "gigabyte:pushkeyhash";
const KEY_SESSION = "gigabyte:session";
const KEY_LASTLINE = "gigabyte:lastline";
const audioKey = (id) => `gigabyte:audio:${id}`;

const CAST_IDS = ["FLOWEXECUTOR", "MISTY", "FADE", "K1N9", "PYRE", "PUSHOUT"];
const AUDIO_TTL_SEC = 6 * 3600;
const STATE_TTL_SEC = 3600; // refreshed by every push (pusher self-heals ~30s)
const MAX_TEXT_CHARS = 600;
const MAX_MP3_B64_CHARS = 1500000; // ~1.5MB of base64 per line
const MAX_LINES_PER_PUSH = 10;
const MAX_TRANSCRIPT = 200;
const STORE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Store: Upstash Redis over HTTPS (command-array POST, as _builderkey.js).
// No memory fallback: the relay is meaningless without the shared store,
// so callers get a loud error instead of a silent per-instance copy.
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
  set: (key, value, ttlSec) =>
    ttlSec ? cmd("SET", key, value, "EX", String(ttlSec)) : cmd("SET", key, value),
  setNx: async (key, value) => (await cmd("SET", key, value, "NX")) === "OK",
};

// ---------------------------------------------------------------------------
// Key + payload validation (pure — shared by the push handler)
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

function validLineShape(l) {
  return (
    l &&
    Number.isInteger(l.id) &&
    l.id >= 1 &&
    CAST_IDS.includes(l.member) &&
    typeof l.text === "string" &&
    l.text.length >= 1 &&
    l.text.length <= MAX_TEXT_CHARS
  );
}

function validateState(state) {
  if (!state || typeof state !== "object") return "state must be an object";
  if (!Number.isFinite(state.startedAt)) return "state.startedAt must be a number";
  if (!Array.isArray(state.transcript)) return "state.transcript must be an array";
  if (state.transcript.length > MAX_TRANSCRIPT) return "state.transcript too long";
  for (const l of state.transcript) {
    if (!validLineShape(l)) return `state.transcript line ${l && l.id} is malformed`;
  }
  if (state.currentLine != null && !validLineShape(state.currentLine)) {
    return "state.currentLine is malformed";
  }
  return null;
}

function validateLines(lines, state) {
  if (!Array.isArray(lines)) return "lines must be an array";
  if (lines.length > MAX_LINES_PER_PUSH) return "too many lines in one push";
  // ids that may legitimately be pushed: the state's transcript + current line
  const known = new Set(state.transcript.map((l) => l.id));
  if (state.currentLine) known.add(state.currentLine.id);
  let prev = 0;
  for (const l of lines) {
    if (!l || !Number.isInteger(l.id) || l.id < 1) return "line id must be a positive integer";
    if (l.id <= prev) return "line ids must be strictly increasing within a push";
    prev = l.id;
    if (!CAST_IDS.includes(l.member)) return `line ${l.id}: unknown cast member`;
    if (!known.has(l.id)) return `line ${l.id}: not present in the pushed state`;
    if (typeof l.mp3b64 !== "string" || l.mp3b64.length < 100 || l.mp3b64.length > MAX_MP3_B64_CHARS) {
      return `line ${l.id}: mp3b64 missing or oversized`;
    }
    const buf = Buffer.from(l.mp3b64, "base64");
    if (!buf.length || buf.length > 1200000) return `line ${l.id}: mp3 payload size out of range`;
  }
  return null;
}

module.exports = {
  KEY_STATE,
  KEY_PUSHKEYHASH,
  KEY_SESSION,
  KEY_LASTLINE,
  audioKey,
  CAST_IDS,
  AUDIO_TTL_SEC,
  STATE_TTL_SEC,
  store,
  storeConfigured,
  hashKey,
  keyMatches,
  validateState,
  validateLines,
};
