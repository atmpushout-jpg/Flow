/**
 * FLOW ARENA — 24/7 ROLLING FLOOR (v1).
 *
 * Scheduled matches are prime time. This is the floor underneath them:
 * rounds run CONTINUOUSLY on a fixed cadence (default hourly), seats are
 * sold through the buy-in entries module (arena-entries.js) at the launch
 * card ($0.50 entry, 15% rake split 11 house / 4 reserve, prizes 50/30/20,
 * min field 6 paid seats), and every round is dealt on LIVE TAPE — the
 * same live market data the prime-time matches play on:
 *   - live prices from DexScreener (Base pairs),
 *   - live quotes + safety verdicts from Flow's own /api/precheck (the
 *     real quote + verify engines),
 *   - live smart-wallet signals + social-velocity spikes from the live
 *     state file behind /api/smart-wallets.
 *
 * Architecture (deliberately boring — three existing layers, one glue):
 *   GAMEPLAY  arena.js runMatch(), UNMODIFIED. The six house personas
 *             play the round on live tape exactly as in a match; the
 *             engine enforces the $0.60/agent data cap internally and
 *             its data charges flow through the listed endpoint prices.
 *             The engine runs with reserve:false here — its internal
 *             ledger pool ($5 exhibition stakes) is gameplay accounting
 *             ONLY and is never presented as the round's money.
 *   MONEY     arena-buyin.js computeEventMath() over the round's real
 *             seats from the entries ledger: entries total, guarantee
 *             top-up, rake house/reserve split, prizes by rank. Integer
 *             cents, same functions the prime-time buy-in uses.
 *   SEATS     arena-entries.js registrar + ledger. A seat exists only
 *             on a verified settlement (outside) or a labeled house
 *             entry (HOUSE). TEST entries never count. A round whose
 *             field misses minField rolls its entries forward — the
 *             module's rule; nobody's money traps.
 *   FAME      arena-standings.js: each dealt round writes a results
 *             record in the module's documented shape ({matchId, class,
 *             results:[{agentId,name,rank,payout,dataSpend,trades,pnl}]})
 *             and rebuilds career standings. Production rounds count as
 *             class BUY-IN; dry runs are EXHIBITION and never counted.
 *
 * LIVE-TAPE GATE: before any round deals, probeTape() must pass —
 * DexScreener returns live prices for WETH + AERO, /api/precheck returns
 * a real quote with a block number, and the smart-wallet state file's
 * signals are fresh (<= config tape.maxSignalsAgeSec). Any failure: the
 * round is SKIPPED and logged with the reason; its entries stay seated
 * for the next attempt. The floor never deals from cached prices or a
 * stale state file and calls it live.
 *
 * ACTIVATION: this engine ships STOPPED. `daemon` and production
 * `run-once` refuse to run unless arena-floor-config.json has
 * "enabled": true. Dry runs (`run-once --dry-run`) are always allowed:
 * house seats only, a separate dry-run ledger + state, EXHIBITION
 * standings records written as files (never into the real history).
 *
 * CLI:
 *   node arena-floor.js status
 *   node arena-floor.js probe
 *   node arena-floor.js run-once [--dry-run] [--seeded] [--rounds N] [--round-ms MS]
 *   node arena-floor.js register-outside <txHash> [agentName]
 *   node arena-floor.js training
 *   node arena-floor.js daemon
 *
 * TRAINING: every dealt round is also recorded by arena-training.js —
 * per-decision records with gap-call accuracy scoring (quote-engine
 * edgeBps at decision block vs a fill-size re-quote), appended to
 * offchain/floor/training/dataset.jsonl. Observational only; disable
 * with "training": {"enabled": false} in the floor config. FLOWX, the
 * standing exhibition fighter, runs via arena-exhibition.js.
 */

const fs = require("fs");
const path = require("path");
const arena = require("./arena.js");
const buyin = require("./arena-buyin.js");
const entries = require("./arena-entries.js");
const standings = require("./arena-standings.js");
const training = require("./arena-training.js");

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const FLOOR_DIR = path.join(DIR, "floor");
const ROUNDS_DIR = path.join(FLOOR_DIR, "rounds");
const CONFIG_PATH = process.env.ARENA_FLOOR_CONFIG || path.join(DIR, "arena-floor-config.json");
const ROOT_SUMMARY_PATH = path.join(ROOT, "arena-floor.json");
const API_BASE = "https://flow-kg4x.vercel.app";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const AERO = "0x940181a94a35a4569e4529a3cDfB74e38Fd98631";
const SMART_WALLETS_PATH = path.join(DIR, "smart-wallets.json");

