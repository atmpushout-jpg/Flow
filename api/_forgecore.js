// Forge core — GENERATED from forge.html (the "// === CORE ===" section).
// The Adjustment Center's pure logic (archetypes, the §7 weights->rules
// mapping, spec builder, validator) has exactly one source of truth:
// forge.html. The Telegram bot loads that section at runtime; this
// serverless copy is extracted from it byte-for-byte so /api/build
// derives specs with identical semantics. If forge.html's core changes,
// regenerate this file from it — never edit the logic here directly.
// Regenerate: extract the text between the CORE markers in forge.html
// and place it below, above the module.exports line.

"use strict";
var ARCHETYPES = {
  momentum:  { label:"Momentum",  plain:"Bold striker",    emoji:"🔴", color:"#ff6b81", blurb:"Attacks whatever is moving first. Speed is the strategy.",
               weights:{momentum:85, contrarian:5,  copySmartMoney:30, safetyFirst:0,  patience:10}, sizingPct:40, dataBudgetUsd:0.45, exitRule:"ride_to_target" },
  contrarian:{ label:"Contrarian",plain:"Lone wolf",      emoji:"🌑", color:"#1dd1a1", blurb:"Buys what the crowd ignores. Wins by spending almost nothing.",
               weights:{momentum:5,  contrarian:90, copySmartMoney:10, safetyFirst:20, patience:60}, sizingPct:30, dataBudgetUsd:0.05, exitRule:"trim_into_strength" },
  copycat:   { label:"Copycat",   plain:"Copy the pros",  emoji:"🪞", color:"#c56cf0", blurb:"Follows the smart wallets' footprints, second in line on purpose.",
               weights:{momentum:30, contrarian:0,  copySmartMoney:85, safetyFirst:10, patience:25}, sizingPct:25, dataBudgetUsd:0.20, exitRule:"cut_losers_fast" },
  auditor:   { label:"Auditor",   plain:"Careful checker",emoji:"🛡️", color:"#54a0ff", blurb:"No trade without a clean safety verdict. Reads the contract first.",
               weights:{momentum:10, contrarian:10, copySmartMoney:0,  safetyFirst:95, patience:55}, sizingPct:15, dataBudgetUsd:0.60, exitRule:"cut_losers_fast" },
  sniper:    { label:"Sniper",    plain:"Patient sniper", emoji:"🎯", color:"#a4b0be", blurb:"Silent for rounds, then one large, patient, well-aimed entry.",
               weights:{momentum:60, contrarian:0,  copySmartMoney:10, safetyFirst:40, patience:95}, sizingPct:65, dataBudgetUsd:0.10, exitRule:"ride_to_target" },
  balanced:  { label:"Balanced",  plain:"Busy worker",    emoji:"🌱", color:"#feca57", blurb:"The playbook fighter: a bit of everything, rules for every case.",
               weights:{momentum:45, contrarian:40, copySmartMoney:50, safetyFirst:50, patience:45}, sizingPct:20, dataBudgetUsd:0.30, exitRule:"cut_losers_fast" }
};
var EXIT_DISCIPLINES = ["cut_losers_fast", "ride_to_target", "trim_into_strength"];
var WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
var CHAMPION_DATA_PER_MATCH = 0.03; // FADE, 4x champion — Match 4 receipts
var RESERVED_NAMES = ["VEX", "AUDREY", "ECHO", "FADE", "LONGSHOT", "ROOK", "FLOWX", "FORMULA"];
var BUDGET_MIN = 0.03, BUDGET_MAX = 0.60; // house fairness cap, enforced in the UI AND here

function clampNum(v, lo, hi){ v = Number(v); if (!isFinite(v)) v = lo; return Math.min(hi, Math.max(lo, v)); }
function isValidWallet(w){ return typeof w === "string" && WALLET_RE.test(w.trim()); }

// Every surface control is clamped to the persona-spec bounds before it can
// reach the spec, so a beginner cannot create an illegal bot from this page.
function clampState(state){
  var s = JSON.parse(JSON.stringify(state));
  s.dataBudgetUsd = Math.round(clampNum(s.dataBudgetUsd, BUDGET_MIN, BUDGET_MAX) * 100) / 100;
  s.sizingPct = Math.round(clampNum(s.sizingPct, 5, 65));
  Object.keys(s.weights).forEach(function(k){ s.weights[k] = Math.round(clampNum(s.weights[k], 0, 100)); });
  if (EXIT_DISCIPLINES.indexOf(s.exitRule) < 0) s.exitRule = "trim_into_strength";
  if (!ARCHETYPES[s.archetype]) s.archetype = "balanced";
  return s;
}

