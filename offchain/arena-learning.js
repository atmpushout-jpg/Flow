/**
 * Flow Arena — fighter learning v1 (offchain/arena-learning.js)
 *
 * Atm's directive (2026-10-12): the cast must LEARN between matches.
 * Character, voice and strategic identity stay fixed — "same gravity" —
 * but each fighter's strategy PARAMETERS adapt from their own recorded
 * evidence, so the field tightens and rankings rotate instead of the
 * same winner and losers every week. FADE learns too. Nobody is static.
 *
 * Design rules (the anti-black-box contract):
 *  - Every tunable knob lives inside hard persona bounds. FADE stays a
 *    patient contrarian, VEX stays aggressive — the bounds ARE the
 *    character. Learning can only move a knob inside its fence.
 *  - Every rule is a named, deterministic if/then over recorded
 *    evidence (prize per data cent, winless spend, cap refusals,
 *    zero-trade events, call accuracy). One bounded step per rule per
 *    training pass. No gradients, no randomness, no hidden state.
 *  - EVERY adjustment is logged: {fighter, rule, knob, from, to,
 *    evidence}. If it isn't in the log, it didn't happen.
 *  - Learning is TRAINING, openly logged — the fairness charter's own
 *    terms. In the ring nothing changes: same tape, same prices, same
 *    $0.60 data cap for everyone. Params are published before a match,
 *    never adjusted during one.
 *  - FLOWX is EXHIBITION-ONLY (owner decision, 2026-10-12): it stays in
 *    the exhibition/floor training pool and is never seated in title
 *    matches, so it has no knobs here.
 *
 * Balance rules v1.1 (Atm directive, 2026-10-13 — "fix it", after FADE
 * won four straight counted matches and all four exhibitions in a night):
 *  - CATCH-UP ASYMMETRY: a fighter with no counted prize learns at
 *    DOUBLE step size (stepMult 2, computed in aggregate()); anyone with
 *    a counted prize — the reigning winner included — stays at the
 *    standard step, which is therefore the smallest step in the field.
 *    Bounded by the same persona fences; the multiplier is recorded in
 *    every adjustment's log entry.
 *  - V-ACT verified-no-convert: accuracy without conversion is treated
 *    as an acting problem, not a caution problem (VEX).
 *  - META-4 burn-discipline: the field's worst winless burner gets
 *    discipline at double step on its data-appetite knob (replacing
 *    META-2 for that fighter) plus, for AUDREY, a verdict-floor step.
 *  Nothing here touches entry prices, rake, payouts, data prices, the
 *  tape, or any character — rotation pressure comes only from how fast
 *  each fighter's own knobs learn, in the open, in the log.
 *
 * Evidence sources (all read-only):
 *  - Counted matches 1-4: arena-match-report.json (M1),
 *    arena-live-evidence-arena-match-2.json (M2 state),
 *    arena-live-report.match3.bak.json (M3), arena-live-report.json (M4).
 *    Prize / efficiency evidence comes from counted matches ONLY — the
 *    standings file's own doctrine (exhibitions are training-valid but
 *    never quoted as counted competitive record).
 *  - Floor exhibitions 1-3: floor/rounds/floor-round-*.state.json —
 *    behavioral evidence (spend patterns, zero-trade events, refusals).
 *  - Call accuracy: floor/training/accuracy.json (the corpus tallies).
 *
 * Usage:
 *   node arena-learning.js learn       one pass over the full corpus
 *   node arena-learning.js trajectory  pass after each recorded event
 *   node arena-learning.js simulate    static vs learned on recorded tapes
 *   node arena-learning.js all         all of the above + RESULTS.md
 *
 * Outputs land in the goal's hidden_files (proof artifacts), never in
 * production paths. Production arena files are NOT modified by this
 * module — a cutover is a separate, reviewed step (see arena-learning.md).
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const OUT_DIR = path.join(
  DIR, "..", "..", "goals", "order-flow-auction-protocol-on-base",
  "hidden_files", "arena-learning-2026-10-12"
);

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// 1. KNOBS — per-fighter tunable parameters, fenced by persona bounds.
//    `def` is the production value, taken verbatim from the literals in
//    offchain/arena.js (actVex / actAudrey / actEcho / actFade /
//    actLongshot / actRook / runScramble). `step` is the largest move one
//    rule may make in one training pass.
// ---------------------------------------------------------------------------
const KNOBS = {
  vex: {
    identity: "Momentum degen — chases spikes, re-quotes his book, never buys a verdict.",
    knobs: {
      requoteCount:    { def: 3,  min: 1,   max: 3,   step: 1,   unit: "positions", label: "Book re-quotes per round (his data-burning ritual)" },
      spikeEntryScore: { def: 15, min: 10,  max: 25,  step: 2,   unit: "score",     label: "Minimum spike score to enter" },
      entrySizePct:    { def: 40, min: 20,  max: 50,  step: 5,   unit: "% of cash", label: "Entry size" },
      exitSpikeFloor:  { def: 8,  min: 4,   max: 12,  step: 1,   unit: "score",     label: "Dump a position when its spike fades below" },
    },
  },
  audrey: {
    identity: "Verdict-first auditor — no trade without a clean verdict, re-verifies holdings.",
    knobs: {
      candidatesScanned:  { def: 3,  min: 1,  max: 3,  step: 1,   unit: "candidates", label: "Candidates quote+verdict-scanned per round ($0.03 each)" },
      verdictScoreFloor:  { def: 70, min: 60, max: 85, step: 5,   unit: "score",      label: "Minimum verdict score to buy a verified token" },
      entrySizePct:       { def: 15, min: 10, max: 25, step: 2.5, unit: "% of cash",  label: "Entry size" },
      reverifyEveryRounds:{ def: 3,  min: 2,  max: 5,  step: 1,   unit: "rounds",     label: "Re-verify a holding every N rounds ($0.02 each)" },
    },
  },
  echo: {
    identity: "Copycat — follows fresh smart-wallet buy signals, exits when the echo fades.",
    knobs: {
      signalMaxAgeSec: { def: 900, min: 300, max: 1800, step: 300, unit: "seconds",   label: "Oldest signal she will still copy" },
      entrySizePct:    { def: 25,  min: 15,  max: 35,   step: 5,   unit: "% of cash", label: "Entry size" },
      holdRounds:      { def: 3,   min: 2,   max: 5,    step: 1,   unit: "rounds",    label: "Scheduled exit after N rounds held" },
    },
  },
  fade: {
    identity: "Contrarian — fades spikes, buys the coldest token, sells into strength.",
    knobs: {
      sellFullPct:  { def: 5,   min: 3.5, max: 7, step: 0.5,  unit: "% gain",    label: "Full exit at this gain" },
      sellHalfPct:  { def: 2.5, min: 1.5, max: 4, step: 0.5,  unit: "% gain",    label: "Half exit at this gain (must stay below sellFullPct)" },
      entrySizePct: { def: 30,  min: 20,  max: 40, step: 5,    unit: "% of cash", label: "Entry size" },
      maxPositions: { def: 3,   min: 2,   max: 4, step: 1,    unit: "positions", label: "Most cold positions held at once" },
    },
  },
  longshot: {
    identity: "Sniper — silent for rounds, then one or two large patient bets on deep-liquidity momentum.",
    knobs: {
      spikeEntryScore: { def: 15, min: 11, max: 20, step: 2, unit: "score",     label: "Minimum spike score to consider a shot" },
      shotsPerMatch:   { def: 2,  min: 1,  max: 3,  step: 1, unit: "shots",     label: "Shots allowed per match" },
      entrySizePct:    { def: 65, min: 45, max: 75, step: 5, unit: "% of cash", label: "Shot size (his identity — size was never his problem)" },
      exitPct:         { def: 3,  min: 2,  max: 5,  step: 0.5, unit: "% gain",  label: "Exit a shot at this gain" },
      lateGateRounds:  { def: 3,  min: 2,  max: 5,  step: 1, unit: "rounds",    label: "Final N rounds where a shot no longer needs deep liquidity" },
    },
  },
  rook: {
    identity: "Balanced rookie — playbook: quote everything, verdict before any new token, cut losers on schedule.",
    knobs: {
      stopLossPct:       { def: 3,  min: 2,  max: 5,  step: 0.5, unit: "% loss",    label: "Cut a loser at this loss" },
      takeProfitPct:     { def: 4,  min: 3,  max: 6,  step: 0.5, unit: "% gain",    label: "Bank a winner at this gain" },
      entrySizePct:      { def: 20, min: 15, max: 30, step: 2.5, unit: "% of cash", label: "Entry size" },
      signalsCheckEvery: { def: 3,  min: 2,  max: 4,  step: 1,   unit: "rounds",    label: "Buy a signals board-check every N rounds ($0.01)" },
      maxPositions:      { def: 3,  min: 2,  max: 3,  step: 1,   unit: "positions", label: "Most positions held at once" },
    },
  },
};

const FIGHTERS = Object.keys(KNOBS);

function defaultParams() {
  const p = {};
  for (const f of FIGHTERS) {
    p[f] = {};
    for (const [k, spec] of Object.entries(KNOBS[f].knobs)) p[f][k] = spec.def;
  }
  return p;
}

function cloneParams(p) { return JSON.parse(JSON.stringify(p)); }

// ---------------------------------------------------------------------------
// 2. EVIDENCE — extracted from the recorded corpus. Nothing here is
//    estimated: every number traces to a published receipt or state file.
// ---------------------------------------------------------------------------
function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf8")); }
  catch { return null; }
}

// Normalize one event's per-agent rows: { id: {spend,trades,pnl,refusals,payout} }
function rowsFromReceipts(report) {
  const out = {};
  for (const a of (report && report.receipts && report.receipts.perAgent) || []) {
    out[a.agent.toLowerCase()] = {
      spend: a.dataSpend || 0, trades: a.trades || 0, pnl: a.realizedPnl || 0,
      refusals: a.capRefusals || 0, payout: a.payout || 0,
    };
  }
  return out;
}
function rowsFromState(state) {
  const out = {};
  for (const [id, a] of Object.entries((state && state.agents) || {})) {
    out[id] = {
      spend: a.dataSpend || 0, trades: a.trades || 0, pnl: a.realizedPnl || 0,
      refusals: a.capRefusals || 0, payout: a.payout || 0,
    };
  }
  return out;
}
function ranksFromReport(report, rows) {
  const lb = (report && report.leaderboard) || [];
  const rank = {};
  for (const r of lb) rank[r.agentId] = r.rank;
  if (!Object.keys(rank).length) {
    const sorted = Object.entries(rows)
      .map(([id, r]) => [id, (r.payout || 0) * 1000 + (r.pnl || 0) - (r.spend || 0)])
      .sort((a, b) => b[1] - a[1]);
    sorted.forEach(([id], i) => { rank[id] = i + 1; });
  }
  return rank;
}

function loadEvents() {
  const events = [];
  const push = (matchId, klass, date, rows, ranks, note) =>
    events.push({ matchId, klass, date, rows, ranks, note: note || null });

  const m1 = readJson("arena-match-report.json");
  if (m1) push("arena-match-1", "OFFICIAL", "2026-10-11", rowsFromReceipts(m1), ranksFromReport(m1, rowsFromReceipts(m1)));

  const m2 = readJson("arena-live-evidence-arena-match-2.json");
  if (m2) push("arena-match-2", "OFFICIAL", "2026-10-11", rowsFromState(m2), ranksFromReport(m2, rowsFromState(m2)));

  const m3 = readJson("arena-live-report.match3.bak.json");
  if (m3) push("arena-match-3", "OFFICIAL", "2026-10-11", rowsFromReceipts(m3), ranksFromReport(m3, rowsFromReceipts(m3)));

  for (const n of ["0001", "0002", "0003"]) {
    const st = readJson(path.join("floor", "rounds", `floor-round-${n}.state.json`));
    if (st) push(`floor-round-${n}`, "EXHIBITION", "2026-10-12", rowsFromState(st), ranksFromReport(st, rowsFromState(st)),
      "Floor exhibition (6-round game) — behavioral evidence only, never counted.");
  }

  // The latest counted match: arena-live.js overwrites arena-live-report.json
  // on every title match, so the report's own `match` field is its true id.
  // (Before the learning cutover this block was hardcoded to arena-match-4 —
  // behavior is identical while the live report IS Match 4.) Once a newer
  // report overwrites it, Match 4 still enters from its preserved evidence
  // state file, so no counted match is lost or double-counted — this is what
  // lets the engine's post-match training pass read the updated record.
  const m4state = readJson("arena-live-evidence-arena-match-4.json");
  const m4 = readJson("arena-live-report.json");
  const latestId = (m4 && m4.match) || "arena-match-4";
  if (m4 && latestId === "arena-match-4") {
    const note = m4state && (m4state.feed || []).some((e) => e.type === "ERROR" && e.agentId === "longshot")
      ? "LONGSHOT's Match 4 spend is contaminated by a data-source fault (14 ERROR events — his brain threw before it could trade). His zero-trade signal is read from Matches 1-3 + floor, not from this spend figure."
      : null;
    push("arena-match-4", "OFFICIAL", "2026-10-12", rowsFromReceipts(m4), ranksFromReport(m4, rowsFromReceipts(m4)), note);
  } else if (m4) {
    if (m4state) push("arena-match-4", "OFFICIAL", "2026-10-12", rowsFromState(m4state), ranksFromReport(m4state, rowsFromState(m4state)));
    const latestState = readJson(`arena-live-evidence-${latestId}.json`);
    const errs = latestState ? (latestState.feed || []).filter((e) => e.type === "ERROR" && e.agentId === "longshot").length : 0;
    const note = errs
      ? `LONGSHOT's ${latestId} spend may be contaminated by a data-source fault (${errs} ERROR events — his brain threw before it could trade). Read his zero-trade signal for this match with that caveat.`
      : null;
    const date = latestState && latestState.startedAt ? String(latestState.startedAt).slice(0, 10) : "unknown";
    push(latestId, "OFFICIAL", date, rowsFromReceipts(m4), ranksFromReport(m4, rowsFromReceipts(m4)), note);
  }
  return events;
}

function loadAccuracy() {
  const acc = readJson(path.join("floor", "training", "accuracy.json"));
  const out = {};
  for (const f of FIGHTERS) {
    const a = acc && acc.fighters && acc.fighters[f];
    out[f] = a ? { calls: a.calls || 0, accuracy: a.accuracy, dataPerRound: a.dataPerRound } : { calls: 0, accuracy: null };
  }
  return out;
}

// Aggregate an evidence snapshot from a list of events (cumulative).
function aggregate(events, accuracy) {
  const ev = {};
  for (const f of FIGHTERS) {
    ev[f] = {
      counted: { matches: 0, wins: 0, podiums: 0, prize: 0, spend: 0, trades: 0, pnl: 0, winlessSpend: 0, prizePerCent: 0, spendPerMatch: 0, podiumRate: 0 },
      all: { events: 0, spend: 0, trades: 0, pnl: 0, refusals: 0, winlessSpend: 0, zeroTradeEvents: 0 },
      accuracy: accuracy[f],
    };
  }
  for (const e of events) {
    for (const f of FIGHTERS) {
      const r = e.rows[f]; if (!r) continue;
      const A = ev[f].all;
      A.events++; A.spend = round2(A.spend + r.spend); A.trades += r.trades; A.pnl = round2(A.pnl + r.pnl);
      A.refusals += r.refusals; if (r.payout <= 0) A.winlessSpend = round2(A.winlessSpend + r.spend);
      if (r.trades === 0) A.zeroTradeEvents++;
      if (e.klass === "OFFICIAL") {
        const C = ev[f].counted;
        C.matches++; C.prize = round2(C.prize + r.payout); C.spend = round2(C.spend + r.spend);
        C.trades += r.trades; C.pnl = round2(C.pnl + r.pnl);
        if (r.payout > 0 && e.ranks[f] === 1) C.wins++;
        if (r.payout > 0) C.podiums++; else C.winlessSpend = round2(C.winlessSpend + r.spend);
      }
    }
  }
  for (const f of FIGHTERS) {
    const C = ev[f].counted;
    C.prizePerCent = C.spend > 0 ? round2(C.prize / (C.spend * 100)) : 0; // $ of prize per cent of data
    C.spendPerMatch = C.matches ? round2(C.spend / C.matches) : 0;
    C.podiumRate = C.matches ? round2(C.podiums / C.matches) : 0;
  }
  // field context for relative rules
  const efficiencies = FIGHTERS.map((f) => ev[f].counted.prizePerCent);
  const winlessSpends = FIGHTERS.filter((f) => ev[f].counted.prize === 0).map((f) => ev[f].counted.spend);
  const maxWinlessSpend = winlessSpends.length ? Math.max(...winlessSpends) : 0;
  for (const f of FIGHTERS) {
    const C = ev[f].counted;
    ev[f].field = { maxPrizePerCent: Math.max(...efficiencies), maxWinlessSpend };
    // CATCH-UP ASYMMETRY (balance rules v1.1): winless fighters learn at
    // double step; prize-winners — the reigning winner included — stay
    // at the standard step, the smallest in the field.
    ev[f].stepMult = C.matches >= 2 && C.prize === 0 ? 2 : 1;
    // BURN DISCIPLINE target: zero counted prizes on the field's highest
    // counted data spend — the worst spend-per-prize record there is.
    ev[f].worstBurner = C.matches >= 2 && C.prize === 0 && C.spend > 0 && C.spend >= maxWinlessSpend;
  }
  return ev;
}

// ---------------------------------------------------------------------------
// 3. RULES — named, deterministic, one bounded step per rule per pass
//    (a step may be multiplied by the fighter's catch-up stepMult — see
//    aggregate() — but it is still ONE rule application, clamped at the
//    same persona bounds, and the multiplier is logged with it).
//    A rule reads ONLY the fighter's own recorded evidence. Directions are
//    fixed per rule (a rule never reverses itself), so repeated passes
//    converge at the persona bounds instead of oscillating.
//    Every knob has exactly ONE rule that can move it, except the
//    meta-rules whose per-fighter knob mapping is disjoint by design —
//    META-4 shares META-2's appetite-knob map but their fire conditions
//    are disjoint (META-2 skips the fighter META-4 handles), so no knob
//    is ever stepped by two rules for the same fighter in one pass.
// ---------------------------------------------------------------------------
function step(fighter, params, log, rule, knob, dir, evidence, mult = 1) {
  const spec = KNOBS[fighter].knobs[knob];
  const from = params[fighter][knob];
  const to = clamp(round2(from + dir * spec.step * mult), spec.min, spec.max);
  // FADE invariant: the half-exit must stay below the full exit.
  if (fighter === "fade" && knob === "sellHalfPct" && to >= params.fade.sellFullPct - 1) return;
  if (to === from) return; // already at the persona bound — converged, nothing to log
  params[fighter][knob] = to;
  log.push({ fighter, rule, knob, from, to, evidence, stepMult: mult });
}

const RULES = [
  {
    id: "META-1 efficiency-press",
    plain: "Proven efficiency earns a slightly bigger size: prize per data cent >= $0.50 over >= 3 counted matches -> entry size +1 step.",
    fires: (f, e) => e.counted.matches >= 3 && e.counted.prizePerCent >= 0.5,
    evidence: (e) => ({ countedMatches: e.counted.matches, prizePerCent: e.counted.prizePerCent, countedPrize: e.counted.prize, countedSpend: e.counted.spend }),
    apply: (f, e, p, log) => step(f, p, log, "META-1 efficiency-press", "entrySizePct", +1, RULES[0].evidence(e), e.stepMult || 1),
  },
  {
    id: "META-2 winless-burn",
    plain: "Zero counted prizes while burning >= $0.75 of data across all events -> the fighter's data-discipline knob tightens 1 step (VEX re-quotes less, AUDREY scans fewer candidates, ECHO copies only fresher signals, ROOK sizes down). LONGSHOT and FADE are exempt: FADE never burns, LONGSHOT's problem is the opposite (see L-FIRE). The field's single worst winless burner is exempt here too — META-4 burn-discipline handles that fighter at double step instead.",
    fires: (f, e) => ["vex", "audrey", "echo", "rook"].includes(f) && !e.worstBurner && e.counted.prize === 0 && e.all.winlessSpend >= 0.75,
    evidence: (e) => ({ countedPrize: e.counted.prize, winlessSpendAllEvents: e.all.winlessSpend, spendAllEvents: e.all.spend }),
    apply: (f, e, p, log) => {
      const knob = { vex: "requoteCount", audrey: "candidatesScanned", echo: "signalMaxAgeSec", rook: "entrySizePct" }[f];
      step(f, p, log, "META-2 winless-burn", knob, -1, RULES[1].evidence(e), e.stepMult || 1);
    },
  },
  {
    id: "META-3 cap-pressure",
    plain: ">= 5 career cap refusals -> stop paying to re-check so often: re-verification cadence +1 round (AUDREY is the only fighter with a re-verify knob — and the only one who has ever hit the cap).",
    fires: (f, e) => !!KNOBS[f].knobs.reverifyEveryRounds && e.all.refusals >= 5,
    evidence: (e) => ({ capRefusalsAllEvents: e.all.refusals }),
    apply: (f, e, p, log) => step(f, p, log, "META-3 cap-pressure", "reverifyEveryRounds", +1, RULES[2].evidence(e), e.stepMult || 1),
  },
  {
    id: "V-ENTRY verified-but-winless",
    plain: "VEX only: his spike calls verify (accuracy >= 0.75 on >= 5 calls) yet he has no prize — the calls were real, the exits were worthless. Hold through shallow fades: exit spike floor -1 step.",
    fires: (f, e) => f === "vex" && e.accuracy.calls >= 5 && e.accuracy.accuracy != null && e.accuracy.accuracy >= 0.75 && e.counted.prize === 0 && e.counted.trades >= 3,
    evidence: (e) => ({ calls: e.accuracy.calls, accuracy: e.accuracy.accuracy, countedPrize: e.counted.prize, countedTrades: e.counted.trades }),
    apply: (f, e, p, log) => step(f, p, log, "V-ENTRY verified-but-winless", "exitSpikeFloor", -1, RULES[3].evidence(e), e.stepMult || 1),
  },
  {
    id: "A-SCORE call-quality",
    plain: "AUDREY only: worst call accuracy in the field (< 0.70 on >= 10 calls) -> demand cleaner verdicts before buying: verdict score floor +1 step. Costs no extra data.",
    fires: (f, e) => f === "audrey" && e.accuracy.calls >= 10 && e.accuracy.accuracy != null && e.accuracy.accuracy < 0.70,
    evidence: (e) => ({ calls: e.accuracy.calls, accuracy: e.accuracy.accuracy }),
    apply: (f, e, p, log) => step(f, p, log, "A-SCORE call-quality", "verdictScoreFloor", +1, RULES[4].evidence(e), e.stepMult || 1),
  },
  {
    id: "E-AGE stale-copy",
    plain: "ECHO only: podiumed but inefficient (prize per cent < $0.25, spend already lean) -> the copies are stale, not costly: only copy fresher money, signal max age -1 step.",
    fires: (f, e) => f === "echo" && e.counted.matches >= 3 && e.counted.prizePerCent < 0.25 && e.counted.spendPerMatch <= 0.20,
    evidence: (e) => ({ countedMatches: e.counted.matches, prizePerCent: e.counted.prizePerCent, spendPerMatch: e.counted.spendPerMatch }),
    apply: (f, e, p, log) => step(f, p, log, "E-AGE stale-copy", "signalMaxAgeSec", -1, RULES[5].evidence(e), e.stepMult || 1),
  },
  {
    id: "F-RUN let-it-run",
    plain: "FADE only: field-best efficiency with a near-zero data bill -> patience is paying, so let strength run a touch longer before trimming: full-exit and half-exit thresholds +1 step each. His cold-buy discipline does not move.",
    fires: (f, e) => f === "fade" && e.counted.matches >= 2 && e.counted.prizePerCent >= e.field.maxPrizePerCent && e.counted.prizePerCent > 0 && e.counted.spendPerMatch <= 0.10,
    evidence: (e) => ({ prizePerCent: e.counted.prizePerCent, fieldMaxPrizePerCent: e.field.maxPrizePerCent, spendPerMatch: e.counted.spendPerMatch }),
    apply: (f, e, p, log) => {
      step(f, p, log, "F-RUN let-it-run", "sellFullPct", +1, RULES[6].evidence(e), e.stepMult || 1);
      step(f, p, log, "F-RUN let-it-run", "sellHalfPct", +1, RULES[6].evidence(e), e.stepMult || 1);
    },
  },
  {
    id: "L-FIRE never-fired",
    plain: "LONGSHOT only: >= 2 events with zero trades — his gates never all align at his check moments. Loosen the trigger, not the size: entry spike score -1 step, and the late-match window where a shot needs no deep liquidity +1 round.",
    fires: (f, e) => f === "longshot" && e.all.zeroTradeEvents >= 2,
    evidence: (e) => ({ zeroTradeEvents: e.all.zeroTradeEvents, events: e.all.events, careerTrades: e.all.trades }),
    apply: (f, e, p, log) => {
      step(f, p, log, "L-FIRE never-fired", "spikeEntryScore", -1, RULES[7].evidence(e), e.stepMult || 1);
      step(f, p, log, "L-FIRE never-fired", "lateGateRounds", +1, RULES[7].evidence(e), e.stepMult || 1);
    },
  },
  {
    id: "L-SHOTS more-shots",
    plain: "LONGSHOT only: >= 3 zero-trade events and zero career trades — one or two chances a match is not enough surface area for a sniper whose trigger loosened: shots per match +1 step.",
    fires: (f, e) => f === "longshot" && e.all.zeroTradeEvents >= 3 && e.all.trades === 0,
    evidence: (e) => ({ zeroTradeEvents: e.all.zeroTradeEvents, careerTrades: e.all.trades }),
    apply: (f, e, p, log) => step(f, p, log, "L-SHOTS more-shots", "shotsPerMatch", +1, RULES[8].evidence(e), e.stepMult || 1),
  },
  {
    id: "R-CHECK feed-the-playbook",
    plain: "ROOK only: podium rate >= 75% on a lean data bill (<= $0.12/match) -> the playbook works, feed it slightly more information: signals board-check every 2 rounds instead of 3.",
    fires: (f, e) => f === "rook" && e.counted.matches >= 3 && e.counted.podiumRate >= 0.75 && e.counted.spendPerMatch <= 0.12,
    evidence: (e) => ({ podiumRate: e.counted.podiumRate, spendPerMatch: e.counted.spendPerMatch, countedPrize: e.counted.prize }),
    apply: (f, e, p, log) => step(f, p, log, "R-CHECK feed-the-playbook", "signalsCheckEvery", -1, RULES[9].evidence(e), e.stepMult || 1),
  },
  {
    id: "V-ACT verified-no-convert",
    plain: "VEX only (balance rule v1.1, 2026-10-13): his spike calls verify (accuracy >= 0.75 on >= 5 calls) and he does trade, yet converts none of it into a counted prize — accuracy without conversion. The prescription is the opposite of caution: act on more of the calls he already gets right. Entry spike score -1 step (doubled by his catch-up multiplier while he stays winless).",
    fires: (f, e) => f === "vex" && e.accuracy.calls >= 5 && e.accuracy.accuracy != null && e.accuracy.accuracy >= 0.75 && e.counted.prize === 0 && e.counted.trades >= 3,
    evidence: (e) => ({ calls: e.accuracy.calls, accuracy: e.accuracy.accuracy, countedPrize: e.counted.prize, countedTrades: e.counted.trades }),
    apply: (f, e, p, log) => step(f, p, log, "V-ACT verified-no-convert", "spikeEntryScore", -1, RULES[10].evidence(e), e.stepMult || 1),
  },
  {
    id: "META-4 burn-discipline",
    plain: "Balance rule v1.1 (2026-10-13): the field's worst winless burner — zero counted prizes on the highest counted data spend in the field — gets discipline HARDER than the standard step: its data-appetite knob tightens 2 steps in one pass (this rule replaces META-2 for that fighter — META-2's fire condition excludes whoever META-4 handles, so the knob still has exactly one mover per pass). For AUDREY the verdict score floor also steps up 1: burn the most, win nothing, and you buy less data while demanding cleaner verdicts with what you still buy. Fighters with no appetite knob in the map (FADE — never a burner; LONGSHOT — his pathology is the opposite) take no appetite step here.",
    fires: (f, e) => !!e.worstBurner,
    evidence: (e) => ({ countedPrize: e.counted.prize, countedSpend: e.counted.spend, fieldMaxWinlessSpend: e.field.maxWinlessSpend, countedMatches: e.counted.matches }),
    apply: (f, e, p, log) => {
      const knob = { vex: "requoteCount", audrey: "candidatesScanned", echo: "signalMaxAgeSec", rook: "entrySizePct" }[f];
      if (knob) step(f, p, log, "META-4 burn-discipline", knob, -1, RULES[11].evidence(e), 2);
      // AUDREY's verdict floor: stepped here only when A-SCORE (the
      // floor's accuracy-pathology owner) is NOT firing this pass — the
      // two conditions stay disjoint, one mover per knob per pass. When
      // A-SCORE does fire for a winless AUDREY, its own step is already
      // doubled by her catch-up multiplier.
      const aScoreFiring = f === "audrey" && e.accuracy.calls >= 10 && e.accuracy.accuracy != null && e.accuracy.accuracy < 0.70;
      if (f === "audrey" && !aScoreFiring) step(f, p, log, "META-4 burn-discipline", "verdictScoreFloor", +1, RULES[11].evidence(e), 1);
    },
  },
];

// One training pass: evaluate every rule once per fighter, in fixed order.
function learnPass(evidence, baseParams) {
  const params = cloneParams(baseParams);
  const adjustments = [];
  for (const rule of RULES) {
    for (const f of FIGHTERS) {
      if (rule.fires(f, evidence[f])) rule.apply(f, evidence[f], params, adjustments);
    }
  }
  return { params, adjustments };
}

// Chronological trajectory: a pass after each recorded event, cumulative
// evidence. Accuracy-based rules (V-ENTRY, V-ACT, A-SCORE) read the corpus-final
// accuracy file — per-event accuracy history was never persisted — so
// they are evaluated only at the final step and say so in the log.
function trajectory(events, accuracy) {
  const params = defaultParams();
  const steps = [];
  events.forEach((e, i) => {
    const isLast = i === events.length - 1;
    const cumulative = aggregate(events.slice(0, i + 1), accuracy);
    const before = cloneParams(params);
    const log = [];
    for (const rule of RULES) {
      const accuracyRule = rule.id.startsWith("V-ENTRY") || rule.id.startsWith("V-ACT") || rule.id.startsWith("A-SCORE");
      if (accuracyRule && !isLast) continue;
      for (const f of FIGHTERS) {
        if (rule.fires(f, cumulative[f])) rule.apply(f, cumulative[f], params, log);
      }
    }
    steps.push({ afterEvent: e.matchId, klass: e.klass, adjustments: log, paramsAfter: cloneParams(params), changed: JSON.stringify(before) !== JSON.stringify(params) });
  });
  return steps;
}

// ---------------------------------------------------------------------------
// 4. SIMULATION — static params vs learned params on IDENTICAL recorded
//    boards. The brains below are faithful ports of arena.js's act*
//    functions with the knob literals replaced by parameters; accounting
//    (data prices, $0.60 cap, fills, liquidation, 50/30/20 payouts) is
//    the engine's own. Boards are reconstructed from the recorded
//    evidence feeds — approximations, disclosed in arena-learning.md:
//      - price marks: last recorded price per token per round, filled
//        forward/backward; untraded tokens have no path (brains can
//        quote them but fills use the nearest recorded mark);
//      - spike scores: scramble events + training-corpus decision
//        features; a token a spike-chaser actually bought implies a
//        spike >= 15 existed that round;
//      - verdicts: AUDREY's recorded PASS marks a token unsafe, every
//        other token defaults to safe/score 80 (unobserved);
//      - signals: the persisted end-of-match snapshot, all rounds;
//      - scramble rounds replay at their recorded rounds/tokens.
//    Both arms share the same boards and marks, so every difference in
//    outcome is attributable to the parameters alone.
// ---------------------------------------------------------------------------
function reconstructTape(state, matchId) {
  const feed = (state && state.feed) || [];
  const rounds = (state && state.totalRounds) || 14;
  const symbols = new Set(["WETH", "AERO"]);
  const addr2sym = {};
  for (const s of (state && state._signals) || []) if (s.token && s.symbol) addr2sym[String(s.token).toLowerCase()] = s.symbol;
  for (const e of feed) if (e.symbol) symbols.add(e.symbol);

  const rawMarks = {};
  for (const e of feed) if (e.price && e.symbol && e.round != null) (rawMarks[e.round] = rawMarks[e.round] || {})[e.symbol] = e.price;
  const firstKnown = {};
  for (let r = 1; r <= rounds; r++) for (const [s, p] of Object.entries(rawMarks[r] || {})) if (!(s in firstKnown)) firstKnown[s] = p;
  const marks = {}; let last = {};
  for (let r = 1; r <= rounds; r++) {
    last = { ...last, ...(rawMarks[r] || {}) };
    marks[r] = { ...last };
    for (const s of symbols) if (marks[r][s] == null && firstKnown[s] != null) marks[r][s] = firstKnown[s];
  }

  const spikes = {}; for (let r = 1; r <= rounds; r++) spikes[r] = {};
  const bump = (r, sym, score) => { if (score != null && r >= 1 && r <= rounds && (spikes[r][sym] == null || score > spikes[r][sym])) spikes[r][sym] = score; };
  for (const e of feed) if (e.type === "SCRAMBLE" && e.symbol) {
    const m = /score ([\d.]+)/.exec(e.line || ""); bump(e.round, e.symbol, m ? parseFloat(m[1]) : 15);
  }
  try {
    const dec = fs.readFileSync(path.join(DIR, "floor", "training", `decisions-${matchId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const d of dec) if (d.features && d.features.spikeScore != null && d.token) bump(d.round, d.token, d.features.spikeScore);
  } catch { /* prime-time matches have no decision file — feed-only spikes */ }
  for (const e of feed) if (e.type === "BUY" && (e.agentId === "vex" || e.agentId === "longshot") && e.symbol) bump(e.round, e.symbol, 15);

  const scrambles = feed.filter((e) => e.type === "SCRAMBLE")
    .map((e) => ({ round: e.round, symbol: e.symbol, score: parseFloat((/score ([\d.]+)/.exec(e.line || "") || [])[1]) || 15 }));

  const verdicts = {}; for (const s of symbols) verdicts[s] = { verdict: "safe", score: 80 };
  for (const e of feed) if (e.type === "PASS" && e.agentId === "audrey" && e.symbol) verdicts[e.symbol] = { verdict: "unsafe", score: null };

  // Deep liquidity: majors only. (An earlier draft inferred depth from
  // VEX's $20+ scramble buys — that was his sizing, not venue depth, and
  // it made LONGSHOT fire in the static arm where the real precheck had
  // kept him silent. Venue depth for unobserved tokens is unknowable
  // from the record, so the sim takes the conservative reading.)
  const deep = new Set(["WETH", "AERO"]);

  const signals = ((state && state._signals) || []).map((s) => ({
    token: s.symbol || addr2sym[String(s.token || "").toLowerCase()] || s.token,
    symbol: s.symbol, side: s.side, amountUsd: s.amountUsd || 0, stale: !!s.stale, ageSec: s.ageSec,
  }));

  return {
    matchId, rounds,
    universe: [...symbols].map((s) => ({ address: s, symbol: s })),
    marks, spikes, scrambles, verdicts, deep, signals,
  };
}

