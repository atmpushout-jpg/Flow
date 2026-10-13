// Flow Arena registration API — shared store + logic for
// POST /api/arena/register (register a fighter persona spec) and
// GET  /api/arena/register?id=<fighterId> (the stored record).
//
// THE FUNNEL (owner doctrine, 2026-10-12 — offchain/arena-register.js
// is the canonical statement; this module mirrors it, never invents):
//   1. VALIDATED — the spec passes the house validator
//      (api/_register-validator.js, a byte-faithful port of
//      offchain/arena-register.js's validateSpec: same verdicts,
//      same refusal sentences, differentially tested).
//   2. QUALIFIED — computed from the fighter's recorded registration
//      rounds, never hand-set: >= 3 recorded rounds, every round
//      inside the declared data budget, cumulative net PnL (realized
//      PnL - data spend, prizes excluded) strictly > $0. The same
//      rule as evaluateQualification() offchain.
//   3. PAID SEATS — qualification is not a purchase; a seat is still
//      bought the ordinary way ($0.50 x402 entry via /api/arena-enter).
//
// SPECS ARE DATA, NEVER CODE. The validated, normalized spec is the
// only thing stored; the house engine interprets specs itself. Floor
// wiring (seating validated fighters in rolling floor rounds) is a
// separate, later step — a record created here starts with zero
// recorded rounds and status VALIDATED, and nothing in this module
// claims the fighter is competing yet.
//
// STORAGE (Upstash Redis via api/_builderkey.js getStore() — the same
// store the Builder Key program and the web builds share):
//   flow:register:fighter:<fighterId>   JSON record
//   flow:register:byname:<NAME>         fighterId (claimed atomically)
// The fighterId is the spec's own id: the lowercase slug of the ring
// name, exactly as the validator derives it (spec.id).

const validator = require("./_register-validator");
const builderKey = require("./_builderkey");
const build = require("./_build"); // specHashOf (stable-stringify SHA-256)

const KEY_FIGHTER = "flow:register:fighter:";
const KEY_BY_NAME = "flow:register:byname:";
const QUALIFICATION_MIN_ROUNDS = 3; // mirrors QUALIFICATION.minRounds offchain

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => "$" + Number(n || 0).toFixed(2);

function getStore() {
  return builderKey.getStore();
}

/**
 * The funnel status, computed from the record's own rounds — a lookup
 * on receipts, never a judgment call (the offchain rule, verbatim
 * thresholds): >= 3 recorded rounds, every round within the declared
 * budget, cumulative net PnL strictly above $0.00.
 */
function evaluateStatus(record) {
  const rounds = record && Array.isArray(record.rounds) ? record.rounds : [];
  const budget = record && record.spec ? record.spec.dataBudgetUsd : null;
  const netPnlUsd = round2(rounds.reduce((s, r) => s + (Number(r.netPnl) || 0), 0));
  const overBudget = rounds.filter((r) => !r.withinBudget);
  const reasons = [];
  if (rounds.length < QUALIFICATION_MIN_ROUNDS) {
    reasons.push(
      `Only ${rounds.length} of the required ${QUALIFICATION_MIN_ROUNDS} registration rounds are on the record — eligibility needs at least ${QUALIFICATION_MIN_ROUNDS} completed rounds on live tape (floor rounds count; floor seating for registered fighters is the follow-on wiring).`
    );
  }
  if (overBudget.length) {
    reasons.push(
      `${overBudget.length} recorded round(s) finished outside the declared data budget of ${money(budget)} — every counted round must finish inside the budget the fighter itself declared.`
    );
  }
  if (rounds.length > 0 && netPnlUsd <= 0) {
    reasons.push(
      `Cumulative net PnL on Flow's data is ${money(netPnlUsd)} across ${rounds.length} round(s) — realized trading PnL minus data spend, prizes excluded. The bar is strictly above $0.00.`
    );
  }
  const qualified = reasons.length === 0;
  return {
    status: qualified ? "QUALIFIED" : "VALIDATED",
    qualified,
    roundsRecorded: rounds.length,
    minRounds: QUALIFICATION_MIN_ROUNDS,
    netPnlUsd,
    reasons,
  };
}

