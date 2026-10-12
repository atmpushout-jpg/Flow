/**
 * FLOW ARENA — LIVE-STATE PUBLISHER (Upstash wire).
 *
 * The fast wire between the live engine and the public page. The GitHub
 * publisher (arena-publish.js) pushes arena-live.json to GitHub main,
 * where it only reaches arena.html when Vercel deploys — and Vercel's
 * daily deploy cap can (and did) freeze that path. This publisher
 * writes the same state to the shared Upstash store instead, where
 * GET /api/arena (api/arena/index.js) serves it to the page's poller
 * with no deploy in the loop. The two wires run side by side: Upstash
 * is the live broadcast; GitHub remains the durable post-match record.
 *
 * Cadence: poll the local state file every 1s; push on every
 * fingerprint change (status + round + treasuries — mid-round changes
 * included, writes are cheap here, unlike deploys). A heartbeat
 * re-push every 45s refreshes the TTL and the publishedAt stamp.
 *
 * Expiry doctrine: live pushes carry a TTL (default 240s). If the
 * publisher (or the whole match process) dies mid-match, the key
 * expires, /api/arena reports idle, and arena.html falls back to the
 * static files — the page can never sit on a frozen "LIVE" frame
 * forever. finalize() pushes the final state with NO TTL (it is the
 * recap until the next match or a resting publish replaces it) and
 * verifies it by read-back.
 *
 * Failure doctrine: identical to the GitHub publisher — publishing
 * NEVER blocks or crashes the match. Every error is logged (console +
 * offchain/arena-publish.log, tagged [upstash]) and retried on the
 * next tick.
 *
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (same store as
 * /api/stats and /api/smart-wallets). If unset, the publisher disables
 * itself with a warning and the GitHub wire carries the match alone.
 *
 * Standalone use:
 *   node offchain/arena-publish-upstash.js --resting
 *     Push the resting (idle) state to the store so /api/arena stops
 *     serving a finished match after the GitHub resting publish.
 *   node offchain/arena-publish-upstash.js --push-file <path>
 *     One-shot push of a state file (ops/testing).
 */

const fs = require("fs");
const path = require("path");
const { fingerprintOf, signatureOf, restingState } = require("./arena-publish.js");

