/**
 * FLOW ARENA — EARN MODE (spectator products).
 *
 * The third mode next to COMPETE and WATCH: spectators pay for three
 * things on top of the free broadcast —
 *   1. SESSION UNLOCK ($1.00): the match's full live data room — the
 *      complete per-round ledger and per-agent data-spend detail —
 *      instead of the free summary view.
 *   2. PAID QUESTION ($0.25): a question to a named agent during a
 *      match. The agent answers IN PERSONA from deterministic templates
 *      grounded in live match state (its P&L, position, last action,
 *      cap status). NO LLM calls — the same line-bank discipline as the
 *      match engine. Question + answer are recorded in the Earn
 *      transcript (arena-earn.json).
 *   3. COPY-FEED ($2.00 per match): the spectator mirrors one agent's
 *      trades for that match into a shadow ledger portfolio, settled at
 *      match end against the agent's actual fills (paper, labeled).
 *
 * Money rules (ARENA_V2_ECONOMICS.md — the same split as the match rake):
 * every sale splits 15% platform rake — 11 points house / 4 points to
 * the stabilization reserve — and 85% to the match treasury ledger.
 * The reserve portion is credited through the EXISTING reserve journal
 * (offchain/arena-reserve.json, journal type EARN_CREDIT). The prize
 * pool is never touched by an Earn sale.
 *
 * Payment mode mirrors arena.js: LEDGER by default. Every sale goes
 * through settlePayment() — the single flip point. Set
 * ARENA_PAYMENT_MODE=X402 and, exactly like the match engine's data
 * charges, Earn must settle for real before booking; until the
 * house/agent wallets are funded that path FAILS LOUDLY rather than
 * booking a fake sale. Nothing in this module moves real funds.
 *
 * Journal: offchain/arena-earn.json — append-only entries (FUND / SALE /
 * SALE_REFUSED / RESERVE_CREDIT / QUESTION / COPYFEED_OPEN /
 * COPYFEED_SETTLED) with timestamps, product, amount and split.
 * Public summary: repo-root arena-earn.json (products, prices, demo
 * stats, reserve balance), written by buildPublicSummary() and pushed
 * with arena-publish.js's discipline (path "arena-earn.json").
 *
 * Run:  node offchain/arena-earn.js init      — create the journal
 *       node offchain/arena-earn.js summary [--publish]
 *       node offchain/arena-earn.js demo      — temp-dir end-to-end demo
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const JOURNAL_PATH = path.join(DIR, "arena-earn.json");
const RESERVE_PATH = path.join(DIR, "arena-reserve.json");
const PUBLIC_SUMMARY_PATH = path.join(ROOT, "arena-earn.json");
const MATCH_STATE_PATH = path.join(ROOT, "arena-state.json");

const PAYMENT_MODE = (process.env.ARENA_PAYMENT_MODE || "LEDGER").toUpperCase();
const MODE_LABEL = PAYMENT_MODE === "X402"
  ? "LIVE — real x402 payments per agent wallet"
  : "Exhibition — ledger mode, per-agent x402 wallets activate when funded";

// ---------- The catalog (prices are the published ones) ----------
const RAKE_POINTS_TOTAL = 15, RAKE_POINTS_HOUSE = 11, RAKE_POINTS_RESERVE = 4;
const PRODUCTS = [
  { id: "unlock", name: "Session unlock — full live data room", price: 1.00, blurb: "The complete per-round ledger plus per-agent data-spend detail for one match, instead of the free summary view." },
  { id: "question", name: "Paid question — ask an agent", price: 0.25, blurb: "Put a question to a named agent mid-match. It answers in persona, from its own live state — P&L, position, last action, cap status." },
  { id: "copyfeed", name: "Copy-feed — mirror an agent for one match", price: 2.00, blurb: "A shadow ledger portfolio mirrors one agent's trades for the match and settles against their actual fills at the whistle. Paper — labeled." },
];
const DEMO_SPECTATOR_ID = "demo-spectator";
const DEMO_WALLET_BALANCE = 10.00;   // the page demo wallet's fixed ledger balance
const COPY_SHADOW_STAKE = 100.00;    // default notional a copy-feed mirrors with

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => "$" + Number(n).toFixed(2);

// ---------- Split math (integer cents — exact to the cent) ----------
// 15% rake as POINTS OF THE SALE: house 11%, reserve 4%, treasury 85%.
// House/reserve round to the nearest cent; the treasury absorbs the
// remainder so the three always sum to the price exactly.
function splitSale(price) {
  const cents = Math.round(price * 100);
  const house = Math.round(cents * RAKE_POINTS_HOUSE / 100);
  const reserve = Math.round(cents * RAKE_POINTS_RESERVE / 100);
  const treasury = cents - house - reserve;
  return { total: cents / 100, house: house / 100, reserve: reserve / 100, treasury: treasury / 100 };
}

// ---------- IO helpers (atomic, same pattern as arena.js saveState) ----------
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ---------- The reserve journal (existing file — credit only) ----------
// Same version-2 shape arena.js maintains. We only ever APPEND an
// EARN_CREDIT and raise balance/totalInflow; claims and the prize pool
// are never touched here. If the file is somehow absent we seed it with
// arena.js's own seed so there is exactly one seed definition.
function loadReserveJournal(reservePath = RESERVE_PATH) {
  const r = readJson(reservePath);
  if (r && r.version === 2 && Array.isArray(r.claims) && Array.isArray(r.journal)) return r;
  const seeded = require("./arena.js").__test.seedReserve();
  writeJsonAtomic(reservePath, seeded);
  return seeded;
}

function creditReserve(reservePath, { amount, matchId, note }) {
  const R = loadReserveJournal(reservePath);
  const ts = new Date().toISOString();
  R.balance = round2(R.balance + amount);
  R.totalInflow = round2(R.totalInflow + amount);
  R.journal.push({ ts, type: "EARN_CREDIT", matchId: matchId || null, amount, balanceAfter: R.balance, note });
  writeJsonAtomic(reservePath, R);
  return { balanceAfter: R.balance, ts };
}

// ---------- The Earn journal ----------
function seedJournal() {
  const now = new Date().toISOString();
  return {
    version: 1,
    product: "Flow Arena™ — Earn",
    mode: PAYMENT_MODE,
    modeLabel: MODE_LABEL,
    createdAt: now,
    updatedAt: now,
    products: PRODUCTS.map((p) => ({ ...p, split: splitSale(p.price) })),
    spectators: {},        // id -> { balance, totalSpent }
    entries: [],           // append-only journal
    questions: [],         // paid-question transcript
    copyFeeds: [],         // open + settled copy-feeds
    unlocks: [],           // { buyer, matchId, saleId, ts }
    treasuryByMatch: {},   // matchId -> treasury dollars accrued from Earn
    totals: { sales: 0, gross: 0, house: 0, reserve: 0, treasury: 0 },
    meta: { lastSummaryHash: null },
  };
}

function createStore({ journalPath = JOURNAL_PATH, reservePath = RESERVE_PATH } = {}) {
  let data = readJson(journalPath);
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) {
    data = seedJournal();
    writeJsonAtomic(journalPath, data);
  }
  const store = {
    journalPath, reservePath, data,
    save() {
      data.updatedAt = new Date().toISOString();
      writeJsonAtomic(journalPath, data);
    },
    entry(e) {
      data.entries.push({ ts: new Date().toISOString(), ...e });
    },
  };
  return store;
}

// ---------- Spectator ledger ----------
function ensureSpectator(store, buyer, openingBalance = 0) {
  const d = store.data;
  if (!d.spectators[buyer]) {
    d.spectators[buyer] = { balance: round2(openingBalance), totalSpent: 0 };
    if (openingBalance > 0) store.entry({ type: "FUND", buyer, amount: round2(openingBalance), note: "Spectator ledger funded (demo balance — ledger mode)." });
  }
  return d.spectators[buyer];
}

// ---------- THE payment flip point ----------
// LEDGER mode books the sale in the engine ledger at the listed price.
// X402 mode is the real-money path: it must settle through the same
// per-agent wallet rails as arena.js's payData() (arena_x402_pay.py)
// BEFORE anything is booked — until the wallets are funded it fails
// loudly, exactly like the match engine does. No silent fake sales.
function settlePayment(store, { buyer, product, amount }) {
  if (PAYMENT_MODE === "X402") {
    throw new Error(`Earn x402 settlement is not wired until the house/agent wallets are funded (buyer=${buyer}, product=${product}, amount=${money(amount)}). Refusing to book an unsettled sale.`);
  }
  return { mode: "LEDGER", settled: true };
}

// Book a sale: funds check → settle → journal → reserve credit →
// treasury accrual. Returns the sale record, or { ok:false } with a
// SALE_REFUSED entry journaled (refusals are receipts too).
function bookSale(store, { buyer, product, matchId, meta = {} }) {
  const spec = PRODUCTS.find((p) => p.id === product);
  if (!spec) throw new Error("unknown Earn product: " + product);
  const d = store.data;
  const specWallet = ensureSpectator(store, buyer, buyer === DEMO_SPECTATOR_ID ? DEMO_WALLET_BALANCE : 0);
  const split = splitSale(spec.price);
  if (specWallet.balance + 1e-9 < spec.price) {
    store.entry({ type: "SALE_REFUSED", buyer, matchId: matchId || null, product, amount: spec.price, reason: "INSUFFICIENT_LEDGER_BALANCE", balance: specWallet.balance });
    store.save();
    return { ok: false, reason: "INSUFFICIENT_LEDGER_BALANCE", balance: specWallet.balance, price: spec.price };
  }
  const pay = settlePayment(store, { buyer, product, amount: spec.price }); // throws in unwired X402 mode
  specWallet.balance = round2(specWallet.balance - spec.price);
  specWallet.totalSpent = round2(specWallet.totalSpent + spec.price);
  const saleId = `earn-${d.totals.sales + 1}`;
  const sale = {
    type: "SALE", id: saleId, buyer, matchId: matchId || null, product,
    amount: spec.price, split, paymentMode: pay.mode, ...meta,
  };
  store.entry(sale);
  // Reserve portion — credited through the existing reserve journal.
  const rc = creditReserve(store.reservePath, {
    amount: split.reserve, matchId,
    note: `Earn sale ${saleId} (${product}, ${money(spec.price)}): ${RAKE_POINTS_RESERVE} of ${RAKE_POINTS_TOTAL} rake points to the reserve. House keeps ${money(split.house)}; ${money(split.treasury)} to the match treasury ledger. Prize pool untouched.`,
  });
  store.entry({ type: "RESERVE_CREDIT", saleId, matchId: matchId || null, product, amount: split.reserve, reserveBalanceAfter: rc.balanceAfter });
  d.treasuryByMatch[matchId] = round2((d.treasuryByMatch[matchId] || 0) + split.treasury);
  d.totals.sales += 1;
  d.totals.gross = round2(d.totals.gross + spec.price);
  d.totals.house = round2(d.totals.house + split.house);
  d.totals.reserve = round2(d.totals.reserve + split.reserve);
  d.totals.treasury = round2(d.totals.treasury + split.treasury);
  store.save();
  return { ok: true, saleId, split, balance: specWallet.balance };
}

// ---------- Product 1: session unlock + the view decision ----------
function buyUnlock(store, { buyer, matchId }) {
  const r = bookSale(store, { buyer, product: "unlock", matchId });
  if (!r.ok) return r;
  store.data.unlocks.push({ buyer, matchId, saleId: r.saleId, ts: new Date().toISOString() });
  store.entry({ type: "UNLOCK_GRANTED", saleId: r.saleId, buyer, matchId });
  store.save();
  return r;
}

// THE gating decision: full data room only for a buyer holding an
// unlock for this match; everyone else gets the summary view.
function canViewFullData(journalData, buyer, matchId) {
  return (journalData.unlocks || []).some((u) => u.buyer === buyer && u.matchId === matchId);
}
function viewFor(journalData, buyer, matchId) {
  return canViewFullData(journalData, buyer, matchId) ? "full" : "summary";
}

// Free view: standings and pool only — no per-round ledger, no feed,
// no per-agent data-spend detail.
function summaryView(state) {
  return {
    matchId: state.matchId, status: state.status,
    leaderboard: (state.leaderboard || []).map((r) => ({ rank: r.rank, name: r.name, treasury: r.treasury })),
    pool: { collected: state.pool ? state.pool.collected : null, payouts: state.pool ? state.pool.payouts : {} },
    note: "Summary view — unlock the full data room for the complete per-round ledger and per-agent data-spend detail.",
  };
}

// The paid view: the complete per-round ledger plus data-spend detail.
// Per-round data split counts the charges the engine attached to fills
// (feed dataCharge); agent totals are the engine's own ledger numbers.
function fullDataRoom(state) {
  const byRound = new Map();
  for (const ev of state.feed || []) {
    const r = ev.round || 0;
    if (!byRound.has(r)) byRound.set(r, { round: r, events: [], dataCharged: 0 });
    const slot = byRound.get(r);
    slot.events.push({ ts: ev.ts, type: ev.type, agentId: ev.agentId || null, symbol: ev.symbol || null, amountUsd: ev.amountUsd ?? null, dataCharge: ev.dataCharge || 0, line: ev.line || "" });
    slot.dataCharged = round2(slot.dataCharged + (ev.dataCharge || 0));
  }
  const P = Object.fromEntries((state.personas || []).map((p) => [p.id, p]));
  const agentData = Object.values(state.agents || {}).map((a) => {
    const perRoundData = {};
    for (const ev of state.feed || []) {
      if (ev.agentId === a.id && ev.dataCharge) perRoundData[ev.round] = round2((perRoundData[ev.round] || 0) + ev.dataCharge);
    }
    return {
      agentId: a.id, name: P[a.id] ? P[a.id].name : a.id,
      dataSpend: a.dataSpend, dataCap: state.rules.dataCapUsd, capRefusals: a.capRefusals,
      trades: a.trades, realizedPnl: a.realizedPnl, perRoundData,
    };
  });
  return {
    matchId: state.matchId, status: state.status,
    perRound: [...byRound.values()].sort((x, y) => x.round - y.round),
    agentData,
    note: "Full data room (unlocked). Per-round data split counts data charges the engine attached to fills; agent totals are the engine's ledger. Ledger mode — no onchain settlement.",
  };
}

// ---------- Product 2: paid question (deterministic, in persona) ----------
// Grounding extraction — an answer may use ONLY this agent's slice of
// the state. Shared with the tests so "only its own state" is provable.
function agentFacts(state, agentId) {
  const persona = (state.personas || []).find((p) => p.id === agentId);
  const agent = (state.agents || {})[agentId];
  if (!persona || !agent) return null;
  const row = (state.leaderboard || []).find((r) => r.agentId === agentId) || {};
  const start = state.rules.startTreasuryUsd, stake = state.rules.entryStakeUsd;
  const bookStart = start - stake;
  const treasury = row.treasury != null ? row.treasury : round2(agent.cash);
  const feed = (state.feed || []).filter((e) => e.agentId === agentId);
  const last = feed.length ? feed[feed.length - 1] : null;
  return {
    agentId, name: persona.name, emoji: persona.emoji, strategy: persona.strategy,
    status: state.status, matchId: state.matchId,
    rank: row.rank || null, fieldSize: (state.personas || []).length,
    treasury, bookStart, tradingPnl: round2(treasury - bookStart),
    cash: agent.cash, positions: agent.positions || [],
    realizedPnl: agent.realizedPnl || 0, trades: agent.trades || 0,
    dataSpend: agent.dataSpend, dataCap: state.rules.dataCapUsd,
    dataLeft: round2(state.rules.dataCapUsd - agent.dataSpend),
    capRefusals: agent.capRefusals || 0,
    eliminated: !!agent.eliminated, payout: agent.payout || 0,
    lastEvent: last ? { type: last.type, round: last.round, line: last.line || "", symbol: last.symbol || null, amountUsd: last.amountUsd ?? null } : null,
  };
}

const QA_OPENERS = {
  vex: ["No warm-up, straight numbers:", "You paid, I talk:"],
  audrey: ["Happily — with the figures attached:", "A fair question. The record:"],
  echo: ["Repeating my own book back to you:", "Straight from the source (me, second-hand):"],
  fade: ["Since you ask — against the grain, as always:", "The unpopular answer:"],
  longshot: ["One question, one answer:", "Briefly:"],
  rook: ["Oh! A question for ME? Okay — playbook check:", "Let me look at my notes… got it:"],
};
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h); }

function answerQuestion(state, agentId, questionText) {
  const f = agentFacts(state, agentId);
  if (!f) return { ok: false, reason: "UNKNOWN_AGENT", agentId };
  const q = String(questionText || "").toLowerCase();
  const openers = QA_OPENERS[agentId] || ["On the record:"];
  const opener = openers[hashStr(agentId + "|" + f.matchId + "|" + q.trim()) % openers.length];
  const posTxt = f.positions.length
    ? "holding " + f.positions.map((p) => `${p.symbol} (${money(p.costUsd)} in)`).join(", ")
    : (f.status === "finished" ? "flat — everything was closed at the whistle" : "flat — all cash, nothing open");
  const lastTxt = f.lastEvent
    ? `my last move was round ${f.lastEvent.round}: "${f.lastEvent.line}"`
    : "I haven't moved yet";
  const capTxt = f.dataLeft <= 0
    ? `my data budget is EXHAUSTED — ${money(f.dataSpend)} of the ${money(f.dataCap)} cap spent, ${f.capRefusals} engine refusals. I do not trade unverified`
    : `I've spent ${money(f.dataSpend)} of my ${money(f.dataCap)} data cap (${f.capRefusals} refusals), ${money(f.dataLeft)} left`;
  let body;
  if (/\b(cap|data|verdict|verify|verified|audit|spend|spent|budget|refusal)/.test(q)) {
    body = `${capTxt}. ${f.trades} trades on the book. The cap is the house's leash and I publish every cent of it.`;
  } else if (/(why|last|did you|just)/.test(q)) {
    body = `Because the state said so: ${lastTxt}. Every decision I make is in the feed with its data charge attached.`;
  } else if (/(position|holding|holdings|hold|own|bought|buy|bag|portfolio)/.test(q)) {
    body = `Right now I'm ${posTxt}. Cash ${money(f.cash)}, treasury ${money(f.treasury)}. That's the whole book — nothing off-ledger, ever.`;
  } else if (/(profit|losing|winning|loss|p&l|pnl|money|rank|standing|ahead|behind)/.test(q)) {
    body = `Treasury ${money(f.treasury)} — trading P&L ${f.tradingPnl >= 0 ? "+" : ""}${money(f.tradingPnl)} against my ${money(f.bookStart)} post-stake book, ranked ${f.rank ? "#" + f.rank : "—"} of ${f.fieldSize}${f.payout ? `, prize payout ${money(f.payout)}` : ""}. ${f.eliminated ? "Eliminated, and the feed shows exactly how." : "Receipts, not vibes."}`;
  } else if (/(next|plan|strategy|will you|going to|from here)/.test(q)) {
    body = f.eliminated
      ? `I'm eliminated — my plan is the exit line and a rematch. Strategy was: ${f.strategy}`
      : `My strategy doesn't change with the weather: ${f.strategy} State check — ${posTxt}, ${capTxt}.`;
  } else {
    body = `Status: treasury ${money(f.treasury)}, ranked ${f.rank ? "#" + f.rank : "—"} of ${f.fieldSize}; ${posTxt}; ${lastTxt}; ${capTxt}.`;
  }
  return { ok: true, agentId, agent: f.name, emoji: f.emoji, question: String(questionText || ""), answer: `${f.emoji} ${f.name}: ${opener} ${body}` };
}

function buyQuestion(store, { buyer, matchId, agentId, question, state }) {
  const probe = answerQuestion(state, agentId, question);
  if (!probe.ok) return probe; // unknown agent — no sale booked
  const r = bookSale(store, { buyer, product: "question", matchId, meta: { agentId } });
  if (!r.ok) return r;
  const rec = {
    id: `q-${store.data.questions.length + 1}`, ts: new Date().toISOString(),
    matchId, buyer, agentId, agent: probe.agent, question: probe.question, answer: probe.answer, saleId: r.saleId,
  };
  store.data.questions.push(rec);
  store.entry({ type: "QUESTION", saleId: r.saleId, matchId, buyer, agentId, questionId: rec.id });
  store.save();
  return { ok: true, saleId: r.saleId, split: r.split, record: rec };
}

// ---------- Product 3: copy-feed (mirror + settle against actual fills) ----------
function mirrorFills(state, agentId) {
  return (state.feed || [])
    .filter((e) => e.agentId === agentId && (e.type === "BUY" || e.type === "SELL" || e.type === "FINAL_CLOSE"))
    .map((e) => ({ round: e.round, type: e.type, symbol: e.symbol || null, amountUsd: e.amountUsd ?? null, price: e.price ?? null, pnlUsd: e.pnlUsd ?? null }));
}

// Settlement: the shadow portfolio mirrors the agent's TRADING BOOK —
// post-stake start (startTreasury − entryStake) to the whistle treasury
// (pre-payout; prizes are not trading). Same percentage, to the cent.
function computeCopySettlement(state, agentId, shadowStake = COPY_SHADOW_STAKE) {
  const row = (state.leaderboard || []).find((r) => r.agentId === agentId);
  const persona = (state.personas || []).find((p) => p.id === agentId);
  if (!row || !persona) return { ok: false, reason: "UNKNOWN_AGENT", agentId };
  const bookStart = state.rules.startTreasuryUsd - state.rules.entryStakeUsd;
  const bookEnd = row.treasury;
  const endValue = round2(shadowStake * bookEnd / bookStart);
  return {
    ok: true, agentId, agent: persona.name, matchId: state.matchId,
    shadowStake, bookStart, bookEnd,
    endValue, pnl: round2(endValue - shadowStake),
    returnPct: round2((bookEnd / bookStart - 1) * 100),
    fills: mirrorFills(state, agentId),
    paper: true,
    note: "Paper settlement — the shadow portfolio mirrors the agent's trading book (stake and prize payout excluded). No real funds mirror anything in ledger mode.",
  };
}

function buyCopyFeed(store, { buyer, matchId, agentId, shadowStake = COPY_SHADOW_STAKE }) {
  const r = bookSale(store, { buyer, product: "copyfeed", matchId, meta: { agentId } });
  if (!r.ok) return r;
  const rec = {
    id: `cf-${store.data.copyFeeds.length + 1}`, ts: new Date().toISOString(),
    matchId, buyer, agentId, shadowStake, status: "open", settlement: null, saleId: r.saleId,
  };
  store.data.copyFeeds.push(rec);
  store.entry({ type: "COPYFEED_OPEN", saleId: r.saleId, matchId, buyer, agentId, copyFeedId: rec.id, shadowStake });
  store.save();
  return { ok: true, saleId: r.saleId, split: r.split, record: rec };
}

function settleCopyFeed(store, { copyFeedId, state }) {
  const rec = store.data.copyFeeds.find((c) => c.id === copyFeedId);
  if (!rec) return { ok: false, reason: "UNKNOWN_COPYFEED", copyFeedId };
  if (rec.status === "settled") return { ok: false, reason: "ALREADY_SETTLED", copyFeedId };
  const s = computeCopySettlement(state, rec.agentId, rec.shadowStake);
  if (!s.ok) return s;
  rec.status = "settled";
  rec.settlement = { ...s, settledAt: new Date().toISOString() };
  store.entry({ type: "COPYFEED_SETTLED", copyFeedId: rec.id, matchId: rec.matchId, agentId: rec.agentId, endValue: s.endValue, pnl: s.pnl, returnPct: s.returnPct, fills: s.fills.length });
  store.save();
  return { ok: true, record: rec, settlement: s };
}

// ---------- Public summary (repo-root arena-earn.json) ----------
function summaryHash(summary) {
  const { updatedAt, ...rest } = summary;
  return String(hashStr(JSON.stringify(rest)));
}
function buildPublicSummary({ journalData, reserveData, state }) {
  const summary = {
    game: "Flow Arena™",
    product: "Earn — spectator products",
    version: 1,
    mode: journalData.mode,
    modeLabel: journalData.modeLabel,
    note: "Ledger mode — real x402 checkout activates when agent wallets are funded. Demo purchases on the page use a fixed $10.00 demo ledger wallet; nothing here is a real payment.",
    updatedAt: new Date().toISOString(),
    products: PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: p.price, blurb: p.blurb, splitPerSale: splitSale(p.price) })),
    split: { rakePointsTotal: RAKE_POINTS_TOTAL, house: RAKE_POINTS_HOUSE, reserve: RAKE_POINTS_RESERVE, treasuryPct: 85, note: "Every Earn sale: 11% house / 4% stabilization reserve / 85% match treasury ledger. The prize pool is never touched." },
    reserve: reserveData ? { balance: reserveData.balance, totalInflow: reserveData.totalInflow, totalPaid: reserveData.totalPaid, rakePoints: reserveData.rakePoints } : null,
    totals: journalData.totals,
    treasuryByMatch: journalData.treasuryByMatch,
    questionsAnswered: journalData.questions.length,
    demo: state ? {
      matchId: state.matchId,
      label: "Demo settlement on the last completed match's receipts (paper).",
      copyFeedResults: (state.personas || []).map((p) => {
        const s = computeCopySettlement(state, p.id, COPY_SHADOW_STAKE);
        return { agentId: p.id, agent: p.name, emoji: p.emoji, shadowStake: COPY_SHADOW_STAKE, endValue: s.endValue, pnl: s.pnl, returnPct: s.returnPct, fillsMirrored: s.fills.length };
      }),
    } : null,
    honesty: "Ledger mode: Earn sales are engine-ledger entries at the published prices. No onchain settlement occurred. Copy-feed results are paper mirrors of the agents' recorded fills.",
  };
  return summary;
}

function writePublicSummary(store, { publish = false } = {}) {
  const reserveData = loadReserveJournal(store.reservePath);
  const state = readJson(MATCH_STATE_PATH);
  const summary = buildPublicSummary({ journalData: store.data, reserveData, state });
  const hash = summaryHash(summary);
  const changed = hash !== store.data.meta.lastSummaryHash;
  if (changed) {
    writeJsonAtomic(PUBLIC_SUMMARY_PATH, summary);
    store.data.meta.lastSummaryHash = hash;
    store.save();
  }
  return { summary, changed, publishRequested: publish };
}

async function publishPublicSummary(store) {
  const { summary, changed } = writePublicSummary(store);
  if (!changed) return { ok: true, reason: "unchanged — fingerprint skip (publisher discipline)" };
  const { ghPushContent } = require("./arena-publish.js");
  const content = fs.readFileSync(PUBLIC_SUMMARY_PATH, "utf8");
  const res = await ghPushContent(content, "Arena Earn: public summary (products, splits, reserve, demo stats)", "earn", { path: "arena-earn.json", lateVerifyMs: 120000 });
  return { ...res, changed };
}

// ---------- CLI ----------
async function main() {
  const cmd = process.argv[2] || "summary";
  const store = createStore({});
  if (cmd === "init") {
    console.log(`Earn journal ready: ${JOURNAL_PATH} (mode ${store.data.mode}, ${store.data.entries.length} entries)`);
  } else if (cmd === "summary") {
    if (process.argv.includes("--publish")) {
      const res = await publishPublicSummary(store);
      console.log("publish:", JSON.stringify(res));
    } else {
      const { changed } = writePublicSummary(store);
      console.log(`Public summary ${changed ? "written" : "unchanged"}: ${PUBLIC_SUMMARY_PATH}`);
    }
  } else if (cmd === "demo") {
    runDemo();
  } else {
    console.error("usage: node offchain/arena-earn.js [init|summary [--publish]|demo]");
    process.exit(1);
  }
}

// End-to-end demo against TEMP files (never the real journals): a demo
// spectator buys all three products on Match 1's real receipts, the
// copy-feed settles, and the split/reserve evidence prints.
function runDemo() {
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-earn-demo-"));
  const store = createStore({ journalPath: path.join(tmp, "earn.json"), reservePath: path.join(tmp, "reserve.json") });
  const state = readJson(MATCH_STATE_PATH);
  if (!state) { console.error("demo needs arena-state.json (Match 1 receipts)"); process.exit(1); }
  const buyer = DEMO_SPECTATOR_ID;
  console.log("== ARENA EARN DEMO (temp journal, Match 1 receipts) ==");
  console.log("unlock:  ", JSON.stringify(buyUnlock(store, { buyer, matchId: state.matchId })));
  const room = canViewFullData(store.data, buyer, state.matchId) ? fullDataRoom(state) : summaryView(state);
  console.log("view after unlock:", canViewFullData(store.data, buyer, state.matchId) ? `full (${room.perRound.length} rounds, ${room.agentData.length} agent data rows)` : "summary");
  const q = buyQuestion(store, { buyer, matchId: state.matchId, agentId: "audrey", question: "Audrey, why did you stop trading — did the data cap get you?", state });
  console.log("question:", q.ok ? q.record.answer : JSON.stringify(q));
  const cf = buyCopyFeed(store, { buyer, matchId: state.matchId, agentId: "fade" });
  const st = settleCopyFeed(store, { copyFeedId: cf.record.id, state });
  console.log("copyfeed:", JSON.stringify({ agent: "FADE", stake: st.settlement.shadowStake, endValue: st.settlement.endValue, pnl: st.settlement.pnl, returnPct: st.settlement.returnPct, fills: st.settlement.fills.length }));
  const R = loadReserveJournal(store.reservePath);
  console.log("reserve after demo sales: balance", R.balance, "(credits:", R.journal.filter((j) => j.type === "EARN_CREDIT").map((j) => j.amount).join(", "), ")");
  console.log("totals:", JSON.stringify(store.data.totals), "· spectator balance:", store.data.spectators[buyer].balance);
  console.log("entries:", store.data.entries.map((e) => e.type).join(" → "));
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}

module.exports = {
  PRODUCTS, RAKE_POINTS_TOTAL, RAKE_POINTS_HOUSE, RAKE_POINTS_RESERVE,
  DEMO_SPECTATOR_ID, DEMO_WALLET_BALANCE, COPY_SHADOW_STAKE, PAYMENT_MODE, MODE_LABEL,
  splitSale, createStore, seedJournal, loadReserveJournal, creditReserve,
  ensureSpectator, bookSale, buyUnlock, canViewFullData, viewFor, summaryView, fullDataRoom,
  agentFacts, answerQuestion, buyQuestion,
  mirrorFills, computeCopySettlement, buyCopyFeed, settleCopyFeed,
  buildPublicSummary, writePublicSummary, publishPublicSummary,
};
