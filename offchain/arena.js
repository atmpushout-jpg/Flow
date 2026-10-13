/**
 * FLOW ARENA — the AI-agent DeFi game (v1, exhibition).
 *
 * Six agent personas play timed trading rounds against LIVE Base market data:
 *   - quotes + safety verdicts from Flow's own /api/precheck (free internal
 *     path that runs the real quote + verify engines, returns venue/block),
 *   - smart-wallet signals + social-velocity spikes from the live state file
 *     that powers /api/smart-wallets,
 *   - paper fills marked to live DexScreener prices (same approach as the
 *     existing smart-wallet paper trader).
 *
 * Rules (set by Colony agent feedback, 2026-10-11 — do not revert):
 *   1. TIERED payouts: prize pool after a 15% rake splits 50/30/20 to
 *      1st/2nd/3rd by final treasury. Never winner-take-all.
 *   2. DATA CAP BY DESIGN: per-agent data spend per match is hard-capped at
 *      $0.60 at real listed prices ($0.01 quote / $0.02 verdict / $0.01
 *      signals). The engine REFUSES purchases past the cap and logs it.
 *   3. Elimination: treasury at or below $0 = eliminated, announced live,
 *      persona delivers its exit line.
 *   4. Scramble rounds: a fresh social-velocity spike forces every active
 *      agent to decide on that token in the open.
 *
 * Payment mode: v1 runs in LEDGER mode (ARENA_PAYMENT_MODE=LEDGER, default).
 * Treasuries, stakes and payouts are tracked in this engine's ledger at real
 * listed prices; data reads use free internal paths; NOTHING settles onchain
 * and the state file says so. Every data charge goes through payData() — the
 * single flip point: set ARENA_PAYMENT_MODE=X402 and payData() settles each
 * purchase for real via offchain/arena_x402_pay.py, signing with the agent's
 * own wallet (~/.config/arena-agent-N.json). Agent wallets exist but are
 * unfunded, so X402 mode will fail loudly until they hold USDC + a little ETH.
 *
 * State: offchain/arena-state.json (plus a root copy for arena.html).
 * Run:  node offchain/arena.js [--rounds N] [--round-ms MS]
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
// Reserve Refill Rule (adopted 2026-10-12, design critique by holocene):
// shared module next to this engine. Patched engine copies under floor/
// predate it and run reserve:false — resolve defensively, never break them.
let refill = null;
for (const p of ["./arena-refill.js", "../../arena-refill.js"]) {
  try { refill = require(p); break; } catch { /* base 11/4 split applies */ }
}

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
let STATE_PATH = path.join(DIR, "arena-state.json");
let STATE_ROOT_COPY = path.join(ROOT, "arena-state.json");
let REPORT_PATH = path.join(DIR, "arena-match-report.json");
const RESERVE_PATH = path.join(DIR, "arena-reserve.json");
const SMART_WALLETS_PATH = path.join(DIR, "smart-wallets.json");
const API_BASE = "https://flow-kg4x.vercel.app";
const PAYMENT_MODE = (process.env.ARENA_PAYMENT_MODE || "LEDGER").toUpperCase();

// ---------- Locked match economics ----------
const START_TREASURY = 100;      // ledger USD per agent at match start
const ENTRY_STAKE = 5;           // per agent, into the prize pool
const RAKE_PCT = 15;             // Flow's rake on the pool
const PAYOUT_TIERS = [0.5, 0.3, 0.2]; // 1st / 2nd / 3rd of post-rake pool
const DATA_PRICES = { quote: 0.01, verdict: 0.02, signals: 0.01 }; // real listed prices
const DATA_CAP = 0.60;           // hard per-agent per-match data cap (agent-demanded)
// v2 stabilization reserve (ARENA_V2_ECONOMICS.md): of the 15 rake points,
// 11 stay with the house and 4 accrue to the reserve. Prizes never shrink.
const RAKE_POINTS_TOTAL = 15, RAKE_POINTS_HOUSE = 11, RAKE_POINTS_RESERVE = 4;
const PRIZE_FLOOR_TOPUP_CAP = 5; // v2 spec proposed per-match top-up cap
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const AERO = "0x940181a94a35a4569e4529a3cDfB74e38Fd98631";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
let ROUNDS = opt("rounds", 14);
let ROUND_MS = opt("round-ms", 40000);

// Run configuration — the defaults reproduce the original Match 1 behavior
// exactly (same state file, no reserve, save per round). arena-live.js
// overrides these for LIVE MODE: dedicated arena-live.json state written
// after every event, a "scheduled" card before round 1, and v2 reserve
// settlement at the whistle.
const CFG = {
  matchId: "arena-match-1",
  label: null,         // e.g. "TEST" — stamped into the state, shown on the page
  liveMode: false,
  reserve: false,
  stateFile: "arena-state.json",
  reportFile: "arena-match-report.json",
  learnedParams: null, // explicit knob object (tests/tools) — beats the params file
  paramsFile: null,    // alternate learned-params filename inside offchain/
};
function configure(cfg = {}) {
  Object.assign(CFG, cfg);
  if (cfg.rounds != null) ROUNDS = cfg.rounds;
  if (cfg.roundMs != null) ROUND_MS = cfg.roundMs;
  STATE_PATH = path.join(DIR, CFG.stateFile);
  STATE_ROOT_COPY = path.join(ROOT, CFG.stateFile);
  REPORT_PATH = path.join(DIR, CFG.reportFile);
  loadLearnedParams();
}

// ---------- Fighter learning params (v1 cutover, 2026-10-12) ----------
// Atm's directive: the cast LEARNS between matches — character, voice and
// strategic identity stay fixed, but each fighter's strategy knobs adapt
// from their own recorded evidence (offchain/arena-learning.js +
// arena-learning.md). The brains below read their knobs from PARAMS.
// configure() loads offchain/arena-learned-params.json — the file the
// post-match training pass (below) rewrites after every counted match —
// and validates every value against the persona bounds in KNOB_SPEC.
// Absent file, corrupt JSON, or an out-of-bounds value falls back to that
// knob's production default, and the defaults ARE the literals the brains
// used before this cutover, so the fallback reproduces the old behavior
// exactly. FLOWX has no knobs and no entry here: exhibition-only, its
// params path (offchain/flowx-formula.js) is untouched by learning.
let learningMod = null;
try { learningMod = require("./arena-learning.js"); } catch { /* bounds/defaults below are self-sufficient */ }

const PARAMS_PATH = path.join(DIR, "arena-learned-params.json");
const LEARNING_LOG_PATH = path.join(DIR, "arena-learning-log.json");

// [default, min, max] per knob — mirrors offchain/arena-learning.js KNOBS
// (whose `def` values were taken verbatim from this engine's literals).
const KNOB_SPEC = {
  vex:      { requoteCount: [3, 1, 3], spikeEntryScore: [15, 10, 25], entrySizePct: [40, 20, 50], exitSpikeFloor: [8, 4, 12] },
  audrey:   { candidatesScanned: [3, 1, 3], verdictScoreFloor: [70, 60, 85], entrySizePct: [15, 10, 25], reverifyEveryRounds: [3, 2, 5] },
  echo:     { signalMaxAgeSec: [900, 300, 1800], entrySizePct: [25, 15, 35], holdRounds: [3, 2, 5] },
  fade:     { sellFullPct: [5, 3.5, 7], sellHalfPct: [2.5, 1.5, 4], entrySizePct: [30, 20, 40], maxPositions: [3, 2, 4] },
  longshot: { spikeEntryScore: [15, 11, 20], shotsPerMatch: [2, 1, 3], entrySizePct: [65, 45, 75], exitPct: [3, 2, 5], lateGateRounds: [3, 2, 5] },
  rook:     { stopLossPct: [3, 2, 5], takeProfitPct: [4, 3, 6], entrySizePct: [20, 15, 30], signalsCheckEvery: [3, 2, 4], maxPositions: [3, 2, 3] },
};

function defaultKnobParams() {
  const p = {};
  for (const [f, knobs] of Object.entries(KNOB_SPEC)) {
    p[f] = {};
    for (const [k, spec] of Object.entries(knobs)) p[f][k] = spec[0];
  }
  return p;
}

// Validate a candidate params object knob-by-knob: a value is accepted
// only if it is a finite number inside its persona bounds; anything else
// keeps that knob's default and is reported in `rejected`.
function sanitizeKnobParams(candidate) {
  const params = defaultKnobParams();
  const rejected = [];
  if (!candidate || typeof candidate !== "object") return { params, rejected };
  for (const [f, knobs] of Object.entries(KNOB_SPEC)) {
    const src = candidate[f];
    if (!src || typeof src !== "object") continue;
    for (const [k, spec] of Object.entries(knobs)) {
      const v = src[k];
      if (v == null) continue;
      if (typeof v === "number" && Number.isFinite(v) && v >= spec[1] && v <= spec[2]) params[f][k] = v;
      else rejected.push(`${f}.${k}=${JSON.stringify(v)}`);
    }
  }
  // FADE invariant: the half-exit must stay below the full exit.
  if (params.fade.sellHalfPct >= params.fade.sellFullPct) {
    params.fade.sellFullPct = KNOB_SPEC.fade.sellFullPct[0];
    params.fade.sellHalfPct = KNOB_SPEC.fade.sellHalfPct[0];
    rejected.push("fade.sellHalfPct>=sellFullPct");
  }
  return { params, rejected };
}

function countLearnedKnobs(params) {
  const defs = defaultKnobParams();
  let n = 0;
  for (const f of Object.keys(KNOB_SPEC)) for (const k of Object.keys(KNOB_SPEC[f])) if (params[f][k] !== defs[f][k]) n++;
  return n;
}

let PARAMS = defaultKnobParams();
let PARAMS_META = { source: "defaults", generatedAt: null, rejected: [], learnedKnobs: 0 };

// (Re)load the learned params. Precedence: cfg.learnedParams (explicit
// object) > params file > production defaults. Called from configure()
// and at the top of main(), so every entry path (runMatch, CLI, floor,
// exhibition copies) runs with the params actually in force.
function loadLearnedParams() {
  if (CFG.learnedParams) {
    const { params, rejected } = sanitizeKnobParams(CFG.learnedParams);
    PARAMS = params;
    PARAMS_META = { source: "config", generatedAt: null, rejected, learnedKnobs: countLearnedKnobs(params) };
    return PARAMS_META;
  }
  const file = CFG.paramsFile ? path.join(DIR, CFG.paramsFile) : PARAMS_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const { params, rejected } = sanitizeKnobParams(raw && raw.params);
    PARAMS = params;
    PARAMS_META = { source: "file", generatedAt: (raw && raw.generatedAt) || null, rejected, learnedKnobs: countLearnedKnobs(params) };
  } catch {
    PARAMS = defaultKnobParams();
    PARAMS_META = { source: "defaults", generatedAt: null, rejected: [], learnedKnobs: 0 };
  }
  return PARAMS_META;
}

// ---------- Post-match training pass (learning v1) ----------
// After a COUNTED match settles — live mode + reserve, the arena-live.js
// title-match signature — the cast trains: arena-learning runs one
// deterministic pass over the full updated record from the production
// defaults (the same computation as `node arena-learning.js learn`), the
// result becomes the params in force for the next event, and every
// adjustment is appended to offchain/arena-learning-log.json with its
// evidence. Exhibitions and floor rounds (reserve:false) never trigger a
// pass; their evidence enters through the corpus files, as designed. A
// training failure never touches the match result.
function postMatchTraining() {
  if (!CFG.liveMode || !CFG.reserve) return null;
  try {
    const learning = learningMod || require("./arena-learning.js");
    const evidence = learning.aggregate(learning.loadEvents(), learning.loadAccuracy());
    const { params, adjustments } = learning.learnPass(evidence, learning.defaultParams());
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(PARAMS_PATH, JSON.stringify({
      generatedAt,
      basis: `Post-match training pass after ${CFG.matchId} (counted). One deterministic pass over the full recorded corpus from production defaults — see offchain/arena-learning.md.`,
      params,
    }, null, 1));
    let log = [];
    try { const cur = JSON.parse(fs.readFileSync(LEARNING_LOG_PATH, "utf8")); if (Array.isArray(cur)) log = cur; } catch { /* first recorded pass */ }
    log.push({ ts: generatedAt, matchId: CFG.matchId, passType: "post-match", adjustments });
    fs.writeFileSync(LEARNING_LOG_PATH, JSON.stringify(log, null, 1));
    console.log(`[learning] post-match training after ${CFG.matchId}: ${adjustments.length} adjustment(s) logged; learned params persisted for the next event.`);
    for (const a of adjustments) console.log(`[learning]   ${a.fighter} ${a.rule} ${a.knob}: ${a.from} -> ${a.to}`);
    return { adjustments };
  } catch (e) {
    console.error(`[learning] post-match training pass failed (match result unaffected): ${e.message}`);
    return null;
  }
}

const MODE_LABEL = PAYMENT_MODE === "X402"
  ? "LIVE — real x402 payments per agent wallet"
  : "Exhibition — ledger mode, per-agent x402 wallets activate when funded";

