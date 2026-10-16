// GIGABYTE PREVIEW relay — shared store + validation for the PRIVATE
// preview loop (VRM stage + big-model host brain). Mirrors api/_gigabyte.js
// but under a fully separate Upstash namespace (gbp:*) and its own push
// key, so the preview can never touch production show state.
//
//   gbp:state          JSON preview show state (full overwrite per push)
//   gbp:audio:<id>      base64 MP3 for one transcript line (6h TTL)
//   gbp:viseme:<id>     JSON Rhubarb mouth-cue track for one line (6h TTL)
//   gbp:pushkeyhash     sha256 hex of the preview push key (hash only)
//   gbp:session         startedAt of the current preview session
//   gbp:lastline        composite "<session>:<lastId>" watermark
//
// AUTH: the preview push key lives ONLY in a 600-perm file on the VM
// (~/.config/gigabyte_preview_push_key). Never committed, never logged.

const crypto = require("crypto");

const KEY_STATE = "gbp:state";
const KEY_PUSHKEYHASH = "gbp:pushkeyhash";
const KEY_SESSION = "gbp:session";
const KEY_LASTLINE = "gbp:lastline";
const audioKey = (id) => `gbp:audio:${id}`;
const visemeKey = (id) => `gbp:viseme:${id}`;

const CAST_IDS = ["FLOWEXECUTOR", "MISTY", "FADE", "K1N9", "PYRE", "PUSHOUT"];
const VISEME_VALUES = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
const AUDIO_TTL_SEC = 6 * 3600;
const STATE_TTL_SEC = 3600;
const MAX_TEXT_CHARS = 600;
const MAX_MP3_B64_CHARS = 1500000;
const MAX_LINES_PER_PUSH = 10;
const MAX_VISEMES_PER_PUSH = 10;
const MAX_CUES_PER_TRACK = 4000;
const MAX_TRANSCRIPT = 200;
const STORE_TIMEOUT_MS = 8000;

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

function validateVisemes(visemes, state) {
  if (!Array.isArray(visemes)) return "visemes must be an array";
  if (visemes.length > MAX_VISEMES_PER_PUSH) return "too many viseme tracks in one push";
  const known = new Set(state.transcript.map((l) => l.id));
  if (state.currentLine) known.add(state.currentLine.id);
  for (const v of visemes) {
    if (!v || !Number.isInteger(v.id) || v.id < 1) return "viseme id must be a positive integer";
    if (!known.has(v.id)) return `viseme ${v.id}: line not present in the pushed state`;
    if (!Array.isArray(v.mouthCues) || !v.mouthCues.length || v.mouthCues.length > MAX_CUES_PER_TRACK) {
      return `viseme ${v.id}: mouthCues missing or oversized`;
    }
    for (const c of v.mouthCues) {
      if (!c || !Number.isFinite(c.start) || !Number.isFinite(c.end) || !VISEME_VALUES.includes(c.value)) {
        return `viseme ${v.id}: malformed cue`;
      }
    }
  }
  return null;
}

module.exports = {
  KEY_STATE,
  KEY_PUSHKEYHASH,
  KEY_SESSION,
  KEY_LASTLINE,
  audioKey,
  visemeKey,
  CAST_IDS,
  AUDIO_TTL_SEC,
  STATE_TTL_SEC,
  store,
  storeConfigured,
  hashKey,
  keyMatches,
  validateState,
  validateLines,
  validateVisemes,
};
