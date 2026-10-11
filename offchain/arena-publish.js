/**
 * FLOW ARENA — LIVE-STATE PUBLISHER.
 *
 * The missing wire between the live engine and the public page: while a
 * live match runs, offchain/arena.js writes the state to arena-live.json
 * (offchain copy + repo-root copy) after EVERY event — but arena.html can
 * only poll what the SITE serves, and the site serves GitHub main via
 * Vercel. This module pushes the root arena-live.json to GitHub main
 * during the match so the page's poller sees the broadcast tick by tick.
 *
 * Cadence (deploy-cap aware — every push is a commit, and Vercel's daily
 * cap is a real budget):
 *   - at most ONE push per round, and only when the state fingerprint
 *     changed (fingerprint = status + currentRound + every agent's
 *     treasury, from the leaderboard);
 *   - mid-round changes after that round's push are throttled (logged);
 *   - the FINAL state (status "finished") is always published at match
 *     end, and finalize() re-verifies it by read-back.
 *   A ~9.5-minute, 14-round match therefore costs ≤ ~15 pushes.
 *
 * Push mechanics mirror flow-agent/explain.py (the 2026-10-11 fix): the
 * bridge's write path (`github call-tool`) is approval-gated and can
 * block indefinitely as a piped subprocess EVEN THOUGH the write lands
 * server-side — so the write is dispatched with a bounded timeout (a
 * timeout means "dispatched", not "failed") and success is confirmed by
 * reading the file back and comparing signatures. One write retry if the
 * read-back mismatches.
 *
 * Failure doctrine: publishing NEVER blocks or crashes the match. The
 * publisher is a decoupled poller (it reads the state file the engine
 * writes); every push runs in a serialized async worker with coalescing
 * (only the freshest pending state is kept); failures are logged to
 * offchain/arena-publish.log and retried on the next decision tick after
 * a short cooldown. One bridge reality shapes the design: dispatched
 * writes COMMIT with wildly variable latency (~10s typical, observed up
 * to ~5 min — every observed dispatch did eventually land). A push that
 * isn't read-back-verified inside its window is therefore treated as
 * PENDING, not lost: a reconciler keeps polling the remote until the
 * write lands (verified late), and no new write is dispatched while one
 * is outstanding, so a straggler can never land out of order and regress
 * the page.
 *
 * Known limit: the bridge passes content as a single command-line
 * argument (~128KB OS cap, minus JSON escaping overhead). A state file
 * that outgrows the guard below is skipped with an OVERSIZE log line
 * rather than crashing — at Match 1 scale the finished state is ~74KB.
 *
 * Standalone use: `node offchain/arena-publish.js --resting` writes and
 * publishes the "no live match" resting state (status idle, liveMode
 * false → arena.html falls back to Match 1 in arena-state.json).
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GH_BIN = "/opt/hatch/bin/github";
const OWNER = "atmpushout-jpg";
const REPO = "Flow";
const BRANCH = "main";
const REMOTE_PATH = "arena-live.json";

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const ROOT_STATE_PATH = path.join(ROOT, "arena-live.json");
const OFFCHAIN_STATE_PATH = path.join(DIR, "arena-live.json");
const LOG_PATH = path.join(DIR, "arena-publish.log");

const WRITE_TIMEOUT_MS = 45000;   // bounded dispatch; timeout = dispatched
const READ_TIMEOUT_MS = 30000;
// Verify patience is sized for the approval-gated write path's observed
// landing latency: usually ~10s, but a write dispatched at T was seen
// committing at T+110s (2026-10-11 publisher unit test) — long after a
// short verify window would have declared it failed. The window below
// (plus the landed-late pre-check on retry) tolerates that.
const VERIFY_TRIES = 6;
const VERIFY_GAP_MS = 5000;
const MAX_ARGS_BYTES = 120000;    // bridge single-argument safety guard
const FAIL_COOLDOWN_MS = 10000;   // min gap before retrying after a failure

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logLine(matchId, msg) {
  const line = `${new Date().toISOString()} [${matchId || "-"}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch { /* log is best-effort */ }
  console.log(`[publish] ${msg}`);
}