/** The public view of a registration record (what GET returns). */
function publicRecord(record) {
  const q = evaluateStatus(record);
  return {
    fighterId: record.fighterId,
    name: record.name,
    status: q.status,
    qualification: {
      qualified: q.qualified,
      roundsRecorded: q.roundsRecorded,
      minRounds: q.minRounds,
      netPnlUsd: q.netPnlUsd,
      reasons: q.reasons,
    },
    spec: record.spec,
    specHash: record.specHash,
    source: record.source || "api-register",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readRecord(store, fighterId) {
  const raw = await store.get(KEY_FIGHTER + fighterId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Register a fighter spec (store injected — exported for tests).
 * `input` is the spec itself (a parsed object or a JSON string), or a
 * wrapper { spec: {...} }. Returns { status, body }.
 */
async function createRegistration(store, input, opts = {}) {
  let raw = input;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.spec && typeof raw.spec === "object" && !Array.isArray(raw.spec) && raw.name === undefined) {
    raw = raw.spec; // tolerate a { spec: {...} } wrapper
  }
  const verdict =
    typeof raw === "string" ? validator.validateSpecText(raw) : validator.validateSpec(raw);
  if (!verdict.ok) {
    return {
      status: 400,
      body: {
        error: verdict.errors[0] ? verdict.errors[0].message : "The spec did not validate.",
        code: verdict.errors[0] ? verdict.errors[0].code : "SPEC_INVALID",
        errors: verdict.errors, // the validator's error list, verbatim
        warnings: verdict.warnings,
      },
    };
  }
  const spec = verdict.spec;
  const name = spec.name;
  const fighterId = spec.id;

  const takenBody = {
    error: `"${name}" is already registered — every ring name belongs to exactly one fighter. If that fighter is yours, its record is at GET /api/arena/register?id=${fighterId}; otherwise pick a name of your own.`,
    code: "NAME_TAKEN",
  };
  if (await store.get(KEY_BY_NAME + name)) {
    return { status: 409, body: takenBody };
  }

  const now = new Date(opts.nowMs || Date.now()).toISOString();
  const record = {
    fighterId,
    name,
    spec,
    specHash: build.specHashOf(spec),
    status: "VALIDATED", // the base state; the served status is computed
    rounds: [], // floor-round records land here when floor wiring ships
    source: "api-register",
    createdAt: now,
    updatedAt: now,
  };

  // Claim the name atomically FIRST (the fighterId is name-derived, so
  // a record-first write could clobber a concurrent winner's record),
  // then write the record; if the write fails, release the claim.
  const claimed = await store.setNx(KEY_BY_NAME + name, fighterId);
  if (!claimed) {
    return { status: 409, body: takenBody };
  }
  try {
    await store.set(KEY_FIGHTER + fighterId, JSON.stringify(record));
  } catch (e) {
    await store.del(KEY_BY_NAME + name);
    throw e;
  }

  return {
    status: 201,
    body: {
      ...publicRecord(record),
      warnings: verdict.warnings,
      note:
        "Registered and VALIDATED — the spec passed the house validator and is on the public record. Next in the funnel: floor rounds on live tape (seating for registered fighters is the follow-on wiring); a fighter QUALIFIES at 3+ recorded rounds, every round inside its declared data budget, with cumulative net PnL above $0.00. Qualification is not a purchase — paid seats are still bought the ordinary way ($0.50 via /api/arena-enter).",
    },
  };
}

async function getRegistration(store, id) {
  const fighterId = String(id || "").trim().toLowerCase();
  if (!fighterId) {
    return {
      status: 400,
      body: { error: 'Pass the fighter id: GET /api/arena/register?id=<fighterId> — the lowercase slug of the ring name (for example "pulse").', code: "ID_REQUIRED" },
    };
  }
  const record = await readRecord(store, fighterId);
  if (!record) {
    return {
      status: 404,
      body: {
        error: `No registered fighter with id "${fighterId}". Registration is public and permanent — check the id, or register the fighter with POST /api/arena/register.`,
        code: "NOT_REGISTERED",
      },
    };
  }
  return { status: 200, body: publicRecord(record) };
}

async function programSummary(store) {
  return {
    status: 200,
    body: {
      service: "flow-arena-register",
      offer:
        "Register a Flow Arena fighter as a persona spec — declarative data in the engine's own vocabulary, never code. The house engine executes every spec itself, on the same live tape, at the same listed data prices, under the same $0.60 data cap as the house cast.",
      howToRegister:
        'POST /api/arena/register with the spec JSON as the body: {specVersion: 1, name, owner: {name, payoutWallet}, display?, dataBudgetUsd (<= 0.60), strategy: {target, entry?, sizing?, data?, exits?, scramble?}, participation?}. Validation is the house validator itself — refusals quote its sentences verbatim, with stable error codes.',
      readBack: "GET /api/arena/register?id=<fighterId> — the stored record and its computed funnel status.",
      funnel: [
        "VALIDATED — the spec passes the house validator.",
        `QUALIFIED — computed from recorded rounds only: >= ${QUALIFICATION_MIN_ROUNDS} rounds, every round inside the declared data budget, cumulative net PnL (realized PnL - data spend, prizes excluded) strictly > $0.00.`,
        "PAID SEATS — qualification is not a purchase; seats are bought the ordinary way ($0.50 x402 entry via /api/arena-enter).",
      ],
      reservedNames: validator.RESERVED_NAMES,
      dataCapUsd: validator.HOUSE_CAP_USD,
      store: store.kind,
    },
  };
}

module.exports = {
  KEY_FIGHTER,
  KEY_BY_NAME,
  QUALIFICATION_MIN_ROUNDS,
  getStore,
  evaluateStatus,
  publicRecord,
  createRegistration,
  getRegistration,
  programSummary,
};

module.exports._test = {
  createMemoryStore: builderKey._test.createMemoryStore,
};
