/**
 * FLOW — FORECASTER BOARD PUBLISHER.
 *
 * Builds the current Aave-Base "about to tip" board from the liquidation
 * trigger's evaluation ledger (logs/liquidation-evaluations.jsonl) and
 * publishes it to the GitHub data plane (offchain/forecaster-state.json
 * on main), where /api/forecaster reads it back via
 * raw.githubusercontent.com — the same channel /api/signals uses for
 * smart-wallet state. The committed file also rides every Vercel deploy
 * as the endpoint's bundled fallback.
 *
 * Board definition (mirrors the trigger's own logging rule):
 *   the trigger logs a forecast row for a borrower when it is a pre-arm
 *   candidate or projected to cross HF 1.0 within 50 blocks (throttled:
 *   on a changed projection or every 30 blocks ≈ every 1–2 minutes).
 *   A borrower belongs to the CURRENT board only while its latest
 *   forecast row is younger than BOARD_WINDOW_MS (10 minutes): the
 *   trigger re-logs a still-valid near-crossing projection roughly
 *   every minute, so 10 minutes of silence means the projection no
 *   longer holds (the borrower recovered, crossed and was handled, or
 *   its HF velocity flattened) — keeping it would sell a dead
 *   projection as a live one. Each position is enriched with the
 *   newest ledger evaluation carrying position economics
 *   (debt/collateral assets, cover, net) for the same borrower, and
 *   carries its own forecastAt so consumers can see per-row age.
 *
 * Doctrine (mirrors offchain/state-publish.js):
 *   - Read the remote file first; no-op when the board is unchanged
 *     and the remote snapshot is still young.
 *   - Send RAW file content only to create_or_update_file.
 *   - Verify every push by read-back before calling it landed.
 *   - At most ONE re-dispatch, only after read-back proves the first
 *     write did not land and no foreign contention is in play.
 *   - Never overwrite a remote snapshot newer than the local one.
 *   - Exclusive lock; overlapping runs no-op as "locked".
 *
 * Standalone:
 *   node offchain/forecaster-publish.js              build + push
 *   node offchain/forecaster-publish.js --build-only build the local
 *                                                    snapshot only
 *
 * Exit codes: 0 = pushed / already current / locked / build-only;
 *             2 = attempted but not verified, contention, or failed.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const GH_BIN = "/opt/hatch/bin/github";
const OWNER = "flow-executor";
const REPO = "Flow";
const BRANCH = "main";
const REMOTE_PATH = "offchain/forecaster-state.json";

const ROOT = path.join(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "logs", "liquidation-evaluations.jsonl");
const STATE_PATH = path.join(__dirname, "forecaster-state.json");
const PUB_STATE_PATH = path.join(__dirname, "forecaster-publish-state.json");
const LOCK_PATH = path.join(__dirname, "forecaster-publish.lock");
const LOG_PATH = path.join(__dirname, "forecaster-publish.log");

const BOARD_WINDOW_MS = 10 * 60 * 1000; // latest forecast row younger than 10m (trigger re-logs live projections ~every 1-2m)
const REPUSH_AGE_MS = 8 * 60 * 1000; // repush an unchanged board once the remote snapshot is this old
const BASE_BLOCK_TIME_SEC = 2; // labeled assumption for estSecondsToCross

const WRITE_TIMEOUT_MS = 240000;
const READ_TIMEOUT_MS = 30000;
const VERIFY_WAITS_MS = [5000, 10000, 15000, 25000, 40000];
const TIMEDOUT_VERIFY_EXTRA_WAITS_MS = [60000, 90000];

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
  console.log(`[forecaster-publish] ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);
const r6 = (n) => (Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : null);
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// ---------------------------------------------------------------------------
// Board construction
// ---------------------------------------------------------------------------

function buildBoard(now) {
  const text = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = text.trim().split("\n");
  const latestForecast = new Map(); // borrower -> newest forecast row
  const latestEcon = new Map(); // borrower -> newest row carrying position economics
  let lastEvalTs = null;
  let lastForecastTs = null;
  let lastBlock = null;

  for (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || !row.borrower || !row.ts) continue;
    if (!lastEvalTs || row.ts > lastEvalTs) lastEvalTs = row.ts;
    if (row.decision === "forecast") {
      const prev = latestForecast.get(row.borrower);
      if (!prev || row.ts > prev.ts) latestForecast.set(row.borrower, row);
      if (!lastForecastTs || row.ts > lastForecastTs) lastForecastTs = row.ts;
      if (row.block && (!lastBlock || row.block > lastBlock)) lastBlock = row.block;
    }
    if (row.debtAsset && row.collateralAsset) {
      const prev = latestEcon.get(row.borrower);
      if (!prev || row.ts > prev.ts) latestEcon.set(row.borrower, row);
    }
  }

  const positions = [];
  for (const [borrower, f] of latestForecast) {
    const ageMs = now - new Date(f.ts).getTime();
    if (!Number.isFinite(ageMs) || ageMs > BOARD_WINDOW_MS) continue;
    const econ = latestEcon.get(borrower) || null;
    const hf = Number.isFinite(f.hf) ? f.hf : null;
    positions.push({
      borrower,
      status: hf !== null && hf < 1 ? "crossed" : "approaching",
      hf: r6(hf),
      hfVelocityPerBlock: Number.isFinite(f.hfVelocityPerBlock) ? f.hfVelocityPerBlock : null,
      blocksToCross: f.blocksToCross === undefined ? null : f.blocksToCross,
      estSecondsToCross:
        Number.isFinite(f.blocksToCross) && f.blocksToCross > 0
          ? f.blocksToCross * BASE_BLOCK_TIME_SEC
          : f.blocksToCross === 0
            ? 0
            : null,
      blocksToProfitable: f.blocksToProfitable === undefined ? null : f.blocksToProfitable,
      preArmed: f.preArmed === true,
      projectedNetUsd: f.projectedNetUsd === undefined ? null : f.projectedNetUsd,
      debtAsset: econ ? econ.debtAsset : null,
      collateralAsset: econ ? econ.collateralAsset : null,
      coverUsd: econ ? r4(econ.coverUsd) : null,
      latestNetUsd: econ ? r4(econ.net) : null,
      lastEvaluationDecision: econ ? econ.decision || null : null,
      lastEvaluatedAt: econ ? econ.ts : null,
      forecastAt: f.ts,
      forecastBlock: f.block || null,
    });
  }
  // Most urgent first: lowest health factor first; crossed before approaching.
  positions.sort((a, b) => (a.hf ?? 99) - (b.hf ?? 99) || a.borrower.localeCompare(b.borrower));

  return {
    service: "Flow forecaster — Aave on Base liquidation board",
    generatedAt: new Date(now).toISOString(),
    source:
      "Flow liquidation trigger (offchain/liquidation-trigger.js) forecast ledger: logs/liquidation-evaluations.jsonl, decision=\"forecast\" rows, enriched with each borrower's newest ledger evaluation carrying position economics.",
    boardRule:
      "A borrower is on the board while its latest forecast row is younger than 10 minutes. The trigger logs a forecast row when a borrower is a pre-arm candidate or projected to cross health factor 1.0 within ~50 blocks, re-logging a still-valid projection roughly every 1-2 minutes — so 10 minutes of silence means the projection no longer holds and the borrower leaves the board.",
    baseBlockTimeSecAssumption: BASE_BLOCK_TIME_SEC,
    ledgerTip: { lastForecastAt: lastForecastTs, lastEvaluationAt: lastEvalTs, lastForecastBlock: lastBlock },
    count: positions.length,
    positions,
  };
}

function positionsHash(board) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(board ? board.positions || [] : []))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// GitHub bridge (same invocation shapes as offchain/state-publish.js)
// ---------------------------------------------------------------------------

function runBridge(argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(GH_BIN, argv, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT")) {
        return resolve({ stdout: stdout || "", stderr: stderr || "", timedOut: true, err: null });
      }
      resolve({ stdout: stdout || "", stderr: stderr || "", timedOut: false, err: err || null });
    });
  });
}

const CONTENTION_PATTERNS = [
  [/equivalent connector write is already running/i, "duplicate-in-flight"],
  [/DuplicateInFlight/, "duplicate-in-flight"],
  [/pending[\s-]?user[\s-]?confirmation/i, "pending-user-confirmation"],
  [/userConfirmationRequired|confirmation[\s-]?required/i, "confirmation-required"],
  [/approval[\s-]?(timeout|timed out|required)|requires approval/i, "approval-blocked"],
];

function classifyWriteOutput(stdout, stderr, err) {
  const combined = [stdout || "", stderr || "", err ? String(err.message || err) : ""].join("\n");
  for (const [pattern, reason] of CONTENTION_PATTERNS) {
    if (pattern.test(combined)) return { kind: "contention", reason };
  }
  try {
    const out = JSON.parse(stdout);
    const result = out.result || {};
    const text = (result.content || []).map((item) => item.text || "").join(" ");
    if (result.isError) {
      if (/sha|409/i.test(text)) return { kind: "sha-rejected", text };
      return { kind: "bridge-error", text: text || "bridge write returned an error" };
    }
    if (/\bcommit\b/i.test(text)) return { kind: "commit", text };
  } catch {}
  return null;
}

async function ghReadRemote() {
  const args = { owner: OWNER, repo: REPO, path: REMOTE_PATH, branch: BRANCH };
  const { stdout, err, timedOut } = await runBridge(
    ["call-read-tool", "--name", "get_file_contents", "--arguments-json", JSON.stringify(args)],
    READ_TIMEOUT_MS
  );
  if (timedOut) return { error: "bridge read timed out" };
  if (err) return { error: String(err.message || err) };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { error: "unparseable bridge read output" };
  }
  const result = data.result || {};
  const items = result.content || [];
  if (result.isError) {
    const text = items.map((item) => item.text || "").join(" ");
    if (/does not exist|Failed to get file contents/i.test(text)) return { missing: true };
    return { error: text.slice(0, 240) || "bridge read error" };
  }
  let sha = null;
  let raw = null;
  for (const item of items) {
    const match = /SHA: ([a-f0-9]+)/.exec(item.text || "");
    if (match) sha = match[1];
    if (item.resource && typeof item.resource.text === "string") raw = item.resource.text;
  }
  if (raw === null) {
    // Some bridge responses inline the file as text content instead.
    const textItem = items.find((i) => typeof i.text === "string" && i.text.trim().startsWith("{"));
    if (textItem) raw = textItem.text;
  }
  if (raw === null) return { error: "bridge read returned no file content" };
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { sha, raw, json };
}

async function ghWriteRemote(content, sha, message) {
  const args = {
    owner: OWNER,
    repo: REPO,
    path: REMOTE_PATH,
    branch: BRANCH,
    content,
    message,
  };
  if (sha) args.sha = sha;
  const { stdout, stderr, err, timedOut } = await runBridge(
    ["call-tool", "--name", "create_or_update_file", "--arguments-json", JSON.stringify(args)],
    WRITE_TIMEOUT_MS
  );
  return { classification: classifyWriteOutput(stdout, stderr, err), timedOut, err, stdout, stderr };
}

async function verifyRemote(expectedHash, expectedGeneratedAt, waits) {
  for (const wait of waits) {
    await sleep(wait);
    const remote = await ghReadRemote();
    if (remote.json && positionsHash(remote.json) === expectedHash && remote.json.generatedAt === expectedGeneratedAt) {
      return remote;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const buildOnly = process.argv.includes("--build-only");
  const now = Date.now();
  const board = buildBoard(now);
  const content = JSON.stringify(board, null, 2) + "\n";
  fs.writeFileSync(STATE_PATH, content);
  const hash = positionsHash(board);
  logLine(`built board: ${board.count} position(s), hash ${hash.slice(0, 12)}`);

  if (buildOnly) {
    logLine("RESULT build-only");
    return 0;
  }

  // Exclusive lock — a locked run is a successful no-op.
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
  } catch {
    logLine("RESULT locked");
    return 0;
  }

  try {
    const remote = await ghReadRemote();
    if (remote.error) {
      logLine(`RESULT failed — remote read: ${remote.error}`);
      return 2;
    }
    if (remote.json) {
      const remoteAge = now - new Date(remote.json.generatedAt || 0).getTime();
      if (positionsHash(remote.json) === hash && Number.isFinite(remoteAge) && remoteAge < REPUSH_AGE_MS) {
        logLine(`RESULT skipped-unchanged — remote snapshot ${Math.round(remoteAge / 1000)}s old, same board`);
        return 0;
      }
      if (remote.json.generatedAt && remote.json.generatedAt > board.generatedAt) {
        logLine("RESULT superseded — remote snapshot is newer than local build");
        return 2;
      }
    }

    const message = `forecaster: board snapshot ${board.generatedAt} (${board.count} positions) [skip ci]`;
    let attempt = await ghWriteRemote(content, remote.missing ? null : remote.sha, message);
    if (attempt.classification && attempt.classification.kind === "contention") {
      logLine(`RESULT skipped-contention — ${attempt.classification.reason}`);
      return 2;
    }
    let waits = attempt.timedOut ? [...VERIFY_WAITS_MS, ...TIMEDOUT_VERIFY_EXTRA_WAITS_MS] : VERIFY_WAITS_MS;
    let verified = await verifyRemote(hash, board.generatedAt, waits);
    if (verified) {
      logLine(`RESULT pushed — verified by read-back (sha ${verified.sha || "?"})`);
      return 0;
    }

    // One re-dispatch with a fresh SHA after a backoff, per doctrine.
    logLine("first write not verified by read-back — re-dispatching once with fresh sha");
    await sleep(30000);
    const fresh = await ghReadRemote();
    if (fresh.json && positionsHash(fresh.json) === hash && fresh.json.generatedAt === board.generatedAt) {
      logLine(`RESULT pushed — verified by read-back after re-check (sha ${fresh.sha || "?"})`);
      return 0;
    }
    attempt = await ghWriteRemote(content, fresh.missing ? null : fresh.sha, message);
    if (attempt.classification && attempt.classification.kind === "contention") {
      logLine(`RESULT skipped-contention — ${attempt.classification.reason} (on re-dispatch)`);
      return 2;
    }
    waits = attempt.timedOut ? [...VERIFY_WAITS_MS, ...TIMEDOUT_VERIFY_EXTRA_WAITS_MS] : VERIFY_WAITS_MS;
    verified = await verifyRemote(hash, board.generatedAt, waits);
    if (verified) {
      logLine(`RESULT pushed — verified by read-back after re-dispatch (sha ${verified.sha || "?"})`);
      return 0;
    }
    logLine("RESULT unverified — write dispatched twice, read-back never matched");
    return 2;
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {}
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {}
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    logLine(`RESULT failed — ${e && e.message ? e.message : e}`);
    process.exit(2);
  });
