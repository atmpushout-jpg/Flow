// Web fighter builds (v1) — shared store + logic for
// POST /api/build (create a fighter), GET /api/build?token=… (the
// owner's dashboard data), and POST /api/build/apply-tuning.
//
// This is the web twin of the Telegram bot's /build + /mybot
// (telegram/flow-bot.js). The semantics are mirrored, not reinvented:
//   - The three taps-dials (data appetite / aggression / patience)
//     map onto the Forge model's own values — BUILD_DIALS, DIAL_ORDER
//     and the step rule are copied from flow-bot.js.
//   - Specs are derived by api/_forgecore.js, the byte-identical
//     extraction of forge.html's CORE section (the §7 weights->rules
//     mapping), through the same choices->state rebuild the bot uses.
//   - Tuning recommendations restates the house learning system's
//     general META rules (offchain/arena-learning.js) on the owner's
//     dials — META-1 efficiency-press, META-2 winless-burn, and the
//     never-fired trigger-loosening — same thresholds, same
//     one-step size, evidence quoted from the fighter's own record,
//     exactly as tuningAdvice() does in flow-bot.js.
//   - The counted-match record folds the published standings with the
//     newest live report exactly like the bot's fighterRecord().
//
// IDENTITY: creating a build issues an owner token (shown ONCE, in
// the create response). Only its SHA-256 hash is stored. The
// dashboard link (mybot.html?t=<token>) is the credential — the
// same hash-only discipline as the Early Builder Key program
// (api/_builderkey.js), whose Upstash store this module shares.
//
// HONEST LIMITS (v1, same posture as Telegram builds):
//   - A web-built fighter's status is "built" — awaiting floor
//     seating. Floor wiring for self-built fighters is not live
//     yet; nothing here claims the fighter is competing.
//   - No payout wallet is collected in v1 (deferred to graduation,
//     as on Telegram), so spec.owner.payoutWallet is "".
//
// HUMAN ENTRY + DATA-CREDIT BALANCE (Atm, locked 2026-10-13):
//   A human seats their OWN bot for $1.00 by card:
//     $1.00 = the standard $0.50 seat + ~$0.33 card costs
//             + ~$0.17 starting DATA CREDIT.
//   The dashboard carries a data-credit balance: it starts with
//   the entry's starter credit and DRAWS DOWN per event as the
//   fighter spends on data (heavy-data bots top up later —
//   top-up mechanics are out of scope for v1; the balance field
//   and the per-event drawdown display are in the model + UI).
//   Card checkout itself is NOT built — it waits on Atm's Stripe
//   account (his identity/tax gate). Until an entry is funded,
//   the balance reads $0.00 and the surfaces say card payment is
//   not yet live; nothing fakes a checkout. The crypto/agent
//   lane is untouched: $0.50 a seat on-chain, as published.
//
// STORAGE (Upstash Redis via api/_builderkey.js getStore()):
//   flow:build:fighter:<fighterId>   JSON record (current version)
//   flow:build:byname:<NAME>         fighterId (claimed atomically)
//   flow:build:byhash:<specHash>     fighterId (duplicate-spec guard)
//   flow:build:bytoken:<sha256>      fighterId (dashboard lookup)

const crypto = require("crypto");
const forge = require("./_forgecore");
const builderKey = require("./_builderkey");

const TOKEN_PREFIX = "flw_own_";
const DASHBOARD_PATH = "/mybot.html";
const SITE_BASE = process.env.FLOW_SITE_BASE || "https://flow-kg4x.vercel.app";
const FETCH_TIMEOUT_MS = 2500;

const KEY_FIGHTER = "flow:build:fighter:";
const KEY_BY_NAME = "flow:build:byname:";
const KEY_BY_HASH = "flow:build:byhash:";
const KEY_BY_TOKEN = "flow:build:bytoken:";

// The locked human entry (Atm, 2026-10-13): $1.00 by card =
// $0.50 seat + ~$0.33 card costs + ~$0.17 starting data credit.
const HUMAN_ENTRY = {
  priceUsd: 1.0,
  seatUsd: 0.5,
  cardCostsUsd: 0.33,
  starterDataCreditUsd: 0.17,
  headline: "A dollar seats your bot.",
  copy: "$1 by card — seat, card costs, and your bot's first data included",
  cardLive: false,
  cardStatusText: "Card entry — coming with the payments launch",
  cryptoSeatUsd: 0.5,
};

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** The entry block stored on a fresh build record (unfunded in v1). */
function defaultEntry() {
  return {
    method: null,
    funded: false,
    priceUsd: HUMAN_ENTRY.priceUsd,
    seatUsd: HUMAN_ENTRY.seatUsd,
    cardCostsUsd: HUMAN_ENTRY.cardCostsUsd,
    starterDataCreditUsd: HUMAN_ENTRY.starterDataCreditUsd,
  };
}