// Run the bridge with a hard timeout. Never rejects: resolves
// { stdout, timedOut, err } so callers can apply the dispatch doctrine.
function runBridge(argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(GH_BIN, argv, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT")) {
        return resolve({ stdout: stdout || "", timedOut: true, err: null });
      }
      resolve({ stdout: stdout || "", timedOut: false, err: err || null });
    });
  });
}

// Read the remote file via the bridge read path (not approval-gated).
// Resolves { parsed, sha, raw } or { missing: true } or { error }.
// `remotePath` defaults to the live-state file; other publishers (the
// Earn summary) reuse the same discipline against their own path.
async function ghReadRemote(remotePath = REMOTE_PATH) {
  const args = { owner: OWNER, repo: REPO, path: remotePath, branch: BRANCH };
  const { stdout, err } = await runBridge(
    ["call-read-tool", "--name", "get_file_contents", "--arguments-json", JSON.stringify(args)],
    READ_TIMEOUT_MS);
  if (err) return { error: String(err.message || err) };
  let data;
  try { data = JSON.parse(stdout); } catch { return { error: "unparseable bridge read output" }; }
  const result = data.result || {};
  const items = result.content || [];
  if (result.isError) {
    const text = items.map((i) => i.text || "").join(" ");
    if (/does not exist|Failed to get file contents/i.test(text)) return { missing: true };
    return { error: text.slice(0, 200) || "bridge read error" };
  }
  let sha = null, raw = null;
  for (const item of items) {
    const m = /SHA: ([a-f0-9]+)/.exec(item.text || "");
    if (m) sha = m[1];
    const text = item.resource && item.resource.text;
    if (typeof text === "string") raw = text;
  }
  if (raw == null) return { error: "read returned no file content" };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* leave null */ }
  return { parsed, sha, raw };
}

// Compact comparison signature: enough to prove the remote file is the
// state we sent, robust to whitespace/formatting differences.
function signatureOf(s) {
  if (!s || typeof s !== "object") return "null";
  const treasuries = Array.isArray(s.leaderboard) && s.leaderboard.length
    ? s.leaderboard.map((r) => `${r.agentId}:${Number(r.treasury).toFixed(2)}`).sort().join(",")
    : (s.agents ? Object.values(s.agents).map((a) => Number(a.cash).toFixed(2)).sort().join(",") : "");
  const feed = Array.isArray(s.feed) ? s.feed : [];
  const last = feed.length ? feed[feed.length - 1] : null;
  return JSON.stringify({
    m: s.matchId ?? null, s: s.status ?? null, r: s.currentRound ?? null,
    t: treasuries, f: feed.length, last: last ? `${last.ts}|${last.type}` : null,
  });
}

// Fingerprint for the cadence rules: status + round + any treasury.
function fingerprintOf(s) {
  const treasuries = Array.isArray(s.leaderboard) && s.leaderboard.length
    ? s.leaderboard.map((r) => `${r.agentId}:${Number(r.treasury).toFixed(2)}`).sort().join(",")
    : (s.agents ? Object.entries(s.agents).map(([id, a]) => `${id}:${Number(a.cash).toFixed(2)}`).sort().join(",") : "");
  return `${s.status}|r${s.currentRound}|${treasuries}`;
}