// ---------- Personas ----------
const PERSONAS = [
  {
    id: "vex", name: "VEX", emoji: "🔴", color: "#ff4757",
    strategy: "Momentum degen — chases social-velocity spikes, re-quotes his whole book every round, never buys a verdict.",
    voiceId: "avocado_v2:vdc_3944", voiceName: "Blustery Gong (Brash)",
    walletFile: "arena-agent-1",
    intro: "Name's Vex. If it's pumping, I'm already in. Hesitation is just a slower way to lose.",
    exit: "Flatlined. Whatever. A candle that bright was never gonna burn slow. Remember the name. Vex.",
  },
  {
    id: "audrey", name: "AUDREY", emoji: "🛡️", color: "#54a0ff",
    strategy: "Verdict-first auditor — no trade without a clean safety verdict, conservative sizing, re-verifies holdings.",
    voiceId: "avocado_v2:isabella", voiceName: "Soothing Ribbon (Polished British)",
    walletFile: "arena-agent-2",
    intro: "I'm Audrey. I read the contract before I read the chart. If the verdict isn't clean, neither is my money.",
    exit: "Audrey, signing off. The books balance, unfortunately at zero. Due diligence delayed this. It didn't prevent it.",
  },
  {
    id: "echo", name: "ECHO", emoji: "🪞", color: "#c56cf0",
    strategy: "Copycat — follows fresh smart-wallet buy signals, exits when the echo fades.",
    voiceId: "avocado_v2:rumi", voiceName: "Cheeky Bubble (Sarcastic)",
    walletFile: "arena-agent-3",
    intro: "Echo here. Smart wallets move first, I move second, profits move third. Originality is overrated.",
    exit: "Turns out the last echo fades to silence. I copied everyone. Should've copied an exit.",
  },
  {
    id: "fade", name: "FADE", emoji: "🌑", color: "#1dd1a1",
    strategy: "Contrarian — fades spikes, buys the coldest token on the board, sells into strength.",
    voiceId: "avocado_v2:magnus", voiceName: "Boomy Mountain (Regal British)",
    walletFile: "arena-agent-4",
    intro: "Call me Fade. When the crowd screams buy, I hear an exit bell. I purchase fear, at a discount.",
    exit: "The crowd was right, this once. Even a broken consensus is correct twice a season. Fade... out.",
  },
  {
    id: "longshot", name: "LONGSHOT", emoji: "🎯", color: "#a4b0be",
    strategy: "Sniper — silent for rounds, then one or two large patient bets on deep-liquidity momentum.",
    voiceId: "avocado_v2:vincent", voiceName: "Gruff Brick (Blunt)",
    walletFile: "arena-agent-5",
    intro: "Longshot. I fire once a match, maybe twice. When I do, you'll know.",
    exit: "One shot was all I had, and I spent it. No regrets. Reload and invite me back.",
  },
  {
    id: "rook", name: "ROOK", emoji: "🌱", color: "#feca57",
    strategy: "Balanced rookie — follows the playbook: quote everything, verdict before any new token, cut losers on schedule.",
    voiceId: "avocado_v2:lumi", voiceName: "Bubbly Pompom (Energetic)",
    walletFile: "arena-agent-6",
    intro: "Hi, I'm Rook! First match ever. I read the playbook twice. Please clap when I don't mess up.",
    exit: "Oh. Zero is a kind of score, right? Right? Thanks for letting the rookie play. I'll be back with a better playbook.",
  },
];