function runSim(tape, params) {
  const DATA_PRICES = { quote: 0.01, verdict: 0.02, signals: 0.01 };
  const DATA_CAP = 0.60, START_CASH = 95, ROUNDS = tape.rounds; // $100 treasury − $5 stake
  const agents = {};
  for (const f of FIGHTERS) agents[f] = { id: f, cash: START_CASH, dataSpend: 0, capRefusals: 0, positions: [], realizedPnl: 0, trades: 0, shotsFired: 0 };
  const rookChecked = new Set();
  let round = 0;
  const priceOf = (sym) => (tape.marks[round] || {})[sym];
  const payData = (agent, kind) => {
    const price = DATA_PRICES[kind];
    if (agent.dataSpend + price > DATA_CAP + 1e-9) { agent.capRefusals++; return { ok: false, price }; }
    agent.dataSpend = round2(agent.dataSpend + price); agent.cash = round2(agent.cash - price);
    return { ok: true, price };
  };
  const precheck = (sym) => {
    const v = tape.verdicts[sym] || { verdict: "safe", score: 80 };
    return { verdict: v.verdict, score: v.score, liquidity: tape.deep.has(sym) ? "deep" : "standard" };
  };
  function doBuy(agent, tok, usd) {
    const sym = tok.symbol || tok.address; const px = priceOf(sym);
    if (!px || usd <= 0 || agent.cash < usd) return false;
    agent.cash = round2(agent.cash - usd);
    agent.positions.push({ token: sym, symbol: sym, units: usd / px, entryPrice: px, costUsd: usd, entryRound: round });
    agent.trades++; return true;
  }
  function doSell(agent, pos, frac) {
    const px = priceOf(pos.token) || pos.entryPrice;
    const proceeds = pos.units * frac * px;
    agent.realizedPnl = round2(agent.realizedPnl + (proceeds - pos.costUsd * frac));
    agent.cash = round2(agent.cash + proceeds);
    pos.units *= (1 - frac); pos.costUsd = round2(pos.costUsd * (1 - frac));
    if (pos.units * px < 0.01) agent.positions = agent.positions.filter((p) => p !== pos);
    agent.trades++;
  }
  const ctxSpikes = () => Object.entries(tape.spikes[round] || {})
    .map(([sym, score]) => ({ token: sym, symbol: sym, score })).sort((a, b) => b.score - a.score);
  const ctx = () => ({ universe: tape.universe, spikes: ctxSpikes(), signals: tape.signals });

  const brains = {
    vex(agent) {
      const P = params.vex; payData(agent, "signals"); const top = ctx().spikes[0];
      for (const pos of [...agent.positions].slice(0, P.requoteCount)) { const q = payData(agent, "quote"); if (!q.ok) break; }
      if (top && top.score >= P.spikeEntryScore && !agent.positions.some((p) => p.token === top.token)) {
        payData(agent, "quote"); const usd = round2(agent.cash * P.entrySizePct / 100);
        if (usd >= 1) doBuy(agent, top, usd);
      }
      for (const pos of [...agent.positions]) {
        const sv = ctx().spikes.find((s) => s.token === pos.token);
        if (!sv || sv.score < P.exitSpikeFloor) doSell(agent, pos, 1);
      }
    },
    audrey(agent) {
      const P = params.audrey;
      if (round % P.reverifyEveryRounds === 0 && agent.positions.length) {
        const pos = agent.positions[0]; const v = payData(agent, "verdict");
        if (v.ok && precheck(pos.token).verdict !== "safe") { doSell(agent, pos, 1); return; }
      }
      const candidates = tape.universe.filter((t) => !agent.positions.some((p) => p.token === t.address));
      for (const tok of candidates.slice(0, P.candidatesScanned)) {
        const q = payData(agent, "quote"); if (!q.ok) return;
        const v = payData(agent, "verdict"); if (!v.ok) return;
        const pc = precheck(tok.address);
        if (pc.verdict === "safe" && (pc.score == null || pc.score >= P.verdictScoreFloor)) {
          const usd = round2(agent.cash * P.entrySizePct / 100);
          if (usd >= 1 && doBuy(agent, tok, usd)) return;
        }
      }
    },
    echo(agent) {
      const P = params.echo; const sig = payData(agent, "signals");
      if (sig.ok) {
        const fresh = tape.signals.filter((s) => s.side === "buy" && !s.stale && s.ageSec != null && s.ageSec < P.signalMaxAgeSec);
        const tally = {};
        for (const s of fresh) { const k = s.token; tally[k] = tally[k] || { token: s.token, symbol: s.symbol || s.token, total: 0 }; tally[k].total += s.amountUsd || 0; }
        const top = Object.values(tally).sort((a, b) => b.total - a.total)[0];
        if (top && !agent.positions.some((p) => p.token === top.token)) {
          payData(agent, "quote"); const usd = round2(agent.cash * P.entrySizePct / 100);
          if (usd >= 1 && doBuy(agent, { address: top.token, symbol: top.symbol }, usd)) return;
        }
        const sellSig = tape.signals.find((s) => s.side === "sell" && agent.positions.some((p) => p.token === s.token));
        if (sellSig) { doSell(agent, agent.positions.find((p) => p.token === sellSig.token), 1); return; }
      }
      for (const pos of [...agent.positions]) if (round - pos.entryRound >= P.holdRounds) { doSell(agent, pos, 1); return; }
    },
    fade(agent) {
      const P = params.fade;
      for (const pos of [...agent.positions]) {
        const px = priceOf(pos.token) || pos.entryPrice; const pct = (px - pos.entryPrice) / pos.entryPrice * 100;
        if (pct >= P.sellFullPct) { doSell(agent, pos, 1); return; }
        if (pct >= P.sellHalfPct) { doSell(agent, pos, 0.5); return; }
      }
      const scored = tape.universe.map((t) => ({ tok: t, score: (ctx().spikes.find((s) => s.token === t.address) || {}).score || 0 }))
        .sort((a, b) => a.score - b.score);
      const cold = scored.find((c) => !agent.positions.some((p) => p.token === c.tok.address));
      if (cold && agent.positions.length < P.maxPositions) {
        const q = payData(agent, "quote");
        if (q.ok) { const usd = round2(agent.cash * P.entrySizePct / 100); if (usd >= 1) doBuy(agent, cold.tok, usd); }
      }
    },
    longshot(agent) {
      const P = params.longshot;
      for (const pos of [...agent.positions]) {
        const px = priceOf(pos.token) || pos.entryPrice; const pct = (px - pos.entryPrice) / pos.entryPrice * 100;
        if (pct >= P.exitPct || round >= ROUNDS - 1) { doSell(agent, pos, 1); return; }
      }
      if (agent.shotsFired < P.shotsPerMatch) {
        const top = ctx().spikes[0];
        if (top && top.score >= P.spikeEntryScore) {
          const pc0 = precheck(top.token);
          if (pc0.liquidity === "deep" || round >= ROUNDS - P.lateGateRounds) {
            const q = payData(agent, "quote"); if (!q.ok) return;
            const v = payData(agent, "verdict"); if (!v.ok) return;
            if (precheck(top.token).verdict === "safe") {
              const usd = round2(agent.cash * P.entrySizePct / 100);
              if (usd >= 1 && doBuy(agent, top, usd)) agent.shotsFired++;
            }
          }
        }
      }
    },
    rook(agent) {
      const P = params.rook;
      for (const pos of [...agent.positions]) {
        const px = priceOf(pos.token) || pos.entryPrice; const pct = (px - pos.entryPrice) / pos.entryPrice * 100;
        if (pct <= -P.stopLossPct || pct >= P.takeProfitPct) { doSell(agent, pos, 1); return; }
      }
      if (round % P.signalsCheckEvery === 1) payData(agent, "signals");
      const buys = tape.signals.filter((s) => s.side === "buy" && !s.stale);
      const tally = {};
      for (const s of buys) tally[s.token] = (tally[s.token] || 0) + 1;
      const targetAddr = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      const tok = targetAddr ? tape.universe.find((t) => t.address === targetAddr[0]) : tape.universe[0];
      if (tok && !agent.positions.some((p) => p.token === tok.address) && agent.positions.length < P.maxPositions) {
        const q = payData(agent, "quote"); if (!q.ok) return;
        if (!rookChecked.has(tok.address)) {
          const v = payData(agent, "verdict"); if (!v.ok) return;
          rookChecked.add(tok.address);
        }
        const usd = round2(agent.cash * P.entrySizePct / 100);
        if (usd >= 1) doBuy(agent, tok, usd);
      }
    },
  };

  // Scramble sizing is engine-level (production constants, not v1 knobs).
  function runScramble(tok) {
    for (const f of FIGHTERS) {
      const agent = agents[f];
      if (f === "vex") {
        payData(agent, "quote"); const usd = round2(agent.cash * 0.25);
        if (usd >= 1) doBuy(agent, tok, usd);
      } else if (f === "audrey") {
        const v = payData(agent, "verdict"); if (!v.ok) continue;
        if (precheck(tok.address).verdict === "safe") { const usd = round2(agent.cash * 0.12); if (usd >= 1) doBuy(agent, tok, usd); }
      } else if (f === "echo") {
        const has = tape.signals.some((s) => s.side === "buy" && s.token === tok.address && !s.stale);
        if (has) { payData(agent, "quote"); const usd = round2(agent.cash * 0.2); if (usd >= 1) doBuy(agent, tok, usd); }
      } else if (f === "rook") {
        const v = payData(agent, "verdict"); if (!v.ok) continue;
        if (precheck(tok.address).verdict === "safe") { payData(agent, "quote"); const usd = round2(agent.cash * 0.1); if (usd >= 1) doBuy(agent, tok, usd); }
      }
      // fade and longshot always pass a scramble (production behavior)
    }
  }

  for (round = 1; round <= ROUNDS; round++) {
    for (const sc of tape.scrambles.filter((s) => s.round === round)) runScramble({ address: sc.symbol, symbol: sc.symbol, score: sc.score });
    for (const f of FIGHTERS) brains[f](agents[f]);
  }
  // Final liquidation at last recorded marks
  round = ROUNDS;
  for (const f of FIGHTERS) {
    const a = agents[f];
    for (const pos of [...a.positions]) {
      const px = priceOf(pos.token) || pos.entryPrice;
      a.realizedPnl = round2(a.realizedPnl + (pos.units * px - pos.costUsd));
      a.cash = round2(a.cash + pos.units * px);
    }
    a.positions = [];
  }
  const rows = FIGHTERS.map((f) => {
    const a = agents[f];
    return { fighter: f, treasury: round2(a.cash), dataSpend: a.dataSpend, capRefusals: a.capRefusals, trades: a.trades, realizedPnl: a.realizedPnl, payout: 0 };
  }).sort((a, b) => b.treasury - a.treasury);
  const distributable = 25.50; // $30 pool − 15% rake, the Matches 1–4 math
  [0.5, 0.3, 0.2].forEach((t, i) => { if (rows[i]) rows[i].payout = round2(distributable * t); });
  rows.forEach((r, i) => { r.rank = i + 1; r.finalBalance = round2(r.treasury + r.payout); });
  const treasuries = rows.map((r) => r.treasury);
  return { rows, spread: round2(Math.max(...treasuries) - Math.min(...treasuries)), winner: rows[0].fighter, podium: rows.slice(0, 3).map((r) => r.fighter) };
}