// Push exact content to GitHub main: bounded dispatch + read-back verify,
// one write retry on mismatch (the explain.py pattern). Never throws.
// Returns { ok, attempts, reason?, bytes, dispatched? } — ok:false with
// reason "unverified" and dispatched:true means the write was dispatched
// but had not committed within the verify horizon (observed landing
// latencies run from ~10s to ~5 minutes through the approval-gated
// bridge; every observed dispatch did eventually commit). Callers treat
// "unverified" as pending, NOT as lost — see LivePublisher's reconciler
// and the lateVerifyMs option for the pushes that matter most.
async function ghPushContent(content, message, matchId, opts = {}) {
  const remotePath = opts.path || REMOTE_PATH;
  const bytes = Buffer.byteLength(content);
  const maxAttempts = opts.attempts || 2;
  const verifyTries = opts.verifyTries || VERIFY_TRIES;
  const verifyGapMs = opts.verifyGapMs || VERIFY_GAP_MS;
  let localSig = null;
  // The compact signature only describes arena match state (agents /
  // leaderboard shaped). Other payloads (e.g. the Earn summary) verify by
  // exact raw comparison instead — a state-shaped signature computed over
  // a foreign object could collide and false-verify a stale file.
  try {
    const parsed = JSON.parse(content);
    if (parsed && (parsed.agents || parsed.leaderboard)) localSig = signatureOf(parsed);
  } catch { /* raw compare fallback */ }
  const sigMatches = (back) => back && back.raw != null &&
    (localSig && back.parsed ? signatureOf(back.parsed) === localSig : back.raw === content);
  let dispatched = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remote = await ghReadRemote(remotePath).catch(() => ({ error: "read threw" }));
    // Landed-late pre-check: a previous attempt's dispatch may commit
    // after its verify window closed (observed ~110s). If the remote
    // already carries exactly this content, don't write again — a second
    // write with a pre-landing sha would just conflict, and a queued one
    // could land out of order.
    if (attempt > 1 && remote && remote.parsed && localSig && signatureOf(remote.parsed) === localSig) {
      logLine(matchId, "PUSH_LANDED_LATE previous dispatch committed after its verify window — content already current, no rewrite");
      return { ok: true, attempts: attempt - 1, bytes, landedLate: true };
    }
    const args = { owner: OWNER, repo: REPO, path: remotePath, branch: BRANCH, message, content };
    if (remote && remote.sha) args.sha = remote.sha;
    const argsJson = JSON.stringify(args);
    if (Buffer.byteLength(argsJson) > MAX_ARGS_BYTES) {
      logLine(matchId, `PUSH_SKIPPED reason=oversize bytes=${Buffer.byteLength(argsJson)} guard=${MAX_ARGS_BYTES}`);
      return { ok: false, attempts: attempt - 1, reason: "oversize", bytes };
    }
    const w = await runBridge(["call-tool", "--name", "create_or_update_file", "--arguments-json", argsJson], WRITE_TIMEOUT_MS);
    dispatched = true; // the dispatch happened (return or timeout) — treat as in-flight server-side
    // A return that mentions a commit is a good sign; a timeout means the
    // write was dispatched (approval-gated client) — either way the
    // read-back below is the authoritative check.
    let commitSeen = false;
    try { commitSeen = /commit/i.test(JSON.stringify(JSON.parse(w.stdout).result || {})); } catch { /* ignore */ }
    for (let v = 0; v < verifyTries; v++) {
      if (v > 0 || !commitSeen) await sleep(v === 0 ? 2000 : verifyGapMs);
      const back = await ghReadRemote(remotePath).catch(() => null);
      if (sigMatches(back)) return { ok: true, attempts: attempt, bytes };
    }
    logLine(matchId, `PUSH_VERIFY_MISMATCH attempt=${attempt} — ${attempt < maxAttempts ? "retrying write once" : "no attempts left"}`);
  }
  // Late-verify horizon for the pushes that matter most (final / resting):
  // keep reading back for a while before calling the push unverified.
  if (opts.lateVerifyMs > 0) {
    const deadline = Date.now() + opts.lateVerifyMs;
    while (Date.now() < deadline) {
      await sleep(15000);
      const back = await ghReadRemote(remotePath).catch(() => null);
      if (sigMatches(back)) {
        logLine(matchId, "PUSH_LANDED_LATE verified during the late-verify horizon");
        return { ok: true, attempts: maxAttempts, bytes, landedLate: true };
      }
    }
  }
  return { ok: false, attempts: maxAttempts, reason: "unverified", bytes, dispatched };
}