const round2 = (n) => Math.round(n * 100) / 100;

// ---------- config / state ----------
function loadFloorConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function statePath(dryRun) {
  return path.join(FLOOR_DIR, dryRun ? "arena-floor-state.dryrun.json" : "arena-floor-state.json");
}
function ledgerPath(dryRun) {
  return path.join(FLOOR_DIR, dryRun ? "arena-floor-entries.dryrun.json" : "arena-floor-entries.json");
}
function loadState(dryRun) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(dryRun), "utf8"));
    if (s && s.version === 1 && s.rounds) return s;
  } catch { /* first run */ }
  return { version: 1, seq: 0, rounds: {}, currentOpenRoundId: null, lastSettledRoundId: null, updatedAt: null };
}
function saveState(s, dryRun) {
  s.updatedAt = new Date().toISOString();
  entries.writeJsonAtomic(statePath(dryRun), s);
}
function journal(ev, dryRun) {
  fs.appendFileSync(
    path.join(FLOOR_DIR, dryRun ? "floor-journal.dryrun.jsonl" : "floor-journal.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n"
  );
}

/** Build the cfg object the buy-in/entries modules expect, with this
 *  round cloned in as its event (same economics shape as buy-in-1). */
function roundCfg(floorCfg, roundId, { seeded = null } = {}) {
  const base = buyin.loadConfig();
  const ev = JSON.parse(JSON.stringify(floorCfg.template));
  ev.name = `${floorCfg.template.name} ${roundId}`;
  if (seeded != null) ev.guaranteeSeeded = !!seeded;
  // Reserve Refill Rule: a floor round is a buy-in table — if the reserve
  // journal says the refill mode is armed, this round's split shifts 2
  // points from house to reserve (total rake unchanged). The split is read
  // from the journal state at the round's start, same as prime-time.
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(DIR, "arena-reserve.json"), "utf8"));
    if (journal && journal.refill && journal.refill.active) {
      Object.assign(ev, buyin.refill.refillBps(ev, true));
      ev.refillActive = true;
    }
  } catch { /* no journal yet — base split applies */ }
  return { ...base, brand: floorCfg.brand, events: { [roundId]: ev } };
}

function roundIdFor(seq) {
  return `floor-round-${String(seq).padStart(4, "0")}`;
}

// ---------- live-tape probe (the gate) ----------
async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function probeTape(floorCfg) {
  const checks = [];
  let ok = true;
  const prices = {};
  for (const [symbol, addr] of [["WETH", WETH], ["AERO", AERO]]) {
    try {
      const d = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/base/${addr}`);
      const pairs = Array.isArray(d) ? d : d.pairs || [];
      let best = null;
      for (const p of pairs) {
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        const ba = ((p.baseToken && p.baseToken.address) || "").toLowerCase();
        const price = ba === addr.toLowerCase() ? parseFloat(p.priceUsd) || 0 : 0;
        if (price > 0 && (!best || liq > best.liq)) best = { liq, price };
      }
      if (best) {
        prices[symbol] = best.price;
        checks.push({ source: "dexscreener", symbol, ok: true, priceUsd: best.price, liquidityUsd: Math.round(best.liq) });
      } else {
        ok = false;
        checks.push({ source: "dexscreener", symbol, ok: false, reason: "no priced Base pair returned" });
      }
    } catch (e) {
      ok = false;
      checks.push({ source: "dexscreener", symbol, ok: false, reason: String(e.message || e).slice(0, 120) });
    }
  }
  let block = null, venue = null, bestOut = null;
  try {
    const d = await fetchJson(`${API_BASE}/api/precheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenIn: USDC, tokenOut: WETH, amountIn: floorCfg.tape.probeAmountIn }),
    }, 30000);
    if (d && d.price && !d.price.error && d.price.bestOut && d.price.blockNumber) {
      block = d.price.blockNumber;
      venue = d.price.venue || null;
      bestOut = String(d.price.bestOut);
      checks.push({ source: "flow-precheck", ok: true, block, venue, quote: `${floorCfg.tape.probeAmountIn} USDC -> WETH`, bestOut });
    } else {
      ok = false;
      checks.push({ source: "flow-precheck", ok: false, reason: "response carried no live quote (no bestOut/blockNumber)" });
    }
  } catch (e) {
    ok = false;
    checks.push({ source: "flow-precheck", ok: false, reason: String(e.message || e).slice(0, 120) });
  }
  let spikes = [], signalsUpdatedAt = null, signalsAgeSec = null;
  try {
    const sw = JSON.parse(fs.readFileSync(SMART_WALLETS_PATH, "utf8"));
    signalsUpdatedAt = sw.signalsUpdatedAt || sw.updatedAt || null;
    signalsAgeSec = signalsUpdatedAt ? Math.round((Date.now() - Date.parse(signalsUpdatedAt)) / 1000) : null;
    spikes = ((sw.socialVelocity || {}).spikes || []).map((s) => ({ symbol: s.symbol, score: s.score, level: s.level }));
    const fresh = signalsAgeSec != null && signalsAgeSec <= floorCfg.tape.maxSignalsAgeSec;
    if (!fresh) ok = false;
    checks.push({ source: "smart-wallets-state", ok: fresh, signalsUpdatedAt, ageSec: signalsAgeSec, maxAgeSec: floorCfg.tape.maxSignalsAgeSec, signals: (sw.signals || []).length, spikes: spikes.length });
  } catch (e) {
    ok = false;
    checks.push({ source: "smart-wallets-state", ok: false, reason: "live state file unreadable" });
  }
  return { ok, checkedAt: new Date().toISOString(), block, venue, prices, spikes, checks };
}

