// Fighter persona-spec validator for POST /api/arena/register.
//
// This is the pure validation core of offchain/arena-register.js,
// extracted byte-for-byte (constants, field vocabulary, refusal
// sentences, cross-field coherence rules, normalization) so the API
// can never drift from the house validator: same input, same verdict,
// same words. The only deliberate difference: HOUSE_CAP_USD is the
// published $0.60 constant here — the offchain validator reads it
// from the buy-in config with this same $0.60 as its fallback, and
// the events' dataCapDefault is $0.60.
//
// Specs are DATA, never code: the banned-key / code-pattern / URL
// scans are part of the port, unchanged. A differential test
// (tests/register.test.js) runs this module and the offchain
// validator over the same battery of specs and requires identical
// verdicts.
//
// Extracted 2026-10-13 from offchain/arena-register.js.

'use strict';

// The house per-round data cap — every entrant plays under it.
const HOUSE_CAP_USD = 0.60;

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => "$" + Number(n).toFixed(2);

const DATA_PRICES_USD = { quote: 0.01, verdict: 0.02, signals: 0.01 };
const HOUSE_IDS = ["vex", "audrey", "echo", "fade", "longshot", "rook"];
const HOUSE_NAMES = HOUSE_IDS.map((s) => s.toUpperCase());

// ---------- Spec vocabulary (v1) — mirrors arena-persona-spec.md ----------
const TARGETS = ["topSpike", "coldest", "smartMoneyTop", "universeFirst", "weth"];
const EXIT_TYPES = ["pctMove", "maxHoldRounds", "spikeFade", "smartMoneyExit", "reverifyExit"];
const EXIT_FIELDS = {
  pctMove: ["type", "atPct", "fraction"],
  maxHoldRounds: ["type", "rounds"],
  spikeFade: ["type", "belowScore"],
  smartMoneyExit: ["type"],
  reverifyExit: ["type"],
};
const RESERVED_NAMES = [...HOUSE_NAMES, "FLOWX", "FORMULA"];
const ROOT_FIELDS = ["specVersion", "name", "owner", "display", "dataBudgetUsd", "strategy", "participation", "sample"];
const OWNER_FIELDS = ["name", "contact", "payoutWallet"];
const DISPLAY_FIELDS = ["emoji", "color", "tagline"];
const STRATEGY_FIELDS = ["target", "entry", "sizing", "data", "exits", "scramble"];
const ENTRY_FIELDS = ["minSpikeScore", "minVerdictScore", "requireVerdictSafe", "requireDeepLiquidity", "requireSmartMoneyBuy", "maxPositions", "maxEntriesPerMatch"];
const SIZING_FIELDS = ["fractionOfCash", "minBuyUsd", "cashReserveFraction"];
const DATA_FIELDS = ["buySignalsFeed", "quoteBeforeBuy", "verdictBeforeBuy", "verdictOncePerToken", "requoteHoldingsPerRound", "reverifyHoldingsEveryRounds"];
const SCRAMBLE_FIELDS = ["action", "fractionOfCash", "requireVerdictSafe", "requireSmartMoneyBuy"];
const PARTICIPATION_FIELDS = ["floor", "events"];
const BANNED_KEYS = ["script", "code", "eval", "webhook", "url", "endpoint", "command", "exec", "function", "import", "require"];
const CODE_PATTERN = /(\bfunction\b|=>|\brequire\s*\(|\bimport\s|\beval\s*\(|\bprocess\.|child_process)/;
const URL_PATTERN = /(https?:\/\/|www\.)/i;

function isPlainObject(x) { return typeof x === "object" && x !== null && !Array.isArray(x); }

const MAX_SPEC_DEPTH = 24; // a real spec nests at most ~4 levels
function scanBanned(node, trail, errors, depth = 0) {
  // SECURITY (audit 2026-10-12): unbounded recursion over attacker-shaped
  // JSON is a stack-overflow crash on hostile intake (a 5000-level nest
  // killed the validator with an uncaught RangeError). Depth is capped;
  // anything deeper is refused as data, never crashed on.
  if (depth > MAX_SPEC_DEPTH) {
    if (!errors.some((e) => e.code === "SPEC_TOO_DEEP")) {
      errors.push({ code: "SPEC_TOO_DEEP", field: trail, message: `The spec nests deeper than ${MAX_SPEC_DEPTH} levels at "${trail}". A persona spec is a shallow, flat document (see arena-persona-spec.md) — flatten it and submit again.` });
    }
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => scanBanned(v, `${trail}[${i}]`, errors, depth + 1)); return; }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (BANNED_KEYS.includes(k.toLowerCase())) {
        errors.push({ code: "BANNED_FIELD", field: trail ? `${trail}.${k}` : k, message: `Field "${trail ? trail + "." : ""}${k}" is not allowed in a persona spec. Specs are data, not code: they cannot carry scripts, endpoints, webhooks, or any external reference — the house engine executes every entrant itself, on the same tape. Remove the field.` });
      }
      scanBanned(v, trail ? `${trail}.${k}` : k, errors, depth + 1);
    }
    return;
  }
  if (typeof node === "string") {
    if (URL_PATTERN.test(node)) {
      errors.push({ code: "EXTERNAL_REFERENCE_BANNED", field: trail, message: `Field "${trail}" contains a URL ("${node.slice(0, 60)}"). Persona specs cannot reference anything external in v1 — the only data a fighter may use is the arena's own tape (prices, Flow verdicts and quotes, smart-wallet signals, social velocity). Remove the reference.` });
    } else if (CODE_PATTERN.test(node)) {
      errors.push({ code: "CODE_NOT_ALLOWED", field: trail, message: `Field "${trail}" contains code-shaped content ("${node.slice(0, 60)}"). A persona spec is declarative data in the engine's published vocabulary — it cannot contain functions, expressions, or code of any kind. Express the intent with the fields in arena-persona-spec.md.` });
    }
  }
}

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj || {})) {
    if (!allowed.includes(k)) {
      errors.push({ code: "UNKNOWN_FIELD", field: where ? `${where}.${k}` : k, message: `Unknown field "${where ? where + "." : ""}${k}". The v1 spec has no such field, and the engine would silently ignore it — a silent no-op is worse than a refusal. Valid fields here: ${allowed.join(", ")}. See arena-persona-spec.md.` });
    }
  }
}