// ---------- Live publisher (decoupled poller + serialized push worker) ----------
class LivePublisher {
  constructor({ matchId, pollMs = 1500 } = {}) {
    this.matchId = matchId;
    this.pollMs = pollMs;
    this.timer = null;
    this.stopped = false;
    this.inFlight = false;
    this.pending = false;          // a push was decided while one was in flight
    this.lastPushedFp = null;
    this.lastPushedRound = -1;
    this.lastSeenFp = null;
    this.lastFailAt = 0;
    this.foreignLogged = false;
    this.pushes = 0;
    this.failures = 0;
    this.unverified = 0;
    this.skipsUnchanged = 0;
    this.skipsThrottle = 0;
    // Reconciler state: a push whose write was dispatched but not yet
    // read-back-verified. While one is outstanding we do NOT dispatch
    // more writes (a straggler could land out of order); ticks just poll
    // the remote until it lands (verified late) or a 240s grace expires
    // (abandoned → normal cadence may re-dispatch).
    this.awaitingVerify = null;   // { fp, sig, round, status, at }
    this.lastVerifyCheckAt = 0;
  }

  log(msg) { logLine(this.matchId, msg); }

  start() {
    this.log(`START cadence=1/round+fingerprint poll=${this.pollMs}ms remote=${REMOTE_PATH}@${BRANCH}`);
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
    this.tick().catch(() => {});
  }

  readLocal() {
    try {
      const raw = fs.readFileSync(ROOT_STATE_PATH, "utf8");
      return { raw, state: JSON.parse(raw) };
    } catch { return null; }
  }

  // Returns true while a dispatched-but-unverified push is outstanding
  // (caller skips new decisions), false once the slate is clean.
  async checkAwaitingVerify() {
    const a = this.awaitingVerify;
    if (!a) return false;
    const now = Date.now();
    if (now - a.at > 240000) {
      this.log(`PUSH_ABANDONED round=${a.round} status=${a.status} — dispatched ${Math.round((now - a.at) / 1000)}s ago and never read back; cadence may re-dispatch`);
      this.awaitingVerify = null;
      return false;
    }
    if (now - this.lastVerifyCheckAt < 15000) return true; // don't hammer the read path
    this.lastVerifyCheckAt = now;
    const back = await ghReadRemote().catch(() => null);
    if (back && back.parsed && signatureOf(back.parsed) === a.sig) {
      this.log(`PUSH_VERIFIED_LATE round=${a.round} status=${a.status} — landed ${Math.round((now - a.at) / 1000)}s after dispatch`);
      this.pushes++;
      this.lastPushedFp = a.fp;
      this.lastPushedRound = a.round;
      this.awaitingVerify = null;
      return false;
    }
    return true;
  }