/** The balance block stored on a fresh build record ($0.00 until funded). */
function defaultBalance() {
  return { funded: false, dataCreditUsd: 0, topUpsUsd: 0 };
}

/**
 * The dashboard balance for a record: the data-credit balance plus
 * its per-event drawdown, computed from the fighter's counted-match
 * record (each counted match's data spend draws the credit down).
 * Unfunded fighters read $0.00 — the starter credit only exists
 * once an entry is actually funded.
 */
function balanceForRecord(record, rec) {
  const stored =
    record && record.balance && typeof record.balance === "object" ? record.balance : {};
  const funded = !!stored.funded;
  const topUpsUsd = round2(stored.topUpsUsd || 0);
  const creditedUsd = funded ? round2(HUMAN_ENTRY.starterDataCreditUsd + topUpsUsd) : 0;
  const perMatch = rec && Array.isArray(rec.perMatch) ? rec.perMatch : [];
  const dataSpentUsd = rec ? round2(rec.data) : round2(perMatch.reduce((s, m) => s + (m.dataSpend || 0), 0));
  let running = creditedUsd;
  const drawdowns = perMatch.map((m, i) => {
    const spend = round2(m.dataSpend || 0);
    const before = running;
    running = round2(Math.max(0, running - spend));
    return { match: i + 1, dataSpendUsd: spend, creditBeforeUsd: before, creditAfterUsd: running };
  });
  const dataCreditUsd = funded ? round2(Math.max(0, creditedUsd - dataSpentUsd)) : 0;
  return {
    funded,
    creditedUsd,
    dataCreditUsd,
    dataSpentUsd,
    topUpsUsd,
    drawdowns,
    entry: { ...HUMAN_ENTRY },
    balanceText: funded
      ? `Data credit: ${money(dataCreditUsd)} left of ${money(creditedUsd)} credited — it draws down per event as your bot spends on data.`
      : `Data credit: $0.00 — no entry funded yet. ${HUMAN_ENTRY.copy}: the ~${money(HUMAN_ENTRY.starterDataCreditUsd)} of starting data credit lands with the entry and draws down per event as your bot spends on data.`,
    topUpText:
      "Top-ups are not live yet — when they open, heavy-data bots will be able to add data credit here. Nothing to buy today.",
  };
}

// ---------------------------------------------------------------------------
// The dials — copied from telegram/flow-bot.js (BUILD_DIALS / DIAL_ORDER /
// DIAL_TITLES / STYLE_BUTTON_BLURBS). Dial choices map onto the Forge
// model's own values (archetype presets and slider bounds):
//   Data appetite -> the data-budget slider (dataBudgetUsd)
//   Aggression    -> the sizing slider (sizingPct)
//   Patience      -> the picky slider (weights.patience)
// ---------------------------------------------------------------------------

const BUILD_DIALS = {
  appetite: {
    careful: { label: "Careful", budget: 0.10 },
    balanced: { label: "Balanced", budget: 0.30 },
    big: { label: "Big spender", budget: 0.60 },
  },
  aggression: {
    safe: { label: "Play it safe", sizing: 15 },
    mixed: { label: "Mixed", sizing: 30 },
    big: { label: "Swing big", sizing: 65 },
  },
  patience: {
    quick: { label: "Quick exits", patience: 10 },
    standard: { label: "Standard", patience: 45 },
    ride: { label: "Let it ride", patience: 95 },
  },
};
const DIAL_ORDER = {
  appetite: ["careful", "balanced", "big"],
  aggression: ["safe", "mixed", "big"],
  patience: ["quick", "standard", "ride"],
};
const DIAL_TITLES = { appetite: "Data appetite", aggression: "Aggression", patience: "Patience" };
const STYLE_BUTTON_BLURBS = {
  momentum: "attacks what's moving",
  contrarian: "buys what the crowd ignores",
  copycat: "follows the smart wallets",
  auditor: "safety verdict first",
  sniper: "waits, then one big shot",
  balanced: "a bit of everything",
};