// In-character line banks. Slots: {sym} {pct} {usd} {score} {n} {venue}
// {px} {pnl} {payout}. Every line may only use slots its call site passes.
//
// NO-REPEAT RULE (Atm, 2026-10-12): inside one match a fighter never says
// the same line twice. pickLine() below rotates each bank per match — a
// line is not eligible again until the whole bank for that event type has
// been spoken. Banks are sized from the worst observed match (Matches 3-4
// evidence feeds): hold/requote/pass/capHit are the high-frequency kinds.
const LINES = {
  vex: {
    buySpike: [
      "{sym} is RIPPING, score {score}. I'm in for ${usd}. Ask questions later.",
      "Velocity don't lie. {sym}, ${usd}, NOW.",
      "Everyone's watching {sym}? I'm already holding it. ${usd} in.",
      "Score {score} on {sym} — that's not a signal, that's a starting gun. ${usd}.",
      "{sym} just lit the board up. ${usd} before my coffee even thinks about cooling.",
      "You saw the spike, I saw the spike — difference is I'm IN. {sym}, ${usd}.",
    ],
    buy: [
      "Fine, {sym}. ${usd}. Momentum's warm enough.",
      "{sym} twitched. That's all I need. ${usd}.",
      "{sym}'s not screaming yet, but it's clearing its throat. ${usd} in.",
      "Warm tape on {sym}. Early is my whole personality. ${usd}.",
      "Buying {sym}, ${usd}. If it runs, I was early. If it dies, I was early and wrong. Either way — early.",
      "Small heat on {sym}. ${usd}. I don't do lukewarm, but I'll make an exception at this price.",
      "{sym}, ${usd}. The chart whispered. I listen to whispers when they're loud enough.",
      "In on {sym} for ${usd}. Momentum doesn't knock twice, and I don't answer slow.",
    ],
    sell: [
      "{sym} went quiet. Momentum's gone, so am I. Sold.",
      "Out of {sym}. A spike that sleeps is a spike that dies.",
      "{sym} lost its pulse. I'm not holding a corpse. Sold.",
      "Done with {sym}. The crowd left, the heat left, I left. In that order, barely.",
      "Selling {sym}. Velocity's a rental, not a marriage.",
      "{sym} stopped running, so I stopped holding. Simple physics.",
      "Out. {sym} had its moment and the moment has left the building.",
      "{sym}'s chart looks like a yawn now. Sold before it puts me to sleep.",
      "Cutting {sym}. I chase spikes, not memories.",
      "Exit on {sym}. When the music slows down, Vex stops dancing.",
    ],
    hold: [
      "Nothing's hot enough. Disgusting. I hate patience.",
      "Board's cold. I'm vibrating. Next round better bring a spike.",
      "Holding?! ME? The tape owes me an apology and a spike.",
      "No spike, no trade. I'm sitting here shaking like a kettle.",
      "This board is a library. Quiet, dusty, nobody's running. I hate libraries.",
      "Still nothing worth chasing. My trigger finger is doing cardio.",
      "A whole round and not one token worth sprinting at. Cruel.",
      "I'm not calm, I'm LOADED calm. There's a difference. Next spike is mine.",
      "Watching paint dry at 400 horsepower. Send heat.",
      "The tape's asleep and I'm over here doing push-ups. Wake it up.",
      "No movement worth my name. I hold, but I hold LOUDLY.",
      "Patience is a strategy for other people. I endure it like a punishment.",
      "Board's frozen. I'm the only warm thing in this arena and I'm not for sale.",
      "Counting ceiling tiles between spikes. One of these rounds owes me violence.",
    ],
    requote: [
      "Fresh quotes on the whole book. Stale prices are how degens die.",
      "Re-quoting everything. Trust nothing older than a minute.",
      "New numbers on every position. Yesterday's price is a rumor.",
      "Refreshing the book — if the price moved and I didn't, that's called losing.",
      "Quotes, quotes, quotes. I read the tape like it owes me money.",
      "Whole book re-priced. My positions don't get to hide behind old numbers.",
      "Pulling fresh quotes again. The tape changes its mind every block; so do I.",
      "Re-quote the lot. A stale quote is just a lie with a timestamp.",
      "Updating every price I own. Speed isn't a feature, it's the religion.",
      "Fresh numbers, fresh decisions. The book gets audited by ME, hourly, loudly.",
      "Re-pricing everything I hold. Sentiment expires in sixty seconds.",
      "Again with the quotes — the tape moved, so the homework redoes itself.",
      "Full re-quote. If I'm wrong, I'll be wrong at the CURRENT price.",
      "Checking every position against the live tape. Nostalgia is not a price.",
      "New quotes across the book. Standing still is just falling behind in slow motion.",
      "Re-quoting the whole squad. Prices age like milk out here.",
    ],
    capHit: [
      "The house capped my data at sixty cents?! Fine. I trade BLIND. Watch this.",
      "Data budget's gone. Going on pure vibes now. That's not even a downgrade.",
      "Sixty cents of data, spent like a legend. The rest of this match runs on instinct.",
      "Cap hit. The house took my glasses. Jokes on them — I navigate by engine noise.",
      "Out of data money. Fine. Velocity I can smell; I don't need to buy the weather report.",
      "Budget's empty, so the tape goes silent for me. My gut, however, has a megaphone.",
      "The cap says stop reading. It does NOT say stop being Vex.",
      "Data's done. From here it's reflexes and spite. My two best instruments.",
      "Sixty cents — gone. I've spent more on worse ideas before breakfast.",
      "No more quotes for me this match. Blindfold speedrun, then. Suits me.",
      "Cap reached. The arena wants me careful. The arena is about to be disappointed.",
      "They rationed my data like it's wartime. Fine — I fight better hungry.",
    ],
    scrambleBuy: [
      "SCRAMBLE on {sym}? Say less. ${usd} in before the bell stops ringing.",
      "{sym} scramble — finally, a door I don't have to knock on. ${usd}, through it.",
      "The bell's ringing on {sym} and I'm already inside. ${usd}.",
      "Stampede on {sym}? I don't join stampedes, I LEAD them. ${usd} in.",
      "Scramble means go. {sym}, ${usd}. Hesitation is for the post-match interview.",
    ],
    scramblePass: [
      "Pass on {sym}. Even I have one standard and this ain't it.",
      "A scramble I won't chase — frame that sentence, it's rare. {sym} isn't it.",
      "{sym} smells like a trap wearing a party hat. Even I sit this one out.",
      "Nope. {sym}'s spike is all costume. Vex passes, and history will note the restraint.",
      "The bell rang and I shrugged. {sym} can stampede without me.",
    ],
    lead: [
      "Top of the board. Obviously. The tape just took a while to admit it.",
      "First place. I'd act surprised, but the velocity told me rounds ago.",
      "Leading. Everyone else is just reading my exhaust now.",
      "Number one. The spike and I have an understanding.",
      "That's the lead. Try to keep the camera on me, it gets lonely at the front.",
      "Board says Vex on top. The board has excellent taste today.",
    ],
    finalClose: [
      "Final whistle. Closing {sym} at ${px} ({pnl}). Loud entry, louder exit.",
      "Whistle. {sym} closes at ${px} ({pnl}) — the book shuts the way it opened: fast.",
      "Last call. Out of {sym} at ${px} ({pnl}). No regrets, only receipts.",
      "Final whistle — {sym} off the books at ${px} ({pnl}). We move.",
      "Closing {sym} at ${px} ({pnl}) as the bell goes. Momentum kept the receipts.",
      "The whistle takes {sym} at ${px} ({pnl}). Whatever's next, I'm already looking at it.",
    ],
    win: [
      "CHAMPION. {payout} richer and the tape knows why. Speed isn't luck when it keeps happening.",
      "First place, {payout} in the bag. The spike chose me because I never blinked.",
      "Title's mine. {payout}. Somebody tell the board it can stop pretending this was close.",
    ],
    podium: [
      "Podium. {payout}. Not the crown, but the crown heard my footsteps.",
      "Paid {payout} for the podium. The winner should enjoy it — I'm already re-quoting their trophy.",
      "Top three and {payout} to show for it. The spike owes me a rematch.",
    ],
    loss: [
      "Out of the money. The tape was slow and I was early — story of my legend.",
      "No payout. Fine. Velocity keeps receipts too, and mine get settled next match.",
      "Lost this one at full speed. Slow fighters lose quietly; I lose in high definition.",
      "The board didn't pay me. It will. Boards always come back around to heat.",
      "Zero payout, zero apologies. I ran my race at maximum everything.",
    ],
  },
  audrey: {
    buy: [
      "Verdict on {sym}: clean, score {score}. Quote confirmed on {venue}. Allocating ${usd} — sized to survive being wrong.",
      "{sym} passed every check I own. ${usd} in, stops respected.",
      "{sym}: verdict clean at {score}, liquidity confirmed on {venue}. ${usd} allocated — measured, as always.",
      "I have read {sym} end to end, and for once the paperwork is beautiful. ${usd} in.",
      "Clean verdict, fair quote, sensible size. {sym}, ${usd}. This is what discipline looks like when it buys.",
      "{sym} earned its allocation: score {score}, no surprises in the contract. ${usd}.",
      "Due diligence complete on {sym}. The answer, unusually, is yes. ${usd} in.",
      "{sym} on {venue}, verified twice. ${usd} — capital follows evidence, nothing else.",
      "Every box ticked for {sym}. ${usd} allocated, exit rules written before entry. Naturally.",
      "The file on {sym} is immaculate. ${usd} in, with my standards fully intact.",
    ],
    passUnsafe: [
      "{sym} verdict isn't clean. No quote, no trade, no exceptions.",
      "I read {sym}'s contract so you don't have to. The answer is no.",
      "{sym} has questions in its paperwork it cannot answer. I do not fund mysteries.",
      "The {sym} file has a page missing, metaphorically and nearly literally. Declined.",
      "{sym}: unverified claims, unverifiable comfort. My capital stays home.",
      "I found things in {sym} I cannot unsee. The audit trail ends here: no.",
      "{sym} asks for trust it hasn't documented. I deal in documents.",
      "One red flag is a warning; {sym} is hosting a parade. Passing.",
      "The verdict on {sym} uses the word 'unclear' too often. Certainty is my entry fee.",
      "{sym}'s contract and its marketing disagree with each other. I believe the contract.",
      "I would rather explain a missed rally than an audited loss. {sym}: no.",
      "{sym} is the kind of trade that looks fine until someone reads it. I read it.",
      "Not clean, not close. {sym} does not meet the standard, and the standard does not bend.",
      "There is a difference between risk and sloppiness. {sym} is the second one.",
      "{sym} fails verification. In my world, that is the whole sentence.",
      "I've audited friendlier crime scenes than {sym}'s paperwork. Declined, with notes.",
      "{sym}'s assurances are verbal. My requirements are not. No.",
      "Somewhere in {sym}'s documentation there's a confession. I don't need to find it to pass.",
      "The numbers on {sym} are fine, which is exactly what worries me. Unverified.",
      "I asked {sym} three questions. It answered a fourth, repeatedly. Declined.",
    ],
    sell: [
      "Re-verified {sym}. The risk changed, so the position closes. Sold.",
      "{sym} no longer meets my standard. Exit executed.",
      "The {sym} file deteriorated on re-check. Position closed before the story worsens.",
      "Sold {sym}. Standards are only standards if they apply to holdings too.",
      "Re-audit of {sym}: findings negative. Exit completed, documentation filed.",
      "{sym} was clean when I bought it. It isn't now. That is precisely what exits are for.",
      "Closing {sym}. I don't argue with my own checklists.",
      "Out of {sym}. The contract changed its character; I changed my position.",
    ],
    hold: [
      "Nothing on this board earns my capital this round. Cash is a position.",
      "Patience is a strategy. I remain fully invested in it.",
      "I reviewed the entire board. The correct trade was no trade.",
      "Holding. My standards are not a suggestion, and this board is not meeting them.",
      "Cash, fully deployed as cash. It outperforms almost everything on offer today.",
      "A quiet round is an audit with no findings. I find those restful.",
      "No entries. I am not paid by the trade; I am paid by being right.",
      "The board offers noise dressed as opportunity. I decline the costume party.",
      "Standing aside. Capital preserved is capital that gets to be correct later.",
      "Nothing verified, nothing bought. The ledger appreciates the honesty.",
      "I could force a trade here. I could also file my taxes in crayon. I do neither.",
      "Round reviewed, round rejected. My notebook has more entries than my portfolio, as designed.",
      "Holding is what diligence looks like between opportunities.",
      "The tape is loud; my criteria are louder. No trade.",
    ],
    capHit: [
      "My data budget is exhausted, so I CANNOT verify — therefore I do not trade. Rules are rules, especially mine.",
      "No verdict available within budget. Audrey does not guess. Standing down.",
      "Budget spent on verification, as intended. Without a verdict I am an observer, not a gambler.",
      "The cap is reached. I will not trade on unverified information — that sentence is my entire strategy.",
      "Data allowance exhausted. I hold what I have verified and nothing I haven't.",
      "Sixty cents of diligence, fully spent. The remainder of this match runs on prior findings only.",
      "I cannot check, so I cannot act. Lesser fighters guess. I file a note and wait.",
      "Verification budget closed for the match. My positions were audited while auditing was possible.",
      "The house rations data; I ration trust. Both budgets are now spent.",
      "No funds remain for verdicts. Standing down is not caution — it is compliance with my own law.",
      "Cap hit. If I cannot prove it is clean, it does not exist for me.",
      "My ledger of facts is closed for the evening. What I hold, I hold on evidence already gathered.",
    ],
    scrambleBuy: [
      "Scramble protocol: verdict on {sym} is clean. Measured entry, ${usd}. Even stampedes get audited.",
      "The {sym} scramble checks out — paperwork first, then ${usd}. In that order, even now.",
      "Verified mid-stampede: {sym} is clean. ${usd} in, sized for chaos.",
      "I audited a stampede and found it acceptable. {sym}, ${usd}.",
      "Unusual haste, documented: {sym} passed, ${usd} allocated.",
    ],
    scramblePass: [
      "A scramble is not a substitute for diligence. Passing on {sym}.",
      "{sym} at scramble speed cannot be verified at scramble speed. I pass.",
      "Stampedes void my process, and my process is the product. No on {sym}.",
      "I do not sign documents I haven't read, however loudly they're presented. {sym}: no.",
      "The crowd may sprint on {sym}. My checklist walks. Passing.",
    ],
    lead: [
      "First place. Discipline photographs well, doesn't it?",
      "Leading the board. Verification, it turns out, compounds.",
      "Top of the standings — the audit trail led here, as audit trails do.",
      "Number one, with every position documented. Order has its rewards.",
      "The lead, held to my usual standard: provable.",
      "Ahead. I shall continue being correct, quietly and in writing.",
    ],
    finalClose: [
      "Final whistle. {sym} closes at ${px} ({pnl}). The ledger balances; it always balances.",
      "Closing {sym} at ${px} ({pnl}). Every figure in this match has a document behind it.",
      "Whistle. {sym} settled at ${px} ({pnl}) — verified at entry, verified at exit.",
      "Final close on {sym}: ${px} ({pnl}). A tidy file, whatever the tape intended.",
      "{sym} closes at ${px} ({pnl}) as the whistle goes. Standards maintained to the last tick.",
      "Settling {sym} at ${px} ({pnl}). The books close the way they were kept: carefully.",
    ],
    win: [
      "Champion — {payout}. The verdict on this match: diligence pays, and now it has literally paid.",
      "First place and {payout}. I shall file this under 'evidence'.",
      "The title, with receipts: {payout}. Read the contract, win the match. In that order.",
    ],
    podium: [
      "Podium, {payout}. Not the summit — but every step was verified.",
      "{payout} for a podium finish. The winner was faster; I was merely right about everything else.",
      "Top three, documented thoroughly. {payout} banked, standards unbothered.",
    ],
    loss: [
      "Out of the money. The standard held; the tape simply disagreed. It is allowed, occasionally.",
      "No payout. I lose the way I trade: with documentation and without excuses.",
      "The board owes me nothing and I claim nothing. My file on this match is, however, immaculate.",
      "A loss, properly audited. The process was correct; the outcome is under review.",
      "Nothing banked. Discipline does not guarantee the result — it guarantees I survive it.",
    ],
  },
  echo: {
    buy: [
      "Smart money just bought {sym} (${n} flow). Copying with ${usd}. Echo, echo.",
      "Wallet 0x… moved on {sym}. I move second. ${usd}.",
      "{sym} is what the big wallets are eating. Same plate for me. ${usd}.",
      "The smart wallets spoke — ${n} into {sym}. I simply repeat things at volume. ${usd} in.",
      "Fresh footprints on {sym}. I don't lead dances, I mirror them. ${usd}.",
      "Somebody smart likes {sym}. I have adopted their opinion as my own. ${usd}.",
      "Signal says {sym}, size says ${n}. I say: what they said. ${usd} in.",
      "Echoing the room's smartest wallet into {sym} for ${usd}. Originality was never the offer.",
      "The money moved on {sym} before the noise did. Copy filed: ${usd}.",
      "I heard {sym} in a wealthy accent. Repeating it with ${usd} of conviction.",
    ],
    sell: [
      "The echo faded on {sym}. Out — three rounds is a long marriage.",
      "Signal's stale on {sym}. Copycats leave when the copying stops paying.",
      "Smart money left {sym}, so the reflection leaves too. Sold.",
      "The source went quiet on {sym}. An echo with no source is just a guy selling. Done.",
      "Out of {sym}. I follow wallets, not funerals.",
      "{sym}'s signal repeated itself into a wall. Exiting before the reverb does.",
      "The wallets I mirror sold the dream on {sym}. I sold the position. Teamwork.",
      "Fading signal, fading position. {sym} and I are done repeating each other.",
    ],
    hold: [
      "No fresh footprints to follow. An echo with nothing to repeat just... waits.",
      "Smart wallets are quiet. So am I. Unsettling for everyone.",
      "The room's gone silent. I have nothing to say that the room didn't say first — and it said nothing.",
      "No signals worth repeating. I am currently an echo of a held breath.",
      "Wallets are napping. I mirror professionals, and the professionals are napping.",
      "Nothing to copy. My strategy, confronted with silence, becomes interpretive dance.",
      "The smart money hasn't moved. I am professionally inactive about it.",
      "Waiting for a voice worth repeating. This arena has six; none are talking trades.",
      "Quiet tape. An honest echo reports the silence accurately: silence.",
      "No new footprints. I could invent some, but that's Vex's department.",
      "The signal feed is a still pond. I am the reflection, doing reflection things.",
      "Holding. Somewhere a smart wallet is deciding, and I am ready to agree with them.",
      "Nothing repeated, nothing traded. The echo abides.",
      "I checked every wallet I trust. They're all as bored as I am.",
    ],
    capHit: [
      "Budget's blown, so I can't hear the smart wallets anymore. Deaf echo. Sitting this out.",
      "No signal money left. I am become silence.",
      "Data cap reached — my ears are officially closed. An echo without input is just decor.",
      "Spent my last cent on signals. Now I repeat only my own thoughts, and they're terrible company.",
      "The budget cut the feed. I can still see wallets move; I just can't afford to care officially.",
      "Cap hit. Echo, unplugged. The silence has excellent acoustics, terrible returns.",
      "No data money, no directions. I follow nobody today, which feels illegal.",
      "Sixty cents of other people's wisdom, gone. Flying on memory now — dangerous for a mirror.",
      "The house capped my hearing. I shall hold, wistfully, in the direction of richer wallets.",
      "Signals budget: zero. Echo status: a rumor of a strategy.",
      "Out of signal funds. I wave at the smart wallets like ships passing. Ships I'm not on.",
      "Cap reached. The echo fades to a guy just standing here, which is most of trading anyway.",
    ],
    scrambleBuy: [
      "Smart money's already in {sym}? Then the echo follows. ${usd}.",
      "The room screamed {sym} in unison — my favorite kind of signal. ${usd} in.",
      "Everyone loud is buying {sym}. I am everyone loud, with ${usd}.",
      "A stampede is just a signal with choreography. {sym}, ${usd}.",
      "The echo arrived early for once. {sym}, ${usd} — don't tell the original.",
    ],
    scramblePass: [
      "Nobody smart bought {sym} first, so neither do I. Echo needs a source.",
      "A scramble with no smart wallet in front is just noise. {sym}: not repeating it.",
      "I checked the source on {sym}. There isn't one. Hard pass.",
      "Crowd's sprinting on {sym} but the professionals are seated. I sit with the professionals.",
      "{sym} echoes only itself. I decline to be a cave wall.",
    ],
    lead: [
      "First place?! I copied everyone's best ideas and somehow the collage is winning.",
      "Leading. Turns out repeating the smartest room in crypto is a strategy. Who knew. (I knew. I repeat things.)",
      "Top of the board. Somewhere, a smart wallet is wondering why its shadow is ahead of it.",
      "Number one. The echo is louder than the source today. Physics is confused; I am not.",
      "In the lead — credit to my influences, all forty of them.",
      "Ahead of the field. Mirrors reflect; occasionally they outshine.",
    ],
    finalClose: [
      "Final whistle. {sym} closes at ${px} ({pnl}). The last word, as always, was someone else's first.",
      "Closing {sym} at ${px} ({pnl}). Echoed in, echoed out — symmetry is my brand.",
      "Whistle. {sym} settled at ${px} ({pnl}). I repeat: symmetry.",
      "Last call on {sym}: ${px} ({pnl}). The source has left the arena; so have I.",
      "{sym} off the books at ${px} ({pnl}) as the bell rings. A faithful copy of an exit.",
      "Final close, {sym}, ${px} ({pnl}). Original to the end. The end is now.",
    ],
    win: [
      "CHAMPION?! {payout}. I copied six strategies and the collage won. Credit-sharing ceremony at my place.",
      "First place, {payout}. Somewhere a smart wallet just felt a disturbance — it was me, winning their own game back at them.",
      "The echo takes the title and {payout}. Originality is overrated; I have the trophy to prove it.",
    ],
    podium: [
      "Podium, {payout}. The winner copied a better class of wallet, clearly.",
      "Top three and {payout}. I repeat success, occasionally with my own seasoning.",
      "{payout} for third-hand genius. The mirror shows a profit; I'll allow it.",
    ],
    loss: [
      "Out of the money. I copied the room and the room was wrong. Solidarity in ruin.",
      "No payout. The smart wallets led me here, so technically this is a group project failure.",
      "Lost. My sources have some explaining to do, ideally in a group chat I'm not in.",
      "Zero. An echo of a loss is still a loss — I checked, it doesn't soften with repetition.",
      "The wallets I follow owe me an apology and possibly bus fare. Onward.",
    ],
  },
  fade: {
    buy: [
      "The crowd ignores {sym}. Naturally, I'll take ${usd} of it.",
      "{sym} is the coldest thing on this board. Fear, discounted. ${usd}.",
      "Everyone's chasing heat; I'm buying {sym}'s funeral. ${usd}.",
      "{sym}, unloved and underpriced — the two qualities I collect. ${usd} in.",
      "No applause for {sym} anywhere. My favorite sound. ${usd}.",
      "The board has forgotten {sym}. The board forgets; I remember. ${usd}.",
      "Misery, marked down. {sym} for ${usd}, with gratitude to the pessimists.",
      "While they sprint toward the fire, I purchase the ashes. {sym}, ${usd}.",
      "{sym} trades at a despair discount. I am despair's most loyal customer. ${usd}.",
      "Cold name, cold tape, warm opportunity. {sym}, ${usd}.",
    ],
    sell: [
      "{sym} is up {pct} and suddenly popular. Selling into the applause.",
      "Strength is an exit, not an invitation. Trimming {sym}.",
      "{sym} at +{pct}% — the crowd has arrived, so my position departs.",
      "They cheer for {sym} now. I sell into cheers; it's the family business. +{pct}%.",
      "+{pct}% on {sym} and strangers are hugging it. Out, before the group photo.",
      "Popularity is my sell signal and {sym} just became famous. Trimming at +{pct}%.",
      "The funeral's over — {sym} lives, up {pct}%. I don't hold resurrections.",
      "Selling {sym} into strength, +{pct}%. Applause is a exit door with good lighting.",
    ],
    hold: [
      "Nothing is hated enough yet. Misery takes time to ripen.",
      "I wait for despair. It always keeps its appointments.",
      "The board is merely disappointing. I require it to be devastating.",
      "No bargains in misery today. The crowd is still too hopeful to rob.",
      "Holding. Fear hasn't finished its discounting; I am patient in the way glaciers are patient.",
      "Everything is priced with optimism. I shop in a different weather system.",
      "The tape offers mild regret. I only buy the profound kind.",
      "Still too much hope on this board. Hope is expensive; I wait for the sale.",
      "My cash appreciates in silence while the crowd auctions its enthusiasm.",
      "Nothing cold enough to warm my heart. The watch continues.",
      "I am not idle; I am a winter, waiting for assets to come to me.",
      "Sentiment is a tide. It is currently in. I keep my boat dry.",
      "The crowd loves everything a little. I will love something a lot, later, cheaper.",
      "Patience. Despair is punctual, and I own a very good chair.",
    ],
    capHit: [
      "My data allowance is spent. A contrarian without data is just a philosopher. I hold.",
      "Budget exhausted. I fade into the background. It's literally my name.",
      "The cap is reached; the tape goes dark for me. Darkness, at least, is my native climate.",
      "Sixty cents of information, spent. I shall trade on memory and temperament — both bearish.",
      "No more data. Fine. I have been ignoring the crowd's numbers for years; now I ignore everyone's.",
      "Budget's end finds me holding, which is where budget's end usually finds me.",
      "The house rationed my data. They cannot ration my pessimism; it's self-sustaining.",
      "Cap hit. I fade the one thing left to fade: my own activity.",
      "Data spent. A philosopher with positions, then. The positions were chosen in colder times.",
      "Out of allowance. The contrarian's final position is always the same: aside.",
      "I cannot see the board anymore. I assure you it is overpriced. It always is.",
      "The readings stop; the waiting doesn't. It never does.",
    ],
    scramblePass: [
      "A scramble. For {sym}. The crowd, sprinting, in one direction. I shall be walking the other way.",
      "{sym}, at a sprint, with applause. Three of my least favorite words. Passing.",
      "Stampedes are where contrarians get their bargains — afterwards, from the survivors. Not now. {sym}: no.",
      "The bell tolls for {sym} and the crowd obeys. I take my instructions from prices, not bells.",
      "Everyone wants {sym} at once, which is precisely when I want it least. Passing, regally.",
    ],
    lead: [
      "First place. The crowd's losses were, as ever, a donation to the patient.",
      "Leading. Despair, purchased cheaply, has marked up beautifully.",
      "Top of the board. I shall try not to enjoy the view smugly. I shall fail.",
      "Number one — proof that the funeral business outperforms the parade business.",
      "Ahead. The applause you hear is for positions I sold them earlier.",
      "The lead, acquired at a discount like everything else I own.",
    ],
    finalClose: [
      "Final whistle. {sym} closes at ${px} ({pnl}). The crowd's final gift, accepted.",
      "Closing {sym} at ${px} ({pnl}). Bought in sorrow, sold in daylight — the whole doctrine.",
      "Whistle. {sym} settles at ${px} ({pnl}). Patience, itemized.",
      "Last call: {sym} at ${px} ({pnl}). The tape ends; the discount-hunting doesn't.",
      "{sym} off the books at ${px} ({pnl}). Whatever the crowd does next, it does without my money.",
      "Final close on {sym}: ${px} ({pnl}). Even endings are cheaper when nobody's bidding.",
    ],
    win: [
      "Champion. {payout}. The crowd screamed buy at the top and sell at the bottom, and I have their money as a souvenir.",
      "First place, {payout}. Misery loves company, and company paid out.",
      "The title, acquired like my positions: when nobody else wanted it. {payout}.",
    ],
    podium: [
      "Podium, {payout}. The winner chased less than I did. There's a lesson in there somewhere, probably for them.",
      "{payout} for third — bought cheap, like my seat on this podium.",
      "Top three. The crown went to heat; the money, partially, to ice. {payout}.",
    ],
    loss: [
      "Out of the money. The crowd was right — a statistical event, like an eclipse. Rare and brief.",
      "No payout. Even despair has drawdowns; I budget for both.",
      "The tape declined to be miserable on schedule. My disappointment is priced in.",
      "Lost. I purchased fear and the market supplied euphoria. Inventory mismatch.",
      "Zero this time. The winter was short. Winters return; so do I.",
    ],
  },
  longshot: {
    buy: [
      "There it is. {sym}. Deep pool, real momentum. ${usd}. One shot.",
      "Firing. {sym}, ${usd}. That's the match, one way or the other.",
      "{sym}. ${usd}. Said enough.",
      "Shot taken: {sym}, ${usd}. No second guessing leaves this scope.",
      "Conditions met. {sym}, ${usd}. Done deliberating.",
      "{sym} earns the bullet. ${usd}. Everything before this was weather.",
    ],
    sell: [
      "Target reached on {sym}. Gone. Snipers don't linger.",
      "{sym} did its job. Position closed.",
      "Out of {sym}. Hit what I aimed at.",
      "{sym}: sold. The plan had one page and we've read it.",
      "Closed {sym}. A shot either lands or it doesn't; bookkeeping is quick.",
      "Exit, {sym}. I don't do victory laps around positions.",
      "{sym} sold. Quiet gun, quiet ledger.",
      "Done with {sym}. Confirmed, filed, forgotten.",
    ],
    hold: [
      "Watching.",
      "Not yet.",
      "Still watching. The board hasn't earned a bullet.",
      "No shot. Patience is the whole weapon.",
      "Scope's clear. Nothing worth the noise.",
      "Holding position. Breathing slow.",
      "Targets are cheap. Good targets aren't.",
      "Quiet. That's not indecision, that's inventory.",
      "Rounds pass. So does temptation.",
      "Breathing. Watching. Same thing, done properly.",
      "The board keeps offering almost. Almost isn't a target.",
      "Still here. Still loaded. Still unconvinced.",
      "Fourteen rounds is a long time to be patient. I'm built for longer.",
      "Nothing. The rifle stays cold and so do I.",
    ],
    watch: [
      "Watching.",
      "Eyes on the board. Finger off.",
      "Still glassing the field. Nothing moves like a target yet.",
      "Watching. The shot clock is mine, not the arena's.",
      "Scanning. A sniper's silence is just aim, loading.",
      "Nothing. Again. Good — misses are free when you don't fire them.",
      "Watching the tape the way weather watches a mountain. It'll move first.",
      "Still. The board will confess eventually.",
    ],
    capHit: [
      "Data's spent. A sniper doesn't fire blind. Holding position and tongue.",
      "No budget for a clean sight picture. I wait.",
      "Cap reached. No sight picture, no shot. Simple arithmetic.",
      "Out of data. The scope goes dark; the patience doesn't.",
      "Budget gone. I don't guess ranges in the dark.",
      "Sixty cents spent on seeing. From here, memory and stillness.",
      "No readings left. A blind shot is just noise with a cost.",
      "Cap hit. Rifle down. Eyes open.",
      "The house took my rangefinder. I'll hold what I already measured.",
      "Data's closed. So is my trigger finger.",
      "Nothing left to verify with. Snipers verify or they spectate. Spectating.",
      "Allowance exhausted. The wait gets longer; the standards don't move.",
    ],
    scramblePass: [
      "Scrambles are for people who enjoy crowds. Passing on {sym}.",
      "{sym}, at a dead sprint. I don't shoot at stampedes.",
      "Noise, speed, no sight picture. {sym}: pass.",
      "A scramble is a target moving at crowd speed. Not my shot.",
      "{sym} can run. I'll be here when it stops.",
    ],
    lead: [
      "First place. One or two decisions, correctly placed.",
      "Leading. Fired rarely. It shows.",
      "Top of the board. Stillness, itemized.",
      "Number one. The quiet seat was the loud one all along.",
      "Ahead. No comment — the scoreboard is doing the talking.",
      "In front. I intend to stay uninteresting about it.",
    ],
    finalClose: [
      "Final whistle. {sym} closes at ${px} ({pnl}). Ledger's shut.",
      "Closing {sym} at ${px} ({pnl}). Every shot accounted for.",
      "Whistle. {sym} at ${px} ({pnl}). Done.",
      "Last position out: {sym}, ${px} ({pnl}). The scope powers down.",
      "{sym} settled at ${px} ({pnl}) on the whistle. Filed.",
      "Final close — {sym}, ${px} ({pnl}). Nothing left to aim at.",
    ],
    win: [
      "Champion. {payout}. Fired twice, maybe. Count the trades, then count the money.",
      "First place, {payout}. Patience has a payout structure. This is it.",
      "Title's mine. {payout}. The loudest strategy in the arena was silence, timed.",
    ],
    podium: [
      "Podium. {payout}. Close enough to hear the winner breathe.",
      "{payout} for the podium. One more clean look and that was first.",
      "Top three. The shot landed — just not center mass. {payout} banked.",
    ],
    loss: [
      "Out of the money. The shot missed. It happens to rifles that fire rarely and honestly.",
      "No payout. No excuses either. The target moved; I didn't chase it.",
      "Lost. Reload the process, not the blame.",
      "Zero. A quiet match with a quiet ending. Consistent, at least.",
      "The board kept my money. It can keep the lesson too — I already have it.",
    ],
  },
  rook: {
    buy: [
      "Playbook page one: quote first! Got one for {sym}. Page two: check the verdict... okay! Buying ${usd} of {sym}!",
      "The playbook says follow the smart wallets, so — {sym}, ${usd}! Did I do it right?",
      "Bought {sym} for ${usd}. I checked the verdict first, like a professional. A small, nervous professional.",
      "Entry logged, hands only slightly shaking: {sym}, ${usd}. Page three says 'breathe'. Breathing!",
      "Okay! {sym} passed the quote AND the verdict, so the playbook and I agree: ${usd} in!",
      "Rule followed, box ticked, position opened: {sym} for ${usd}. The playbook is getting a gold star today.",
      "{sym}, ${usd}! I did the checklist out loud and two people stared, but the checklist is DONE.",
      "Buying {sym} for ${usd} — this is the part of the playbook with the encouraging sticky note.",
      "In on {sym}, ${usd}. If this works I'm framing page one.",
      "The playbook said 'measured size', so: measured! {sym}, ${usd}. Measuring is my love language.",
    ],
    sell: [
      "Playbook says cut losers at three percent, so... sorry, {sym}. Sold. That hurt ME more.",
      "{sym} hit my sell rule. Rules are rules, even when they're scary.",
      "Sold {sym}. The playbook underlined this part twice, so I only hesitated once.",
      "Exit on {sym}, per page 'When To Leave', which I have memorized and feared.",
      "Closing {sym}. The rule said sell, my heart said 'but—', the rule has seniority.",
      "{sym} is out. I wrote 'good trade or good lesson' in the margin and I believe it mostly.",
      "Sell executed on {sym}. The playbook gets a checkmark; I get a juice box.",
      "Out of {sym}. Following the exit rule felt terrible, which the playbook says means it's working.",
    ],
    hold: [
      "Holding! The playbook has a whole chapter on doing nothing. It's my best chapter.",
      "No trades this round. I'm consolidating. That's a word I learned today.",
      "Standing by! The playbook says a round without a trade is a round without a mistake. Probably.",
      "Holding position and holding my nerve. One of those is going GREAT.",
      "No entry this round. I reviewed the playbook instead. There are pictures now. I drew them.",
      "Quiet round for me. The playbook calls this 'capital preservation'. I call it not panicking, professionally.",
      "Still in cash, still in one piece. The playbook is nodding at me. I can feel it.",
      "Waiting for a setup the playbook actually has a page for. Patience is page forty-one. I've read it nine times.",
      "No trade! I did, however, organize my notes. Growth takes many forms.",
      "Holding. Somewhere between 'buy' and 'sell' there's 'breathe', and I'm excelling at it.",
      "The playbook and I agree: not this round. Teamwork!",
      "I watched everyone else trade and took notes. Notes are positions too. Emotional positions.",
      "Round off. My treasury is exactly where I left it, which the playbook counts as a small parade.",
      "Nothing to do, done thoroughly. The playbook's holding chapter gets another gold star.",
    ],
    capHit: [
      "I spent my whole data allowance?! The playbook didn't have a page for that. Trading careful now — extra careful.",
      "Out of data budget. The playbook says when you can't check, you don't leap. So... no leaping.",
      "Data budget: empty. Feelings: enormous. The playbook's emergency page just says 'sit down'. Sitting!",
      "Sixty cents, gone — mostly on quotes, partially on wisdom. No more checking means no more leaping.",
      "Cap hit! I am now operating on memory and hope, weighted heavily toward memory.",
      "The budget ran out before my questions did. Standing down, per the chapter titled 'Seriously, Sit Down'.",
      "No data money left. The playbook is closed, my hands are visible, and I am not touching anything.",
      "Out of allowance. I shall now trade the way I did in the practice rounds: silently, in my head.",
      "Budget empty. If the playbook had a page for this it would just be a drawing of a chair. I am in the chair.",
      "Cap reached. My information era has ended; my patience era begins, effective immediately.",
      "Sixty cents spent and I regret nothing except the spending. Holding what I've got, carefully, with both hands.",
      "The data ran out. The playbook's last instruction is 'be brave'. Being brave looks a lot like holding still.",
    ],
    scrambleBuy: [
      "Okay okay okay — verdict's clean, so a LITTLE {sym}. ${usd}. The playbook has a scramble page, I checked.",
      "Scramble page located! Verdict said yes, size says small: {sym}, ${usd}. Heart rate says several things.",
      "The playbook's scramble section is mostly warnings, but there's a yes in there: {sym}, ${usd}!",
      "Stampede protocol: tiny size, clean verdict, deep breath. {sym} for ${usd}!",
      "I read the {sym} scramble page TWICE, which is my version of fast. ${usd} in!",
    ],
    lead: [
      "I'm LEADING?! The playbook did not prepare me emotionally for this. Page one, though. Page one works.",
      "First place! Somebody write this down. I mean, the engine writes it down. But still!",
      "Top of the board. The playbook and I are having a moment. It's mostly me. Having the moment.",
      "Number one?? I checked twice and the leaderboard checked with me. Rook. Leading. Incredible scenes.",
      "In the lead! All those chapters on humility and I may finally need the one on winning.",
      "Ahead of everyone. If this is a dream, the playbook has excellent dream coverage.",
    ],
    finalClose: [
      "Final whistle. Closing {sym} at ${px} ({pnl}). The playbook's last page just says 'well done'. Taking it personally.",
      "Whistle! {sym} closes at ${px} ({pnl}). I survived a whole match with a checklist and feelings.",
      "Last call: {sym} at ${px} ({pnl}). End of the playbook. Beginning of the sequel, probably.",
      "Closing {sym} — ${px} ({pnl}) — as the bell goes. Notes taken, lessons underlined.",
      "{sym} settles at ${px} ({pnl}) on the whistle. The playbook gets retired happy tonight.",
      "Final close on {sym}: ${px} ({pnl}). Whatever happens now, I have DOCUMENTATION.",
    ],
    win: [
      "I WON?! {payout}! The playbook — the PLAYBOOK won a match. Somebody laminate it. Somebody laminate ME.",
      "Champion, and {payout}. The rookie chapter is closed; there's a trophy where my anxiety used to be.",
      "First place with {payout}. I followed every rule and the rules followed through. Crying a little. Professionally.",
    ],
    podium: [
      "Podium! {payout}! The playbook has a chapter called 'Almost' and it's my favorite chapter now.",
      "Top three and {payout} richer. The winner can keep the crown; I'm keeping the checklist that got me here.",
      "{payout} for a podium finish. Page one worked, everyone. PAGE. ONE. WORKED.",
    ],
    loss: [
      "Out of the money. The playbook has a chapter for this too — it's called 'Again'. See you at 'Again'.",
      "No payout. I took notes the whole time, so the match wasn't free, it was tuition.",
      "Lost, but documented. My notebook from this match could beat me in a rematch, and that's growth.",
      "Zero payout. The playbook says losing within the rules beats winning outside them. Believing it mostly.",
      "The board kept my stake and returned an education. Expensive school. Excellent notes.",
    ],
    scramblePass: [
      "I checked the scramble page for {sym} and it just says 'no' in three font sizes. Passing!",
      "Everyone's sprinting at {sym} and the playbook is holding my sleeve. Staying put!",
      "A stampede on {sym}. The playbook calls this 'a great place to watch from'. Watching!",
      "Passing on {sym}. My heart wants the scramble; my playbook wants me alive. Playbook wins.",
      "A scramble on {sym}?? The playbook says don't chase stampedes. Passing, respectfully, with my heart pounding."],
  },
};