function boolField(obj, key, dflt, where, errors) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") {
    errors.push({ code: "FIELD_TYPE", field: `${where}.${key}`, message: `"${where}.${key}" must be true or false — it is ${JSON.stringify(v)}. Set it to true or false, or remove it to take the default (${dflt}).` });
    return dflt;
  }
  return v;
}

function numField(obj, key, dflt, where, errors, { min = null, max = null, exclusiveMin = false, integer = false } = {}) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v))) {
    errors.push({ code: "FIELD_TYPE", field: `${where}.${key}`, message: `"${where}.${key}" must be ${integer ? "a whole number" : "a number"} — it is ${JSON.stringify(v)}.` });
    return dflt;
  }
  if (min !== null && (exclusiveMin ? v <= min : v < min)) {
    errors.push({ code: "FIELD_RANGE", field: `${where}.${key}`, message: `"${where}.${key}" is ${v}, below the ${exclusiveMin ? "exclusive " : ""}minimum of ${min} for this field. See arena-persona-spec.md for the field's range.` });
    return dflt;
  }
  if (max !== null && v > max) {
    errors.push({ code: "FIELD_RANGE", field: `${where}.${key}`, message: `"${where}.${key}" is ${v}, above the maximum of ${max} for this field. See arena-persona-spec.md for the field's range.` });
    return dflt;
  }
  return v;
}

/**
 * Validate a parsed spec object. Returns { ok, errors, warnings, spec } —
 * errors are human-readable sentences (the Bot Forge quotes them
 * verbatim), each with a stable code. `spec` is the normalized spec
 * (defaults filled in, name upper-cased, id derived) when ok.
 */