const money = (n) => "$" + Number(n || 0).toFixed(2);
const signedMoney = (n) => (n < 0 ? "-$" : "+$") + Math.abs(n).toFixed(2);

/** Same name rule as the Forge page and the bot: letters/digits, uppercased, <= 10. */
function sanitizeRingName(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10);
}

/** One step along a dial ladder; null when already at that end. (flow-bot.js) */
function stepDial(dial, key, dir) {
  const order = DIAL_ORDER[dial];
  const i = order.indexOf(key);
  if (i < 0) return null;
  return order[i + dir] || null;
}

function dialPlain(dial, key) {
  const d = BUILD_DIALS[dial][key];
  if (dial === "appetite") return `${d.label} — up to ${money(d.budget)} of data a match`;
  if (dial === "aggression") return `${d.label} — ${d.sizing}% of its cash per entry`;
  return d.label;
}

/** Rebuild the Forge page state (preset + dial overrides) for a set of choices. (flow-bot.js) */
function choicesToForgeState(choices, ownerName) {
  const a = forge.ARCHETYPES[choices.archetype];
  const weights = { ...a.weights };
  if (choices.patience) weights.patience = BUILD_DIALS.patience[choices.patience].patience;
  return {
    name: choices.name,
    ownerName: ownerName || "",
    walletAddress: "",
    archetype: choices.archetype,
    weights,
    sizingPct: choices.aggression ? BUILD_DIALS.aggression[choices.aggression].sizing : a.sizingPct,
    dataBudgetUsd: choices.appetite ? BUILD_DIALS.appetite[choices.appetite].budget : a.dataBudgetUsd,
    exitRule: a.exitRule,
  };
}

