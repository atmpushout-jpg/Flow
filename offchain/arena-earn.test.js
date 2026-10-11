/**
 * Flow Arena — EARN MODE unit tests.
 * Plain-script harness in the house style (cf. local-test.js): node
 * assert, real temp files, exact-cent expectations.
 * Run: node offchain/arena-earn.test.js
 *
 * Covers: split math exact to the cent · reserve credit lands in the
 * existing journal · copy-feed settlement matches the agent's actual
 * fills · paid-question answers use ONLY that agent's state · unlock
 * gating (summary vs full) · page/engine parity for the ported demo
 * logic in arena.html.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const earn = require("./arena-earn.js");
const arena = require("./arena.js");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-earn-test-"));
const newStore = () => {
  const d = tmp();
  return earn.createStore({ journalPath: path.join(d, "earn.json"), reservePath: path.join(d, "reserve.json") });
};

// A synthetic finished match with distinct, unmistakable numbers.
function syntheticState() {
  return {
    matchId: "synthetic-1", status: "finished",
    rules: { startTreasuryUsd: 100, entryStakeUsd: 5, dataCapUsd: 0.60 },
    personas: [
      { id: "vex", name: "VEX", emoji: "🔴", strategy: "Momentum degen." },
      { id: "audrey", name: "AUDREY", emoji: "🛡️", strategy: "Verdict-first auditor." },
      { id: "fade", name: "FADE", emoji: "🌑", strategy: "Contrarian." },
    ],
    agents: {
      vex: { id: "vex", cash: 111.11, dataSpend: 0.29, positions: [{ token: "0xa", symbol: "AERO", units: 10, entryPrice: 1, costUsd: 12.34, entryRound: 3 }], realizedPnl: 1.5, trades: 4, eliminated: false, payout: 0, capRefusals: 0 },
      audrey: { id: "audrey", cash: 222.22, dataSpend: 0.60, positions: [], realizedPnl: -2.25, trades: 2, eliminated: false, payout: 0, capRefusals: 7 },
      fade: { id: "fade", cash: 90, dataSpend: 0.03, positions: [], realizedPnl: 4.75, trades: 5, eliminated: false, payout: 12.75, capRefusals: 0 },
    },
    leaderboard: [
      { agentId: "fade", name: "FADE", treasury: 99.75, rank: 1 },
      { agentId: "vex", name: "VEX", treasury: 111.11, rank: 2 },
      { agentId: "audrey", name: "AUDREY", treasury: 222.22, rank: 3 },
    ],
    pool: { collected: 30, payouts: { fade: 12.75 } },
    feed: [
      { ts: "t1", round: 1, type: "BUY", agentId: "fade", symbol: "WETH", amountUsd: 20, price: 3000, dataCharge: 0.01, line: "fade buy 1" },
      { ts: "t2", round: 2, type: "BUY", agentId: "fade", symbol: "AERO", amountUsd: 15, price: 1.5, dataCharge: 0.01, line: "fade buy 2" },
      { ts: "t3", round: 2, type: "BUY", agentId: "vex", symbol: "AERO", amountUsd: 999, price: 1.5, dataCharge: 0.29, line: "vex buy" },
      { ts: "t4", round: 5, type: "SELL", agentId: "fade", symbol: "WETH", amountUsd: 22, price: 3100, pnlUsd: 2, dataCharge: 0.01, line: "fade sell" },
      { ts: "t5", round: 9, type: "HOLD", agentId: "audrey", line: "audrey holds" },
      { ts: "t6", round: 14, type: "FINAL_CLOSE", agentId: "fade", symbol: "AERO", amountUsd: 16.5, price: 1.6, pnlUsd: 1.5, line: "fade closes" },
    ],
  };
}

console.log("== split math ==");
ok("unlock $1.00 splits 0.11 / 0.04 / 0.85", () => {
  assert.deepStrictEqual(earn.splitSale(1.00), { total: 1, house: 0.11, reserve: 0.04, treasury: 0.85 });
});
ok("question $0.25 splits 0.03 / 0.01 / 0.21 (exact cents)", () => {
  assert.deepStrictEqual(earn.splitSale(0.25), { total: 0.25, house: 0.03, reserve: 0.01, treasury: 0.21 });
});
ok("copyfeed $2.00 splits 0.22 / 0.08 / 1.70", () => {
  assert.deepStrictEqual(earn.splitSale(2.00), { total: 2, house: 0.22, reserve: 0.08, treasury: 1.7 });
});
ok("every cent price 1..10000 splits sum exactly to the price", () => {
  for (let c = 1; c <= 10000; c++) {
    const s = earn.splitSale(c / 100);
    const sum = Math.round((s.house + s.reserve + s.treasury) * 100);
    assert.strictEqual(sum, c, `price ${c}c split sums to ${sum}`);
    assert.strictEqual(Math.round(s.total * 100), c);
  }
});

console.log("== sales, journal, reserve credit ==");
ok("full purchase flow: balances, totals, journal order, reserve credit lands", () => {
  const store = newStore();
  const state = syntheticState();
  // Reserve starts as arena.js's own seed: balance 0, founding claim pending.
  const R0 = earn.loadReserveJournal(store.reservePath);
  assert.strictEqual(R0.balance, 0);
  assert.strictEqual(R0.claims.length, 1);

  const buyer = earn.DEMO_SPECTATOR_ID;
  const u = earn.buyUnlock(store, { buyer, matchId: state.matchId });
  assert.strictEqual(u.ok, true);
  assert.strictEqual(store.data.spectators[buyer].balance, 9.00);
  assert.strictEqual(store.data.treasuryByMatch[state.matchId], 0.85);

  const q = earn.buyQuestion(store, { buyer, matchId: state.matchId, agentId: "audrey", question: "Did the data cap stop you?", state });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(store.data.questions.length, 1);
  assert.strictEqual(store.data.questions[0].answer, q.record.answer);

  const cf = earn.buyCopyFeed(store, { buyer, matchId: state.matchId, agentId: "fade" });
  assert.strictEqual(cf.ok, true);
  assert.strictEqual(store.data.spectators[buyer].balance, 6.75);
  assert.strictEqual(store.data.spectators[buyer].totalSpent, 3.25);

  // Totals: gross 3.25 · house .11+.03+.22=.36 · reserve .04+.01+.08=.13 · treasury .85+.21+1.70=2.76
  assert.deepStrictEqual(store.data.totals, { sales: 3, gross: 3.25, house: 0.36, reserve: 0.13, treasury: 2.76 });

  // Reserve journal: EARN_CREDITs landed, balance exact, claims untouched.
  const R = earn.loadReserveJournal(store.reservePath);
  assert.strictEqual(R.balance, 0.13);
  assert.strictEqual(R.totalInflow, 0.13);
  const credits = R.journal.filter((j) => j.type === "EARN_CREDIT");
  assert.deepStrictEqual(credits.map((c) => c.amount), [0.04, 0.01, 0.08]);
  assert.strictEqual(credits[2].balanceAfter, 0.13);
  assert.strictEqual(R.claims.length, 1); // founding claim untouched
  assert.strictEqual(R.claims[0].status, "pending");

  // Earn journal order: FUND → (SALE, RESERVE_CREDIT) ×2 → SALE, RESERVE_CREDIT, COPYFEED_OPEN…
  const types = store.data.entries.map((e) => e.type);
  assert.strictEqual(types[0], "FUND");
  assert.strictEqual(types.filter((t) => t === "SALE").length, 3);
  assert.strictEqual(types.filter((t) => t === "RESERVE_CREDIT").length, 3);
  assert.ok(types.includes("QUESTION") && types.includes("COPYFEED_OPEN") && types.includes("UNLOCK_GRANTED"));
  const sale = store.data.entries.find((e) => e.type === "SALE" && e.product === "question");
  assert.deepStrictEqual(sale.split, { total: 0.25, house: 0.03, reserve: 0.01, treasury: 0.21 });
});

ok("insufficient balance refuses the sale and journals the refusal", () => {
  const store = newStore();
  earn.ensureSpectator(store, "poor-spectator", 0.10);
  store.save();
  const r = earn.buyUnlock(store, { buyer: "poor-spectator", matchId: "synthetic-1" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "INSUFFICIENT_LEDGER_BALANCE");
  assert.strictEqual(store.data.spectators["poor-spectator"].balance, 0.10);
  assert.strictEqual(store.data.totals.sales, 0);
  assert.ok(store.data.entries.some((e) => e.type === "SALE_REFUSED" && e.product === "unlock"));
  // Reserve untouched by a refused sale.
  assert.strictEqual(earn.loadReserveJournal(store.reservePath).balance, 0);
});

ok("unknown agent question books NO sale", () => {
  const store = newStore();
  const r = earn.buyQuestion(store, { buyer: earn.DEMO_SPECTATOR_ID, matchId: "m", agentId: "ghost", question: "hi?", state: syntheticState() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(store.data.totals.sales, 0);
});

console.log("== unlock gating ==");
ok("view decision: summary before unlock, full after — per buyer, per match", () => {
  const store = newStore();
  const state = syntheticState();
  earn.ensureSpectator(store, "alice", 10); // funded spectator ledger
  store.save();
  assert.strictEqual(earn.viewFor(store.data, "alice", state.matchId), "summary");
  assert.strictEqual(earn.buyUnlock(store, { buyer: "alice", matchId: state.matchId }).ok, true);
  assert.strictEqual(earn.viewFor(store.data, "alice", state.matchId), "full");
  assert.strictEqual(earn.viewFor(store.data, "bob", state.matchId), "summary");       // other buyer
  assert.strictEqual(earn.viewFor(store.data, "alice", "another-match"), "summary");   // other match
});
ok("summary view leaks no per-round ledger or data-spend detail; full room has both", () => {
  const state = syntheticState();
  const s = earn.summaryView(state);
  assert.ok(!("perRound" in s) && !("feed" in s) && !("agentData" in s));
  assert.ok(s.leaderboard.every((r) => !("dataSpend" in r)));
  const full = earn.fullDataRoom(state);
  assert.strictEqual(full.perRound.length, 5); // rounds 1,2,5,9,14
  const fadeData = full.agentData.find((a) => a.agentId === "fade");
  assert.strictEqual(fadeData.dataSpend, 0.03);
  assert.deepStrictEqual(fadeData.perRoundData, { 1: 0.01, 2: 0.01, 5: 0.01 });
  assert.strictEqual(full.perRound.find((r) => r.round === 2).dataCharged, 0.30); // fade 0.01 + vex 0.29
});

console.log("== copy-feed settlement ==");
ok("settlement matches the agent's actual fills and the book math, to the cent", () => {
  const state = syntheticState();
  const s = earn.computeCopySettlement(state, "fade", 100);
  // book: 95.00 → 99.75 ⇒ +5% ⇒ shadow $100 → $105.00
  assert.strictEqual(s.bookStart, 95);
  assert.strictEqual(s.bookEnd, 99.75);
  assert.strictEqual(s.endValue, 105);
  assert.strictEqual(s.pnl, 5);
  assert.strictEqual(s.returnPct, 5);
  assert.strictEqual(s.fills.length, 4); // BUY, BUY, SELL, FINAL_CLOSE — vex's BUY excluded
  assert.deepStrictEqual(s.fills.map((f) => f.type), ["BUY", "BUY", "SELL", "FINAL_CLOSE"]);
  assert.strictEqual(s.paper, true);
});
ok("settle via store: open → settled once, second settle refused", () => {
  const store = newStore();
  const state = syntheticState();
  const cf = earn.buyCopyFeed(store, { buyer: earn.DEMO_SPECTATOR_ID, matchId: state.matchId, agentId: "fade" });
  const st = earn.settleCopyFeed(store, { copyFeedId: cf.record.id, state });
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.record.status, "settled");
  assert.strictEqual(st.settlement.endValue, 105);
  assert.ok(store.data.entries.some((e) => e.type === "COPYFEED_SETTLED" && e.pnl === 5));
  assert.strictEqual(earn.settleCopyFeed(store, { copyFeedId: cf.record.id, state }).ok, false);
});
ok("Match 1 receipts: FADE copy-feed demo settlement is exact", () => {
  const m1 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "arena-state.json"), "utf8"));
  const s = earn.computeCopySettlement(m1, "fade", 100);
  assert.strictEqual(s.bookStart, 95);
  assert.strictEqual(s.bookEnd, 94.93);
  assert.strictEqual(s.endValue, 99.93);
  assert.strictEqual(s.pnl, -0.07);
  assert.strictEqual(s.returnPct, -0.07);
  assert.ok(s.fills.length > 0);
});

console.log("== paid questions ==");
ok("answers are grounded in ONLY that agent's state", () => {
  const state = syntheticState();
  const aVex = earn.answerQuestion(state, "vex", "How are you doing?");
  assert.strictEqual(aVex.ok, true);
  assert.ok(aVex.answer.includes("$111.11"), "vex answer carries vex's treasury");
  assert.ok(!aVex.answer.includes("$222.22"), "vex answer must NOT carry audrey's numbers");
  assert.ok(aVex.answer.includes("AERO"), "vex answer names his own position");
  const aAud = earn.answerQuestion(state, "audrey", "How much of your data budget did you burn?");
  assert.ok(aAud.answer.includes("$0.60") && aAud.answer.includes("7 engine refusals"));
  assert.ok(!aAud.answer.includes("$111.11"), "audrey answer must NOT carry vex's numbers");
  assert.ok(/EXHAUSTED/.test(aAud.answer), "audrey is at her cap — the answer says so");
});
ok("answers are deterministic — same question, same answer", () => {
  const state = syntheticState();
  const q = "What's your plan from here?";
  assert.strictEqual(earn.answerQuestion(state, "fade", q).answer, earn.answerQuestion(state, "fade", q).answer);
});
ok("last-action answers quote that agent's own last feed line", () => {
  const state = syntheticState();
  const a = earn.answerQuestion(state, "audrey", "Why did you just hold?");
  assert.ok(a.answer.includes("audrey holds"));
  assert.ok(!a.answer.includes("fade buy"));
});

console.log("== public summary ==");
ok("summary carries products, prices, splits, reserve balance, demo results", () => {
  const store = newStore();
  const state = syntheticState();
  earn.buyUnlock(store, { buyer: earn.DEMO_SPECTATOR_ID, matchId: state.matchId });
  const reserveData = earn.loadReserveJournal(store.reservePath);
  const sum = earn.buildPublicSummary({ journalData: store.data, reserveData, state: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "arena-state.json"), "utf8")) });
  assert.deepStrictEqual(sum.products.map((p) => p.price), [1, 0.25, 2]);
  assert.deepStrictEqual(sum.products[1].splitPerSale, { total: 0.25, house: 0.03, reserve: 0.01, treasury: 0.21 });
  assert.strictEqual(sum.reserve.balance, 0.04);
  const fadeDemo = sum.demo.copyFeedResults.find((r) => r.agentId === "fade");
  assert.strictEqual(fadeDemo.endValue, 99.93);
  assert.strictEqual(sum.totals.gross, 1);
  assert.ok(/ledger mode/i.test(sum.note));
});

console.log("== page parity (arena.html port) ==");
ok("the page's ported demo logic matches the engine exactly", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "arena.html"), "utf8");
  const m = /\/\* EARN-PORT-BEGIN \*\/([\s\S]*?)\/\* EARN-PORT-END \*\//.exec(html);
  assert.ok(m, "arena.html carries the EARN-PORT block");
  const port = new Function(m[1] + "\nreturn { earnSplit, earnAnswer, earnCopySettlement };")();
  const state = syntheticState();
  assert.deepStrictEqual(port.earnSplit(0.25), earn.splitSale(0.25));
  assert.deepStrictEqual(port.earnSplit(2), earn.splitSale(2));
  const q = "How are you doing?";
  assert.strictEqual(port.earnAnswer(state, "vex", q), earn.answerQuestion(state, "vex", q).answer);
  const q2 = "Did the data cap stop you?";
  assert.strictEqual(port.earnAnswer(state, "audrey", q2), earn.answerQuestion(state, "audrey", q2).answer);
  const ps = port.earnCopySettlement(state, "fade", 100);
  const es = earn.computeCopySettlement(state, "fade", 100);
  assert.strictEqual(ps.endValue, es.endValue);
  assert.strictEqual(ps.returnPct, es.returnPct);
  assert.strictEqual(ps.fills.length, es.fills.length);
});

console.log(`\n${passed} checks passed${process.exitCode ? " — FAILURES above" : ""}.`);