function validateSpec(raw) {
  const errors = [];
  const warnings = [];
  const err = (code, field, message) => errors.push({ code, field, message });

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ code: "SPEC_NOT_OBJECT", field: null, message: "A persona spec must be a single JSON object — name, owner, dataBudgetUsd, and a strategy. See arena-persona-spec.md and the sample spec (sample-pulse.persona.json)." }], warnings, spec: null };
  }
  scanBanned(raw, "", errors);
  unknownKeys(raw, ROOT_FIELDS, "", errors);

  // specVersion
  if (raw.specVersion === undefined) err("FIELD_REQUIRED", "specVersion", `"specVersion" is required and must be 1 — it is missing. Add "specVersion": 1.`);
  else if (raw.specVersion !== 1) err("SPEC_VERSION_UNSUPPORTED", "specVersion", `"specVersion" is ${JSON.stringify(raw.specVersion)} — only version 1 of the persona spec exists. Set "specVersion": 1.`);

  // name
  let name = null;
  if (typeof raw.name !== "string" || !raw.name.trim()) err("FIELD_REQUIRED", "name", `"name" is required — the fighter's ring name, 2–10 letters or digits (for example "PULSE").`);
  else if (!/^[A-Za-z0-9]{2,10}$/.test(raw.name.trim())) err("NAME_MALFORMED", "name", `"name" is "${raw.name}" — a ring name is 2–10 characters, letters and digits only, no spaces or symbols.`);
  else {
    name = raw.name.trim().toUpperCase();
    if (RESERVED_NAMES.includes(name)) err("NAME_RESERVED", "name", `"${name}" is a house name — the cast (VEX, AUDREY, ECHO, FADE, LONGSHOT, ROOK), FLOWX, and FORMULA are reserved and cannot be registered. Pick a name of your own.`);
  }

  // owner
  const owner = isPlainObject(raw.owner) ? raw.owner : null;
  if (!owner) err("FIELD_REQUIRED", "owner", `"owner" is required: an object with the owner's display name and the Base payout wallet that receives this fighter's prizes.`);
  else {
    unknownKeys(owner, OWNER_FIELDS, "owner", errors);
    if (typeof owner.name !== "string" || !owner.name.trim()) err("FIELD_REQUIRED", "owner.name", `"owner.name" is required — the owner's display name (a person, a team, or an agent identity).`);
    else if (owner.name.length > 80) err("FIELD_RANGE", "owner.name", `"owner.name" is ${owner.name.length} characters — the limit is 80.`);
    if (typeof owner.payoutWallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(owner.payoutWallet)) err("PAYOUT_WALLET_INVALID", "owner.payoutWallet", `"owner.payoutWallet" must be a Base address — "0x" followed by 40 hex characters. It is ${JSON.stringify(owner.payoutWallet)}. This is the wallet the house pays this fighter's prizes to, so it must be exactly right.`);
    else if (/^0x0{40}$/i.test(owner.payoutWallet)) err("PAYOUT_WALLET_INVALID", "owner.payoutWallet", `"owner.payoutWallet" is the zero address — prizes sent there are unrecoverable. Provide the owner's real Base wallet.`);
    if (owner.contact !== undefined && (typeof owner.contact !== "string" || owner.contact.length > 120)) err("FIELD_RANGE", "owner.contact", `"owner.contact" must be a short email address or handle (120 characters at most).`);
  }

  // display
  const display = isPlainObject(raw.display) ? raw.display : {};
  if (raw.display !== undefined && !isPlainObject(raw.display)) err("FIELD_TYPE", "display", `"display" must be an object with emoji, color, and tagline — or be removed entirely.`);
  unknownKeys(display, DISPLAY_FIELDS, "display", errors);
  if (display.color !== undefined && (typeof display.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(display.color))) err("FIELD_RANGE", "display.color", `"display.color" must be a hex color like "#ff6b81" — it is ${JSON.stringify(display.color)}.`);
  if (display.emoji !== undefined && (typeof display.emoji !== "string" || display.emoji.length > 8)) err("FIELD_RANGE", "display.emoji", `"display.emoji" must be a single short emoji (8 characters at most).`);
  if (display.tagline !== undefined && (typeof display.tagline !== "string" || display.tagline.length > 140)) err("FIELD_RANGE", "display.tagline", `"display.tagline" must be one line of at most 140 characters.`);

  // data budget
  let dataBudgetUsd = null;
  if (typeof raw.dataBudgetUsd !== "number" || !Number.isFinite(raw.dataBudgetUsd)) err("FIELD_REQUIRED", "dataBudgetUsd", `"dataBudgetUsd" is required — the fighter's own declared per-round data budget in USD (for example 0.30). It may be lower than the house cap of ${money(HOUSE_CAP_USD)}, never higher.`);
  else if (raw.dataBudgetUsd <= 0) err("DATA_BUDGET_INVALID", "dataBudgetUsd", `"dataBudgetUsd" is ${money(raw.dataBudgetUsd)} — a data budget must be above $0.00. The cheapest data product (quote or signals) costs $0.01.`);
  else if (raw.dataBudgetUsd > HOUSE_CAP_USD + 1e-9) err("DATA_BUDGET_OVER_CAP", "dataBudgetUsd", `"dataBudgetUsd" is ${money(raw.dataBudgetUsd)}, over the house cap of ${money(HOUSE_CAP_USD)} per fighter per round. Every entrant — cast and registered alike — plays under the same cap; that symmetry is the fairness rule. Lower the declared budget to ${money(HOUSE_CAP_USD)} or less.`);
  else dataBudgetUsd = round2(raw.dataBudgetUsd);

  // strategy
  const st = isPlainObject(raw.strategy) ? raw.strategy : null;
  if (!st) err("FIELD_REQUIRED", "strategy", `"strategy" is required: target, entry gates, sizing, data plan, exits, and the scramble rule — the fighter's whole game plan, in the spec vocabulary.`);
  let target = null, entry = {}, sizing = {}, data = {}, scramble = {}, exits = [];
  if (st) {
    unknownKeys(st, STRATEGY_FIELDS, "strategy", errors);
    if (st.target === undefined) err("FIELD_REQUIRED", "strategy.target", `"strategy.target" is required — how the fighter picks its entry token. One of: ${TARGETS.join(", ")}. See arena-persona-spec.md §3.`);
    else if (!TARGETS.includes(st.target)) err("TARGET_UNKNOWN", "strategy.target", `"strategy.target" is ${JSON.stringify(st.target)} — the v1 engine cannot execute that selection rule. Supported targets: ${TARGETS.join(", ")}. If the strategy needs a selection rule that is not listed, it is out of v1 scope (arena-persona-spec.md §5).`);
    else target = st.target;

    const e = isPlainObject(st.entry) ? st.entry : {};
    if (st.entry !== undefined && !isPlainObject(st.entry)) err("FIELD_TYPE", "strategy.entry", `"strategy.entry" must be an object of entry gates — or be removed to take the defaults.`);
    unknownKeys(e, ENTRY_FIELDS, "strategy.entry", errors);
    entry = {
      minSpikeScore: numField(e, "minSpikeScore", 0, "strategy.entry", errors, { min: 0 }),
      minVerdictScore: numField(e, "minVerdictScore", null, "strategy.entry", errors, { min: 0, max: 100, integer: true }),
      requireVerdictSafe: boolField(e, "requireVerdictSafe", false, "strategy.entry", errors),
      requireDeepLiquidity: boolField(e, "requireDeepLiquidity", false, "strategy.entry", errors),
      requireSmartMoneyBuy: boolField(e, "requireSmartMoneyBuy", false, "strategy.entry", errors),
      maxPositions: numField(e, "maxPositions", 3, "strategy.entry", errors, { min: 1, max: 10, integer: true }),
      maxEntriesPerMatch: numField(e, "maxEntriesPerMatch", null, "strategy.entry", errors, { min: 1, max: 50, integer: true }),
    };

    const sz = isPlainObject(st.sizing) ? st.sizing : {};
    if (st.sizing !== undefined && !isPlainObject(st.sizing)) err("FIELD_TYPE", "strategy.sizing", `"strategy.sizing" must be an object — or be removed to take the defaults.`);
    unknownKeys(sz, SIZING_FIELDS, "strategy.sizing", errors);
    sizing = {
      fractionOfCash: numField(sz, "fractionOfCash", 0.25, "strategy.sizing", errors, { min: 0, max: 0.9, exclusiveMin: true }),
      minBuyUsd: numField(sz, "minBuyUsd", 1, "strategy.sizing", errors, { min: 1 }),
      cashReserveFraction: numField(sz, "cashReserveFraction", 0, "strategy.sizing", errors, { min: 0, max: 0.9 }),
    };
    if (sizing.fractionOfCash + sizing.cashReserveFraction > 1 + 1e-9) {
      err("SIZING_CONTRADICTION", "strategy.sizing", `"strategy.sizing" can never trade: fractionOfCash (${sizing.fractionOfCash}) plus cashReserveFraction (${sizing.cashReserveFraction}) exceeds 100% of cash — after keeping the reserve there is never enough left to size an entry. Lower one of the two so they sum to 1 or less.`);
    }

    const d = isPlainObject(st.data) ? st.data : {};
    if (st.data !== undefined && !isPlainObject(st.data)) err("FIELD_TYPE", "strategy.data", `"strategy.data" must be an object — the fighter's data plan — or be removed to take the defaults.`);
    unknownKeys(d, DATA_FIELDS, "strategy.data", errors);
    data = {
      buySignalsFeed: boolField(d, "buySignalsFeed", false, "strategy.data", errors),
      quoteBeforeBuy: boolField(d, "quoteBeforeBuy", true, "strategy.data", errors),
      verdictBeforeBuy: boolField(d, "verdictBeforeBuy", false, "strategy.data", errors),
      verdictOncePerToken: boolField(d, "verdictOncePerToken", false, "strategy.data", errors),
      requoteHoldingsPerRound: numField(d, "requoteHoldingsPerRound", 0, "strategy.data", errors, { min: 0, max: 3, integer: true }),
      reverifyHoldingsEveryRounds: numField(d, "reverifyHoldingsEveryRounds", 0, "strategy.data", errors, { min: 0, max: 10, integer: true }),
    };

    const sc = isPlainObject(st.scramble) ? st.scramble : {};
    if (st.scramble !== undefined && !isPlainObject(st.scramble)) err("FIELD_TYPE", "strategy.scramble", `"strategy.scramble" must be an object — or be removed to take the defaults (scramble: pass).`);
    unknownKeys(sc, SCRAMBLE_FIELDS, "strategy.scramble", errors);
    let scAction = "pass";
    if (sc.action !== undefined) {
      if (!["buy", "pass"].includes(sc.action)) err("FIELD_RANGE", "strategy.scramble.action", `"strategy.scramble.action" is ${JSON.stringify(sc.action)} — a scramble rule is either "buy" (play the surge, subject to its gates) or "pass" (stand aside, as FADE does).`);
      else scAction = sc.action;
    }
    scramble = {
      action: scAction,
      fractionOfCash: numField(sc, "fractionOfCash", 0.2, "strategy.scramble", errors, { min: 0, max: 0.9, exclusiveMin: true }),
      requireVerdictSafe: boolField(sc, "requireVerdictSafe", false, "strategy.scramble", errors),
      requireSmartMoneyBuy: boolField(sc, "requireSmartMoneyBuy", false, "strategy.scramble", errors),
    };

    // exits
    const rawExits = st.exits === undefined ? [] : st.exits;
    if (!Array.isArray(rawExits)) err("FIELD_TYPE", "strategy.exits", `"strategy.exits" must be an array of exit rules (possibly empty — an empty list means positions ride to the final whistle).`);
    else {
      if (rawExits.length > 6) err("FIELD_RANGE", "strategy.exits", `"strategy.exits" declares ${rawExits.length} rules — the v1 limit is 6. Combine or drop the weakest rules.`);
      exits = rawExits.map((r, i) => {
        const where = `strategy.exits[${i}]`;
        if (!isPlainObject(r) || typeof r.type !== "string") {
          err("FIELD_TYPE", where, `Exit rule #${i + 1} must be an object with a "type" — one of: ${EXIT_TYPES.join(", ")}.`);
          return { type: "__invalid__" };
        }
        if (!EXIT_TYPES.includes(r.type)) {
          err("EXIT_RULE_OUT_OF_SCOPE", `${where}.type`, `Exit rule #${i + 1} uses type "${r.type}", which the v1 engine cannot execute. Supported exit types: ${EXIT_TYPES.join(", ")}. Anything else — trailing stops, laddered exits, time-based conditions beyond maxHoldRounds — is out of v1 scope (arena-persona-spec.md §5). Rework the rule into a supported type or remove it.`);
          return { type: "__invalid__" };
        }
        unknownKeys(r, EXIT_FIELDS[r.type], where, errors);
        if (r.type === "pctMove") {
          const atPct = numField(r, "atPct", null, where, errors, {});
          if (atPct === null || atPct === 0) err("FIELD_RANGE", `${where}.atPct`, `Exit rule #${i + 1} (pctMove) needs a non-zero "atPct": positive takes profit at or above it, negative cuts at or below it (for example +5 or -3).`);
          if (atPct !== null && (atPct < -90 || atPct > 500)) err("FIELD_RANGE", `${where}.atPct`, `Exit rule #${i + 1} has atPct ${atPct} — outside the sane band of -90 to +500 for a single round.`);
          const fraction = numField(r, "fraction", 1, where, errors, { min: 0, max: 1, exclusiveMin: true });
          return { type: "pctMove", atPct, fraction };
        }
        if (r.type === "maxHoldRounds") return { type: "maxHoldRounds", rounds: numField(r, "rounds", null, where, errors, { min: 1, max: 100, integer: true }) };
        if (r.type === "spikeFade") return { type: "spikeFade", belowScore: numField(r, "belowScore", null, where, errors, { min: 0 }) };
        return { type: r.type };
      });
    }

    // cross-field coherence — the combinations that would silently never trade
    if (target === "smartMoneyTop" && !data.buySignalsFeed) {
      err("SIGNALS_FEED_REQUIRED", "strategy.data.buySignalsFeed", `Target "smartMoneyTop" reads the smart-wallet signals feed, but "strategy.data.buySignalsFeed" is false — the fighter would be choosing from data it never bought. Set "strategy.data.buySignalsFeed": true (the feed costs $0.01 per round at the listed price).`);
    }
    if (entry.requireVerdictSafe && !data.verdictBeforeBuy) {
      err("VERDICT_DATA_REQUIRED", "strategy.data.verdictBeforeBuy", `"strategy.entry.requireVerdictSafe" is true, but "strategy.data.verdictBeforeBuy" is false — the gate would check verdicts the fighter never bought. Set "strategy.data.verdictBeforeBuy": true (a verdict costs $0.02 at the listed price), or drop the gate.`);
    }
    if (exits.some((x) => x.type === "reverifyExit") && !(data.reverifyHoldingsEveryRounds >= 1)) {
      err("REVERIFY_SCHEDULE_REQUIRED", "strategy.data.reverifyHoldingsEveryRounds", `An exit rule uses "reverifyExit", but "strategy.data.reverifyHoldingsEveryRounds" is 0 — no re-verification is ever scheduled, so the exit could never fire. Set reverifyHoldingsEveryRounds to 1–10 (AUDREY re-verifies every 3rd round), or remove the reverifyExit rule.`);
    }
    // warnings (valid, but probably not what the owner meant)
    if (entry.minVerdictScore !== null && !entry.requireVerdictSafe) warnings.push(`"strategy.entry.minVerdictScore" is set but "requireVerdictSafe" is false — the score floor has no effect unless the verdict gate is on.`);
    if (entry.minSpikeScore > 0 && target !== "topSpike") warnings.push(`"strategy.entry.minSpikeScore" only applies to target "topSpike" — with target "${target}" it has no effect.`);
    if (dataBudgetUsd !== null) {
      const cycle = (data.quoteBeforeBuy ? DATA_PRICES_USD.quote : 0) + (data.verdictBeforeBuy ? DATA_PRICES_USD.verdict : 0);
      if (cycle > 0 && dataBudgetUsd < cycle) warnings.push(`Declared data budget ${money(dataBudgetUsd)} cannot fund one full entry's data purchases (${money(cycle)}: ${data.quoteBeforeBuy ? "quote" : ""}${data.quoteBeforeBuy && data.verdictBeforeBuy ? " + " : ""}${data.verdictBeforeBuy ? "verdict" : ""}). The fighter will announce a budget refusal instead of trading — if that is not the intent, raise the budget or slim the data plan.`);
      if (data.buySignalsFeed && dataBudgetUsd < DATA_PRICES_USD.signals + cycle) warnings.push(`Declared data budget ${money(dataBudgetUsd)} barely covers the signals feed plus one entry's data — expect budget refusals from round two onward.`);
    }
  }

  // participation
  const part = isPlainObject(raw.participation) ? raw.participation : {};
  if (raw.participation !== undefined && !isPlainObject(raw.participation)) err("FIELD_TYPE", "participation", `"participation" must be an object with floor and events booleans — or be removed to take the defaults (both true).`);
  unknownKeys(part, PARTICIPATION_FIELDS, "participation", errors);
  const participation = {
    floor: boolField(part, "floor", true, "participation", errors),
    events: boolField(part, "events", true, "participation", errors),
  };

  if (errors.length) return { ok: false, errors, warnings, spec: null };
  const spec = {
    specVersion: 1,
    name,
    id: name.toLowerCase(),
    owner: { name: owner.name.trim(), payoutWallet: owner.payoutWallet, ...(owner.contact ? { contact: owner.contact } : {}) },
    display: {
      emoji: display.emoji || "🤖",
      color: display.color || "#95a5a6",
      tagline: display.tagline || "",
    },
    dataBudgetUsd,
    strategy: { target, entry, sizing, data, exits, scramble },
    participation,
    ...(raw.sample === true ? { sample: true } : {}),
  };
  return { ok: true, errors: [], warnings, spec };
}


