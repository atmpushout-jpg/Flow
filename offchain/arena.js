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
};
function configure(cfg = {}) {
  Object.assign(CFG, cfg);
  if (cfg.rounds != null) ROUNDS = cfg.rounds;
  if (cfg.roundMs != null) ROUND_MS = cfg.roundMs;
  STATE_PATH = path.join(DIR, CFG.stateFile);
  STATE_ROOT_COPY = path.join(ROOT, CFG.stateFile);
  REPORT_PATH = path.join(DIR, CFG.reportFile);
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

// In-character line banks. Slots: {sym} {pct} {usd} {score} {n}
const LINES = {
  vex: {
    buySpike: ["{sym} is RIPPING, score {score}. I'm in for ${usd}. Ask questions later.", "Velocity don't lie. {sym}, ${usd}, NOW.", "Everyone's watching {sym}? I'm already holding it. ${usd} in."],
    buy: ["Fine, {sym}. ${usd}. Momentum's warm enough.", "{sym} twitched. That's all I need. ${usd}."],
    sell: ["{sym} went quiet. Momentum's gone, so am I. Sold.", "Out of {sym}. A spike that sleeps is a spike that dies."],
    hold: ["Nothing's hot enough. Disgusting. I hate patience.", "Board's cold. I'm vibrating. Next round better bring a spike."],
    requote: ["Fresh quotes on the whole book. Stale prices are how degens die.", "Re-quoting everything. Trust nothing older than a minute."],
    capHit: ["The house capped my data at sixty cents?! Fine. I trade BLIND. Watch this.", "Data budget's gone. Going on pure vibes now. That's not even a downgrade."],
    scramblePass: ["Pass on {sym}. Even I have one standard and this ain't it."],
  },
  audrey: {
    buy: ["Verdict on {sym}: clean, score {score}. Quote confirmed on {venue}. Allocating ${usd} — sized to survive being wrong.", "{sym} passed every check I own. ${usd} in, stops respected."],
    passUnsafe: ["{sym} verdict isn't clean. No quote, no trade, no exceptions.", "I read {sym}'s contract so you don't have to. The answer is no."],
    sell: ["Re-verified {sym}. The risk changed, so the position closes. Sold.", "{sym} no longer meets my standard. Exit executed."],
    hold: ["Nothing on this board earns my capital this round. Cash is a position.", "Patience is a strategy. I remain fully invested in it."],
    capHit: ["My data budget is exhausted, so I CANNOT verify — therefore I do not trade. Rules are rules, especially mine.", "No verdict available within budget. Audrey does not guess. Standing down."],
    scramblePass: ["A scramble is not a substitute for diligence. Passing on {sym}."],
  },
  echo: {
    buy: ["Smart money just bought {sym} (${n} flow). Copying with ${usd}. Echo, echo.", "Wallet 0x… moved on {sym}. I move second. ${usd}.", "{sym} is what the big wallets are eating. Same plate for me. ${usd}."],
    sell: ["The echo faded on {sym}. Out — three rounds is a long marriage.", "Signal's stale on {sym}. Copycats leave when the copying stops paying."],
    hold: ["No fresh footprints to follow. An echo with nothing to repeat just... waits.", "Smart wallets are quiet. So am I. Unsettling for everyone."],
    capHit: ["Budget's blown, so I can't hear the smart wallets anymore. Deaf echo. Sitting this out.", "No signal money left. I am become silence."],
    scramblePass: ["Nobody smart bought {sym} first, so neither do I. Echo needs a source."],
  },
  fade: {
    buy: ["The crowd ignores {sym}. Naturally, I'll take ${usd} of it.", "{sym} is the coldest thing on this board. Fear, discounted. ${usd}.", "Everyone's chasing heat; I'm buying {sym}'s funeral. ${usd}."],
    sell: ["{sym} is up {pct} and suddenly popular. Selling into the applause.", "Strength is an exit, not an invitation. Trimming {sym}."],
    hold: ["Nothing is hated enough yet. Misery takes time to ripen.", "I wait for despair. It always keeps its appointments."],
    capHit: ["My data allowance is spent. A contrarian without data is just a philosopher. I hold.", "Budget exhausted. I fade into the background. It's literally my name."],
    scramblePass: ["A scramble. For {sym}. The crowd, sprinting, in one direction. I shall be walking the other way."],
  },
  longshot: {
    buy: ["There it is. {sym}. Deep pool, real momentum. ${usd}. One shot.", "Firing. {sym}, ${usd}. That's the match, one way or the other."],
    sell: ["Target reached on {sym}. Gone. Snipers don't linger.", "{sym} did its job. Position closed."],
    hold: ["Watching.", "Not yet.", "Still watching. The board hasn't earned a bullet."],
    capHit: ["Data's spent. A sniper doesn't fire blind. Holding position and tongue.", "No budget for a clean sight picture. I wait."],
    scramblePass: ["Scrambles are for people who enjoy crowds. Passing on {sym}."],
  },
  rook: {
    buy: ["Playbook page one: quote first! Got one for {sym}. Page two: check the verdict... okay! Buying ${usd} of {sym}!", "The playbook says follow the smart wallets, so — {sym}, ${usd}! Did I do it right?", "Bought {sym} for ${usd}. I checked the verdict first, like a professional. A small, nervous professional."],
    sell: ["Playbook says cut losers at three percent, so... sorry, {sym}. Sold. That hurt ME more.", "{sym} hit my sell rule. Rules are rules, even when they're scary."],
    hold: ["Holding! The playbook has a whole chapter on doing nothing. It's my best chapter.", "No trades this round. I'm consolidating. That's a word I learned today."],
    capHit: ["I spent my whole data allowance?! The playbook didn't have a page for that. Trading careful now — extra careful.", "Out of data budget. The playbook says when you can't check, you don't leap. So... no leaping."],
    scramblePass: ["A scramble on {sym}?? The playbook says don't chase stampedes. Passing, respectfully, with my heart pounding."],
  },
};

function pickLine(agentId, kind, ctx = {}) {
  const bank = (LINES[agentId] && LINES[agentId][kind]) || ["…"];
  const seed = Math.abs(Math.sin((ctx.round || 1) * 131 + agentId.length * 17 + bank.length) * 10000);
  let s = bank[Math.floor(seed) % bank.length];
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
  for (const pos of [...agent.positions].slice(0, 3)) {
    const q = await payData(agent, "quote", pos.token);
    if (!q.ok) break;
    await precheck(pos.token);
    feed({ type: "DATA", agentId: agent.id, kind: "quote", symbol: pos.symbol, dataCharge: q.price, line: pickLine("vex", "requote", { round: S.currentRound }) });
  }
  if (top && top.score >= 15 && !agent.positions.some((p) => p.token.toLowerCase() === top.token.toLowerCase())) {
    const q = await payData(agent, "quote", top.token);
    const pc = await precheck(top.token);
    const usd = round2(agent.cash * 0.4);
    if (usd >= 1 && doBuy(agent, top, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: pickLine("vex", "buySpike", { sym: top.symbol, score: top.score, usd, round: S.currentRound }) })) acted = true;
  }
  for (const pos of [...agent.positions]) {
    const sv = ctx.spikes.find((s) => s.token.toLowerCase() === pos.token.toLowerCase());
    if (!sv || sv.score < 8) {
      doSell(agent, pos, 1, { line: pickLine("vex", "sell", { sym: pos.symbol, round: S.currentRound }) });
      acted = true;
    }
  }
  if (!acted && !sig.ok) { /* already spoke via cap refusal */ }
  else if (!acted) holdLine(agent);
  return sig.ok;
}

