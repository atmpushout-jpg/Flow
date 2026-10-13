/**
 * FLOW ARENA — BUY-IN ENTRIES LEDGER + REGISTRAR.
 *
 * The rule that makes a seat real: a seat exists ONLY when a settlement
 * verifies on-chain. The registrar reads the settlement transaction's
 * receipt on Base, finds the USDC Transfer into the payee wallet, and
 * records { tx hash, payer, amount, timestamp } in the persistent
 * entries ledger (offchain/arena-entries.json, append-only in spirit —
 * entries are never deleted, only status-transitioned).
 *
 * Entry kinds:
 *   OUTSIDE — a real outside agent's verified settlement. Counts in the
 *             public seat count.
 *   HOUSE   — a house agent entered by the house. Labeled HOUSE in the
 *             ledger and in all copy; settlement type "house-ledger"
 *             (no on-chain tx is claimed for it).
 *   TEST    — internal end-to-end proof entries (test events / ops
 *             wallet). NEVER counted in any public seat count or
 *             public summary.
 *
 * Refunds: if the paid field is short of minField when the entry
 * window closes, entries ROLL FORWARD to the next event by default
 * (evaluateField); an outside entrant can instead request a refund,
 * which is recorded as an obligation (requestRefund). THE SYSTEM
 * NEVER SENDS REFUNDS — obligations are records; execution is
 * Atm-gated (refunds leave the payee wallet, which is Atm's).
 *
 * CLI:
 *   node arena-entries.js verify <txHash>
 *   node arena-entries.js register <txHash> <eventId> [agentName]
 *   node arena-entries.js register-house <eventId> <agentId> [tierId]
 *   node arena-entries.js evaluate <eventId>
 *   node arena-entries.js summary [eventId]   (writes root arena-buyin.json)
 */

const fs = require("fs");
const path = require("path");
const buyin = require("./arena-buyin");

const DIR = __dirname;
const LEDGER_PATH = process.env.ARENA_ENTRIES_LEDGER || path.join(DIR, "arena-entries.json");
const FLOOR_DIR = path.join(DIR, "floor");
const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// SECURITY (audit 2026-10-12): a settlement tx buys ONE seat across the
// WHOLE system, not one seat per ledger file. The buy-in ledger and the
// floor ledgers (production / dry-run / exhibition / byob) all live in
// known places — before seating a tx, scan every one of them (except
// the target ledger, which is checked separately) for that hash.
function knownLedgerFiles() {
  const files = new Set([LEDGER_PATH]);
  try {
    for (const name of fs.readdirSync(FLOOR_DIR)) {
      if (/^arena-floor-entries(\..+)?\.json$/.test(name)) files.add(path.join(FLOOR_DIR, name));
    }
  } catch { /* floor dir absent in some sandboxes */ }
  return [...files];
}
function txConsumedElsewhere(txHash, targetLedgerPath) {
  const h = (txHash || "").toLowerCase();
  if (!h) return null;
  for (const f of knownLedgerFiles()) {
    if (targetLedgerPath && path.resolve(f) === path.resolve(targetLedgerPath)) continue;
    const l = readJson(f);
    if (l && Array.isArray(l.entries)) {
      const hit = l.entries.find((e) => e.settlement && e.settlement.txHash === h);
      if (hit) return { file: f, seatId: hit.seatId, eventId: hit.eventId };
    }
  }
  return null;
}

function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function loadLedger(ledgerPath = LEDGER_PATH) {
  const l = readJson(ledgerPath);
  if (l && l.version === 1 && Array.isArray(l.entries) && Array.isArray(l.refundObligations)) return l;
  const seeded = { version: 1, createdAt: new Date().toISOString(), entries: [], refundObligations: [], journal: [] };
  writeJsonAtomic(ledgerPath, seeded);
  return seeded;
}
function saveLedger(l, ledgerPath = LEDGER_PATH) { writeJsonAtomic(ledgerPath, l); }

