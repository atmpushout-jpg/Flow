/**
 * FLOW ARENA — LIVE MODE runner.
 *
 * Same engine, same personas, same rules as arena.js — but the match plays
 * in REAL TIME: rounds tick on a clock (default 40s) and the state is
 * written to offchain/arena-live.json (plus a root copy for the page)
 * after EVERY feed event, so arena.html can broadcast it tick by tick:
 * LIVE indicator, current round, live treasury/burn meters, growing feed.
 *
 * v2 economics are ON in live mode: the stabilization reserve
 * (ARENA_V2_ECONOMICS.md) settles at the whistle — 4 of the 15 rake points
 * accrue to the reserve, AUDREY-rule claims are evaluated mechanically,
 * and the reserve balance + journal print into the state and the page.
 * The persistent reserve journal lives in offchain/arena-reserve.json.
 *
 * Payment mode is inherited from arena.js (LEDGER unless
 * ARENA_PAYMENT_MODE=X402).
 *
 * LIVE-STATE PUBLISHING (arena-publish.js): while the match runs, the
 * root arena-live.json is pushed to GitHub main — where Vercel serves it
 * to arena.html — on a deploy-cap-aware cadence: at most one push per
 * round and only when the state fingerprint (status + round + treasuries)
 * changed, plus the final state always at match end. Publishing never
 * blocks or crashes the match; decisions are logged to
 * offchain/arena-publish.log. Flags:
 *   --publish       force publishing ON  (default for real matches)
 *   --no-publish    force publishing OFF (local-only run)
 *   --publish-test  allow publishing for a TEST match (label/match-id
 *                   containing "test"); tests are local-only by default
 * Note: a push lands on GitHub immediately, but the public page only
 * picks it up when Vercel's daily deploy cap allows a deployment.
 *
 * Run:  node offchain/arena-live.js [--rounds N] [--round-ms MS]
 *           [--match-id ID] [--label TEXT]
 *           [--publish | --no-publish | --publish-test]
 * Defaults: 14 rounds × 40s (~10 min broadcast), match id arena-live-YYYY-MM-DD.
 */

const arena = require("./arena.js");
const { LivePublisher } = require("./arena-publish.js");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = Number(opt(name, dflt));
  return Number.isFinite(v) ? v : dflt;
};
const has = (name) => args.includes("--" + name);

const matchId = opt("match-id", "arena-live-" + new Date().toISOString().slice(0, 10));
const label = opt("label", null);

// Publishing defaults: ON for real matches, OFF for tests (a match is a
// test when its id or label says so) unless --publish-test opts in.
// --no-publish always wins; --publish always turns it on.
const isTest = /test/i.test(matchId) || /test/i.test(label || "");
const publishEnabled = has("no-publish") ? false
  : has("publish") ? true
  : isTest ? has("publish-test")
  : true;

async function run() {
  let publisher = null;
  if (publishEnabled) {
    publisher = new LivePublisher({ matchId });
    publisher.start();
  } else {
    console.log(`[publish] OFF for ${matchId} (${isTest ? "test match — pass --publish-test to publish" : "--no-publish"}). State stays local.`);
  }
  let matchError = null;
  try {
    await arena.runMatch({
      matchId,
      label,
      liveMode: true,
      reserve: true,
      stateFile: "arena-live.json",
      reportFile: "arena-live-report.json",
      rounds: num("rounds", 14),
      roundMs: num("round-ms", 40000),
    });
  } catch (e) {
    matchError = e;
  }
  if (publisher) {
    // The final state ALWAYS goes out (even if the match errored, whatever
    // state exists is the truth) — and publishing trouble never masks the
    // match's own result.
    try {
      const fin = await publisher.finalize();
      const sum = publisher.summary();
      console.log(`[publish] done: ${sum.pushes} pushed, ${sum.failures} failed, ${sum.unverified || 0} unverified, ${sum.skipsThrottle} throttled, final=${fin.ok ? "ok" : (fin.reason || "failed") + (fin.dispatched ? " (dispatched)" : "")}`);
    } catch (e) {
      console.error("[publish] finalize error (match result unaffected):", e.message);
    }
  }
  if (matchError) throw matchError;
  console.log("\nLIVE MATCH COMPLETE — state: offchain/arena-live.json · reserve journal: offchain/arena-reserve.json");
}

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