// ---------- round lifecycle ----------
function openRound(floorCfg, state, dryRun) {
  const seq = state.seq + 1;
  const roundId = roundIdFor(seq);
  const cfg = roundCfg(floorCfg, roundId);
  const lp = ledgerPath(dryRun);
  const ledger = entries.loadLedger(lp);
  const seatedHouse = [];
  for (const agentId of floorCfg.houseAgents) {
    const e = entries.registerHouseEntry(cfg, ledger, { eventId: roundId, agentId, ledgerPath: lp });
    seatedHouse.push(e.seatId);
  }
  state.seq = seq;
  state.rounds[roundId] = {
    roundId, seq,
    status: "ENTRY_OPEN",
    openedAt: new Date().toISOString(),
    dryRun: !!dryRun,
    houseSeats: seatedHouse,
    attempts: [],
    dealtAt: null, settledAt: null,
    classification: null,
  };
  state.currentOpenRoundId = roundId;
  saveState(state, dryRun);
  journal({ type: "ROUND_OPENED", roundId, houseSeats: seatedHouse.length, dryRun: !!dryRun }, dryRun);
  return state.rounds[roundId];
}

/** Seats that play in a round: its own SEATED entries plus any entries
 *  rolled forward INTO it by an earlier shortfall. TEST never counts. */
function collectSeats(ledger, roundId) {
  return ledger.entries.filter(
    (e) => e.kind !== "TEST" && ((e.eventId === roundId && e.status === "SEATED") || (e.status === "ROLLED_FORWARD" && e.carriedTo === roundId))
  );
}

