/**
 * Unit tests for the Reserve Refill Rule (adopted 2026-10-12, holocene).
 * Run: node offchain/arena-refill.test.js
 *
 * The cycle is simulated in the exact call order arena.js settleReserve
 * uses: split from journal state at event start -> inflow/claims move the
 * balance -> evaluateRefill at event end arms/clears the NEXT event.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const refill = require("./arena-refill");
const buyin = require("./arena-buyin");
const arena = require("./arena.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const round2 = (n) => Math.round(n * 100) / 100;

// A synthetic journal in the shape arena.js persists.
function mkJournal(balance) {
  return {
    version: 2,
    rakePoints: { total: 15, house: 11, reserve: 4 },
    refill: refill.defaultRefill(),
    balance,
    totalInflow: 0,
    totalPaid: 0,
    claims: [],
    journal: [],
  };
}

// One event, settled the way settleReserve settles it: split at start,
// inflow at that split, claims drain, evaluation at the end.
function runEvent(j, eventId, { pool = 30, claimPaid = 0 } = {}) {
  const split = refill.splitPointsFor(j);
  const rake = round2(pool * 0.15);
  const rakeReserve = round2(pool * (split.reserve / 100));
  const rakeHouse = round2(rake - rakeReserve);
  j.balance = round2(j.balance + rakeReserve - claimPaid);
  const ev = refill.evaluateRefill(j, eventId);
  return { split, rakeReserve, rakeHouse, ...ev };
}

t("dormant against today's real journal: balance $4.20, split 11/4, rule present but unarmed", () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "arena-reserve.json"), "utf8"));
  assert.strictEqual(real.balance, 4.2);
  const rf = refill.ensureRefill(real); // migration is in-memory here; file untouched by the test
  assert.strictEqual(rf.active, false);
  const split = refill.splitPointsFor(real);
  assert.deepStrictEqual([split.house, split.reserve, split.total], [11, 4, 15]);
  const ev = refill.evaluateRefill(real, "arena-match-4"); // ends at $4.20
  assert.strictEqual(ev.active, false);
  assert.strictEqual(ev.flipped, false);
});

t("migration: a pre-rule journal (no refill block) gains a dormant block, never retroactively armed", () => {
  const j = mkJournal(0.5);
  delete j.refill;
  const rf = refill.ensureRefill(j);
  assert.strictEqual(rf.active, false); // even below $2 — adoption alone does not arm
  assert.strictEqual(rf.thresholdUsd, 2);
  assert.strictEqual(rf.credit, refill.REFILL_CREDIT);
});

t("full cycle: >=$2 stays 11/4 -> drain below $2 arms 9/6 -> stays armed -> recovery reverts to 11/4", () => {
  const j = mkJournal(4.2);
  // Event A ends healthy: +$1.20 inflow, no claims -> 5.40
  let r = runEvent(j, "ev-a", { claimPaid: 0 });
  assert.deepStrictEqual([r.split.house, r.split.reserve], [11, 4]);
  assert.strictEqual(r.balance, 5.4);
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.flipped, false);
  // Event B: a big claim drains the reserve to $1.40 at the whistle
  r = runEvent(j, "ev-b", { claimPaid: 5.2 });
  assert.deepStrictEqual([r.split.house, r.split.reserve], [11, 4]); // B itself still ran the base split
  assert.strictEqual(r.rakeReserve, 1.2);
  assert.strictEqual(r.balance, 1.4);
  assert.strictEqual(r.flipped, true);
  assert.strictEqual(r.active, true);
  assert.strictEqual(j.refill.sinceEventId, "ev-b");
  // Event C runs the shifted split; a claim keeps it below $2 -> stays armed
  r = runEvent(j, "ev-c", { claimPaid: 1.5 });
  assert.deepStrictEqual([r.split.house, r.split.reserve], [9, 6]);
  assert.strictEqual(r.rakeReserve, 1.8); // 6% of the $30 pool
  assert.strictEqual(r.rakeHouse, 2.7);
  assert.strictEqual(r.balance, 1.7); // 1.40 + 1.80 - 1.50
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.flipped, false);
  // Event D still runs 9/6 and ends back above $2 -> the rule clears
  r = runEvent(j, "ev-d", { claimPaid: 0 });
  assert.deepStrictEqual([r.split.house, r.split.reserve], [9, 6]);
  assert.strictEqual(r.balance, 3.5); // 1.70 + 1.80
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.flipped, true);
  assert.strictEqual(j.refill.sinceEventId, null);
  // Event E is back to the base split
  r = runEvent(j, "ev-e", { claimPaid: 0 });
  assert.deepStrictEqual([r.split.house, r.split.reserve], [11, 4]);
  assert.strictEqual(r.active, false);
});

t("armed mode persists across consecutive sub-$2 endings (no flapping)", () => {
  const j = mkJournal(1.5);
  j.refill.active = true; // armed by a prior event
  let r = runEvent(j, "ev-x", { pool: 3, claimPaid: 0.6 }); // tiny buy-in pool: +0.18 -> 1.08
  assert.deepStrictEqual([r.split.house, r.split.reserve], [9, 6]);
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.flipped, false);
  r = runEvent(j, "ev-y", { pool: 3, claimPaid: 0 });
  assert.strictEqual(r.split.reserve, 6);
  assert.strictEqual(r.active, true);
});

t("boundary: an event ending at exactly $2.00 does NOT arm the rule", () => {
  const under = mkJournal(0.8);
  assert.strictEqual(refill.evaluateRefill(under, "ev-under").active, true); // sanity: below arms
  const exact = mkJournal(2.0);
  const evExact = refill.evaluateRefill(exact, "ev-exact");
  assert.strictEqual(evExact.active, false); // exactly $2.00 = not below -> no shift
  const cent = mkJournal(1.99);
  assert.strictEqual(refill.evaluateRefill(cent, "ev-cent").active, true); // one cent under arms
});

t("buy-in math honors the rule: same total rake, 2 points move house -> reserve", () => {
  const cfg = buyin.loadConfig();
  const ev = { ...buyin.getEvent(cfg, "buy-in-1"), guaranteeSeeded: true };
  const seats = Array.from({ length: 6 }, () => ({ amount: 0.5, kind: "OUTSIDE" }));
  const base = buyin.computeEventMath(ev, seats);
  assert.deepStrictEqual([base.rake, base.rakeHouse, base.rakeReserve], [0.45, 0.33, 0.12]);
  assert.strictEqual(base.refillActive, false);
  const shifted = buyin.computeEventMath(ev, seats, { refillActive: true });
  assert.deepStrictEqual([shifted.rake, shifted.rakeHouse, shifted.rakeReserve], [0.45, 0.27, 0.18]);
  assert.strictEqual(shifted.refillActive, true);
  assert.deepStrictEqual(shifted.prizes, base.prizes); // prizes never move
  assert.deepStrictEqual(shifted.splitBps, { houseBpsOfPool: 900, reserveBpsOfPool: 600 });
});

t("refillBps shifts exactly 200 bps and preserves the 1500 total", () => {
  const ev = { houseBpsOfPool: 1100, reserveBpsOfPool: 400 };
  assert.deepStrictEqual(refill.refillBps(ev, false), { houseBpsOfPool: 1100, reserveBpsOfPool: 400 });
  const on = refill.refillBps(ev, true);
  assert.deepStrictEqual(on, { houseBpsOfPool: 900, reserveBpsOfPool: 600 });
  assert.strictEqual(on.houseBpsOfPool + on.reserveBpsOfPool, 1500);
});

t("public summary publishes the rule + credit, and its math follows the mode in force", () => {
  const cfg = buyin.loadConfig();
  const ledger = { entries: [] };
  const dormant = buyin.buildPublicSummary(cfg, ledger, "buy-in-1", {
    reserveState: { balance: 4.2, refill: refill.defaultRefill() },
  });
  assert.strictEqual(dormant.reserveRule.refillActive, false);
  assert.deepStrictEqual([dormant.reserveRule.splitInForce.house, dormant.reserveRule.splitInForce.reserve], [11, 4]);
  assert.ok(dormant.reserveRule.text.includes("below $2.00"), "trigger in published text");
  assert.ok(dormant.reserveRule.text.includes("11/4 → 9/6"), "shift in published text");
  assert.ok(dormant.reserveRule.text.includes("at or above $2.00"), "revert in published text");
  assert.strictEqual(dormant.reserveRule.credit, "Reserve refill rule — adopted 2026-10-12 from a design critique by holocene.");
  // 0 seats: guarantee tops the pool to $2.00; base split -> house .22 / reserve .08
  assert.deepStrictEqual([dormant.math.rakeHouse, dormant.math.rakeReserve], [0.22, 0.08]);
  const armedState = { balance: 1.4, refill: { ...refill.defaultRefill(), active: true } };
  const armed = buyin.buildPublicSummary(cfg, ledger, "buy-in-1", { reserveState: armedState });
  assert.strictEqual(armed.reserveRule.refillActive, true);
  assert.deepStrictEqual([armed.reserveRule.splitInForce.house, armed.reserveRule.splitInForce.reserve], [9, 6]);
  assert.deepStrictEqual([armed.math.rakeHouse, armed.math.rakeReserve], [0.18, 0.12]);
  assert.ok(armed.workedExample.some((l) => l.includes("Reserve Refill Rule in force")), "worked example flags the shifted split");
});

t("engine wiring: arena.js loads the refill module and seeds dormant refill state", () => {
  assert.ok(arena.__test.refill, "arena.js resolved arena-refill.js");
  assert.strictEqual(arena.__test.refill.REFILL_THRESHOLD_USD, 2);
  const seeded = arena.__test.seedReserve();
  assert.ok(seeded.refill, "seeded journal carries the refill block");
  assert.strictEqual(seeded.refill.active, false);
  assert.strictEqual(seeded.refill.credit, refill.REFILL_CREDIT);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