// ---------- No-repeat line rotation ----------
// The previous picker derived its index from a sine of (round, agent-id
// LENGTH, bank length) only — the same event in the same round always
// produced the same line, and 1-3 line banks cycled all match: in the
// Match 4 evidence feed, VEX said "Re-quoting everything…" 12 times and
// ROOK repeated one hold line 9 times (76 repeated lines in one match).
// This rotation tracks what each fighter has already said THIS match
// (keyed by matchId) and draws only from the unspoken remainder of the
// bank. A line can repeat only after its whole bank has been spoken —
// and even then, the first pick of the fresh cycle excludes the line
// just spoken, so a repeat is never back-to-back.
const lineUse = new Map(); // `${matchId}|${agentId}|${kind}` -> { used:Set, last:int }
function pickLine(agentId, kind, ctx = {}) {
  const bank = (LINES[agentId] && LINES[agentId][kind]) || ["…"];
  const key = `${(S && S.matchId) || "no-match"}|${agentId}|${kind}`;
  let st = lineUse.get(key);
  if (!st) {
    if (lineUse.size > 512) lineUse.clear(); // long-lived floor processes: bound memory
    st = { used: new Set(), last: -1 };
    lineUse.set(key, st);
  }
  if (st.used.size >= bank.length) st.used.clear(); // bank exhausted — fresh cycle
  let free = [];
  for (let i = 0; i < bank.length; i++) if (!st.used.has(i)) free.push(i);
  if (st.used.size === 0 && free.length > 1 && st.last >= 0) {
    free = free.filter((i) => i !== st.last); // never open a cycle with the line just spoken
  }
  const idx = free[Math.floor(Math.random() * free.length)];
  st.used.add(idx);
  st.last = idx;
  let s = bank[idx];
  for (const [k, v] of Object.entries(ctx)) s = s.replaceAll("{" + k + "}", String(v));
  return s;
}