// THE §7 MAPPING (arena-persona-spec.md §7 — normative). Translates the five
// strategy weights + the sizing and budget sliders into the strategy{} of an
// arena-persona-spec v1 — the exact vocabulary offchain/arena-register.js
// validates and the house engine executes. The exit-discipline picker is not
// in §7 (the table leaves exit ORDER open): exits are evaluated in declared
// order in the engine, so the picker sets that order — stop first, target
// first, or profit-taking first.
function deriveStrategy(state){
  var w = state.weights;
  var m = w.momentum, c = w.contrarian, cp = w.copySmartMoney, s = w.safetyFirst, p = w.patience;
  // Target: highest of momentum / contrarian / copySmartMoney; ties break
  // momentum -> copySmartMoney -> contrarian. safetyFirst and patience never
  // choose the target.
  var top = Math.max(m, c, cp);
  var target = (m === top) ? "topSpike" : (cp === top) ? "smartMoneyTop" : "coldest";
  var entry = {
    minSpikeScore: target === "topSpike" ? 5 + Math.round(20 * m / 100) + Math.round(5 * p / 100) : 0,
    minVerdictScore: s >= 50 ? 50 + Math.round(s / 2) : null,
    requireVerdictSafe: s >= 50,
    requireDeepLiquidity: false,
    requireSmartMoneyBuy: false,
    maxPositions: 1 + Math.round(2 * (100 - p) / 100),
    maxEntriesPerMatch: p >= 80 ? 2 : (p >= 50 ? 4 : null)
  };
  var data = {
    buySignalsFeed: target === "smartMoneyTop" || cp >= 50 || m >= 50,
    quoteBeforeBuy: true,
    verdictBeforeBuy: s >= 25,
    verdictOncePerToken: false,
    requoteHoldingsPerRound: 0,
    reverifyHoldingsEveryRounds: s >= 75 ? 3 : 0
  };
  var sizing = {
    fractionOfCash: Math.round(state.sizingPct) / 100,
    minBuyUsd: 1,
    cashReserveFraction: (target === "coldest" && c >= 60) ? 0.33 : 0
  };
  var byKind = {
    takeProfit: { type: "pctMove", atPct: 3 + Math.round(5 * p / 100), fraction: 1 },
    lossCut: s >= 25 ? { type: "pctMove", atPct: -(3 + Math.round(5 * s / 100)), fraction: 1 } : null,
    maxHold: p >= 40 ? { type: "maxHoldRounds", rounds: 3 + Math.round(7 * p / 100) } : null,
    reverify: s >= 75 ? { type: "reverifyExit" } : null,
    targetExit: target === "topSpike" ? { type: "spikeFade", belowScore: 8 }
              : target === "smartMoneyTop" ? { type: "smartMoneyExit" } : null
  };
  var ORDER = {
    cut_losers_fast:    ["lossCut", "takeProfit", "maxHold", "reverify", "targetExit"],
    ride_to_target:     ["takeProfit", "maxHold", "targetExit", "reverify", "lossCut"],
    trim_into_strength: ["takeProfit", "lossCut", "maxHold", "targetExit", "reverify"]
  };
  var order = ORDER[state.exitRule] || ORDER.trim_into_strength;
  var exits = order.map(function(k){ return byKind[k]; }).filter(function(x){ return !!x; });
  var scramble = {
    action: m >= 60 ? "buy" : "pass",
    fractionOfCash: 0.2,
    requireVerdictSafe: s >= 50,
    requireSmartMoneyBuy: false
  };
  return { target: target, entry: entry, sizing: sizing, data: data, exits: exits, scramble: scramble };
}

function estimateDataSpend(state){
  var w = state.weights;
  var raw = 0.02
    + 0.28 * (w.momentum / 100)
    + 0.14 * (w.copySmartMoney / 100)
    + 0.20 * (w.safetyFirst / 100)
    + 0.08 * (w.contrarian / 100)
    - 0.15 * (w.patience / 100);
  var est = Math.max(0.02, Math.round(raw * 100) / 100);
  return Math.min(est, state.dataBudgetUsd);
}

function styleTitle(state){
  var w = state.weights;
  var ranked = Object.keys(w).sort(function(a,b){ return w[b]-w[a]; });
  var lead = { momentum:"momentum-led", contrarian:"contrarian", copySmartMoney:"smart-money-copying",
               safetyFirst:"verdict-first", patience:"patient" }[ranked[0]];
  return lead;
}