async function runRound(floorCfg, state, dryRun, opts = {}) {
  const roundId = state.currentOpenRoundId;
  if (!roundId) throw new Error("no open round — open one first");
  const round = state.rounds[roundId];
  const lp = ledgerPath(dryRun);
  const cfg = roundCfg(floorCfg, roundId, { seeded: opts.seeded });
  const ev = buyin.getEvent(cfg, roundId);

  // 1) LIVE-TAPE GATE — a failed probe skips the round; seats stay put.
  const tape = await probeTape(floorCfg);
  if (!tape.ok) {
    round.attempts.push({ ts: tape.checkedAt, result: "SKIPPED_TAPE", failedChecks: tape.checks.filter((c) => !c.ok).map((c) => c.source) });
    saveState(state, dryRun);
    journal({ type: "ROUND_SKIPPED_TAPE", roundId, failedChecks: tape.checks.filter((c) => !c.ok) }, dryRun);
    return { dealt: false, reason: "TAPE", tape };
  }

  // 2) FIELD CHECK — short field rolls forward via the entries module.
  let ledger = entries.loadLedger(lp);
  let seats = collectSeats(ledger, roundId);
  if (seats.length < ev.minField) {
    const nextId = roundIdFor(state.seq + 1);
    const r = entries.evaluateField(cfg, ledger, roundId, { nextEventId: nextId, ledgerPath: lp });
    // carried-in entries that were waiting on THIS round roll again too
    ledger = entries.loadLedger(lp);
    for (const e of ledger.entries) {
      if (e.status === "ROLLED_FORWARD" && e.carriedTo === roundId) e.carriedTo = nextId;
    }
    entries.saveLedger(ledger, lp);
    round.status = "ROLLED_FORWARD";
    round.settledAt = new Date().toISOString();
    state.currentOpenRoundId = null;
    saveState(state, dryRun);
    journal({ type: "ROUND_ROLLED_FORWARD", roundId, paidSeats: r.paidSeats, minField: ev.minField, carriedTo: nextId }, dryRun);
    return { dealt: false, reason: "FIELD_SHORT", evaluation: r };
  }
  const outside = seats.filter((e) => e.kind === "OUTSIDE").length;
  round.classification = outside >= 2 ? "PUBLIC" : "HOUSE SHOWCASE";

  // 3) DEAL — the unmodified match engine plays the round on live tape.
  round.status = "DEALING";
  round.dealtAt = new Date().toISOString();
  saveState(state, dryRun);
  journal({ type: "ROUND_DEALING", roundId, paidSeats: seats.length, outside, classification: round.classification, tapeBlock: tape.block }, dryRun);
  // TRAINING RECORDER — observational only: snapshots the quote engine's
  // edgeBps per token and re-quotes each BUY at fill size while the round
  // plays, so gap calls can be scored against the engine's own numbers.
  // Any recorder failure degrades to missing evidence, never a failed round.
  let recorder = null;
  if (!floorCfg.training || floorCfg.training.enabled !== false) {
    try {
      recorder = training.startRecorder({ statePath: path.join(ROUNDS_DIR, `${roundId}.state.json`) });
    } catch { recorder = null; }
  }
  await arena.runMatch({
    matchId: roundId,
    label: dryRun ? "FLOOR DRY-RUN" : "FLOOR",
    liveMode: true,
    reserve: false, // the floor's money layer (below) owns the reserve split
    stateFile: `floor/rounds/${roundId}.state.json`,
    reportFile: `floor/rounds/${roundId}.report.json`,
    rounds: opts.gameRounds || floorCfg.gameRounds,
    roundMs: opts.gameRoundMs || floorCfg.gameRoundMs,
  });

  // 4) SETTLE — real money math over the round's real seats.
  const report = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, `${roundId}.report.json`), "utf8"));
  const math = buyin.computeEventMath(ev, seats.map((s) => ({ amount: s.amount, kind: s.kind })));
  const byName = {};
  for (const row of report.receipts.perAgent) {
    const p = arena.PERSONAS.find((x) => x.name === row.agent);
    if (p) byName[p.id] = row;
  }
  const prizesByRank = report.leaderboard.slice(0, 3).map((row, i) => ({
    rank: row.rank,
    agentId: row.agentId,
    name: row.name,
    affiliation: "HOUSE",
    amount: math.prizes[i] || 0,
  }));
  const prizeOf = (agentId) => {
    const p = prizesByRank.find((x) => x.agentId === agentId);
    return p ? p.amount : 0;
  };
  const results = report.leaderboard.map((row) => {
    const pa = byName[row.agentId] || {};
    return {
      agentId: row.agentId,
      name: row.name,
      rank: row.rank,
      payout: prizeOf(row.agentId),
      dataSpend: round2(pa.dataSpend || 0),
      trades: pa.trades || 0,
      pnl: round2(pa.realizedPnl || 0),
    };
  });
  const standingsRecord = {
    matchId: roundId,
    class: dryRun ? floorCfg.dryRunStandingsClass : floorCfg.standingsClass,
    results,
  };

  // 5) RECEIPT — gameplay + money + fame, published per round.
  const receipt = {
    game: floorCfg.brand,
    roundId,
    kind: dryRun ? "FLOOR DRY-RUN (house seats only, no public entry)" : "FLOOR ROUND",
    status: "SETTLED",
    dealtAt: round.dealtAt,
    settledAt: new Date().toISOString(),
    classification: round.classification,
    cadenceMinutes: floorCfg.cadenceMinutes,
    tape: {
      source: "live — DexScreener Base prices + Flow /api/precheck (quote + verify engines) + live smart-wallet state (signals + social velocity)",
      probe: tape,
    },
    field: {
      paidSeats: seats.length,
      outside,
      house: seats.filter((e) => e.kind === "HOUSE").length,
      minField: ev.minField,
      seats: seats.map((e) => ({ seatId: e.seatId, kind: e.kind, agent: e.agentName, amount: e.amount, tx: e.settlement ? e.settlement.txHash : null })),
    },
    gameplay: {
      engine: "arena.js runMatch (unmodified), paper fills at live prices",
      engineReport: `offchain/floor/rounds/${roundId}.report.json`,
      leaderboard: report.leaderboard.map((r) => ({ rank: r.rank, agentId: r.agentId, name: r.name, treasury: r.treasury, pnl: r.pnl, dataSpend: r.dataSpend, eliminated: r.eliminated })),
      perAgent: results,
      totalDataSpend: report.receipts.totalDataSpend,
      dataCapPerAgent: floorCfg.dataCapUsd,
      capRefusals: report.receipts.totalCapRefusals,
    },
    money: {
      entriesTotal: math.entriesTotal,
      guaranteeTopUp: math.guaranteeTopUp,
      guaranteeSeeded: !!ev.guaranteeSeeded,
      effectivePool: math.effectivePool,
      rake: math.rake,
      rakeHouse: math.rakeHouse,
      rakeReserve: math.rakeReserve,
      distributable: math.distributable,
      prizes: prizesByRank,
      honesty:
        "Money block is authoritative: computed by arena-buyin.computeEventMath over the round's verified seats. " +
        "The gameplay engine's internal ledger pool ($5 exhibition stakes) is gameplay accounting only and is NOT this round's money. " +
        "House prizes are house receipts, published as such. Prize execution to outside seat-holders follows the same recorded-obligation pattern as refunds (house-executed, never automatic).",
    },
    standingsRecord,
    notes: [
      "Floor v1: the six seats of play are the house cast, labeled HOUSE. Outside entries are verified seats in the round's field and pool.",
      `Standings class for this round: ${standingsRecord.class}${dryRun ? " (dry run — exhibition, never counted in career totals)" : ""}.`,
    ],
  };
  entries.writeJsonAtomic(path.join(ROUNDS_DIR, `${roundId}.receipt.json`), receipt);

  // 6) FAME — production rounds feed the real career standings; dry
  //    runs write the record file only (proven against the module in
  //    the build's integration test, never into the real history).
  if (dryRun) {
    entries.writeJsonAtomic(path.join(ROUNDS_DIR, `${roundId}.standings-record.json`), standingsRecord);
  } else {
    const history = standings.loadHistory();
    if (!history.frozen[roundId]) standings.addResult(history, standingsRecord);
    standings.build();
  }

  // 6b) TRAINING — decision records + gap-call accuracy for this round
  //     (arena-training.js; the House Formula's future training corpus).
  //     Observational: a failure here never fails the round.
  if (recorder) {
    try {
      const evidence = await recorder.stop();
      const roundState = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, `${roundId}.state.json`), "utf8"));
      const t = training.recordRound({
        matchId: roundId, source: "floor", klass: standingsRecord.class, settledAt: receipt.settledAt,
        state: roundState, report, results, spikes: tape.spikes, evidence,
      });
      receipt.training = { decisions: t.decisions, dataset: "offchain/floor/training/dataset.jsonl", accuracy: "offchain/floor/training/accuracy.json" };
      entries.writeJsonAtomic(path.join(ROUNDS_DIR, `${roundId}.receipt.json`), receipt);
      journal({ type: "TRAINING_RECORDED", roundId, decisions: t.decisions }, dryRun);
    } catch (e) {
      journal({ type: "TRAINING_ERROR", roundId, error: String(e.message || e).slice(0, 200) }, dryRun);
    }
  }

  // 7) CLOSE — seats transition to PLAYED (never deleted), state moves on.
  ledger = entries.loadLedger(lp);
  for (const e of ledger.entries) {
    if ((e.eventId === roundId && e.status === "SEATED") || (e.status === "ROLLED_FORWARD" && e.carriedTo === roundId)) {
      e.status = "PLAYED";
      e.playedRound = roundId;
    }
  }
  ledger.journal.push({ ts: new Date().toISOString(), type: "ROUND_SETTLED", roundId, paidSeats: seats.length, poolUsd: math.effectivePool, rakeUsd: math.rake });
  entries.saveLedger(ledger, lp);
  round.status = "SETTLED";
  round.settledAt = receipt.settledAt;
  state.lastSettledRoundId = roundId;
  state.currentOpenRoundId = null;
  saveState(state, dryRun);
  journal({ type: "ROUND_SETTLED", roundId, poolUsd: math.effectivePool, rakeUsd: math.rake, winner: prizesByRank[0] ? prizesByRank[0].name : null }, dryRun);
  writeRootSummary(floorCfg, state, receipt, dryRun);
  return { dealt: true, receipt };
}

