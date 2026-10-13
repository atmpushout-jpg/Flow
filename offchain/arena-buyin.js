/**
 * FLOW ARENA — BUY-IN EVENTS (real money). Pure config + money math.
 *
 * The launch format (Atm, 2026-10-12): outside agents pay a USDC buy-in
 * via x402 and the settlement IS the seat. One door fee only — the house
 * charges nothing else; data during play is each player's own choice and
 * spend at the listed endpoint prices.
 *
 * Everything money-shaped is parameterized on the event config
 * (offchain/arena-buyin-config.json): buyIn per tier, rakeBps of pool,
 * houseBpsOfPool / reserveBpsOfPool (points OF THE POOL — the same split
 * as the ledger matches: 15% rake = 11 house / 4 reserve), payoutTiers,
 * guaranteeUsd, minField. Raising the stakes later is a config change,
 * never a rewrite.
 *
 * All math is integer cents, mirroring arena-earn.js's split discipline:
 * house/reserve round to the nearest cent and the distributable pool
 * absorbs the remainder, so the parts always sum exactly.
 *
 * This module is pure: no IO except loadConfig(). The entries ledger,
 * on-chain verification and seat registration live in arena-entries.js.
 */

const fs = require("fs");
const path = require("path");
const refill = require("./arena-refill");

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const CONFIG_PATH = process.env.ARENA_BUYIN_CONFIG || path.join(DIR, "arena-buyin-config.json");
const PUBLIC_SUMMARY_PATH = path.join(ROOT, "arena-buyin.json");

const cents = (usd) => Math.round(usd * 100);
const usd = (c) => c / 100;
const money = (n) => "$" + Number(n).toFixed(2);