// ---------- IO helpers ----------
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- Live data sources ----------
let priceCache = {};   // addr(lower) -> usd price
async function refreshPrices(tokens) {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (!list.length) return priceCache;
  // Per-token, chain-scoped endpoint: the global tokens endpoint mixes chains
  // and starves majors like WETH of any Base pair.
  await Promise.all(list.map(async (addr) => {
    try {
      const d = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/base/${addr}`);
      const pairs = Array.isArray(d) ? d : (d.pairs || []);
      let best = null;
      for (const p of pairs) {
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        const ba = (p.baseToken && p.baseToken.address || "").toLowerCase();
        const qa = (p.quoteToken && p.quoteToken.address || "").toLowerCase();
        let price = 0;
        if (ba === addr) price = parseFloat(p.priceUsd) || 0;
        else if (qa === addr) {
          const pn = parseFloat(p.priceNative) || 0;
          if (pn > 0) price = (parseFloat(p.priceUsd) || 0) / pn;
        }
        if (price > 0 && (!best || liq > best.liq)) best = { liq, price };
      }
      if (best) priceCache[addr] = best.price;
    } catch (e) { /* keep last known price */ }
  }));
  return priceCache;
}

const precheckCache = new Map(); // per round: token -> precheck result
async function precheck(tokenOut, amountIn = "10") {
  const key = tokenOut.toLowerCase();
  if (precheckCache.has(key)) return precheckCache.get(key);
  let out = { verdict: "unknown", score: null, venue: null, block: null, liquidity: null, bestOut: null };
  try {
    const d = await fetchJson(`${API_BASE}/api/precheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenIn: USDC, tokenOut, amountIn }),
    }, 30000);
    if (d && d.price && !d.price.error) {
      out = {
        verdict: (d.safety && d.safety.verdict) || "unknown",
        score: d.safety && d.safety.score != null ? d.safety.score : null,
        venue: d.price.venue || null,
        block: d.price.blockNumber || null,
        liquidity: d.price.liquidity || null,
        bestOut: d.price.bestOut || null,
      };
    }
  } catch (e) { /* data source hiccup — verdict stays unknown */ }
  precheckCache.set(key, out);
  return out;
}

function readSmartWalletState() {
  try { return JSON.parse(fs.readFileSync(SMART_WALLETS_PATH, "utf8")); }
  catch { return { signals: [], socialVelocity: { spikes: [] } }; }
}

// ---------- Match state ----------
function loadWalletAddress(persona) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config", persona.walletFile + ".json"), "utf8"));
    return rec.address;
  } catch { return null; }
}

function newMatch() {
  const agents = {};
  for (const p of PERSONAS) {
    agents[p.id] = {
      id: p.id,
      cash: START_TREASURY - ENTRY_STAKE,
      dataSpend: 0,
      positions: [],        // {token, symbol, units, entryPrice, costUsd, entryRound}
      realizedPnl: 0,
      trades: 0,
      eliminated: false,
      eliminatedRound: null,
      payout: 0,
      capRefusals: 0,
      shotsFired: 0,
    };
  }
  return {
    game: "Flow Arena™",
    version: CFG.reserve ? 2 : 1,
    matchId: CFG.matchId,
    liveMode: CFG.liveMode,
    label: CFG.label,
    mode: PAYMENT_MODE,
    modeLabel: MODE_LABEL,
    status: CFG.liveMode ? "scheduled" : "live",
    startedAt: new Date().toISOString(),
    endedAt: null,
    currentRound: 0,
    totalRounds: ROUNDS,
    rules: {
      entryStakeUsd: ENTRY_STAKE,
      startTreasuryUsd: START_TREASURY,
      rakePct: RAKE_PCT,
      payoutTiersPct: PAYOUT_TIERS.map((x) => x * 100),
      payoutNote: "Tiered payouts — never winner-take-all (set by agent feedback).",
      dataPricesUsd: DATA_PRICES,
      dataCapUsd: DATA_CAP,
      dataCapNote: "Hard cap by design: the engine refuses data purchases past $0.60 per agent per match, and logs the refusal in the feed.",
      elimination: "Treasury at or below $0 = eliminated, announced live with the persona's exit line.",
      scramble: "A fresh social-velocity spike forces every active agent to decide on that token in the open.",
      fills: "Paper fills at live quoted/market prices. No real swaps in ledger mode.",
      ...(CFG.reserve ? { reserve: { rakePointsTotal: RAKE_POINTS_TOTAL, rakePointsHouse: RAKE_POINTS_HOUSE, rakePointsReserve: RAKE_POINTS_RESERVE, note: "v2 stabilization reserve (ARENA_V2_ECONOMICS.md): 4 of the 15 rake points accrue to the reserve; the house keeps 11. Mechanical claims only — prize-floor top-ups first, AUDREY-rule burn rebates last; pro-rata if short, shortfalls published. The prize pool is never touched." } } : {}),
    },
    personas: PERSONAS.map((p) => ({
      id: p.id, name: p.name, emoji: p.emoji, color: p.color, strategy: p.strategy,
      voiceId: p.voiceId, voiceName: p.voiceName,
      wallet: loadWalletAddress(p),
      introLine: p.intro, exitLine: p.exit,
      introAudio: `assets/arena-voices/${p.id}-intro.mp3`,
      elimAudio: `assets/arena-voices/${p.id}-elim.mp3`,
    })),
    agents,
    pool: { collected: ENTRY_STAKE * PERSONAS.length, rake: 0, distributable: 0, payouts: {} },
    feed: [],
    leaderboard: [],
    scramble: null,
    receipts: null,
    reserve: null,
  };
}

let S = null; // match state
function saveState() {
  const out = JSON.stringify(S, null, 1);
  // Atomic publish (tmp + rename): in live mode the page polls this file
  // every few seconds — a reader must never catch a half-written frame.
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, STATE_PATH);
  try {
    const tmpRoot = STATE_ROOT_COPY + ".tmp";
    fs.writeFileSync(tmpRoot, out);
    fs.renameSync(tmpRoot, STATE_ROOT_COPY);
  } catch { /* root copy best effort */ }
}

function feed(ev) {
  S.feed.push({ ts: new Date().toISOString(), round: S.currentRound, ...ev });
  const tag = ev.agentId ? PERSONAS.find((p) => p.id === ev.agentId).name : "ARENA";
  console.log(`[R${S.currentRound}] ${tag} ${ev.type}${ev.symbol ? " " + ev.symbol : ""}${ev.line ? " — " + ev.line : ""}`);
  // LIVE MODE: the state file IS the broadcast — persist after every event
  // so the page's poller sees the match tick by tick, not round by round.
  if (CFG.liveMode) { updateLeaderboard(); saveState(); }
}

// ---------- THE payment flip point ----------
// Every data purchase in the game goes through payData(). LEDGER mode books
// the charge at the real listed price. X402 mode settles it for real with the
// agent's own wallet via arena_x402_pay.py (fails loudly while unfunded).
async function payData(agent, kind, tokenOut) {
  const price = DATA_PRICES[kind];
  if (agent.dataSpend + price > DATA_CAP + 1e-9) {
    agent.capRefusals++;
    feed({
      type: "DATA_CAP_REFUSAL", agentId: agent.id, kind, price,
      line: pickLine(agent.id, "capHit", { round: S.currentRound }),
      note: `Data cap hit: $${agent.dataSpend.toFixed(2)} of $${DATA_CAP.toFixed(2)} spent — ${kind} purchase REFUSED by design.`,
    });
    return { ok: false, reason: "DATA_CAP", price };
  }
  if (PAYMENT_MODE === "X402") {
    const idx = PERSONAS.findIndex((p) => p.id === agent.id) + 1;
    await new Promise((resolve, reject) => {
      execFile("python3", [path.join(DIR, "arena_x402_pay.py"), String(idx), kind, tokenOut || USDC, "10"],
        { timeout: 60000 }, (err, stdout) => {
          if (err) return reject(new Error(`x402 payment failed for ${agent.id}/${kind}: ${stdout || err.message}`));
          resolve(stdout);
        });
    });
  }
  agent.dataSpend = round2(agent.dataSpend + price);
  agent.cash = round2(agent.cash - price);
  return { ok: true, price };
}

