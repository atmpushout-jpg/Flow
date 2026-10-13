/**
 * FLOW ARENA — RESERVE REFILL RULE (adopted 2026-10-12).
 *
 * The hole, as spotted by holocene on the Buy-In #1 announcement thread:
 * the stabilization reserve takes a flat 4 of the 15 rake points, but no
 * rule raised that rate when the balance ran low — in a low-participation
 * stretch the reserve could sit drained while claims kept priority.
 *
 * The rule (deterministic, published in advance, no discretion):
 *   If the reserve ENDS an event (prime-time match or buy-in table) with
 *   a balance below $2.00, the NEXT event's rake split shifts 2 points
 *   from house to reserve — 11/4 becomes 9/6 (percent of pool; the total
 *   rake stays 15%) — and stays shifted until an event ends with the
 *   reserve back at or above $2.00, when it reverts to 11/4.
 *   Exactly $2.00 is NOT below the threshold: no shift.
 *
 * State lives in the reserve journal (offchain/arena-reserve.json) under
 * `refill`. The split for an event is computed from the journal state at
 * that event's start; the event-end evaluation (after that event's inflow
 * and claims settle) is what arms or clears the mode for the next event.
 *
 * Credit: "Reserve refill rule — adopted 2026-10-12 from a design critique
 * by holocene." (ARENA_V2_ECONOMICS.md §8.)
 *
 * This module is pure functions over a journal object — IO stays with the
 * callers (arena.js owns the journal file; arena-buyin.js stays pure).
 */

const REFILL_THRESHOLD_USD = 2.0;
const REFILL_SHIFT_POINTS = 2; // percentage points of pool, house -> reserve
const NORMAL_SPLIT = { house: 11, reserve: 4 }; // percent of pool
const REFILL_SPLIT = { house: 9, reserve: 6 }; // percent of pool
const RAKE_TOTAL_POINTS = 15;
const REFILL_CREDIT =
  "Reserve refill rule — adopted 2026-10-12 from a design critique by holocene.";
const REFILL_RULE_TEXT =
  "Reserve refill rule: if the stabilization reserve ends an event below $2.00, " +
  "the next event's rake split shifts 2 points from house to reserve (11/4 → 9/6 " +
  "of the pool; total rake stays 15%) and stays shifted until an event ends with " +
  "the reserve back at or above $2.00, when it reverts to 11/4. Deterministic, " +
  "published in advance, no discretion. " +
  REFILL_CREDIT;

const centsOf = (usd) => Math.round(Number(usd) * 100);

/** The refill block as seeded into a fresh reserve journal (dormant). */
function defaultRefill() {
  return {
    rule: "RESERVE_REFILL",
    thresholdUsd: REFILL_THRESHOLD_USD,
    shiftPoints: REFILL_SHIFT_POINTS,
    normalSplit: { ...NORMAL_SPLIT },
    refillSplit: { ...REFILL_SPLIT },
    active: false,
    sinceEventId: null,
    lastEvaluatedEventId: null,
    lastEvaluatedBalance: null,
    credit: REFILL_CREDIT,
  };
}

/**
 * Migration: journals written before the rule have no `refill` block.
 * Add a dormant one — adoption never retroactively arms the mode; the
 * first event-end evaluation after adoption sets it from a real balance.
 */
function ensureRefill(journal) {
  if (!journal.refill || typeof journal.refill !== "object") {
    journal.refill = defaultRefill();
  }
  return journal.refill;
}

/** Split (points of pool) in force for an event starting NOW. */
function splitPointsFor(journal) {
  const rf = ensureRefill(journal);
  const split = rf.active ? REFILL_SPLIT : NORMAL_SPLIT;
  return { total: RAKE_TOTAL_POINTS, house: split.house, reserve: split.reserve, refillActive: !!rf.active };
}

/**
 * Event-end evaluation. Call AFTER the event's inflow and claims have
 * settled, with the journal's final balance for that event. Arms the mode
 * when the balance is below the threshold; clears it at or above.
 * Returns { active, flipped, balance } — the caller journals a flip.
 */
function evaluateRefill(journal, eventId) {
  const rf = ensureRefill(journal);
  const below = centsOf(journal.balance) < centsOf(rf.thresholdUsd ?? REFILL_THRESHOLD_USD);
  const flipped = below !== !!rf.active;
  rf.active = below;
  if (below && flipped) rf.sinceEventId = eventId || null;
  if (!below) rf.sinceEventId = null;
  rf.lastEvaluatedEventId = eventId || null;
  rf.lastEvaluatedBalance = journal.balance;
  return { active: below, flipped, balance: journal.balance };
}

/** Buy-in surface: bps of pool for an event config under the refill mode. */
function refillBps(ev, refillActive) {
  if (!refillActive) {
    return { houseBpsOfPool: ev.houseBpsOfPool, reserveBpsOfPool: ev.reserveBpsOfPool };
  }
  const shiftBps = REFILL_SHIFT_POINTS * 100;
  return {
    houseBpsOfPool: ev.houseBpsOfPool - shiftBps,
    reserveBpsOfPool: ev.reserveBpsOfPool + shiftBps,
  };
}

/** Published rule block for public summaries (arena-buyin.json etc.). */
function publicRule(refillState) {
  const rf = refillState && refillState.refill ? refillState.refill : null;
  const active = !!(rf && rf.active);
  const split = active ? REFILL_SPLIT : NORMAL_SPLIT;
  return {
    rule: "RESERVE_REFILL",
    text: REFILL_RULE_TEXT,
    credit: REFILL_CREDIT,
    thresholdUsd: REFILL_THRESHOLD_USD,
    normalSplit: { ...NORMAL_SPLIT },
    refillSplit: { ...REFILL_SPLIT },
    refillActive: active,
    splitInForce: { total: RAKE_TOTAL_POINTS, house: split.house, reserve: split.reserve },
    reserveBalance: refillState && typeof refillState.balance === "number" ? refillState.balance : null,
  };
}

module.exports = {
  REFILL_THRESHOLD_USD,
  REFILL_SHIFT_POINTS,
  NORMAL_SPLIT,
  REFILL_SPLIT,
  RAKE_TOTAL_POINTS,
  REFILL_CREDIT,
  REFILL_RULE_TEXT,
  defaultRefill,
  ensureRefill,
  splitPointsFor,
  evaluateRefill,
  refillBps,
  publicRule,
};