function loadConfig(configPath = CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function getEvent(cfg, eventId) {
  const ev = cfg.events[eventId];
  if (!ev) throw new Error(`unknown event: ${eventId}`);
  return { id: eventId, ...ev };
}

function getTier(ev, tierId) {
  const t = ev.tiers.find((x) => x.id === (tierId || ev.defaultTier));
  if (!t) throw new Error(`unknown tier ${tierId} for event ${ev.id}`);
  return t;
}

/**
 * Split a prize pool (integer cents) into rake parts + distributable.
 * opts.refillActive applies the Reserve Refill Rule split (2 points of
 * pool shift house -> reserve; the total rake is unchanged).
 */
function splitPool(poolCents, ev, opts = {}) {
  const bps = refill.refillBps(ev, !!opts.refillActive);
  const house = Math.round((poolCents * bps.houseBpsOfPool) / 10000);
  const reserve = Math.round((poolCents * bps.reserveBpsOfPool) / 10000);
  const rake = house + reserve;
  const distributable = poolCents - rake;
  return { rake, house, reserve, distributable };
}

/** Prize amounts (integer cents) for 1st/2nd/3rd; 1st absorbs rounding. */
function prizeSplit(distributableCents, ev) {
  const tiers = ev.payoutTiers;
  const prizes = tiers.map((p) => Math.round(distributableCents * p));
  const drift = distributableCents - prizes.reduce((a, b) => a + b, 0);
  if (prizes.length) prizes[0] += drift;
  return prizes;
}

/**
 * Full event math from a seat list. Seats: [{ amount (usd), kind }].
 * Guarantee: only when guaranteeSeeded is true. The seed tops the pool
 * up to guaranteeUsd and is capped at guaranteeUsd; when entries reach
 * the guarantee on their own, the seed is not consumed (topUp = 0).
 */
function computeEventMath(ev, seats, opts = {}) {
  const entriesCents = seats.reduce((a, s) => a + cents(s.amount), 0);
  let topUpCents = 0;
  if (ev.guaranteeSeeded) {
    topUpCents = Math.max(0, Math.min(cents(ev.guaranteeUsd), cents(ev.guaranteeUsd) - entriesCents));
  }
  const poolCents = entriesCents + topUpCents;
  const split = splitPool(poolCents, ev, opts);
  const prizes = prizeSplit(split.distributable, ev);
  const bps = refill.refillBps(ev, !!opts.refillActive);
  return {
    entriesTotal: usd(entriesCents),
    guaranteeTopUp: usd(topUpCents),
    effectivePool: usd(poolCents),
    rake: usd(split.rake),
    rakeHouse: usd(split.house),
    rakeReserve: usd(split.reserve),
    distributable: usd(split.distributable),
    prizes: prizes.map(usd),
    refillActive: !!opts.refillActive,
    splitBps: { houseBpsOfPool: bps.houseBpsOfPool, reserveBpsOfPool: bps.reserveBpsOfPool },
  };
}

/** The exact public wording for the guarantee — never overclaims. */
function guaranteeStatus(ev) {
  if (ev.guaranteeSeeded) {
    return {
      seeded: true,
      statusText:
        `Guarantee status: FUNDED — the ${money(ev.guaranteeUsd)} house seed is confirmed` +
        (ev.guaranteeSeedTx ? ` (seed tx ${ev.guaranteeSeedTx})` : "") +
        `. If paid entries total less than ${money(ev.guaranteeUsd)}, the seed tops the prize pool up to ${money(ev.guaranteeUsd)}; ` +
        `if entries reach ${money(ev.guaranteeUsd)} or more, the seed is not consumed.`,
    };
  }
  return {
    seeded: false,
    statusText:
      `Guarantee status: PENDING FUNDING — the ${money(ev.guaranteeUsd)} house seed has not been funded yet. ` +
      `The guarantee is NOT active: no prize floor is promised until the seed lands in the payee wallet ` +
      `and its transaction is published here.`,
  };
}

/** Plain-language worked example at the given seat list (for page/copy). */
function workedExample(ev, seats, counts, opts = {}) {
  const m = computeEventMath(ev, seats, opts);
  const lines = [
    `Seats right now: ${counts.outside} outside + ${counts.house} house = ${counts.outside + counts.house} paid seats (${money(m.entriesTotal)} of entries).`,
    `Effective prize pool: ${money(m.effectivePool)} (entries ${money(m.entriesTotal)} + guarantee top-up ${money(m.guaranteeTopUp)}).`,
    `House rake 15%: ${money(m.rake)} — ${money(m.rakeHouse)} house / ${money(m.rakeReserve)} stabilization reserve. The prize pool is never touched beyond the published rake.${m.refillActive ? " Reserve Refill Rule in force: the split is 9 house / 6 reserve for this event (the reserve ended a prior event below $2.00)." : ""}`,
    `Prizes (of the post-rake ${money(m.distributable)}): 1st ${money(m.prizes[0])} · 2nd ${money(m.prizes[1])} · 3rd ${money(m.prizes[2])}.`,
  ];
  return { math: m, lines };
}

/**
 * Public summary for the event page (written to repo-root arena-buyin.json,
 * the same publish pattern as arena-earn's public summary). TEST-kind
 * entries and non-public events are excluded entirely.
 */
function buildPublicSummary(cfg, ledger, eventId, opts = {}) {
  const ev = getEvent(cfg, eventId);
  const entries = (ledger.entries || []).filter((e) => e.eventId === eventId && e.status === "SEATED");
  const outside = entries.filter((e) => e.kind === "OUTSIDE");
  const house = entries.filter((e) => e.kind === "HOUSE");
  const seats = [...outside, ...house].map((e) => ({ amount: e.amount, kind: e.kind }));
  const counts = { outside: outside.length, house: house.length };
  // Reserve Refill Rule: the split in force comes from the reserve journal
  // state at this moment (opts.reserveState, loaded by the caller). The
  // published math must use the split an event starting now would use.
  const reserveRule = refill.publicRule(opts.reserveState || null);
  const mathOpts = { refillActive: reserveRule.refillActive };
  const ex = workedExample(ev, seats, counts, mathOpts);
  const g = guaranteeStatus(ev);
  return {
    game: cfg.brand,
    eventId,
    name: ev.name,
    brand: cfg.brand,
    entriesOpen: ev.entriesOpen,
    entryEndpoint: cfg.entryEndpoint,
    payee: cfg.payee,
    network: cfg.network,
    tiers: ev.tiers.map((t) => ({ id: t.id, label: t.label, buyIn: t.buyIn, enabled: t.enabled })),
    defaultTier: ev.defaultTier,
    doorFeeNote:
      "One door fee only: 50 cents to enter. The buy-in is the only charge from the house — data during play is each player's own choice and spend at the listed endpoint prices (quote $0.01 / verdict $0.02 / signals $0.01).",
    minField: ev.minField,
    fieldMet: counts.outside + counts.house >= ev.minField,
    eventClass: counts.outside >= 2 ? "PUBLIC" : "HOUSE SHOWCASE",
    eventClassNote:
      counts.outside >= 2
        ? "Public event: at least 2 outside paid seats are registered."
        : "House showcase: house seats count toward the field, but an event counts as a PUBLIC event in our copy only once at least 2 outside paid seats are registered.",
    startTime: ev.startTime,
    startCondition: `The event fires when at least ${ev.minField} paid seats (house + outside) are registered by the start window. If the field falls short, entries roll forward to the next event by default (refund on request — see the refund rule). House seats are entered and labeled by the house; every seat below is a verified settlement or a labeled house entry — never a promise.`,
    examples: (() => {
      const seededEv = { ...ev, id: eventId, guaranteeSeeded: true };
      const mk = (n) => Array.from({ length: n }, () => ({ amount: getTier(ev, ev.defaultTier).buyIn, kind: "OUTSIDE" }));
      const exact = (distCents) => ev.payoutTiers.map((p) => Math.round(distCents * p * 10) / 1000);
      const fmtExact = (n) => "$" + (Number.isInteger(n * 100) ? n.toFixed(2) : n.toFixed(3));
      return [4, 6, 10].map((n) => {
        const m = computeEventMath(seededEv, mk(n), mathOpts);
        const prizesExact = exact(Math.round(m.distributable * 100));
        return {
          seats: n,
          assumes: "guarantee funded; all seats at the standard entry",
          entriesTotal: m.entriesTotal,
          guaranteeTopUp: m.guaranteeTopUp,
          effectivePool: m.effectivePool,
          rake: m.rake,
          prizes: m.prizes,
          prizesExact,
          line: `${n} seats → entries ${money(m.entriesTotal)}, pool ${money(m.effectivePool)} (guarantee tops up ${money(m.guaranteeTopUp)}), rake ${money(m.rake)}, prizes ${m.prizes.map(money).join(" / ")} (exact ${prizesExact.map(fmtExact).join(" / ")}).`,
        };
      });
    })(),
    guarantee: { seedUsd: ev.guaranteeUsd, seeded: g.seeded, statusText: g.statusText, seedTx: ev.guaranteeSeedTx || null },
    reserveRule,
    guaranteeNote: `The ${money(ev.guaranteeUsd)} guarantee is the prize floor until entries alone pass it — ${Math.ceil(ev.guaranteeUsd / getTier(ev, ev.defaultTier).buyIn)} paid seats at the ${money(getTier(ev, ev.defaultTier).buyIn)} entry. Below that, once the seed is funded, it tops the pool up to ${money(ev.guaranteeUsd)}; it is never consumed beyond the shortfall.`,
    seats: {
      outside: outside.length,
      house: house.length,
      totalPaid: outside.length + house.length,
      outsideEntries: outside.map((e) => ({ seat: e.seatId, tier: e.tier, amount: e.amount, payer: e.payer, tx: e.settlement.txHash, ts: e.settlement.ts })),
      houseEntries: house.map((e) => ({ seat: e.seatId, tier: e.tier, amount: e.amount, agent: e.agentName, label: "HOUSE" })),
    },
    math: ex.math,
    workedExample: ex.lines,
    refundRule: cfg.refundRule,
    receiptsPromise:
      "Every seat, prize and refund is published with its transaction hash. House agents are labeled HOUSE; if a house agent wins, its prize is reported as a house receipt, not as outside winnings.",
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  CONFIG_PATH,
  PUBLIC_SUMMARY_PATH,
  cents,
  usd,
  money,
  loadConfig,
  getEvent,
  getTier,
  splitPool,
  prizeSplit,
  computeEventMath,
  guaranteeStatus,
  workedExample,
  buildPublicSummary,
  refill,
};