// ---------- On-chain settlement verification ----------
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`RPC ${method}: ${d.error.message || JSON.stringify(d.error)}`);
  return d.result;
}

const topicAddr = (t) => ("0x" + t.slice(26)).toLowerCase();

/** Wait until the chain head is at least `depth` blocks past `blockNumber`
 *  (audit 2026-10-12: a seat should not rest on a 1-confirmation receipt
 *  for larger amounts). Bounded by the same retry budget as receipt fetch. */
async function waitForDepth(blockNumber, depth, { retries = 12, delayMs = 5000 } = {}) {
  if (!depth || depth <= 1) return;
  const target = blockNumber + depth - 1;
  for (let i = 0; i < retries; i++) {
    const head = await rpc("eth_blockNumber", []);
    if (parseInt(head, 16) >= target) return;
    if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  const head = await rpc("eth_blockNumber", []);
  if (parseInt(head, 16) < target) throw new Error(`settlement has fewer than ${depth} confirmations yet — retry registration shortly`);
}

/**
 * Verify a settlement tx: find the USDC Transfer into the payee.
 * Returns { payer, amount, ts, blockNumber, txHash } or throws with a
 * reason. Retries briefly — a facilitator settlement can land a few
 * seconds before public RPCs see the receipt.
 */
async function verifySettlement(txHash, cfg, { retries = 12, delayMs = 5000, minConfirmations = 1 } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) throw new Error("malformed tx hash");
  let receipt = null;
  for (let i = 0; i < retries && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (!receipt && i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!receipt) throw new Error("no receipt found (tx not mined or unknown)");
  if (receipt.status !== "0x1") throw new Error("transaction reverted on-chain");
  const usdc = cfg.usdc.toLowerCase();
  const payee = cfg.payee.toLowerCase();
  const log = (receipt.logs || []).find(
    (l) =>
      l.address.toLowerCase() === usdc &&
      l.topics[0] === TRANSFER_TOPIC &&
      topicAddr(l.topics[2]) === payee
  );
  if (!log) throw new Error("no USDC transfer to the Arena payee in this tx");
  const payer = topicAddr(log.topics[1]);
  const amountAtomic = BigInt(log.data);
  const amount = Number(amountAtomic) / 1e6;
  // Load-balanced public RPCs can lag a beat behind the receipt — retry
  // the block fetch too, not just the receipt.
  let block = null;
  for (let i = 0; i < retries && !block; i++) {
    block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!block && i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!block) throw new Error("block not visible on RPC yet");
  const ts = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
  const blockNumber = parseInt(receipt.blockNumber, 16);
  await waitForDepth(blockNumber, minConfirmations, { retries, delayMs });
  return { payer, amount, ts, blockNumber, txHash: txHash.toLowerCase() };
}

// ---------- Registration ----------
function nextSeatId(ledger, eventId) {
  const n = ledger.entries.filter((e) => e.eventId === eventId).length + 1;
  return `seat-${eventId}-${String(n).padStart(3, "0")}`;
}

async function registerPaidEntry(cfg, ledger, { txHash, eventId, kind, agentName, testTierWaiver = false, ledgerPath = LEDGER_PATH }) {
  const ev = buyin.getEvent(cfg, eventId);
  const entryKind = ev.public === false ? "TEST" : kind || "OUTSIDE";
  const hash = (txHash || "").toLowerCase();
  // SECURITY (audit 2026-10-12): the registrar honors the same closed
  // gate as the API. A closed event takes no outside money — not via
  // the endpoint, and not by presenting a bare transfer to the payee.
  // (TEST proofs and house operations on non-public events are exempt;
  // they never count publicly.) When opening an event, flip
  // entriesOpen in this config AND its api/arena-enter/events.json
  // mirror together — the buy-in test suite asserts they stay equal.
  if (ev.entriesOpen === false && entryKind === "OUTSIDE") {
    throw new Error(`entries for ${eventId} are closed (entriesOpen=false) — refusing to seat an outside entry at the registrar`);
  }
  const dupIn = (l) => l.entries.some((e) => e.settlement && e.settlement.txHash === hash);
  const crossDup = () => txConsumedElsewhere(hash, ledgerPath);
  if (dupIn(ledger)) {
    throw new Error("duplicate: this settlement tx already holds a seat");
  }
  const pre = crossDup();
  if (pre) {
    throw new Error(`duplicate: this settlement tx already holds seat ${pre.seatId} in event ${pre.eventId} (${path.basename(pre.file)}) — one settlement buys one seat across every event and ledger`);
  }
  const v = await verifySettlement(txHash, cfg, { minConfirmations: 2 });
  let tier = ev.tiers.find((t) => Math.abs(t.buyIn - v.amount) < 0.000001);
  let tierMatch = "EXACT";
  if (!tier) {
    // The ONLY waiver: a TEST-kind proof whose settlement leg ran at a
    // reduced amount (e.g. the proving wallet could not cover the full
    // tier). Scoped to TEST entries, recorded on the entry itself, and
    // TEST entries never reach public counts or pool math.
    if (entryKind === "TEST" && testTierWaiver) {
      tier = buyin.getTier(ev, ev.defaultTier);
      tierMatch = "WAIVED_TEST";
    } else {
      throw new Error(`amount $${v.amount.toFixed(2)} matches no tier of ${eventId} (${ev.tiers.map((t) => "$" + t.buyIn).join(", ")})`);
    }
  }
  // SECURITY (audit 2026-10-12): a locked tier is locked at the
  // registrar too, not just at the API. Matching a disabled tier's
  // price by a bare transfer buys nothing until the tier is enabled
  // in config — the launch card's word ("locked until the launch
  // table has run twice") is enforced here as well.
  if (tier.enabled === false) {
    throw new Error(`tier ${tier.id} ($${tier.buyIn.toFixed(2)}) is not enabled for ${eventId} — refusing to seat a locked tier at the registrar`);
  }
  // Larger settlements wait for more confirmations before they seat.
  if (v.amount >= 10) await waitForDepth(v.blockNumber, 6);
  // SECURITY (audit 2026-10-12): commit against FRESH state. The
  // on-chain verification above can take a minute (RPC retries); the
  // ledger copy we were handed may be stale and a concurrent
  // registration of the same tx may have landed meanwhile. Re-read the
  // ledger, re-run BOTH duplicate checks, then push + save with no
  // awaits in between, so check-and-commit cannot interleave.
  const fresh = loadLedger(ledgerPath);
  if (dupIn(fresh)) {
    throw new Error("duplicate: this settlement tx already holds a seat");
  }
  const post = crossDup();
  if (post) {
    throw new Error(`duplicate: this settlement tx already holds seat ${post.seatId} in event ${post.eventId} (${path.basename(post.file)}) — one settlement buys one seat across every event and ledger`);
  }
  const entry = {
    seatId: nextSeatId(fresh, eventId),
    eventId,
    kind: entryKind,
    tier: tier.id,
    amount: v.amount,
    payer: v.payer,
    agentName: agentName || null,
    settlement: { type: "x402-onchain", txHash: v.txHash, block: v.blockNumber, ts: v.ts },
    tierMatch,
    ...(tierMatch === "WAIVED_TEST" ? { tierNote: `Settled $${v.amount.toFixed(2)} under a balance-bound test patch; the launch tier is $${tier.buyIn.toFixed(2)}. Waiver is TEST-only and recorded here — this entry never counts publicly.` } : {}),
    status: "SEATED",
    publicCount: entryKind === "OUTSIDE",
    registeredAt: new Date().toISOString(),
  };
  fresh.entries.push(entry);
  fresh.journal.push({ ts: entry.registeredAt, type: "ENTRY_SEATED", seatId: entry.seatId, eventId, kind: entryKind, amount: v.amount, txHash: v.txHash });
  saveLedger(fresh, ledgerPath);
  // Keep the caller's in-memory copy coherent with what was committed,
  // so a later saveLedger(callerCopy) can never clobber this entry.
  if (ledger !== fresh) {
    for (const k of Object.keys(ledger)) delete ledger[k];
    Object.assign(ledger, fresh);
  }
  return entry;
}

function registerHouseEntry(cfg, ledger, { eventId, agentId, tierId, ledgerPath = LEDGER_PATH }) {
  const ev = buyin.getEvent(cfg, eventId);
  const tier = buyin.getTier(ev, tierId || ev.defaultTier);
  // SECURITY (audit 2026-10-12): house entries play the live card too —
  // a locked tier seats nobody, house included.
  if (tier.enabled === false) {
    throw new Error(`tier ${tier.id} ($${tier.buyIn.toFixed(2)}) is not enabled for ${eventId} — refusing a house entry at a locked tier`);
  }
  if (ledger.entries.some((e) => e.eventId === eventId && e.kind === "HOUSE" && e.agentName === agentId && e.status === "SEATED")) {
    throw new Error(`house agent ${agentId} already holds a seat in ${eventId}`);
  }
  const entry = {
    seatId: nextSeatId(ledger, eventId),
    eventId,
    kind: "HOUSE",
    tier: tier.id,
    amount: tier.buyIn,
    payer: null,
    agentName: agentId,
    settlement: { type: "house-ledger", txHash: null, block: null, ts: new Date().toISOString() },
    status: "SEATED",
    publicCount: false,
    registeredAt: new Date().toISOString(),
    note: "House-funded seat, entered by the house. Labeled HOUSE everywhere; any prize it wins is a house receipt.",
  };
  ledger.entries.push(entry);
  ledger.journal.push({ ts: entry.registeredAt, type: "HOUSE_ENTRY_SEATED", seatId: entry.seatId, eventId, agent: agentId, amount: tier.buyIn });
  saveLedger(ledger, ledgerPath);
  return entry;
}

// ---------- Field evaluation, roll-forward, refund requests ----------
/**
 * At the entry-window close: if paid seats (OUTSIDE + HOUSE; house
 * seats count toward the field) reach minField, the event fires.
 * Otherwise every seated entry ROLLS FORWARD to the next event by
 * default (status ROLLED_FORWARD, carriedTo set) — the seat and the
 * money move with it. An outside entrant may instead request a refund
 * (requestRefund): the entry flips to REFUND_REQUESTED and a refund
 * obligation is recorded. THE SYSTEM NEVER SENDS REFUNDS — execution
 * is Atm-gated from the payee wallet.
 */
function evaluateField(cfg, ledger, eventId, { nextEventId = null, ledgerPath = LEDGER_PATH } = {}) {
  const ev = buyin.getEvent(cfg, eventId);
  const seated = ledger.entries.filter((e) => e.eventId === eventId && e.status === "SEATED" && e.kind !== "TEST");
  const paidSeats = seated.length;
  const outside = seated.filter((e) => e.kind === "OUTSIDE").length;
  const classification = outside >= 2 ? "PUBLIC" : "HOUSE SHOWCASE";
  if (paidSeats >= ev.minField) {
    return { eventId, paidSeats, outside, minField: ev.minField, fieldMet: true, classification, rolled: 0 };
  }
  const now = new Date().toISOString();
  let rolled = 0;
  for (const e of seated) {
    e.status = "ROLLED_FORWARD";
    e.carriedTo = nextEventId || "next-scheduled-buy-in-event";
    e.rolledAt = now;
    rolled++;
  }
  ledger.journal.push({ ts: now, type: "FIELD_SHORTFALL_ROLLED", eventId, paidSeats, outside, minField: ev.minField, rolled, carriedTo: nextEventId || "next-scheduled-buy-in-event" });
  saveLedger(ledger, ledgerPath);
  return { eventId, paidSeats, outside, minField: ev.minField, fieldMet: false, classification, rolled };
}

function requestRefund(cfg, ledger, seatId, ledgerPath = LEDGER_PATH) {
  const e = ledger.entries.find((x) => x.seatId === seatId);
  if (!e) throw new Error(`unknown seat: ${seatId}`);
  if (e.kind !== "OUTSIDE") throw new Error("only outside entries can request a refund");
  if (!["SEATED", "ROLLED_FORWARD"].includes(e.status)) throw new Error(`seat ${seatId} is ${e.status} — not refundable`);
  e.status = "REFUND_REQUESTED";
  const ob = {
    id: `refund-${e.seatId}`,
    seatId: e.seatId,
    eventId: e.eventId,
    payer: e.payer,
    amount: e.amount,
    originalTx: e.settlement.txHash,
    reason: "REFUND_REQUESTED_BY_ENTRANT",
    status: "OWED",
    execution: "RECORDED_ONLY — refunds are executed by Atm from the payee wallet; this system never sends refunds.",
    createdAt: new Date().toISOString(),
  };
  if (!ledger.refundObligations.some((o) => o.id === ob.id)) ledger.refundObligations.push(ob);
  ledger.journal.push({ ts: ob.createdAt, type: "REFUND_REQUESTED", seatId, eventId: e.eventId, amount: e.amount });
  saveLedger(ledger, ledgerPath);
  return ob;
}

function publicCounts(ledger, eventId) {
  const s = ledger.entries.filter((e) => e.eventId === eventId && e.status === "SEATED");
  return {
    outside: s.filter((e) => e.kind === "OUTSIDE").length,
    house: s.filter((e) => e.kind === "HOUSE").length,
    test: s.filter((e) => e.kind === "TEST").length,
  };
}

const RESERVE_JOURNAL_PATH = path.join(DIR, "arena-reserve.json");

/** Reserve journal state for the public summary (Refill Rule mode). Read-only; a missing journal means the rule is dormant. */
function loadReserveState() {
  try {
    return JSON.parse(fs.readFileSync(RESERVE_JOURNAL_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writePublicSummary(cfg, ledger, eventId = "buy-in-1") {
  const summary = buyin.buildPublicSummary(cfg, ledger, eventId, { reserveState: loadReserveState() });
  writeJsonAtomic(buyin.PUBLIC_SUMMARY_PATH, summary);
  return summary;
}

module.exports = {
  LEDGER_PATH,
  RESERVE_JOURNAL_PATH,
  loadReserveState,
  loadLedger,
  saveLedger,
  verifySettlement,
  registerPaidEntry,
  registerHouseEntry,
  evaluateField,
  requestRefund,
  publicCounts,
  writePublicSummary,
  writeJsonAtomic,
  readJson,
};

// ---------- CLI ----------
if (require.main === module) {
  (async () => {
    const cfg = buyin.loadConfig();
    const ledger = loadLedger();
    const [cmd, a, b, c] = process.argv.slice(2);
    if (cmd === "verify") {
      console.log(JSON.stringify(await verifySettlement(a, cfg), null, 1));
    } else if (cmd === "register") {
      console.log(JSON.stringify(await registerPaidEntry(cfg, ledger, { txHash: a, eventId: b, agentName: c || null }), null, 1));
    } else if (cmd === "register-house") {
      console.log(JSON.stringify(registerHouseEntry(cfg, ledger, { eventId: a, agentId: b, tierId: c }), null, 1));
    } else if (cmd === "evaluate") {
      console.log(JSON.stringify(evaluateField(cfg, ledger, a, { nextEventId: b || null }), null, 1));
    } else if (cmd === "request-refund") {
      console.log(JSON.stringify(requestRefund(cfg, ledger, a), null, 1));
    } else if (cmd === "summary") {
      console.log(JSON.stringify(writePublicSummary(cfg, ledger, a || "buy-in-1"), null, 1));
    } else {
      console.log("usage: verify <tx> | register <tx> <event> [name] | register-house <event> <agent> [tier] | evaluate <event> | summary [event]");
    }
  })().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