function describeFighter(state){
  var w = state.weights, name = (state.name || "UNNAMED").toUpperCase();
  var bits = [];
  if (w.momentum >= 50) bits.push("attacks social-velocity spikes early");
  else if (w.momentum >= 20) bits.push("takes momentum when it is served up");
  if (w.contrarian >= 50) bits.push("buys the coldest names on the board while the crowd chases heat");
  else if (w.contrarian >= 20) bits.push("keeps a contrarian streak against crowded trades");
  if (w.copySmartMoney >= 50) bits.push("mirrors fresh smart-wallet buys");
  else if (w.copySmartMoney >= 20) bits.push("listens to what the smart wallets are doing");
  if (w.safetyFirst >= 50) bits.push("refuses any entry without a clean safety verdict");
  else if (w.safetyFirst >= 20) bits.push("checks the contract before it commits real size");
  if (w.patience >= 60) bits.push("waits for one or two deep, well-aimed shots instead of spraying entries");
  else if (w.patience >= 35) bits.push("stays selective about when it spends");
  if (!bits.length) bits.push("plays a quiet, balanced book and lets the board come to it");
  var exitTxt = { cut_losers_fast:"Its stop is checked first, so it cuts losers fast and banks quick targets.",
                  ride_to_target:"It rides positions to the profit target and tolerates the swings — the stop is the last rule consulted.",
                  trim_into_strength:"It takes profit off the table first, then manages what remains." }[state.exitRule];
  return name + " — a " + styleTitle(state) + " fighter that " + bits.join(", ") + ". " +
    "It stakes " + state.sizingPct + "% of its cash per entry on a $" + state.dataBudgetUsd.toFixed(2) +
    " data budget. " + exitTxt;
}

// The one-sentence plain-English summary a beginner reads while adjusting.
function summarySentence(state){
  var p = state.weights.patience;
  var pick = p >= 70 ? "waits for only the strongest signals before it moves"
           : p >= 40 ? "is picky about when it enters — it wants a real signal first"
           : p >= 15 ? "enters when a decent signal shows up"
           : "jumps in early and often";
  var profit = { cut_losers_fast: "takes profits early and cuts losses fast",
                 ride_to_target: "lets its winners run toward the big target",
                 trim_into_strength: "banks half its profit early and lets the rest run" }[state.exitRule];
  return "Your bot " + pick + ", spends up to $" + state.dataBudgetUsd.toFixed(2) +
    " on data per match, stakes " + state.sizingPct + "% of its cash per entry, and " + profit + ".";
}

function buildSpec(rawState){
  var state = clampState(rawState);
  var a = ARCHETYPES[state.archetype];
  return {
    specVersion: 1,
    name: (state.name || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10),
    owner: { name: (state.ownerName || "").trim(), payoutWallet: (state.walletAddress || "").trim() },
    display: { emoji: a.emoji, color: a.color, tagline: a.blurb },
    dataBudgetUsd: state.dataBudgetUsd,
    strategy: deriveStrategy(state),
    participation: { floor: true, events: true }
  };
}

// Page-side pre-check, mirroring the checks the house validator
// (offchain/arena-register.js) runs on the fields a human controls — its
// sentences are quoted so the fix is always plain. The strategy block is
// machine-derived via the §7 mapping; the authoritative check is the
// validator's, at registration.
function validateSpec(spec){
  var errs = [];
  if (!spec || typeof spec !== "object") return ["A persona spec must be a single JSON object — name, owner, dataBudgetUsd, and a strategy."];
  if (typeof spec.name !== "string" || !/^[A-Za-z0-9]{2,10}$/.test(spec.name))
    errs.push("\"name\" is \"" + (spec.name || "") + "\" — a ring name is 2–10 characters, letters and digits only, no spaces or symbols.");
  else if (RESERVED_NAMES.indexOf(spec.name) >= 0)
    errs.push("\"" + spec.name + "\" is a house name — the cast (VEX, AUDREY, ECHO, FADE, LONGSHOT, ROOK), FLOWX, and FORMULA are reserved and cannot be registered. Pick a name of your own.");
  if (!spec.owner || typeof spec.owner !== "object" || !spec.owner.name)
    errs.push("Add your name as the owner (step 2) — it goes on the fighter's registration.");
  if (!spec.owner || !isValidWallet(spec.owner.payoutWallet || ""))
    errs.push("Add your bot's wallet address in step 1 — a Base address is \"0x\" followed by 40 hex characters. Prizes settle to this wallet, so it must be exactly right.");
  else if (/^0x0{40}$/i.test(spec.owner.payoutWallet))
    errs.push("That wallet is the zero address — prizes sent there are unrecoverable. Use your real Base wallet from step 1.");
  if (typeof spec.dataBudgetUsd !== "number" || !(spec.dataBudgetUsd >= 0.03) || spec.dataBudgetUsd > 0.60)
    errs.push("\"dataBudgetUsd\" must be between $0.03 and the house cap of $0.60 per fighter per match.");
  if (!spec.strategy || ["topSpike", "coldest", "smartMoneyTop", "universeFirst", "weth"].indexOf(spec.strategy.target) < 0)
    errs.push("\"strategy.target\" is missing or not a selection rule the v1 engine can execute.");
  return errs;
}

module.exports = { ARCHETYPES, EXIT_DISCIPLINES, RESERVED_NAMES, BUDGET_MIN, BUDGET_MAX,
  clampState, deriveStrategy, estimateDataSpend, describeFighter, summarySentence,
  buildSpec, validateSpec, isValidWallet };