  async tick() {
    if (this.stopped) return;
    if (await this.checkAwaitingVerify()) return; // one write in flight server-side — wait for it
    // Flush a coalesced pending push first (re-read: freshest state wins).
    if (this.pending && !this.inFlight && Date.now() - this.lastFailAt >= FAIL_COOLDOWN_MS) {
      this.pending = false;
      const cur = this.readLocal();
      if (cur && cur.state.matchId === this.matchId && fingerprintOf(cur.state) !== this.lastPushedFp) {
        await this.doPush(cur, "coalesced-pending");
        return;
      }
    }
    const cur = this.readLocal();
    if (!cur) return;
    const { state } = cur;
    if (state.matchId !== this.matchId) {
      if (!this.foreignLogged) { this.foreignLogged = true; this.log(`SKIP reason=foreign-state fileMatch=${state.matchId || "none"} (waiting for this match's first save)`); }
      return;
    }
    const fp = fingerprintOf(state);
    if (fp === this.lastSeenFp) { this.skipsUnchanged++; return; }
    this.lastSeenFp = fp;
    if (fp === this.lastPushedFp) { this.skipsUnchanged++; return; }
    // Fingerprint changed — apply the cadence rules.
    let reason = null;
    if (state.status === "finished") reason = "final-state";
    else if (state.currentRound !== this.lastPushedRound) reason = "round-advance";
    if (!reason) {
      this.skipsThrottle++;
      this.log(`SKIP-THROTTLE round=${state.currentRound} status=${state.status} reason=round-already-published (mid-round change waits for the next round)`);
      return;
    }
    if (Date.now() - this.lastFailAt < FAIL_COOLDOWN_MS) {
      this.pending = true;
      this.log(`DEFER round=${state.currentRound} reason=failure-cooldown (will flush)`);
      return;
    }
    if (this.inFlight) {
      this.pending = true;
      this.log(`QUEUED round=${state.currentRound} status=${state.status} reason=push-in-flight (freshest state will flush)`);
      return;
    }
    await this.doPush(cur, reason);
  }

  async doPush({ raw, state }, reason) {
    this.inFlight = true;
    const msg = state.status === "finished"
      ? `Arena live state: ${this.matchId} — FINAL (status finished)`
      : `Arena live state: ${this.matchId} — round ${state.currentRound}/${state.totalRounds} [${state.status}]`;
    this.log(`PUSH round=${state.currentRound} status=${state.status} reason=${reason} bytes=${Buffer.byteLength(raw)}`);
    let res;
    try {
      res = await ghPushContent(raw, msg, this.matchId);
    } catch (e) {
      res = { ok: false, reason: "exception: " + (e && e.message), attempts: 0 };
    }
    this.inFlight = false;
    if (res.ok) {
      this.pushes++;
      this.lastPushedFp = fingerprintOf(state);
      this.lastPushedRound = state.currentRound;
      this.log(`PUSHED round=${state.currentRound} status=${state.status} attempts=${res.attempts}${res.landedLate ? " landed-late" : ""} verified-by-readback`);
    } else if (res.dispatched) {
      // Dispatched but unconfirmed — every observed dispatch eventually
      // commits, so this is pending, not lost. The reconciler (tick)
      // confirms it by read-back; no immediate re-dispatch (stragglers
      // could land out of order).
      this.unverified++;
      this.awaitingVerify = { fp: fingerprintOf(state), sig: signatureOf(state), round: state.currentRound, status: state.status, at: Date.now() };
      this.lastVerifyCheckAt = Date.now();
      this.log(`PUSH_UNVERIFIED round=${state.currentRound} status=${state.status} — write dispatched, landing not yet confirmed; reconciler watching (match unaffected)`);
    } else {
      this.failures++;
      this.lastFailAt = Date.now();
      this.pending = true; // retry via flush once the cooldown passes
      this.log(`PUSH_FAILED round=${state.currentRound} status=${state.status} reason=${res.reason || "unknown"} (match unaffected; will retry)`);
    }
    if (this.pending && !this.stopped) setImmediate(() => { this.tick().catch(() => {}); });
  }