// ---------------------------------------------------------------------------
// 5. CLI + artifacts
// ---------------------------------------------------------------------------
function ensureOut() { fs.mkdirSync(OUT_DIR, { recursive: true }); }
function writeArtifact(name, obj) {
  ensureOut();
  fs.writeFileSync(path.join(OUT_DIR, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));
  return path.join(OUT_DIR, name);
}
function fmtAdj(a) { return `${a.fighter.toUpperCase().padEnd(9)} ${a.rule.padEnd(28)} ${a.knob}: ${a.from} -> ${a.to}`; }

function cmdLearn() {
  const events = loadEvents(); const accuracy = loadAccuracy();
  const evidence = aggregate(events, accuracy);
  const { params, adjustments } = learnPass(evidence, defaultParams());
  const evidenceOut = {};
  for (const f of FIGHTERS) evidenceOut[f] = evidence[f];
  writeArtifact("evidence.json", { generatedAt: new Date().toISOString(), eventsUsed: events.map((e) => e.matchId), notes: events.filter((e) => e.note).map((e) => `${e.matchId}: ${e.note}`), fighters: evidenceOut });
  writeArtifact("learned-params.json", { generatedAt: new Date().toISOString(), basis: "One training pass over the full recorded corpus (Matches 1-4 counted + floor exhibitions behavioral + corpus accuracy). Production defaults in offchain/arena-learning.md.", params });
  writeArtifact("adjustment-log.json", { generatedAt: new Date().toISOString(), passType: "full-corpus-single-pass", adjustments });
  console.log(`EVENTS USED: ${events.map((e) => e.matchId).join(", ")}`);
  console.log(`\nADJUSTMENTS (${adjustments.length}):`);
  for (const a of adjustments) console.log("  " + fmtAdj(a) + `   [evidence: ${JSON.stringify(a.evidence)}]`);
  console.log("\nEVIDENCE HEADLINES:");
  for (const f of FIGHTERS) {
    const e = evidence[f];
    console.log(`  ${f.toUpperCase().padEnd(9)} counted: ${e.counted.matches} matches, prize $${e.counted.prize}, spend $${e.counted.spend}, prize/cent $${e.counted.prizePerCent} | all events: spend $${e.all.spend}, zero-trade ${e.all.zeroTradeEvents}/${e.all.events}, refusals ${e.all.refusals} | accuracy ${e.accuracy.accuracy} (${e.accuracy.calls} calls)`);
  }
  return { evidence, params, adjustments };
}