const REDIS_KEY = "flow:arena-live";
const DIR = __dirname;
const ROOT_STATE_PATH = path.join(DIR, "..", "arena-live.json");
const LOG_PATH = path.join(DIR, "arena-publish.log");
const STORE_TIMEOUT_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logLine(matchId, msg) {
  const line = `${new Date().toISOString()} [${matchId || "-"}] [upstash] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch { /* log is best-effort */ }
  console.log(`[publish:upstash] ${msg}`);
}

function storeCreds() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && tok ? { url, tok } : null;
}

// One Upstash REST command (command-array style, as in seed-worker.js).
async function storeCmd(...parts) {
  const creds = storeCreds();
  if (!creds) throw new Error("store not configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
  try {
    const r = await fetch(creds.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`store responded ${r.status}`);
    return (await r.json()).result;
  } finally {
    clearTimeout(timer);
  }
}

// Push one state object. ttlSec > 0 → SET ... EX ttlSec; 0 → persistent.
// The pushed copy is stamped with publishedAt (the local file is never
// mutated) so consumers can see wire freshness. Returns true on success.
async function pushState(state, { ttlSec = 0 } = {}) {
  const copy = { ...state, publishedAt: new Date().toISOString() };
  const body = JSON.stringify(copy);
  if (ttlSec > 0) await storeCmd("SET", REDIS_KEY, body, "EX", String(ttlSec));
  else await storeCmd("SET", REDIS_KEY, body);
  return true;
}

async function readRemote() {
  const raw = await storeCmd("GET", REDIS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

class UpstashPublisher {
  constructor({ matchId, statePath = ROOT_STATE_PATH, pollMs = 1000, heartbeatMs = 45000, ttlSec = 240 } = {}) {
    this.matchId = matchId;
    this.statePath = statePath;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.ttlSec = ttlSec;
    this.timer = null;
    this.stopped = false;
    this.lastPushedFp = null;
    this.lastPushAt = 0;
    this.pushes = 0;
    this.failures = 0;
    this.foreignLogged = false;
  }

  static available() {
    return Boolean(storeCreds());
  }

  log(msg) { logLine(this.matchId, msg); }

  start() {
    this.log(`START key=${REDIS_KEY} poll=${this.pollMs}ms ttl=${this.ttlSec}s heartbeat=${this.heartbeatMs}ms`);
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
    this.tick().catch(() => {});
  }

  readLocal() {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      return { raw, state: JSON.parse(raw) };
    } catch { return null; }
  }

  async tick() {
    if (this.stopped) return;
    const cur = this.readLocal();
    if (!cur) return;
    const { state } = cur;
    if (state.matchId !== this.matchId) {
      if (!this.foreignLogged) {
        this.foreignLogged = true;
        this.log(`SKIP reason=foreign-state fileMatch=${state.matchId || "none"} (waiting for this match's first save)`);
      }
      return;
    }
    const fp = fingerprintOf(state);
    const dueHeartbeat = Date.now() - this.lastPushAt >= this.heartbeatMs;
    if (fp === this.lastPushedFp && !dueHeartbeat) return;
    const isHeartbeat = fp === this.lastPushedFp;
    try {
      await pushState(state, { ttlSec: this.ttlSec });
      this.pushes++;
      this.lastPushedFp = fp;
      this.lastPushAt = Date.now();
      this.log(`PUSHED round=${state.currentRound} status=${state.status}${isHeartbeat ? " (heartbeat)" : ""} bytes=${Buffer.byteLength(JSON.stringify(state))}`);
    } catch (e) {
      this.failures++;
      this.log(`PUSH_FAILED round=${state.currentRound} status=${state.status} reason=${e.message} (match unaffected; will retry)`);
    }
  }

  // Stop polling and force-push the final local state with no TTL,
  // verified by read-back. Never throws.
  async finalize() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const cur = this.readLocal();
    if (!cur || cur.state.matchId !== this.matchId) {
      this.log("FINALIZE no local final state for this match — nothing to force-push");
      return { ok: false, reason: "no-final-state" };
    }
    try {
      await pushState(cur.state, { ttlSec: 0 });
      const back = await readRemote();
      const match = back && signatureOf(back) === signatureOf(cur.state);
      if (match) {
        this.pushes++;
        this.lastPushedFp = fingerprintOf(cur.state);
        this.log(`FINAL_PUSHED round=${cur.state.currentRound} status=${cur.state.status} verified-by-readback`);
        return { ok: true };
      }
      this.log("FINAL_VERIFY_MISMATCH remote signature differs after final push");
      return { ok: false, reason: "verify-mismatch" };
    } catch (e) {
      this.failures++;
      this.log(`FINAL_PUSH_FAILED reason=${e.message}`);
      return { ok: false, reason: e.message };
    }
  }

  summary() {
    return { pushes: this.pushes, failures: this.failures };
  }
}

// ---------- Standalone ops ----------
async function publishRestingUpstash() {
  const state = restingState();
  await pushState(state, { ttlSec: 0 });
  const back = await readRemote();
  const ok = back && back.status === "idle" && back.liveMode === false;
  logLine("resting", ok ? "RESTING_PUSHED to store (page falls back to static chain)" : "RESTING_VERIFY_MISMATCH");
  return { ok };
}

async function pushFile(file) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const ttlSec = state.status === "finished" || state.status === "idle" ? 0 : 240;
  await pushState(state, { ttlSec });
  const back = await readRemote();
  const ok = back && signatureOf(back) === signatureOf(state);
  logLine(state.matchId || "one-shot", `PUSH_FILE ${file} round=${state.currentRound} status=${state.status} verified=${ok}`);
  return { ok };
}

if (require.main === module) {
  (async () => {
    if (!UpstashPublisher.available()) {
      console.error("UPSTASH_REDIS_REST_URL/TOKEN not set — cannot publish.");
      process.exit(1);
    }
    if (process.argv.includes("--resting")) {
      const res = await publishRestingUpstash();
      console.log(res.ok ? "RESTING STATE PUSHED (upstash)" : "RESTING PUSH FAILED");
      process.exit(res.ok ? 0 : 1);
    }
    const i = process.argv.indexOf("--push-file");
    if (i >= 0 && process.argv[i + 1]) {
      const res = await pushFile(process.argv[i + 1]);
      console.log(res.ok ? "PUSHED + VERIFIED" : "PUSH FAILED/UNVERIFIED");
      process.exit(res.ok ? 0 : 1);
    }
    console.log("arena-publish-upstash.js is a module (required by arena-live.js). Standalone: --resting | --push-file <path>");
  })().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}

module.exports = { UpstashPublisher, pushState, readRemote, publishRestingUpstash, REDIS_KEY };