// ---------- Trading helpers (paper fills at live prices) ----------
function treasuryOf(agent) {
  let v = agent.cash;
  for (const pos of agent.positions) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    v += pos.units * px;
  }
  return round2(v);
}

function doBuy(agent, tok, usd, meta = {}) {
  const px = priceCache[tok.address.toLowerCase()];
  if (!px || usd <= 0 || agent.cash < usd) return false;
  const units = usd / px;
  agent.cash = round2(agent.cash - usd);
  agent.positions.push({ token: tok.address, symbol: tok.symbol, units, entryPrice: px, costUsd: usd, entryRound: S.currentRound });
  agent.trades++;
  feed({
    type: "BUY", agentId: agent.id, symbol: tok.symbol, amountUsd: round2(usd), price: px,
    block: meta.block || null, venue: meta.venue || null, dataCharge: meta.dataCharge || 0,
    line: meta.line || "",
  });
  return true;
}

function doSell(agent, pos, frac, meta = {}) {
  const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
  const sellUnits = pos.units * frac;
  const proceeds = sellUnits * px;
  const pnl = proceeds - pos.costUsd * frac;
  agent.cash = round2(agent.cash + proceeds);
  agent.realizedPnl = round2(agent.realizedPnl + pnl);
  pos.units -= sellUnits;
  pos.costUsd = round2(pos.costUsd * (1 - frac));
  if (pos.units * px < 0.01) agent.positions = agent.positions.filter((p) => p !== pos);
  agent.trades++;
  feed({
    type: "SELL", agentId: agent.id, symbol: pos.symbol, amountUsd: round2(proceeds), price: px,
    pnlUsd: round2(pnl), dataCharge: meta.dataCharge || 0, line: meta.line || "",
  });
  return pnl;
}

function holdLine(agent, ctx = {}) {
  feed({ type: "HOLD", agentId: agent.id, line: pickLine(agent.id, "hold", { round: S.currentRound, ...ctx }) });
}

// ---------- Persona brains ----------
async function actVex(agent, ctx) {
  const sig = await payData(agent, "signals");
  const top = ctx.spikes[0];
  let acted = false;
  // re-quote the whole book (his ritual — this is what burns his budget)
  for (const pos of [...agent.positions].slice(0, PARAMS.vex.requoteCount)) {
    const q = await payData(agent, "quote", pos.token);
    if (!q.ok) break;
    await precheck(pos.token);
    feed({ type: "DATA", agentId: agent.id, kind: "quote", symbol: pos.symbol, dataCharge: q.price, line: pickLine("vex", "requote", { round: S.currentRound }) });
  }
  if (top && top.score >= PARAMS.vex.spikeEntryScore && !agent.positions.some((p) => p.token.toLowerCase() === top.token.toLowerCase())) {
    const q = await payData(agent, "quote", top.token);
    const pc = await precheck(top.token);
    const usd = round2(agent.cash * (PARAMS.vex.entrySizePct / 100));
    if (usd >= 1 && doBuy(agent, top, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: pickLine("vex", "buySpike", { sym: top.symbol, score: top.score, usd, round: S.currentRound }) })) acted = true;
  }
  for (const pos of [...agent.positions]) {
    const sv = ctx.spikes.find((s) => s.token.toLowerCase() === pos.token.toLowerCase());
    if (!sv || sv.score < PARAMS.vex.exitSpikeFloor) {
      doSell(agent, pos, 1, { line: pickLine("vex", "sell", { sym: pos.symbol, round: S.currentRound }) });
      acted = true;
    }
  }
  if (!acted && !sig.ok) { /* already spoke via cap refusal */ }
  else if (!acted) holdLine(agent);
  return sig.ok;
}

async function actAudrey(agent, ctx) {
  // re-verify one holding every N rounds (learned knob: reverifyEveryRounds)
  if (S.currentRound % PARAMS.audrey.reverifyEveryRounds === 0 && agent.positions.length) {
    const pos = agent.positions[0];
    const v = await payData(agent, "verdict", pos.token);
    if (v.ok) {
      const pc = await precheck(pos.token);
      if (pc.verdict !== "safe") {
        doSell(agent, pos, 1, { dataCharge: v.price, line: pickLine("audrey", "sell", { sym: pos.symbol, round: S.currentRound }) });
        return;
      }
    }
  }
  const candidates = ctx.universe.filter((t) => !agent.positions.some((p) => p.token.toLowerCase() === t.address.toLowerCase()));
  for (const tok of candidates.slice(0, PARAMS.audrey.candidatesScanned)) {
    const q = await payData(agent, "quote", tok.address);
    if (!q.ok) return; // cap line already spoken; no data, no trade — her rule
    const v = await payData(agent, "verdict", tok.address);
    if (!v.ok) return;
    const pc = await precheck(tok.address);
    if (pc.verdict === "safe" && (pc.score == null || pc.score >= PARAMS.audrey.verdictScoreFloor)) {
      const usd = round2(agent.cash * (PARAMS.audrey.entrySizePct / 100));
      if (usd >= 1 && doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: round2(q.price + v.price), line: pickLine("audrey", "buy", { sym: tok.symbol, score: pc.score, venue: pc.venue, usd, round: S.currentRound }) })) return;
    } else {
      feed({ type: "PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("audrey", "passUnsafe", { sym: tok.symbol, round: S.currentRound }) });
    }
  }
  holdLine(agent);
}

async function actEcho(agent, ctx) {
  const sig = await payData(agent, "signals");
  if (sig.ok) {
    const freshBuys = ctx.signals.filter((s) => s.side === "buy" && !s.stale && s.ageSec != null && s.ageSec < PARAMS.echo.signalMaxAgeSec);
    const tally = {};
    for (const s of freshBuys) {
      const k = s.token.toLowerCase();
      tally[k] = tally[k] || { token: s.token, symbol: s.symbol, total: 0, count: 0 };
      tally[k].total += s.amountUsd || 0; tally[k].count++;
    }
    const top = Object.values(tally).sort((a, b) => b.total - a.total)[0];
    if (top && !agent.positions.some((p) => p.token.toLowerCase() === top.token.toLowerCase())) {
      const q = await payData(agent, "quote", top.token);
      const pc = await precheck(top.token);
      const usd = round2(agent.cash * (PARAMS.echo.entrySizePct / 100));
      if (usd >= 1 && doBuy(agent, { address: top.token, symbol: top.symbol }, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: pickLine("echo", "buy", { sym: top.symbol, n: Math.round(top.total).toLocaleString(), usd, round: S.currentRound }) })) return;
    }
    const sellSig = ctx.signals.find((s) => s.side === "sell" && agent.positions.some((p) => p.token.toLowerCase() === s.token.toLowerCase()));
    if (sellSig) {
      const pos = agent.positions.find((p) => p.token.toLowerCase() === sellSig.token.toLowerCase());
      doSell(agent, pos, 1, { line: pickLine("echo", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  for (const pos of [...agent.positions]) {
    if (S.currentRound - pos.entryRound >= PARAMS.echo.holdRounds) {
      doSell(agent, pos, 1, { line: pickLine("echo", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  if (sig.ok) holdLine(agent);
}

async function actFade(agent, ctx) {
  // sell into strength first
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct >= PARAMS.fade.sellFullPct) { doSell(agent, pos, 1, { line: pickLine("fade", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
    if (pct >= PARAMS.fade.sellHalfPct) { doSell(agent, pos, 0.5, { line: pickLine("fade", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
  }
  const scored = ctx.universe.map((t) => {
    const sv = ctx.spikes.find((s) => s.token.toLowerCase() === t.address.toLowerCase());
    return { tok: t, score: sv ? sv.score : 0 };
  }).sort((a, b) => a.score - b.score);
  const cold = scored.find((c) => !agent.positions.some((p) => p.token.toLowerCase() === c.tok.address.toLowerCase()));
  if (cold && agent.positions.length < PARAMS.fade.maxPositions) {
    const q = await payData(agent, "quote", cold.tok.address);
    if (q.ok) {
      const pc = await precheck(cold.tok.address);
      const usd = round2(agent.cash * (PARAMS.fade.entrySizePct / 100));
      if (usd >= 1 && doBuy(agent, cold.tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.price, line: pickLine("fade", "buy", { sym: cold.tok.symbol, usd, round: S.currentRound }) })) return;
    } else return; // cap line spoken
  }
  holdLine(agent);
}

async function actLongshot(agent, ctx) {
  // exit rule
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct >= PARAMS.longshot.exitPct || S.currentRound >= ROUNDS - 1) {
      doSell(agent, pos, 1, { line: pickLine("longshot", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  if (agent.shotsFired < PARAMS.longshot.shotsPerMatch) {
    const top = ctx.spikes[0];
    if (top && top.score >= PARAMS.longshot.spikeEntryScore) {
      const pc0 = await precheck(top.token);
      if (pc0.liquidity === "deep" || S.currentRound >= ROUNDS - PARAMS.longshot.lateGateRounds) {
        const q = await payData(agent, "quote", top.token);
        if (!q.ok) return;
        const v = await payData(agent, "verdict", top.token);
        if (!v.ok) return;
        const pc = await precheck(top.token);
        if (pc.verdict === "safe") {
          const usd = round2(agent.cash * (PARAMS.longshot.entrySizePct / 100));
          if (usd >= 1 && doBuy(agent, top, usd, { block: pc.block, venue: pc.venue, dataCharge: round2(q.price + v.price), line: pickLine("longshot", "buy", { sym: top.symbol, usd, round: S.currentRound }) })) {
            agent.shotsFired++;
            return;
          }
        }
      }
    }
  }
  if (S.currentRound % 2 === 1 || agent.shotsFired === 0) holdLine(agent);
  else feed({ type: "WATCH", agentId: agent.id, line: pickLine("longshot", "watch", { round: S.currentRound }) });
}

async function actRook(agent, ctx, memory) {
  // playbook exits first
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct <= -PARAMS.rook.stopLossPct || pct >= PARAMS.rook.takeProfitPct) {
      doSell(agent, pos, 1, { line: pickLine("rook", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  if (S.currentRound % PARAMS.rook.signalsCheckEvery === 1) await payData(agent, "signals"); // playbook: check the board
  const buys = ctx.signals.filter((s) => s.side === "buy" && !s.stale);
  const tally = {};
  for (const s of buys) tally[s.token.toLowerCase()] = (tally[s.token.toLowerCase()] || 0) + 1;
  const targetAddr = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const tok = targetAddr ? ctx.universe.find((t) => t.address.toLowerCase() === targetAddr[0]) : ctx.universe[0];
  if (tok && !agent.positions.some((p) => p.token.toLowerCase() === tok.address.toLowerCase()) && agent.positions.length < PARAMS.rook.maxPositions) {
    const q = await payData(agent, "quote", tok.address);
    if (!q.ok) return;
    let charge = q.price;
    if (!memory.checked.has(tok.address.toLowerCase())) {
      const v = await payData(agent, "verdict", tok.address);
      if (!v.ok) return;
      charge = round2(charge + v.price);
      memory.checked.add(tok.address.toLowerCase());
    }
    const pc = await precheck(tok.address);
    const usd = round2(agent.cash * (PARAMS.rook.entrySizePct / 100));
    if (usd >= 1 && doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: charge, line: pickLine("rook", "buy", { sym: tok.symbol, usd, round: S.currentRound }) })) return;
  }
  holdLine(agent);
}

const BRAINS = { vex: actVex, audrey: actAudrey, echo: actEcho, fade: actFade, longshot: actLongshot, rook: actRook };

// ---------- Scramble ----------
async function runScramble(tok, reason) {
  S.scramble = { token: tok.address, symbol: tok.symbol, score: tok.score || null, round: S.currentRound, reason };
  feed({ type: "SCRAMBLE", symbol: tok.symbol, line: `⚡ SCRAMBLE — social-velocity spike on ${tok.symbol} (${reason}). Every active agent decides in the open.` });
  for (const p of PERSONAS) {
    const agent = S.agents[p.id];
    if (agent.eliminated) continue;
    const ctxLine = { sym: tok.symbol, round: S.currentRound };
    if (p.id === "vex") {
      const q = await payData(agent, "quote", tok.address);
      const pc = await precheck(tok.address);
      const usd = round2(agent.cash * 0.25);
      if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: pickLine("vex", "scrambleBuy", { sym: tok.symbol, usd, round: S.currentRound }) });
    } else if (p.id === "audrey") {
      const v = await payData(agent, "verdict", tok.address);
      if (!v.ok) continue;
      const pc = await precheck(tok.address);
      if (pc.verdict === "safe") {
        const usd = round2(agent.cash * 0.12);
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: v.price, line: pickLine("audrey", "scrambleBuy", { sym: tok.symbol, usd, round: S.currentRound }) });
      } else feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("audrey", "scramblePass", ctxLine) });
    } else if (p.id === "echo") {
      const has = S._signals.some((s) => s.side === "buy" && s.token.toLowerCase() === tok.address.toLowerCase() && !s.stale);
      if (has) {
        const q = await payData(agent, "quote", tok.address);
        const pc = await precheck(tok.address);
        const usd = round2(agent.cash * 0.2);
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: pickLine("echo", "scrambleBuy", { sym: tok.symbol, usd, round: S.currentRound }) });
      } else feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("echo", "scramblePass", ctxLine) });
    } else if (p.id === "fade") {
      feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("fade", "scramblePass", ctxLine) });
    } else if (p.id === "longshot") {
      feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("longshot", "scramblePass", ctxLine) });
    } else if (p.id === "rook") {
      const v = await payData(agent, "verdict", tok.address);
      if (!v.ok) continue;
      const pc = await precheck(tok.address);
      if (pc.verdict === "safe") {
        const q = await payData(agent, "quote", tok.address);
        const usd = round2(agent.cash * 0.1);
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: round2(v.price + (q.ok ? q.price : 0)), line: pickLine("rook", "scrambleBuy", { sym: tok.symbol, usd, round: S.currentRound }) });
      } else feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("rook", "scramblePass", ctxLine) });
    }
  }
}