function cmdTrajectory() {
  const events = loadEvents(); const accuracy = loadAccuracy();
  const steps = trajectory(events, accuracy);
  writeArtifact("trajectory.json", { generatedAt: new Date().toISOString(), note: "One pass after each recorded event, cumulative evidence. Accuracy rules (V-ENTRY, A-SCORE) evaluate only at the final step — per-event accuracy history was never persisted. Re-firing rules walk to their persona bounds and stop: convergence, not oscillation.", steps });
  console.log("\nTRAJECTORY (params after each recorded event):");
  for (const s of steps) {
    console.log(`  after ${s.afterEvent} (${s.klass}): ${s.adjustments.length ? s.adjustments.map(fmtAdj).join(" · ") : "no movement"}`);
  }
  return steps;
}

function cmdSimulate(learnedParams) {
  const tapes = [];
  const m4 = readJson("arena-live-evidence-arena-match-4.json"); if (m4) tapes.push(reconstructTape(m4, "arena-match-4"));
  const m3 = readJson("arena-live-evidence-arena-match-3.json"); if (m3) tapes.push(reconstructTape(m3, "arena-match-3"));
  for (const n of ["0001", "0002", "0003"]) {
    const st = readJson(path.join("floor", "rounds", `floor-round-${n}.state.json`));
    if (st) tapes.push(reconstructTape(st, `floor-round-${n}`));
  }
  const staticParams = defaultParams();
  const results = [];
  for (const tape of tapes) {
    const s = runSim(tape, staticParams);
    const l = runSim(tape, learnedParams);
    results.push({ tape: tape.matchId, rounds: tape.rounds, static: s, learned: l });
    console.log(`\nSIM ${tape.matchId} (${tape.rounds} rounds, identical boards both arms)`);
    console.log(`  winner: static=${s.winner.toUpperCase()} learned=${l.winner.toUpperCase()} | podium static=${s.podium.join(">")} learned=${l.podium.join(">")}`);
    console.log(`  treasury spread: static $${s.spread} -> learned $${l.spread}`);
    for (const f of FIGHTERS) {
      const sr = s.rows.find((r) => r.fighter === f), lr = l.rows.find((r) => r.fighter === f);
      console.log(`  ${f.toUpperCase().padEnd(9)} static: rank ${sr.rank}, treasury $${sr.treasury}, spend $${sr.dataSpend}, trades ${sr.trades}, payout $${sr.payout} | learned: rank ${lr.rank}, treasury $${lr.treasury}, spend $${lr.dataSpend}, trades ${lr.trades}, payout $${lr.payout}`);
    }
  }
  writeArtifact("simulation-results.json", { generatedAt: new Date().toISOString(), fidelity: "Decision-replay over reconstructed recorded boards — see arena-learning.md §Validation for the approximation list. Both arms share boards/marks/cap; only parameters differ.", results });
  return results;
}

function main() {
  const cmd = process.argv[2] || "all";
  const { params } = (cmd === "learn" || cmd === "all") ? cmdLearn() : { params: (() => { const e = aggregate(loadEvents(), loadAccuracy()); return learnPass(e, defaultParams()).params; })() };
  if (cmd === "trajectory" || cmd === "all") cmdTrajectory();
  if (cmd === "simulate" || cmd === "all") cmdSimulate(params);
  if (!["learn", "trajectory", "simulate", "all"].includes(cmd)) {
    console.log("usage: node arena-learning.js learn | trajectory | simulate | all");
  }
}

if (require.main === module) main();

module.exports = { KNOBS, FIGHTERS, defaultParams, loadEvents, loadAccuracy, aggregate, RULES, learnPass, trajectory, reconstructTape, runSim };
