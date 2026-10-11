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
 * ARENA_PAYMENT_MODE=X402). Nothing here posts or announces anything —
 * running a match and publishing it are separate decisions.
 *
 * Run:  node offchain/arena-live.js [--rounds N] [--round-ms MS]
 *           [--match-id ID] [--label TEXT]
 * Defaults: 14 rounds × 40s (~10 min broadcast), match id arena-live-YYYY-MM-DD.
 */

const arena = require("./arena.js");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = Number(opt(name, dflt));
  return Number.isFinite(v) ? v : dflt;
};

const matchId = opt("match-id", "arena-live-" + new Date().toISOString().slice(0, 10));

arena.runMatch({
  matchId,
  label: opt("label", null),
  liveMode: true,
  reserve: true,
  stateFile: "arena-live.json",
  reportFile: "arena-live-report.json",
  rounds: num("rounds", 14),
  roundMs: num("round-ms", 40000),
})
  .then(() => console.log("\nLIVE MATCH COMPLETE — state: offchain/arena-live.json · reserve journal: offchain/arena-reserve.json"))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