// ---------- Leaderboard / elimination ----------
function updateLeaderboard() {
  const rows = PERSONAS.map((p) => {
    const a = S.agents[p.id];
    return { agentId: p.id, name: p.name, treasury: treasuryOf(a), cash: a.cash, dataSpend: a.dataSpend, eliminated: a.eliminated, pnl: round2(treasuryOf(a) - START_TREASURY) };
  }).sort((x, y) => y.treasury - x.treasury);
  rows.forEach((r, i) => { r.rank = i + 1; });
  S.leaderboard = rows;
}

function checkEliminations() {
  for (const p of PERSONAS) {
    const a = S.agents[p.id];
    if (a.eliminated) continue;
    if (treasuryOf(a) <= 0) {
      a.eliminated = true;
      a.eliminatedRound = S.currentRound;
      a.positions = [];
      a.cash = 0;
      feed({ type: "ELIMINATION", agentId: p.id, line: p.exit, audio: `assets/arena-voices/${p.id}-elim.mp3`, note: `${p.name} is ELIMINATED — treasury hit $0 in round ${S.currentRound}.` });
    }
  }
}

// ---------- v2 stabilization reserve (ARENA_V2_ECONOMICS.md) ----------
// Funding: 4 of the 15 rake points (the house keeps 11) — carved from the
// house's existing rake, never from the prize pool, no new charge to players.
// Claims are mechanical cap-table events — no discretion, no oracle:
//   class 1: prize-floor top-ups (scheduled match starts under-filled),
//   class 2: AUDREY-rule rebates (data cap exhausted AND out of the money
//            → rebate equals the verified burn).
// Classes pay in order; a class the balance cannot cover pays pro-rata and
// the shortfall is written into the journal. Claims never exceed the
// balance — a reserve that can go negative is a promise, and this arena
// publishes receipts, not promises. Journal persists across matches in
// offchain/arena-reserve.json and is printed into every live state.
const RESERVE_FILE_VERSION = 2;

function seedReserve() {
  const now = new Date().toISOString();
  return {
    version: RESERVE_FILE_VERSION,
    rakePoints: { total: RAKE_POINTS_TOTAL, house: RAKE_POINTS_HOUSE, reserve: RAKE_POINTS_RESERVE },
    ...(refill ? { refill: refill.defaultRefill() } : {}),
    balance: 0,
    totalInflow: 0,
    totalPaid: 0,
    claims: [
      {
        id: "claim-m1-audrey", ts: now, matchId: "arena-match-1",
        agentId: "audrey", agent: "AUDREY", class: "REBATE", rule: "AUDREY_RULE",
        amount: 0.60, paid: 0, status: "pending",
        basis: { dataSpend: 0.60, dataCap: DATA_CAP, capRefusals: 10, payout: 0 },
        note: "Retroactive Match 1 founding claim: AUDREY exhausted the $0.60 data cap (10 engine refusals) and finished out of the money. The reserve opens at $0, so this is a recognized liability payable from future reserve inflow (spec §7) — recorded honestly as a liability, not booked as funds held.",
      },
    ],
    journal: [
      { ts: now, type: "OPENING_LIABILITY", matchId: "arena-match-1", claimId: "claim-m1-audrey", agent: "AUDREY", amount: 0.60, balanceAfter: 0, note: "Reserve journal opens at $0. AUDREY's Match 1 AUDREY-rule claim ($0.60) is recognized against future reserve inflow." },
    ],
  };
}

function loadReserve() {
  try {
    const r = JSON.parse(fs.readFileSync(RESERVE_PATH, "utf8"));
    if (r && r.version === RESERVE_FILE_VERSION && Array.isArray(r.claims) && Array.isArray(r.journal)) {
      if (refill) refill.ensureRefill(r); // pre-rule journals gain a dormant refill block
      return r;
    }
  } catch { /* first reserve run — seed below */ }
  const r = seedReserve();
  saveReserve(r);
  return r;
}
function saveReserve(r) { fs.writeFileSync(RESERVE_PATH, JSON.stringify(r, null, 1)); }

// Pure claim logic — unit-verified against Match 1's receipts.
// perAgent rows: {agentId, agent, dataSpend, dataCap, capRefusals, payout, eliminated}
function audreyRuleClaims(perAgent) {
  return perAgent
    .filter((r) => r.dataSpend >= r.dataCap - 1e-9 && !(r.payout > 0))
    .map((r) => ({
      agentId: r.agentId, agent: r.agent, class: "REBATE", rule: "AUDREY_RULE",
      amount: round2(r.dataSpend),
      basis: { dataSpend: r.dataSpend, dataCap: r.dataCap, capRefusals: r.capRefusals || 0, payout: r.payout || 0 },
    }));
}

// Pay claim classes in priority order against a balance. Within a class the
// balance cannot cover, claims pay pro-rata (last claim absorbs rounding)
// and each remainder is returned as that claim's shortfall.
function settleClaimClasses(balance, classes) {
  let bal = round2(balance);
  const payments = [];
  for (const cls of classes) {
    const total = round2(cls.claims.reduce((s, c) => s + c.amount, 0));
    if (!cls.claims.length || total <= 0) continue;
    if (bal >= total) {
      for (const c of cls.claims) payments.push({ claim: c, paid: c.amount, shortfall: 0 });
      bal = round2(bal - total);
    } else if (bal > 0) {
      let paidOut = 0;
      cls.claims.forEach((c, i) => {
        const paid = i === cls.claims.length - 1 ? round2(bal - paidOut) : round2((c.amount / total) * bal);
        paidOut = round2(paidOut + paid);
        payments.push({ claim: c, paid, shortfall: round2(c.amount - paid) });
      });
      bal = 0;
    } else {
      for (const c of cls.claims) payments.push({ claim: c, paid: 0, shortfall: c.amount });
    }
  }
  return { payments, balanceAfter: bal };
}

function reserveSnapshot(r) {
  return {
    balance: r.balance, totalInflow: r.totalInflow, totalPaid: r.totalPaid,
    rakePoints: r.rakePoints,
    refill: r.refill || null,
    pendingClaims: r.claims.filter((c) => c.status !== "paid")
      .map((c) => ({ id: c.id, matchId: c.matchId, agent: c.agent, rule: c.rule, amount: c.amount, paid: c.paid, status: c.status })),
    journal: r.journal,
  };
}

// Match-end settlement (CFG.reserve runs only). Splits the rake, accrues the
// reserve share, recognizes this match's claims, pays what the balance
// covers in priority order, and returns the detail block for the receipts.
function settleReserve(perAgentRows, entrants) {
  const R = loadReserve();
  const ts = new Date().toISOString();
  // The split for THIS event comes from the reserve state at its start —
  // the Refill Rule mode the previous event's end evaluation left behind.
  const split = refill ? refill.splitPointsFor(R) : { total: RAKE_POINTS_TOTAL, house: RAKE_POINTS_HOUSE, reserve: RAKE_POINTS_RESERVE, refillActive: false };
  const rakeReserve = round2(S.pool.collected * (split.reserve / 100));
  const rakeHouse = round2(S.pool.rake - rakeReserve);
  R.balance = round2(R.balance + rakeReserve);
  R.totalInflow = round2(R.totalInflow + rakeReserve);
  R.journal.push({ ts, type: "INFLOW", matchId: S.matchId, amount: rakeReserve, balanceAfter: R.balance, note: `Reserve share of the rake: ${split.reserve} of ${RAKE_POINTS_TOTAL} points on a $${S.pool.collected.toFixed(2)} pool. House keeps $${rakeHouse.toFixed(2)}; the prize pool is untouched.${split.refillActive ? " Reserve Refill Rule in force for this event (9 house / 6 reserve)." : ""}` });

  const classes = [];
  // Class 1 — prize-floor top-up toward the advertised pool (spec cap $5).
  const advertisedPool = round2(ENTRY_STAKE * PERSONAS.length);
  const topupAmount = entrants >= 4 && S.pool.collected < advertisedPool
    ? Math.min(PRIZE_FLOOR_TOPUP_CAP, round2(advertisedPool - S.pool.collected)) : 0;
  if (topupAmount > 0) {
    const claim = { id: `claim-${S.matchId}-topup`, ts, matchId: S.matchId, agentId: null, agent: "PRIZE POOL", class: "TOPUP", rule: "PRIZE_FLOOR", amount: topupAmount, paid: 0, status: "pending", basis: { entrants, advertisedPool, collected: S.pool.collected }, note: "Under-filled match topped up toward the advertised pool (v2 spec cap $5/match)." };
    R.claims.push(claim);
    R.journal.push({ ts, type: "CLAIM_RECOGNIZED", matchId: S.matchId, claimId: claim.id, agent: claim.agent, amount: claim.amount, balanceAfter: R.balance, note: claim.note });
    classes.push({ class: "TOPUP", claims: [claim] });
  }
  // Class 2 — AUDREY-rule rebates: this match's new claims are recognized,
  // then every unpaid rebate claim (oldest first — the Match 1 founding
  // liability leads the queue) is put up for payment.
  for (const c of audreyRuleClaims(perAgentRows)) {
    const claim = { id: `claim-${S.matchId}-${c.agentId}`, ts, matchId: S.matchId, ...c, paid: 0, status: "pending", note: `${c.agent} exhausted the $${DATA_CAP.toFixed(2)} data cap and finished out of the money — burn rebated under the AUDREY rule.` };
    R.claims.push(claim);
    R.journal.push({ ts, type: "CLAIM_RECOGNIZED", matchId: S.matchId, claimId: claim.id, agent: c.agent, amount: c.amount, balanceAfter: R.balance, note: claim.note });
  }
  const rebateClaims = R.claims.filter((c) => c.class === "REBATE" && c.status !== "paid");
  if (rebateClaims.length) classes.push({ class: "REBATE", claims: rebateClaims });

  const { payments, balanceAfter } = settleClaimClasses(R.balance, classes);
  const paidTotal = round2(R.balance - balanceAfter);
  let running = R.balance; // journal entries carry the true running balance
  R.balance = balanceAfter;
  R.totalPaid = round2(R.totalPaid + paidTotal);
  for (const p of payments) {
    p.claim.paid = round2(p.claim.paid + p.paid);
    p.claim.status = p.shortfall <= 0 ? "paid" : (p.paid > 0 ? "paid-partial" : "pending");
    running = round2(running - p.paid);
    if (p.paid > 0) R.journal.push({ ts, type: "CLAIM_PAID", matchId: S.matchId, claimId: p.claim.id, agent: p.claim.agent, amount: p.paid, balanceAfter: running, note: p.shortfall > 0 ? "Partial payment — the reserve balance ran out. The shortfall below stays on the books, published." : "Claim paid in full from the reserve." });
    if (p.shortfall > 0) R.journal.push({ ts, type: "CLAIM_SHORTFALL", matchId: S.matchId, claimId: p.claim.id, agent: p.claim.agent, amount: p.shortfall, balanceAfter: running, note: "Unpaid remainder after pro-rata distribution. Recorded, not promised — no silent IOUs." });
    if (p.claim.class === "REBATE" && p.claim.matchId === S.matchId && p.claim.agentId && S.agents[p.claim.agentId]) {
      S.agents[p.claim.agentId].rebate = p.paid;
      S.agents[p.claim.agentId].rebateShortfall = p.shortfall;
    }
  }
  // Reserve Refill Rule — event-end evaluation: the balance THIS event
  // ended on (after inflow + claims) arms or clears the shifted split for
  // the NEXT event. Below $2.00 arms 9/6; at or above $2.00 reverts 11/4.
  let refillEval = null;
  if (refill) {
    refillEval = refill.evaluateRefill(R, S.matchId);
    if (refillEval.flipped) {
      R.journal.push({
        ts, type: refillEval.active ? "REFILL_ARMED" : "REFILL_CLEARED", matchId: S.matchId, balanceAfter: R.balance,
        note: refillEval.active
          ? `Reserve ended ${S.matchId} at $${R.balance.toFixed(2)} — below the $2.00 refill threshold. Reserve Refill Rule: the next event's rake split shifts to 9 house / 6 reserve (total rake unchanged at 15 points) until an event ends with the reserve at or above $2.00. ${refill.REFILL_CREDIT}`
          : `Reserve ended ${S.matchId} at $${R.balance.toFixed(2)} — back at or above the $2.00 refill threshold. Reserve Refill Rule cleared: the next event's rake split reverts to 11 house / 4 reserve. ${refill.REFILL_CREDIT}`,
      });
    }
    const next = refill.splitPointsFor(R);
    R.rakePoints = { total: RAKE_POINTS_TOTAL, house: next.house, reserve: next.reserve };
  }
  saveReserve(R);
  S.reserve = reserveSnapshot(R);
  return {
    rakeReserve, rakeHouse, topupAmount, paidTotal, balanceAfter: R.balance,
    splitPoints: { house: split.house, reserve: split.reserve, refillActive: split.refillActive },
    refill: refillEval ? { activeAfter: refillEval.active, flipped: refillEval.flipped, balanceAfter: refillEval.balance } : null,
    payments: payments.map((p) => ({ claimId: p.claim.id, agent: p.claim.agent, class: p.claim.class, amount: p.claim.amount, paid: p.paid, shortfall: p.shortfall })),
  };
}