function writeRootSummary(floorCfg, state, lastReceipt, dryRun) {
  if (dryRun) return; // dry runs never touch the public surface
  const open = state.currentOpenRoundId ? state.rounds[state.currentOpenRoundId] : null;
  const summary = {
    game: floorCfg.brand,
    floor: "24/7 rolling rounds — a new round every cadence on live tape; scheduled matches are prime time on top of this floor.",
    enabled: floorCfg.enabled,
    cadenceMinutes: floorCfg.cadenceMinutes,
    entry: { buyIn: floorCfg.template.tiers[0].buyIn, rakeBps: floorCfg.template.rakeBps, payouts: floorCfg.template.payoutTiers, minField: floorCfg.template.minField },
    lastRound: lastReceipt
      ? {
          roundId: lastReceipt.roundId,
          settledAt: lastReceipt.settledAt,
          classification: lastReceipt.classification,
          pool: lastReceipt.money.effectivePool,
          rake: lastReceipt.money.rake,
          prizes: lastReceipt.money.prizes,
          tapeBlock: lastReceipt.tape.probe.block,
        }
      : null,
    nextRound: open ? { roundId: open.roundId, status: open.status, openedAt: open.openedAt } : null,
    standings: "arena-standings.json",
    updatedAt: new Date().toISOString(),
  };
  entries.writeJsonAtomic(ROOT_SUMMARY_PATH, summary);
}