/** The fighter card lines, mirroring the bot's buildSummaryCard(). */
function summaryCardLines(choices, ownerName) {
  const state = choicesToForgeState(choices, ownerName);
  const cs = forge.clampState(state);
  const est = forge.estimateDataSpend(cs);
  return {
    summarySentence: forge.summarySentence(cs),
    estimatedDataSpend: est,
    lines: [
      `Data: paced at about ${money(est)} a match, inside a ${money(cs.dataBudgetUsd)} cap`,
      `Stakes: ${cs.sizingPct}% of its cash per entry`,
      `Patience: ${BUILD_DIALS.patience[choices.patience].label.toLowerCase()} — ${choices.patience === "quick" ? "takes profit early" : choices.patience === "ride" ? "holds for the bigger move" : "a normal hold"}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Token + hash primitives (hash-only storage, like _builderkey.js)
// ---------------------------------------------------------------------------

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

function tokenFormatOk(rawToken) {
  return (
    typeof rawToken === "string" &&
    rawToken.startsWith(TOKEN_PREFIX) &&
    /^[A-Za-z0-9_-]{32,64}$/.test(rawToken.slice(TOKEN_PREFIX.length))
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function specHashOf(spec) {
  return crypto.createHash("sha256").update(stableStringify(spec), "utf8").digest("hex");
}

function newFighterId() {
  return "fb_" + crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Input validation — refusal sentences in the house validator's voice
// (offchain/arena-register.js / forge core validateSpec).
// ---------------------------------------------------------------------------

function sanitizeOwnerName(input) {
  if (typeof input !== "string") return "";
  return input.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 80);
}

function validateCreateInput(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, error: "request body must be JSON: {name, style, dials:{appetite, aggression, patience}, ownerName?}" };
  }
  const rawName = typeof input.name === "string" ? input.name.trim() : "";
  if (!/^[A-Za-z0-9]{2,10}$/.test(rawName)) {
    return {
      ok: false, status: 400, code: "NAME_MALFORMED",
      error: `"name" is "${rawName}" — a ring name is 2–10 characters, letters and digits only, no spaces or symbols.`,
    };
  }
  const name = rawName.toUpperCase();
  if (forge.RESERVED_NAMES.includes(name)) {
    return {
      ok: false, status: 400, code: "NAME_RESERVED",
      error: `"${name}" is a house name — the cast (VEX, AUDREY, ECHO, FADE, LONGSHOT, ROOK), FLOWX, and FORMULA are reserved and cannot be registered. Pick a name of your own.`,
    };
  }
  const style = input.style;
  if (typeof style !== "string" || !forge.ARCHETYPES[style]) {
    return {
      ok: false, status: 400, code: "STYLE_UNKNOWN",
      error: `"style" is ${JSON.stringify(style)} — pick one of the six Forge styles: ${Object.keys(forge.ARCHETYPES).join(", ")}.`,
    };
  }
  const dialsIn = input.dials && typeof input.dials === "object" ? input.dials : {};
  const dials = {};
  for (const dial of Object.keys(DIAL_ORDER)) {
    const v = dialsIn[dial];
    if (typeof v !== "string" || !BUILD_DIALS[dial][v]) {
      return {
        ok: false, status: 400, code: "DIAL_UNKNOWN",
        error: `"${dial}" is ${JSON.stringify(v)} — the ${DIAL_TITLES[dial]} dial takes one of: ${DIAL_ORDER[dial].join(", ")}.`,
      };
    }
    dials[dial] = v;
  }
  return { ok: true, name, style, dials, ownerName: sanitizeOwnerName(input.ownerName) };
}

// ---------------------------------------------------------------------------
// The counted-match record + seat state, from the PUBLISHED arena state.
// Direct ports of the bot's fighterRecord() / seatStatus() folds, reading
// parsed JSON (fetched from the site's public files) instead of disk.
// ---------------------------------------------------------------------------

function fighterRecordFromPublished(name, standings, live) {
  const want = String(name || "").toLowerCase();
  let rec = null;
  if (standings && Array.isArray(standings.agents)) {
    const a = standings.agents.find(
      (x) => String(x.name).toLowerCase() === want || String(x.agentId).toLowerCase() === want
    );
    if (a) {
      rec = {
        name: a.name, matches: a.matches || 0, wins: a.wins || 0,
        prizes: a.prizeTotal || 0, data: a.dataSpentTotal || 0,
        trades: a.tradesTotal || 0, pnl: a.pnlTotal || 0,
        perMatch: (a.perMatch || []).map((m) => ({ payout: m.payout || 0, dataSpend: m.dataSpend || 0, trades: m.trades || 0 })),
      };
    }
  }
  const liveMatchId = live && (live.match || live.matchId);
  if (live && live.receipts && /^arena-match-(\d+)$/.test(liveMatchId || "")) {
    const counted = (standings && standings.countedMatches) || [];
    const frozenMax = counted.reduce((mx, id) => {
      const m = /(\d+)$/.exec(id);
      return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
    }, 0);
    const n = parseInt(liveMatchId.split("-").pop(), 10);
    if (n > frozenMax) {
      const row = (live.receipts.perAgent || []).find((pa) => String(pa.agent).toLowerCase() === want);
      if (row) {
        if (!rec) rec = { name: row.agent, matches: 0, wins: 0, prizes: 0, data: 0, trades: 0, pnl: 0, perMatch: [] };
        const winner = (live.leaderboard || []).find((r) => r.rank === 1);
        rec.matches += 1;
        if (winner && String(winner.agentId).toLowerCase() === want) rec.wins += 1;
        rec.prizes = Math.round((rec.prizes + (row.payout || 0)) * 100) / 100;
        rec.data = Math.round((rec.data + (row.dataSpend || 0)) * 100) / 100;
        rec.trades += row.trades || 0;
        rec.pnl = Math.round((rec.pnl + (row.realizedPnl || 0)) * 100) / 100;
        rec.perMatch.push({ payout: row.payout || 0, dataSpend: row.dataSpend || 0, trades: row.trades || 0 });
      }
    }
  }
  if (!rec || rec.matches === 0) return null;
  rec.winlessSpend = Math.round(rec.perMatch.filter((m) => m.payout <= 0).reduce((s, m) => s + m.dataSpend, 0) * 100) / 100;
  rec.zeroTradeMatches = rec.perMatch.filter((m) => m.trades === 0).length;
  rec.prizePerCent = rec.data > 0 ? Math.round((rec.prizes / (rec.data * 100)) * 100) / 100 : 0;
  return rec;
}

/** A settled seat for this fighter in the published buy-in state, or null. */
function seatFromPublished(name, buyin) {
  if (!buyin || !buyin.seats) return null;
  const want = String(name || "").toLowerCase();
  const lists = [buyin.seats.outsideEntries || [], buyin.seats.houseEntries || []];
  for (const list of lists) {
    const hit = list.find(
      (e) => (e.status === undefined || e.status === "SEATED") && String(e.agentName || "").toLowerCase() === want
    );
    if (hit) return { eventId: hit.eventId || buyin.eventId || null, tier: hit.tier || null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tuning recommendations — the bot's tuningAdvice(), verbatim thresholds.
// ---------------------------------------------------------------------------

function tuningAdvice(choices, record) {
  const c = choices;
  const recs = [];
  if (record) {
    // META-1 efficiency-press: proven efficiency earns a bigger stake.
    if (record.matches >= 3 && record.prizePerCent >= 0.5) {
      const to = stepDial("aggression", c.aggression, +1);
      if (to) recs.push({
        dial: "aggression", to,
        reason: `It earns $${record.prizePerCent.toFixed(2)} of prize per data cent across ${record.matches} counted matches — proven efficiency. The house learners run the same rule (META-1): proven efficiency earns a slightly bigger stake.`,
      });
    }
    // META-2 winless-burn: spend without prizes tightens the data dial.
    if (record.prizes === 0 && record.winlessSpend >= 0.75) {
      const to = stepDial("appetite", c.appetite, -1);
      if (to) recs.push({
        dial: "appetite", to,
        reason: `It has spent ${money(record.winlessSpend)} on data across ${record.matches} counted matches without a prize yet. The house winless-burn rule (META-2): when spending runs ahead of prizes, tighten the data dial first.`,
      });
    }
    // Never-fired: repeated zero-trade matches loosen the trigger.
    if (record.zeroTradeMatches >= 2) {
      const to = stepDial("patience", c.patience, -1);
      if (to) recs.push({
        dial: "patience", to,
        reason: `It finished ${record.zeroTradeMatches} counted matches without a single entry — its gates are too tight to fire. The house fix for a fighter that never fires is to loosen the trigger, not the size: one step less picky.`,
      });
    }
    return recs.slice(0, 3);
  }
  // No record yet: at most one starting check, framed as exactly that.
  if (c.appetite === "big") {
    recs.push({
      dial: "appetite", to: "balanced", baseline: true,
      reason: "Starting check — not from results, it hasn't run yet: most new fighters start on Balanced data until their first record shows what they actually spend. The $0.60 cap protects it either way.",
    });
  } else if (c.aggression === "big") {
    recs.push({
      dial: "aggression", to: "mixed", baseline: true,
      reason: "Starting check — not from results, it hasn't run yet: Swing big puts 65% of its cash on every entry before it has any record at all. Mixed (30%) is the usual proving setting; you can swing it back up once the record argues for it.",
    });
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function getStore() {
  return builderKey.getStore();
}

async function readFighter(store, fighterId) {
  const raw = await store.get(KEY_FIGHTER + fighterId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeFighter(store, record) {
  await store.set(KEY_FIGHTER + record.fighterId, JSON.stringify(record));
}

async function resolveToken(store, rawToken) {
  if (!tokenFormatOk(rawToken)) return null;
  const fighterId = await store.get(KEY_BY_TOKEN + hashToken(rawToken));
  if (!fighterId) return null;
  return readFighter(store, fighterId);
}

// ---------------------------------------------------------------------------
// Create a build (store injected — exported for tests)
// ---------------------------------------------------------------------------

async function createBuild(store, input, opts = {}) {
  const v = validateCreateInput(input);
  if (!v.ok) return { status: v.status, body: { error: v.error, code: v.code } };
  const { name, style, dials, ownerName } = v;

  const choices = { name, archetype: style, appetite: dials.appetite, aggression: dials.aggression, patience: dials.patience };
  const spec = forge.buildSpec(choicesToForgeState(choices, ownerName));
  // The derived spec must carry the name we validated (buildSpec applies
  // the same sanitize rule; a mismatch would mean the core changed).
  if (spec.name !== name) {
    return { status: 400, body: { error: `"name" is "${name}" — a ring name is 2–10 characters, letters and digits only, no spaces or symbols.`, code: "NAME_MALFORMED" } };
  }
  const specHash = specHashOf(spec);

  // Fast-path duplicate checks (the atomic claims below are the guard).
  if (await store.get(KEY_BY_NAME + name)) {
    return {
      status: 409, body: {
        error: `"${name}" is already built — every ring name belongs to exactly one fighter. If that fighter is yours, open it from the dashboard link in your original build; otherwise pick a name of your own.`,
        code: "NAME_TAKEN",
      },
    };
  }
  if (await store.get(KEY_BY_HASH + specHash)) {
    return {
      status: 409, body: {
        error: "This exact fighter — same name, style, and dials — is already built. Nothing new was saved; open it from the dashboard link in the original build.",
        code: "SPEC_DUPLICATE",
      },
    };
  }

  const now = new Date(opts.nowMs || Date.now()).toISOString();
  const fighterId = newFighterId();
  const ownerToken = generateToken();
  const tokenHash = hashToken(ownerToken);
  const record = {
    fighterId,
    name,
    style,
    dials,
    choices,
    spec,
    specHash,
    ownerTokenHash: tokenHash,
    createdAt: now,
    updatedAt: now,
    status: "built",
    entry: defaultEntry(),
    balance: defaultBalance(),
    events: [{ type: "built", at: now, via: "web" }],
  };

  // Record first, then claim the name + spec hash atomically; a race
  // loser deletes its orphaned record (builder-key discipline).
  await writeFighter(store, record);
  const nameClaimed = await store.setNx(KEY_BY_NAME + name, fighterId);
  if (!nameClaimed) {
    await store.del(KEY_FIGHTER + fighterId);
    return {
      status: 409, body: {
        error: `"${name}" is already built — every ring name belongs to exactly one fighter. If that fighter is yours, open it from the dashboard link in your original build; otherwise pick a name of your own.`,
        code: "NAME_TAKEN",
      },
    };
  }
  const hashClaimed = await store.setNx(KEY_BY_HASH + specHash, fighterId);
  if (!hashClaimed) {
    await store.del(KEY_FIGHTER + fighterId);
    await store.del(KEY_BY_NAME + name);
    return {
      status: 409, body: {
        error: "This exact fighter — same name, style, and dials — is already built. Nothing new was saved; open it from the dashboard link in the original build.",
        code: "SPEC_DUPLICATE",
      },
    };
  }
  await store.set(KEY_BY_TOKEN + tokenHash, fighterId);

  return {
    status: 201,
    body: {
      fighterId,
      name,
      status: "built",
      statusText: "Built — awaiting floor seating",
      spec,
      specHash,
      ownerToken,
      dashboardUrl: `${DASHBOARD_PATH}?t=${ownerToken}`,
      entry: { ...HUMAN_ENTRY },
      balance: balanceForRecord(record, null),
      createdAt: now,
      note: "Your dashboard link is shown ONCE — bookmark it now. The link is your key: anyone holding it sees this fighter's dashboard and can apply tuning. Only a hash of the token is stored, so a lost link cannot be re-issued.",
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// published: { standings, live, buyin } — parsed public JSON, or null
// per file when it could not be fetched (the page then says the record
// is unavailable instead of inventing one).
// ---------------------------------------------------------------------------

function dashboardBody(record, published) {
  const { standings, live, buyin } = published || {};
  const a = forge.ARCHETYPES[record.style];
  const card = summaryCardLines(record.choices, record.spec.owner ? record.spec.owner.name : "");
  const rec = standings ? fighterRecordFromPublished(record.name, standings, live) : null;
  const recs = tuningAdvice(record.choices, rec);
  const seat = buyin ? seatFromPublished(record.name, buyin) : null;

  let seatBody = null;
  if (buyin) {
    if (seat) {
      seatBody = {
        seated: true,
        eventId: seat.eventId,
        text: `Seated in ${seat.eventId === buyin.eventId ? buyin.name || "the open event" : "a paid event"} — the seat is recorded in the public entries ledger.`,
      };
    } else if (buyin.entriesOpen) {
      seatBody = {
        seated: false,
        text: `Not seated in a paid event yet. ${buyin.name || "Buy-In #1"} is open at $0.50 a seat on-chain — or ${HUMAN_ENTRY.copy} when card entry opens (see /buyin.html for the live board).`,
      };
    } else {
      seatBody = {
        seated: false,
        text: "Not seated in a paid event, and entries are closed right now — /buyin.html shows the live board.",
      };
    }
  }

  return {
    fighter: {
      fighterId: record.fighterId,
      name: record.name,
      status: record.status,
      statusText: "Built — awaiting floor seating",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      style: { key: record.style, label: a.label, plain: a.plain, emoji: a.emoji, color: a.color, tagline: a.blurb, blurb: STYLE_BUTTON_BLURBS[record.style] },
      dials: {
        appetite: { key: record.dials.appetite, title: DIAL_TITLES.appetite, label: BUILD_DIALS.appetite[record.dials.appetite].label, plain: dialPlain("appetite", record.dials.appetite) },
        aggression: { key: record.dials.aggression, title: DIAL_TITLES.aggression, label: BUILD_DIALS.aggression[record.dials.aggression].label, plain: dialPlain("aggression", record.dials.aggression) },
        patience: { key: record.dials.patience, title: DIAL_TITLES.patience, label: BUILD_DIALS.patience[record.dials.patience].label, plain: dialPlain("patience", record.dials.patience) },
      },
      card: { summarySentence: card.summarySentence, estimatedDataSpend: card.estimatedDataSpend, lines: card.lines },
      spec: record.spec,
      specSummary: {
        dataBudgetUsd: record.spec.dataBudgetUsd,
        target: record.spec.strategy.target,
        sizingPct: Math.round(record.spec.strategy.sizing.fractionOfCash * 100),
        exits: record.spec.strategy.exits.map((e) => e.type),
      },
      specHash: record.specHash,
    },
    balance: {
      wallet: null,
      walletText: "Wallet: none yet — a payout wallet is only needed for paid seats, and it's collected at graduation with help, never at build time.",
      dataBudgetText: `Data budget: up to ${money(record.spec.dataBudgetUsd)} a match — its own money rule, inside the $0.60 house cap.`,
      ...balanceForRecord(record, rec),
    },
    seat: seatBody,
    record: rec,
    recordState: standings ? (rec ? "counted" : "none") : "unavailable",
    tuning: recs.map((r) => ({
      dial: r.dial,
      to: r.to,
      baseline: !!r.baseline,
      title: DIAL_TITLES[r.dial],
      fromKey: record.choices[r.dial],
      fromPlain: dialPlain(r.dial, record.choices[r.dial]),
      toPlain: dialPlain(r.dial, r.to),
      toLabel: BUILD_DIALS[r.dial][r.to].label,
      reason: r.reason,
    })),
    tuningNote: rec
      ? (recs.length ? null : "No changes recommended — its record doesn't trip any of the house tuning rules right now. The learners only adjust on recorded evidence, and so does this page.")
      : (recs.length ? null : "No changes recommended yet — it needs its first runs before tuning means anything. The house learners only adjust on recorded evidence."),
    events: [...(record.events || [])].reverse(),
    published: { standingsOk: !!standings, buyinOk: !!buyin },
    dashboardPath: DASHBOARD_PATH,
  };
}

async function getDashboard(store, rawToken, published) {
  const record = await resolveToken(store, rawToken);
  if (!record) {
    return {
      status: 404,
      body: { error: "That dashboard link doesn't match any fighter. The link is the whole key, exactly as issued at build time — check for a complete copy of it.", code: "TOKEN_UNKNOWN" },
    };
  }
  return { status: 200, body: dashboardBody(record, published) };
}

// ---------------------------------------------------------------------------
// Apply one tuning step: one dial, one step, rebuilt through the Forge.
// Mirrors the bot's applyTune guard — a stale suggestion never moves a
// dial twice or backwards.
// ---------------------------------------------------------------------------

async function applyTuning(store, rawToken, input, published, opts = {}) {
  const record = await resolveToken(store, rawToken);
  if (!record) {
    return {
      status: 404,
      body: { error: "That dashboard link doesn't match any fighter. The link is the whole key, exactly as issued at build time — check for a complete copy of it.", code: "TOKEN_UNKNOWN" },
    };
  }
  const dial = input && input.dial;
  const toKey = input && input.to;
  const order = DIAL_ORDER[dial] || null;
  if (!order || typeof toKey !== "string" || !BUILD_DIALS[dial][toKey]) {
    return {
      status: 400,
      body: { error: `"dial"/"to" must name one of the three dials and a step on it — appetite, aggression, patience. Reload your dashboard for the current recommendation.`, code: "DIAL_UNKNOWN" },
    };
  }
  const from = record.choices[dial];
  if (Math.abs(order.indexOf(toKey) - order.indexOf(from)) !== 1) {
    return {
      status: 409,
      body: { error: "That suggestion is out of date — a dial only ever moves one step from its current setting. Reload your dashboard for the current recommendation.", code: "STALE_TUNING" },
    };
  }
  const choices = { ...record.choices, [dial]: toKey };
  const ownerName = record.spec.owner ? record.spec.owner.name : "";
  const spec = forge.buildSpec(choicesToForgeState(choices, ownerName));
  const now = new Date(opts.nowMs || Date.now()).toISOString();
  record.choices = choices;
  record.dials = { appetite: choices.appetite, aggression: choices.aggression, patience: choices.patience };
  record.spec = spec;
  record.specHash = specHashOf(spec);
  record.updatedAt = now;
  record.events = [...(record.events || []), { type: "tuning", at: now, dial, from, to: toKey, via: "web-dashboard" }];
  await writeFighter(store, record);
  await store.setNx(KEY_BY_HASH + record.specHash, record.fighterId);
  return { status: 200, body: { applied: { dial, from, to: toKey }, dashboard: dashboardBody(record, published) } };
}

// ---------------------------------------------------------------------------
// Published arena state fetch (the site's own public JSON files)
// ---------------------------------------------------------------------------

async function fetchPublishedJson(pathname, fetchFn) {
  const f = fetchFn || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await f(SITE_BASE + pathname, { signal: ctrl.signal });
    if (!r || !r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPublished(fetchFn) {
  const [standings, live, buyin] = await Promise.all([
    fetchPublishedJson("/arena-standings.json", fetchFn),
    fetchPublishedJson("/arena-live.json", fetchFn),
    fetchPublishedJson("/arena-buyin.json", fetchFn),
  ]);
  return { standings, live, buyin };
}

async function programSummary(store) {
  // There is no global counter key in v1 (names are the index), so the
  // summary reports only what it can know.
  return {
    status: 200,
    body: {
      service: "flow-arena-web-build",
      offer:
        "Build a Flow Arena fighter in the browser — no code, no wallet needed to start. Pick a ring name, one of six Forge styles, and three dials; the house engine derives a real arena-persona-spec v1 from your choices (the §7 weights-to-rules mapping). First it proves itself free on the all-day floor; a profitable floor record graduates it to paid seats, where fighters compete for prize pools split 50/30/20.",
      howToBuild: 'POST /api/build with JSON {name, style, dials:{appetite, aggression, patience}, ownerName?}. The response carries your dashboard link ONCE — bookmark it; the link is your key.',
      dashboard: `GET /api/build?token=<ownerToken> — or open ${DASHBOARD_PATH}?t=<ownerToken> in a browser.`,
      applyTuning: "POST /api/build/apply-tuning with JSON {token, dial, to} — one dial, one step, exactly like the dashboard's Apply buttons.",
      humanEntry: {
        ...HUMAN_ENTRY,
        note: "The human entry is $1.00 by card: the standard $0.50 seat + ~$0.33 card costs + ~$0.17 starting data credit. The dashboard balance starts at $0.00, is credited with the entry, and draws down per event as the fighter spends on data. Card payment is NOT live yet (it waits on the house Stripe account) — no checkout is offered. The crypto/agent lane stays $0.50 a seat on-chain.",
      },
      styles: Object.keys(forge.ARCHETYPES),
      dials: DIAL_ORDER,
      store: store.kind,
    },
  };
}

module.exports = {
  TOKEN_PREFIX,
  DASHBOARD_PATH,
  HUMAN_ENTRY,
  defaultEntry,
  defaultBalance,
  balanceForRecord,
  BUILD_DIALS,
  DIAL_ORDER,
  DIAL_TITLES,
  STYLE_BUTTON_BLURBS,
  sanitizeRingName,
  sanitizeOwnerName,
  stepDial,
  dialPlain,
  choicesToForgeState,
  summaryCardLines,
  generateToken,
  hashToken,
  tokenFormatOk,
  specHashOf,
  validateCreateInput,
  fighterRecordFromPublished,
  seatFromPublished,
  tuningAdvice,
  createBuild,
  getDashboard,
  applyTuning,
  dashboardBody,
  fetchPublished,
  programSummary,
  getStore,
};

module.exports._test = {
  KEY_FIGHTER,
  KEY_BY_NAME,
  KEY_BY_HASH,
  KEY_BY_TOKEN,
  createMemoryStore: builderKey._test.createMemoryStore,
};