  // Stop polling, drain any in-flight push, then force-publish the final
  // local state and verify it by read-back. Never throws.
  async finalize() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + 300000; // a slow approval-gated push can occupy the worker ~3 min
    while (this.inFlight && Date.now() < deadline) await sleep(250);
    // Resolve any dispatched-but-unverified push BEFORE dispatching the
    // final state — a straggler landing after the final would regress
    // the page to a mid-match frame. Polls the reconciler check until
    // the outstanding write lands or its grace expires (≤240s).
    while (this.awaitingVerify && Date.now() < deadline) {
      if (!(await this.checkAwaitingVerify())) break;
      await sleep(5000);
    }
    const cur = this.readLocal();
    if (!cur || cur.state.matchId !== this.matchId) {
      this.log("FINALIZE no local final state for this match — nothing to force-publish");
      return { ok: false, reason: "no-final-state" };
    }
    if (fingerprintOf(cur.state) === this.lastPushedFp) {
      // Already pushed this exact fingerprint during play — prove the
      // remote copy carries the same signature before calling it done.
      const back = await ghReadRemote().catch(() => null);
      const match = back && back.parsed && signatureOf(back.parsed) === signatureOf(cur.state);
      this.log(match ? "FINAL_VERIFIED remote signature == final local state (already published during play)" : "FINAL_VERIFY_MISMATCH remote differs — forcing a final push");
      if (match) return { ok: true, reason: "already-published-verified" };
    }
    const res = await ghPushContent(cur.raw, `Arena live state: ${this.matchId} — FINAL (status ${cur.state.status})`, this.matchId, { lateVerifyMs: 240000 });
    if (res.ok) {
      this.pushes++;
      this.lastPushedFp = fingerprintOf(cur.state);
      this.lastPushedRound = cur.state.currentRound;
      this.log(`FINAL_PUSHED round=${cur.state.currentRound} status=${cur.state.status} attempts=${res.attempts}${res.landedLate ? " landed-late" : ""} verified-by-readback`);
    } else if (res.dispatched) {
      this.unverified++;
      this.log(`FINAL_PUSH_UNVERIFIED reason=${res.reason || "unknown"} — final state dispatched; landing not confirmed inside the horizon (every observed dispatch has eventually committed). Remote may lag the local final state until it lands.`);
    } else {
      this.failures++;
      this.log(`FINAL_PUSH_FAILED reason=${res.reason || "unknown"}`);
    }
    return res;
  }

  summary() {
    return { pushes: this.pushes, failures: this.failures, unverified: this.unverified, skipsThrottle: this.skipsThrottle, skipsUnchanged: this.skipsUnchanged };
  }
}

// ---------- Resting state ----------
function restingState() {
  return {
    game: "Flow Arena™",
    version: 2,
    liveMode: false, // arena.html only adopts liveMode files; false → falls back to Match 1
    status: "idle",
    matchId: null,
    label: null,
    currentRound: 0,
    totalRounds: 0,
    fallback: "arena-state.json",
    note: "No live match right now. arena.html falls back to the last completed match (arena-state.json) until the next live match publishes here.",
    updatedAt: new Date().toISOString(),
  };
}

function writeLocalCopies(obj) {
  const out = JSON.stringify(obj, null, 1);
  for (const p of [OFFCHAIN_STATE_PATH, ROOT_STATE_PATH]) {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, p);
  }
  return out;
}

async function publishResting() {
  const content = writeLocalCopies(restingState());
  logLine("resting", "PUSH resting state (status=idle, fallback=arena-state.json)");
  const res = await ghPushContent(content, "Arena live state: idle (no live match — page falls back to Match 1)", "resting", { lateVerifyMs: 240000 });
  logLine("resting", res.ok
    ? `RESTING_PUBLISHED attempts=${res.attempts}${res.landedLate ? " landed-late" : ""} verified-by-readback`
    : `RESTING_PUSH_${res.dispatched ? "UNVERIFIED (dispatched; landing unconfirmed)" : "FAILED"} reason=${res.reason || "unknown"}`);
  return res;
}

if (require.main === module) {
  if (process.argv.includes("--resting")) {
    publishResting()
      .then((res) => { console.log(res.ok ? "RESTING STATE PUBLISHED" : "RESTING PUBLISH FAILED: " + (res.reason || "?")); process.exit(res.ok ? 0 : 1); })
      .catch((e) => { console.error("FATAL:", e); process.exit(1); });
  } else {
    console.log("arena-publish.js is a module (required by arena-live.js). Standalone: --resting publishes the idle state.");
  }
}

module.exports = { LivePublisher, ghPushContent, ghReadRemote, signatureOf, fingerprintOf, restingState, publishResting, REMOTE_PATH };