// ---------- CLI ----------
function ensureDirs() {
  fs.mkdirSync(ROUNDS_DIR, { recursive: true });
}

function assertCapParity(floorCfg) {
  if (Math.abs(floorCfg.dataCapUsd - arena.DATA_CAP) > 1e-9) {
    throw new Error(`data cap mismatch: floor config $${floorCfg.dataCapUsd} vs engine DATA_CAP $${arena.DATA_CAP} — refusing to run on divergent caps`);
  }
}

function refuseStopped(floorCfg, what) {
  console.error(`REFUSED: the 24/7 floor is STOPPED (arena-floor-config.json "enabled": false). ${what} will not run.`);
  console.error("Activation requires: entry path verified live in production + guarantee seed funded + outside-seat prize-attribution rule published. Dry runs are always available: run-once --dry-run");
  process.exit(2);
}

async function main() {
  ensureDirs();
  const floorCfg = loadFloorConfig();
  assertCapParity(floorCfg);
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";
  const has = (f) => args.includes("--" + f);
  const num = (name, dflt) => {
    const i = args.indexOf("--" + name);
    if (i < 0) return dflt;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) ? v : dflt;
  };
  const dryRun = has("dry-run");

  if (cmd === "status") {
    for (const dr of [false, true]) {
      const s = loadState(dr);
      const rounds = Object.values(s.rounds);
      console.log(`${dr ? "DRY-RUN" : "PRODUCTION"} floor: enabled=${floorCfg.enabled} seq=${s.seq} open=${s.currentOpenRoundId || "none"} settled=${rounds.filter((r) => r.status === "SETTLED").length} rounds (${rounds.map((r) => `${r.roundId}:${r.status}`).join(", ") || "none yet"})`);
    }
    console.log(`cadence ${floorCfg.cadenceMinutes}m · entry $${floorCfg.template.tiers[0].buyIn} · rake ${floorCfg.template.rakeBps / 100}% (${floorCfg.template.houseBpsOfPool / 100} house / ${floorCfg.template.reserveBpsOfPool / 100} reserve) · minField ${floorCfg.template.minField} · dataCap $${floorCfg.dataCapUsd} (engine parity OK)`);
    return;
  }

  if (cmd === "probe") {
    const tape = await probeTape(floorCfg);
    console.log(JSON.stringify(tape, null, 1));
    console.log(tape.ok ? "TAPE: LIVE — a round may deal." : "TAPE: NOT LIVE — a round would be SKIPPED, never dealt from cache.");
    return;
  }

  if (cmd === "training") {
    const acc = training.loadAccuracy();
    console.log(`training accuracy — updated ${acc.updatedAt || "never"} · ${Object.keys(acc.rounds).length} rounds recorded (dataset: offchain/floor/training/dataset.jsonl, schema: offchain/floor/training/SCHEMA.md)`);
    console.log(training.formatTable(acc));
    return;
  }

  if (cmd === "register-outside") {
    const txHash = args[1];
    const agentName = args[2] || null;
    if (!txHash) { console.error("usage: register-outside <txHash> [agentName]"); process.exit(1); }
    const state = loadState(false);
    if (!state.currentOpenRoundId) { console.error("no production round is open for entry"); process.exit(1); }
    const roundId = state.currentOpenRoundId;
    const cfg = roundCfg(floorCfg, roundId);
    const lp = ledgerPath(false);
    const ledger = entries.loadLedger(lp);
    const entry = await entries.registerPaidEntry(cfg, ledger, { txHash, eventId: roundId, agentName, ledgerPath: lp });
    console.log(JSON.stringify(entry, null, 1));
    return;
  }

  if (cmd === "run-once") {
    if (!dryRun && !floorCfg.enabled) refuseStopped(floorCfg, "production run-once");
    const state = loadState(dryRun);
    if (!state.currentOpenRoundId) openRound(floorCfg, state, dryRun);
    const r = await runRound(floorCfg, state, dryRun, {
      seeded: has("seeded") ? true : null,
      gameRounds: num("rounds", null),
      gameRoundMs: num("round-ms", null),
    });
    if (r.dealt) {
      // keep the door open: the next round's seats are selling now
      const fresh = loadState(dryRun);
      openRound(floorCfg, fresh, dryRun);
      const m = r.receipt.money;
      console.log(`\nFLOOR ROUND SETTLED ${r.receipt.roundId}: pool $${m.effectivePool.toFixed(2)} (entries $${m.entriesTotal.toFixed(2)} + top-up $${m.guaranteeTopUp.toFixed(2)}) · rake $${m.rake.toFixed(2)} (house $${m.rakeHouse.toFixed(2)} / reserve $${m.rakeReserve.toFixed(2)}) · prizes ${m.prizes.map((p) => `${p.name} $${p.amount.toFixed(2)}`).join(" / ")} · total data spend $${r.receipt.gameplay.totalDataSpend.toFixed(2)} · classification ${r.receipt.classification}`);
    } else {
      console.log(`\nFLOOR ROUND NOT DEALT (${r.reason}) — see journal.`);
    }
    return;
  }

  if (cmd === "daemon") {
    if (!floorCfg.enabled) refuseStopped(floorCfg, "the daemon");
    console.log(`24/7 FLOOR LIVE — cadence ${floorCfg.cadenceMinutes}m. Rounds deal on live tape only; a failed probe skips, never fakes.`);
    for (;;) {
      const state = loadState(false);
      if (!state.currentOpenRoundId) openRound(floorCfg, loadState(false), false);
      const cadenceMs = floorCfg.cadenceMinutes * 60000;
      const wait = Math.max(1000, Math.ceil((Date.now() + 1000) / cadenceMs) * cadenceMs - Date.now());
      console.log(`next round at ${new Date(Date.now() + wait).toISOString()} (in ${Math.round(wait / 1000)}s)`);
      await new Promise((r) => setTimeout(r, wait));
      try {
        const s2 = loadState(false);
        const r = await runRound(floorCfg, s2, false, {});
        if (r.dealt) openRound(floorCfg, loadState(false), false);
      } catch (e) {
        journal({ type: "ROUND_ERROR", error: String(e.message || e).slice(0, 300) }, false);
        console.error("round error (floor stays up):", e.message);
      }
    }
  }

  console.log("usage: status | probe | run-once [--dry-run] [--seeded] [--rounds N] [--round-ms MS] | register-outside <txHash> [agentName] | training | daemon");
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}

module.exports = { loadFloorConfig, probeTape, openRound, runRound, collectSeats, roundCfg, roundIdFor };