const MAX_SPEC_BYTES = 65536; // a real spec is ~2–4 KB; the Forge sample is 2.4 KB
/** Validate raw file text (the malformed-JSON case is a first-class refusal). */
function validateSpecText(text) {
  // SECURITY (audit 2026-10-12): bound the intake. Specs arrive via
  // GitHub issue bodies and file uploads — neither should ever carry a
  // multi-megabyte "spec" into the parser and validator.
  if (typeof text === "string" && text.length > MAX_SPEC_BYTES) {
    return { ok: false, errors: [{ code: "SPEC_TOO_LARGE", field: null, message: `The spec file is ${text.length} characters — the limit is ${MAX_SPEC_BYTES}. A persona spec is a small JSON document (the sample is about 2,400 characters). Remove anything that is not the spec itself and submit again.` }], warnings: [], spec: null };
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    return { ok: false, errors: [{ code: "MALFORMED_JSON", field: null, message: `The spec file is not valid JSON: ${e.message}. A persona spec is one JSON object — check commas, quotes, and brackets, then submit again. (The sample spec, sample-pulse.persona.json, is a working starting point.)` }], warnings: [], spec: null };
  }
  return validateSpec(parsed);
}


module.exports = {
  validateSpec, validateSpecText,
  RESERVED_NAMES, TARGETS, EXIT_TYPES, HOUSE_CAP_USD, MAX_SPEC_BYTES,
};