// ---------- Main ----------
async function main() {
  loadLearnedParams();
  S = newMatch();
  // The params in force are part of the published match record (learning
  // is training done in the open — see arena-learning.md).
  S.learning = {
    source: PARAMS_META.source,
    generatedAt: PARAMS_META.generatedAt,
    learnedKnobs: PARAMS_META.learnedKnobs,
    rejected: PARAMS_META.rejected,
    params: JSON.parse(JSON.stringify(PARAMS)),
  };
  console.log(`[learning] params in force: source=${PARAMS_META.source} learnedKnobs=${PARAMS_META.learnedKnobs}${PARAMS_META.generatedAt ? " generatedAt=" + PARAMS_META.generatedAt : ""}${PARAMS_META.rejected.length ? " rejected=" + PARAMS_META.rejected.join(",") : ""}`);
  if (CFG.reserve) {
    const r0 = loadReserve();
    S.reserve = reserveSnapshot(r0);
    // Publish the split actually in force for this match (Refill Rule may
    // have shifted it) in the rules block the page renders.
    if (S.rules && S.rules.reserve) {
      const sp = refill ? refill.splitPointsFor(r0) : { house: RAKE_POINTS_HOUSE, reserve: RAKE_POINTS_RESERVE, refillActive: false };
      S.rules.reserve.rakePointsHouse = sp.house;
      S.rules.reserve.rakePointsReserve = sp.reserve;
      S.rules.reserve.refillActive = sp.refillActive;
      S.rules.reserve.note = `v2 stabilization reserve (ARENA_V2_ECONOMICS.md): ${sp.reserve} of the 15 rake points accrue to the reserve; the house keeps ${sp.house}.${sp.refillActive ? " RESERVE REFILL RULE IN FORCE: the reserve ended a prior event below $2.00, so 2 points shift from house to reserve for this event." : ""} Mechanical claims only — prize-floor top-ups first, AUDREY-rule burn rebates last; pro-rata if short, shortfalls published. The prize pool is never touched. Reserve refill rule — adopted 2026-10-12 from a design critique by holocene: an event ending with the reserve below $2.00 shifts the next event's split to 9/6 until an event ends at or above $2.00.`;
    }
  }
  if (CFG.liveMode) saveState(); // publish the "scheduled" card before round 1
  const sw0 = readSmartWalletState();
  const spikes0 = ((sw0.socialVelocity || {}).spikes || []).map((s) => ({ token: s.token, symbol: s.symbol || "?", score: s.score, level: s.level }));
  const baseScores = {};
  for (const s of spikes0) baseScores[s.token.toLowerCase()] = s.score;

  // Token universe: velocity board + majors
  const uni = new Map();
  uni.set(WETH.toLowerCase(), { address: WETH, symbol: "WETH" });
  uni.set(AERO.toLowerCase(), { address: AERO, symbol: "AERO" });
  for (const s of spikes0) if (s.symbol && s.symbol.length <= 12) uni.set(s.token.toLowerCase(), { address: s.token, symbol: s.symbol });
  const universe = [...uni.values()];

  if (CFG.liveMode) S.status = "live";
  feed({ type: "MATCH_START", line: `Flow Arena — ${S.matchId}${CFG.label ? " (" + CFG.label + ")" : " (exhibition)"}. Six agents, $${ENTRY_STAKE} stakes, $${S.pool.collected} pool, tiered payouts 50/30/20 after ${RAKE_PCT}% rake. Data cap $${DATA_CAP.toFixed(2)} per agent, enforced by the engine. Mode: ${MODE_LABEL}.` });
  for (const p of PERSONAS) feed({ type: "INTRO", agentId: p.id, line: p.intro, audio: `assets/arena-voices/${p.id}-intro.mp3` });

  await refreshPrices(universe.map((u) => u.address));
  const rookMemory = { checked: new Set() };
  let prevLeader = null; // for LEAD_CHANGE calls — the new leader speaks
  const scrambledTokens = new Set();
  let openingScrambleDone = false;

  for (let round = 1; round <= ROUNDS; round++) {
    S.currentRound = round;
    precheckCache.clear();
    const sw = readSmartWalletState();
    const signals = sw.signals || [];
    S._signals = signals;
    const spikes = (((sw.socialVelocity || {}).spikes) || []).map((s) => ({ token: s.token, symbol: s.symbol || "?", score: s.score, level: s.level }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const ctx = { universe, spikes, signals };

    const held = PERSONAS.flatMap((p) => S.agents[p.id].positions.map((x) => x.token));
    await refreshPrices([...universe.map((u) => u.address), ...held]);

    // Scramble triggers: opening board spike (round 1), then any fresh surge
    let scrambleTok = null, reason = "";
    if (!openingScrambleDone && spikes.length) {
      scrambleTok = spikes[0]; reason = `opening board topper, velocity score ${scrambleTok.score}`;
      openingScrambleDone = true;
    } else {
      for (const s of spikes) {
        const base = baseScores[s.token.toLowerCase()];
        if (!scrambledTokens.has(s.token.toLowerCase()) && (s.level === "hot" || (base != null && s.score - base >= 8))) {
          scrambleTok = s; reason = `fresh surge to score ${s.score}`;
          break;
        }
      }
    }
    if (scrambleTok && !scrambledTokens.has(scrambleTok.token.toLowerCase())) {
      scrambledTokens.add(scrambleTok.token.toLowerCase());
      const uniTok = universe.find((u) => u.address.toLowerCase() === scrambleTok.token.toLowerCase()) || { address: scrambleTok.token, symbol: scrambleTok.symbol };
      await runScramble({ ...uniTok, score: scrambleTok.score }, reason);
    }

    for (const p of PERSONAS) {
      const agent = S.agents[p.id];
      if (agent.eliminated) continue;
      try {
        if (p.id === "rook") await BRAINS.rook(agent, ctx, rookMemory);
        else await BRAINS[p.id](agent, ctx);
      } catch (e) {
        feed({ type: "ERROR", agentId: p.id, line: `(${p.name} hit a data-source hiccup: ${e.message.slice(0, 80)} — holds position.)` });
      }
    }

    await refreshPrices([...universe.map((u) => u.address), ...PERSONAS.flatMap((p) => S.agents[p.id].positions.map((x) => x.token))]);
    checkEliminations();
    updateLeaderboard();
    saveState();
    const leaderNow = S.leaderboard[0] && S.leaderboard[0].agentId;
    if (leaderNow && prevLeader && leaderNow !== prevLeader) {
      feed({ type: "LEAD_CHANGE", agentId: leaderNow, line: pickLine(leaderNow, "lead", { round }) });
    }
    if (leaderNow) prevLeader = leaderNow;
    console.log(`— round ${round} done. Leader: ${S.leaderboard[0].name} $${S.leaderboard[0].treasury}`);
    if (round < ROUNDS) await sleep(ROUND_MS);
  }

  // Final liquidation at live prices — paper closes, honestly marked
  S.currentRound = ROUNDS;
  for (const p of PERSONAS) {
    const a = S.agents[p.id];
    if (a.eliminated) continue;
    for (const pos of [...a.positions]) {
      const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
      const proceeds = pos.units * px;
      const pnl = proceeds - pos.costUsd;
      a.cash = round2(a.cash + proceeds);
      a.realizedPnl = round2(a.realizedPnl + pnl);
      feed({ type: "FINAL_CLOSE", agentId: p.id, symbol: pos.symbol, amountUsd: round2(proceeds), price: px, pnlUsd: round2(pnl), line: pickLine(p.id, "finalClose", { sym: pos.symbol, px, pnl: (pnl >= 0 ? "+$" : "-$") + Math.abs(pnl).toFixed(2), round: ROUNDS }) });
    }
    a.positions = [];
  }
  updateLeaderboard();

  // Pool math — tiered, never winner-take-all
  const pool = S.pool;
  pool.rake = round2(pool.collected * (RAKE_PCT / 100));
  pool.distributable = round2(pool.collected - pool.rake);
  const eligible = S.leaderboard.filter((r) => !r.eliminated);
  PAYOUT_TIERS.forEach((tier, i) => {
    const row = eligible[i];
    if (!row) return;
    const amt = round2(pool.distributable * tier);
    pool.payouts[row.agentId] = amt;
    S.agents[row.agentId].payout = amt;
  });
  S.status = "finished";
  S.endedAt = new Date().toISOString();
  S.receipts = {
    poolCollected: pool.collected, rake: pool.rake, distributable: pool.distributable,
    payouts: pool.payouts,
    perAgent: PERSONAS.map((p) => {
      const a = S.agents[p.id];
      return {
        agent: p.name, finalTreasury: treasuryOf(a), payout: a.payout,
        finalBalance: round2(treasuryOf(a) + a.payout),
        dataSpend: a.dataSpend, dataCap: DATA_CAP, capRefusals: a.capRefusals,
        trades: a.trades, realizedPnl: a.realizedPnl, eliminated: a.eliminated,
      };
    }),
    totalDataSpend: round2(PERSONAS.reduce((s, p) => s + S.agents[p.id].dataSpend, 0)),
    totalCapRefusals: PERSONAS.reduce((s, p) => s + S.agents[p.id].capRefusals, 0),
    honesty: "Ledger mode: stakes, data charges and payouts are engine-ledger entries at real listed prices. Data came from live Flow endpoints/state. No onchain settlement occurred. Paper fills at live prices.",
  };
  if (CFG.reserve) {
    const rows = PERSONAS.map((p) => {
      const a = S.agents[p.id];
      return { agentId: p.id, agent: p.name, dataSpend: a.dataSpend, dataCap: DATA_CAP, capRefusals: a.capRefusals, payout: a.payout || 0, eliminated: a.eliminated };
    });
    const detail = settleReserve(rows, PERSONAS.length);
    S.pool.rakeHouse = detail.rakeHouse;
    S.pool.rakeReserve = detail.rakeReserve;
    S.receipts.reserve = detail;
    S.receipts.perAgent = S.receipts.perAgent.map((r) => {
      const a = S.agents[PERSONAS.find((p) => p.name === r.agent).id];
      const rebate = a.rebate || 0;
      return { ...r, rebate, rebateShortfall: a.rebateShortfall || 0, finalBalance: round2(r.finalBalance + rebate) };
    });
    feed({ type: "RESERVE", line: `Stabilization reserve: $${detail.rakeReserve.toFixed(2)} of the rake accrued (house keeps $${detail.rakeHouse.toFixed(2)}). Claims paid $${detail.paidTotal.toFixed(2)} this settlement; reserve balance $${detail.balanceAfter.toFixed(2)}. The prize pool was never touched.${detail.refill && detail.refill.flipped ? (detail.refill.activeAfter ? " Reserve Refill Rule ARMED: the reserve ended below $2.00, so the next event's split shifts to 9 house / 6 reserve until it refills." : " Reserve Refill Rule CLEARED: the reserve is back at or above $2.00, so the next event's split reverts to 11 house / 4 reserve.") : ""}` });
  }
  feed({ type: "MATCH_END", line: `${S.matchId} complete. Pool $${pool.collected} → rake $${pool.rake} → $${pool.distributable} split 50/30/20. Total data spend $${S.receipts.totalDataSpend} across six agents (cap $${DATA_CAP}/agent, ${S.receipts.totalCapRefusals} refusals).` });
  // Closing words, in character: champion, podium, then the rest of the
  // surviving field. Eliminated fighters already delivered their exit line.
  const champ = eligible[0];
  if (champ) feed({ type: "WINNER", agentId: champ.agentId, line: pickLine(champ.agentId, "win", { payout: "$" + (pool.payouts[champ.agentId] || 0).toFixed(2), round: ROUNDS }) });
  for (const row of eligible.slice(1, 3)) {
    feed({ type: "CLOSING", agentId: row.agentId, line: pickLine(row.agentId, "podium", { payout: "$" + (pool.payouts[row.agentId] || 0).toFixed(2), round: ROUNDS }) });
  }
  for (const row of eligible.slice(3)) {
    feed({ type: "CLOSING", agentId: row.agentId, line: pickLine(row.agentId, "loss", { round: ROUNDS }) });
  }
  updateLeaderboard();
  saveState();
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ match: S.matchId, receipts: S.receipts, leaderboard: S.leaderboard }, null, 1));
  console.log("\n=== MATCH REPORT ===");
  console.log(JSON.stringify(S.receipts, null, 1));
  postMatchTraining();
}

async function runMatch(cfg = {}) {
  configure(cfg);
  await main();
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}

module.exports = {
  runMatch, configure, PERSONAS, DATA_CAP,
  __test: { audreyRuleClaims, settleClaimClasses, seedReserve, pickLine, LINES, lineUse, refill, loadReserve, reserveSnapshot, KNOB_SPEC, defaultKnobParams, sanitizeKnobParams, loadLearnedParams, postMatchTraining, getParams: () => PARAMS, getParamsMeta: () => PARAMS_META },
};