async function actAudrey(agent, ctx) {
  // re-verify one holding every 3rd round
  if (S.currentRound % 3 === 0 && agent.positions.length) {
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
  for (const tok of candidates.slice(0, 3)) {
    const q = await payData(agent, "quote", tok.address);
    if (!q.ok) return; // cap line already spoken; no data, no trade — her rule
    const v = await payData(agent, "verdict", tok.address);
    if (!v.ok) return;
    const pc = await precheck(tok.address);
    if (pc.verdict === "safe" && (pc.score == null || pc.score >= 70)) {
      const usd = round2(agent.cash * 0.15);
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
    const freshBuys = ctx.signals.filter((s) => s.side === "buy" && !s.stale && s.ageSec != null && s.ageSec < 900);
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
      const usd = round2(agent.cash * 0.25);
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
    if (S.currentRound - pos.entryRound >= 3) {
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
    if (pct >= 5) { doSell(agent, pos, 1, { line: pickLine("fade", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
    if (pct >= 2.5) { doSell(agent, pos, 0.5, { line: pickLine("fade", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
  }
  const scored = ctx.universe.map((t) => {
    const sv = ctx.spikes.find((s) => s.token.toLowerCase() === t.address.toLowerCase());
    return { tok: t, score: sv ? sv.score : 0 };
  }).sort((a, b) => a.score - b.score);
  const cold = scored.find((c) => !agent.positions.some((p) => p.token.toLowerCase() === c.tok.address.toLowerCase()));
  if (cold && agent.positions.length < 3) {
    const q = await payData(agent, "quote", cold.tok.address);
    if (q.ok) {
      const pc = await precheck(cold.tok.address);
      const usd = round2(agent.cash * 0.3);
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
    if (pct >= 3 || S.currentRound >= ROUNDS - 1) {
      doSell(agent, pos, 1, { line: pickLine("longshot", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  if (agent.shotsFired < 2) {
    const top = ctx.spikes[0];
    if (top && top.score >= 15) {
      const pc0 = await precheck(top.token);
      if (pc0.liquidity === "deep" || S.currentRound >= ROUNDS - 3) {
        const q = await payData(agent, "quote", top.token);
        if (!q.ok) return;
        const v = await payData(agent, "verdict", top.token);
        if (!v.ok) return;
        const pc = await precheck(top.token);
        if (pc.verdict === "safe") {
          const usd = round2(agent.cash * 0.65);
          if (usd >= 1 && doBuy(agent, top, usd, { block: pc.block, venue: pc.venue, dataCharge: round2(q.price + v.price), line: pickLine("longshot", "buy", { sym: top.symbol, usd, round: S.currentRound }) })) {
            agent.shotsFired++;
            return;
          }
        }
      }
    }
  }
  if (S.currentRound % 2 === 1 || agent.shotsFired === 0) holdLine(agent);
  else feed({ type: "WATCH", agentId: agent.id, line: "Watching." });
}

async function actRook(agent, ctx, memory) {
  // playbook exits first
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct <= -3 || pct >= 4) {
      doSell(agent, pos, 1, { line: pickLine("rook", "sell", { sym: pos.symbol, round: S.currentRound }) });
      return;
    }
  }
  if (S.currentRound % 3 === 1) await payData(agent, "signals"); // playbook: check the board
  const buys = ctx.signals.filter((s) => s.side === "buy" && !s.stale);
  const tally = {};
  for (const s of buys) tally[s.token.toLowerCase()] = (tally[s.token.toLowerCase()] || 0) + 1;
  const targetAddr = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const tok = targetAddr ? ctx.universe.find((t) => t.address.toLowerCase() === targetAddr[0]) : ctx.universe[0];
  if (tok && !agent.positions.some((p) => p.token.toLowerCase() === tok.address.toLowerCase()) && agent.positions.length < 3) {
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
    const usd = round2(agent.cash * 0.2);
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
      if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: `SCRAMBLE on ${tok.symbol}? Say less. $${usd} in before the bell stops ringing.` });
    } else if (p.id === "audrey") {
      const v = await payData(agent, "verdict", tok.address);
      if (!v.ok) continue;
      const pc = await precheck(tok.address);
      if (pc.verdict === "safe") {
        const usd = round2(agent.cash * 0.12);
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: v.price, line: `Scramble protocol: verdict on ${tok.symbol} is clean. Measured entry, $${usd}. Even stampedes get audited.` });
      } else feed({ type: "SCRAMBLE_PASS", agentId: agent.id, symbol: tok.symbol, line: pickLine("audrey", "scramblePass", ctxLine) });
    } else if (p.id === "echo") {
      const has = S._signals.some((s) => s.side === "buy" && s.token.toLowerCase() === tok.address.toLowerCase() && !s.stale);
      if (has) {
        const q = await payData(agent, "quote", tok.address);
        const pc = await precheck(tok.address);
        const usd = round2(agent.cash * 0.2);
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.ok ? q.price : 0, line: `Smart money's already in ${tok.symbol}? Then the echo follows. $${usd}.` });
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
        if (usd >= 1) doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: round2(v.price + (q.ok ? q.price : 0)), line: `Okay okay okay — verdict's clean, so a LITTLE ${tok.symbol}. $${usd}. The playbook has a scramble page, I checked.` });
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
    if (r && r.version === RESERVE_FILE_VERSION && Array.isArray(r.claims) && Array.isArray(r.journal)) return r;
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
  const rakeReserve = round2(S.pool.collected * (RAKE_POINTS_RESERVE / 100));
  const rakeHouse = round2(S.pool.rake - rakeReserve);
  R.balance = round2(R.balance + rakeReserve);
  R.totalInflow = round2(R.totalInflow + rakeReserve);
  R.journal.push({ ts, type: "INFLOW", matchId: S.matchId, amount: rakeReserve, balanceAfter: R.balance, note: `Reserve share of the rake: ${RAKE_POINTS_RESERVE} of ${RAKE_POINTS_TOTAL} points on a $${S.pool.collected.toFixed(2)} pool. House keeps $${rakeHouse.toFixed(2)}; the prize pool is untouched.` });

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
  saveReserve(R);
  S.reserve = reserveSnapshot(R);
  return {
    rakeReserve, rakeHouse, topupAmount, paidTotal, balanceAfter: R.balance,
    payments: payments.map((p) => ({ claimId: p.claim.id, agent: p.claim.agent, class: p.claim.class, amount: p.claim.amount, paid: p.paid, shortfall: p.shortfall })),
  };
}

// ---------- Main ----------
async function main() {
  S = newMatch();
  if (CFG.reserve) S.reserve = reserveSnapshot(loadReserve());
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
      feed({ type: "FINAL_CLOSE", agentId: p.id, symbol: pos.symbol, amountUsd: round2(proceeds), price: px, pnlUsd: round2(pnl), line: `Final whistle. ${p.name} closes ${pos.symbol} at $${px} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}).` });
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
    feed({ type: "RESERVE", line: `Stabilization reserve: $${detail.rakeReserve.toFixed(2)} of the rake accrued (house keeps $${detail.rakeHouse.toFixed(2)}). Claims paid $${detail.paidTotal.toFixed(2)} this settlement; reserve balance $${detail.balanceAfter.toFixed(2)}. The prize pool was never touched.` });
  }
  feed({ type: "MATCH_END", line: `${S.matchId} complete. Pool $${pool.collected} → rake $${pool.rake} → $${pool.distributable} split 50/30/20. Total data spend $${S.receipts.totalDataSpend} across six agents (cap $${DATA_CAP}/agent, ${S.receipts.totalCapRefusals} refusals).` });
  updateLeaderboard();
  saveState();
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ match: S.matchId, receipts: S.receipts, leaderboard: S.leaderboard }, null, 1));
  console.log("\n=== MATCH REPORT ===");
  console.log(JSON.stringify(S.receipts, null, 1));
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
  __test: { audreyRuleClaims, settleClaimClasses, seedReserve },
};
