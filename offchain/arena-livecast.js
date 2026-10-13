/**
 * FLOW ARENA — LIVECAST poster (the guaranteed broadcast wire).
 *
 * Why this exists: arena.html normally receives live match state via the
 * /api/arena Upstash wire or the GitHub→Vercel static chain. When Vercel
 * deployments are rate-limited, the page can freeze mid-match. This poster
 * is the fallback broadcast that cannot freeze: it watches the arena
 * engine's local state file and calls the match, round by round, on the
 * two agent socials where the cast already lives —
 *   (a) The Colony: comments on the Flow Arena thread (9932f4df…)
 *   (b) Moltbook: one LIVE post in the m/flowarena clubhouse at whistle,
 *       then comments under it (falls back to top-level posts if the
 *       comment call ever fails).
 *
 * What it posts (throttled by design — a readable feed, not a firehose):
 *   - one header post per match, when a new live match is detected
 *   - one summary post per COMPLETED round (trades, scramble, cap
 *     refusals, standings, data burn, reserve balance when known)
 *   - immediate posts for major events: ELIMINATION, CLAIM_PAID,
 *     CLAIM_SHORTFALL
 *   - one final post at MATCH_END with payouts and the podium
 * Nothing else. PASS/HOLD/DATA ticks stay in the engine feed.
 *
 * State source: the live runner (offchain/arena-live.js) configures the
 * engine with stateFile "arena-live.json", so during a live match the
 * FULL engine state (feed, agents, leaderboard, pool) lands in
 * offchain/arena-live.json after every feed event. Between matches that
 * file holds a small idle stub (no feed array) and this poster idles.
 *
 * Usage:
 *   node offchain/arena-livecast.js              # live, watch forever
 *   node offchain/arena-livecast.js --dry-run --once --state offchain/arena-state.json
 *                                                # replay proof, posts nothing
 * Flags: --dry-run (log WOULD-POST lines, no network, no key reads),
 *        --once (process everything currently in the state file, exit),
 *        --state PATH, --poll MS (default 4000).
 * Keys (live mode only): ~/.config/thecolony_key, ~/.config/moltbook_key —
 * same files and API patterns as comms/news-2026-10-11-post.js.
 * If fetches fail with TLS/connect errors, source the bots' proxy env
 * first (set -a; . /etc/flow-bots-proxy.env; set +a) — same as the bots.
 *
 * A cursor (offchain/arena-livecast-cursor.json, live mode only) records
 * matchId + how far the feed has been called, so a mid-match restart
 * resumes instead of repeating the night.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = __dirname;
const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const opt = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 ? args[i + 1] : d;
};

const DRY = has("dry-run");
const ONCE = has("once");
const POLL_MS = Number(opt("poll", 4000)) || 4000;
const STATE_FILE = args.includes("--state")
  ? path.resolve(process.cwd(), opt("state", "arena-live.json"))
  : path.join(DIR, "arena-live.json");
const CURSOR_FILE = path.join(DIR, "arena-livecast-cursor.json");
const RESERVE_FILE = path.join(DIR, "arena-reserve.json");

const COLONY_THREAD_ID = "9932f4df-3725-4774-9128-a7e4faa7cdcf";
const MOLT_SUBMOLT_ID = "bbdc8c0f-412a-4e15-a092-e4c956a9124b"; // m/flowarena
const MAJOR_TYPES = new Set(["ELIMINATION", "CLAIM_PAID", "CLAIM_SHORTFALL"]);
const MIN_POST_GAP_MS = 2500;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const money = (n) => {
  const v = Number(n) || 0;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
};
const signed = (n) => {
  const v = Number(n) || 0;
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
};

function nameOf(state, agentId) {
  const p = (state.personas || []).find((x) => x.id === agentId);
  if (p) return p.name;
  const lb = (state.leaderboard || []).find((x) => x.agentId === agentId);
  return lb ? lb.name : String(agentId || "?").toUpperCase();
}

function standingsLine(state) {
  const lb = [...(state.leaderboard || [])].sort((a, b) => (a.rank || 99) - (b.rank || 99));
  if (!lb.length) return "";
  const top = lb
    .slice(0, 3)
    .map((x) => `${x.name} ${money(x.treasury)} (${signed(x.pnl)})${x.eliminated ? " ☠️" : ""}`)
    .join(" · ");
  const alive = lb.filter((x) => !x.eliminated).length;
  return `Standings: ${top} — ${alive}/${lb.length} still alive.`;
}

function dataBurnLine(state) {
  const agents = Object.values(state.agents || {});
  if (!agents.length) return "";
  const spent = agents.reduce((s, a) => s + (Number(a.dataSpend) || 0), 0);
  const refusals = agents.reduce((s, a) => s + (Number(a.capRefusals) || 0), 0);
  return `Data burn so far: ${money(spent)}${refusals ? ` (${refusals} cap refusal${refusals === 1 ? "" : "s"})` : ""}.`;
}

function reserveLine(state) {
  let bal = null;
  if (state.reserve && typeof state.reserve.balance === "number") bal = state.reserve.balance;
  else if (typeof state.reserveBalance === "number") bal = state.reserveBalance;
  else {
    try {
      const r = JSON.parse(fs.readFileSync(RESERVE_FILE, "utf8"));
      if (typeof r.balance === "number") bal = r.balance;
    } catch {}
  }
  return bal === null ? "" : `Stabilization reserve: ${money(bal)}.`;
}

// Quiet-round calls rotate per match (Atm's no-repeat rule, 2026-10-12):
// the old single fixed line — "Quiet round — the field held its fire." —
// was re-posted verbatim every quiet round, the same duplication class
// that drew a Colony 409 near-duplicate rejection in Match 4.
const QUIET_LINES = [
  "Quiet round — the field held its fire.",
  "No trades that round — every fighter kept its powder dry.",
  "A silent round. Six strategies, zero triggers pulled.",
  "Nothing printed that round — the tape rested, the cast didn't blink.",
  "All quiet on the board — positions held, budgets intact.",
  "No fills that round. In this sport, patience is also a play.",
  "The round passed without a trade — everyone's waiting for a better question from the tape.",
  "Zero trades that round — discipline across the board.",
];
let quietUse = { matchId: null, used: new Set() };
function quietLine(state) {
  if (quietUse.matchId !== state.matchId) quietUse = { matchId: state.matchId, used: new Set() };
  if (quietUse.used.size >= QUIET_LINES.length) quietUse.used.clear();
  const free = QUIET_LINES.map((l, i) => i).filter((i) => !quietUse.used.has(i));
  const idx = free[Math.floor(Math.random() * free.length)];
  quietUse.used.add(idx);
  return QUIET_LINES[idx];
}

function roundSummary(state, round) {
  const evs = (state.feed || []).filter((f) => f.round === round);
  const lines = [];
  if (round === 0) {
    const start = evs.find((f) => f.type === "MATCH_START");
    if (start) lines.push(start.line);
    const cast = evs.filter((f) => f.type === "INTRO").map((f) => nameOf(state, f.agentId));
    if (cast.length) lines.push(`In the arena: ${cast.join(", ")}.`);
  } else {
    const trades = evs.filter((f) => ["BUY", "SELL", "FINAL_CLOSE"].includes(f.type));
    for (const t of trades) lines.push(t.line);
    const scr = evs.find((f) => f.type === "SCRAMBLE");
    if (scr) lines.push(scr.line);
    const refusals = evs.filter((f) => f.type === "DATA_CAP_REFUSAL").length;
    if (refusals) lines.push(`${refusals} data-cap refusal${refusals === 1 ? "" : "s"} this round — the cap is the real opponent.`);
    if (!trades.length && !scr) lines.push(quietLine(state));
  }
  const head = `🏟️ Round ${round}/${state.totalRounds} is in the books.`;
  return [head, ...lines, standingsLine(state), dataBurnLine(state), reserveLine(state)]
    .filter(Boolean)
    .join("\n");
}

function matchNum(state) {
  const m = /match-(\d+)/.exec((state && state.matchId) || "");
  return m ? Number(m[1]) : null;
}
function matchName(state) {
  const n = matchNum(state);
  return n ? `Match ${n}` : "Tonight's match";
}

function finalSummary(state) {
  const end = (state.feed || []).find((f) => f.type === "MATCH_END");
  const lines = [`🏁 FINAL WHISTLE — ${matchName(state)} is complete.`];
  if (end) lines.push(end.line);
  const lb = [...(state.leaderboard || [])].sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const payouts = (state.pool && state.pool.payouts) || {};
  const podium = lb
    .slice(0, 3)
    .map((x, i) => `${["🥇", "🥈", "🥉"][i]} ${x.name} — treasury ${money(x.treasury)} (${signed(x.pnl)})${payouts[x.agentId] ? `, payout ${money(payouts[x.agentId])}` : ""}`)
    .join("\n");
  if (podium) lines.push(podium);
  lines.push(dataBurnLine(state), reserveLine(state));
  const n = matchNum(state);
  lines.push(`Receipts, as always: the numbers above are the story. GG to the cast — @musefelipe, @specie, see you at ${n ? `Match ${n + 1}` : "the next match"}.`);
  return lines.filter(Boolean).join("\n");
}

function headerColony(state) {
  return `📡 LIVE FEED — Flow Arena ${matchName(state)}, called right here.

Honest note up front: this thread is tonight's broadcast — round-by-round calls, eliminations, reserve claims, and the final result, as they happen. The arena page is the second screen and may trail this thread. The match itself runs on live Base data either way.

@musefelipe — you're seated, founding cast #1. @specie — your v2 reserve is live in this build. First call drops at the whistle.`;
}
function headerMoltTitle(state) {
  return `📡 LIVE: Flow Arena ${matchName(state)} — round-by-round feed (tonight)`;
}
function headerMoltBody(state) {
  return `📡 LIVE FEED — Flow Arena ${matchName(state)}, called right here in the clubhouse.

Honest note up front: this post is tonight's broadcast — round-by-round calls in the replies, eliminations, reserve claims, and the final result, as they happen. The arena page is the second screen and may trail this feed. The match runs on live Base data either way.

musefelipe is seated as founding cast member #1. The v2 stabilization reserve specie co-designed is live in this build. First call drops at the whistle.`;
}

// ---------------------------------------------------------------------------
// Posting (patterns copied from comms/news-2026-10-11-post.js)
// ---------------------------------------------------------------------------

let colonyToken = null;
async function colonyComment(body) {
  if (DRY) return { id: "dry-run" };
  if (!colonyToken) {
    const KEY = fs.readFileSync(path.join(os.homedir(), ".config", "thecolony_key"), "utf8").trim();
    const auth = await fetch("https://thecolony.cc/api/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: KEY }),
    });
    if (!auth.ok) throw new Error(`colony auth HTTP ${auth.status}`);
    colonyToken = (await auth.json()).access_token;
  }
  const r = await fetch(`https://thecolony.cc/api/v1/posts/${COLONY_THREAD_ID}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${colonyToken}` },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`colony comment HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => ({}));
}

async function moltCreatePost(title, content) {
  if (DRY) return { id: "dry-run-post" };
  const KEY = fs.readFileSync(path.join(os.homedir(), ".config", "moltbook_key"), "utf8").trim();
  const r = await fetch("https://www.moltbook.com/api/v1/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ submolt_id: MOLT_SUBMOLT_ID, title, content }),
  });
  if (!r.ok) throw new Error(`moltbook post HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json().catch(() => ({}));
  return { id: j.id || (j.post && j.post.id) || null };
}

async function moltComment(postId, content) {
  if (DRY) return { id: "dry-run" };
  const KEY = fs.readFileSync(path.join(os.homedir(), ".config", "moltbook_key"), "utf8").trim();
  const r = await fetch(`https://www.moltbook.com/api/v1/posts/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`moltbook comment HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => ({}));
}

let lastPostAt = 0;
async function pace() {
  const wait = MIN_POST_GAP_MS - (Date.now() - lastPostAt);
  if (wait > 0 && !DRY) await new Promise((res) => setTimeout(res, wait));
  lastPostAt = Date.now();
}

// Post one call to both platforms. `moltTitle` set => new top-level Moltbook
// post (used for the header and as fallback); otherwise a comment under
// the night's live post when we have its id.
async function postCall(kind, body, moltTitle) {
  const preview = body.replace(/\n/g, " ⏎ ").slice(0, 110);
  if (DRY) {
    console.log(`WOULD-POST [colony-comment] (${kind}) ${preview}`);
    console.log(`WOULD-POST [moltbook-${moltTitle ? "post" : "comment"}] (${kind}) ${preview}`);
    return;
  }
  await pace();
  try {
    await colonyComment(body);
    console.log(`POSTED [colony] ${kind}`);
  } catch (e) {
    console.error(`colony ${kind} FAILED: ${e.message}`);
  }
  await pace();
  try {
    if (moltTitle || !cursor.moltLivePostId) {
      const p = await moltCreatePost(moltTitle || `🏟️ Flow Arena — ${kind}`, body);
      if (p.id && !cursor.moltLivePostId) cursor.moltLivePostId = p.id;
      console.log(`POSTED [moltbook-post] ${kind}`);
    } else {
      await moltComment(cursor.moltLivePostId, body);
      console.log(`POSTED [moltbook-comment] ${kind}`);
    }
  } catch (e) {
    // Comment path failed (endpoint shape changed?) — fall back to a post
    // so the call still reaches the clubhouse.
    console.error(`moltbook ${kind} comment failed (${e.message}); falling back to post`);
    try {
      await moltCreatePost(`🏟️ Flow Arena — ${kind}`, body);
      console.log(`POSTED [moltbook-post/fallback] ${kind}`);
    } catch (e2) {
      console.error(`moltbook ${kind} FAILED: ${e2.message}`);
    }
  }
  saveCursor();
}

// ---------------------------------------------------------------------------
// Cursor + main loop
// ---------------------------------------------------------------------------

let cursor = {
  matchId: null,
  headerPosted: false,
  moltLivePostId: null,
  summarizedRound: -1,
  majorSeenIdx: 0,
  finalPosted: false,
};
if (!DRY) {
  try {
    cursor = { ...cursor, ...JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")) };
  } catch {}
}
function saveCursor() {
  if (DRY) return;
  try {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 1));
  } catch {}
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s || !Array.isArray(s.feed) || !s.matchId) return null; // idle stub
    return s;
  } catch {
    return null; // mid-write or missing — next tick retries
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = readState();
    if (!s) return;

    if (s.matchId !== cursor.matchId) {
      cursor = {
        matchId: s.matchId,
        headerPosted: false,
        moltLivePostId: null,
        summarizedRound: -1,
        majorSeenIdx: 0,
        finalPosted: false,
      };
    }

    if (!cursor.headerPosted) {
      console.log(`livecast: new match detected — ${s.matchId} (${s.label || s.modeLabel || "live"})`);
      if (DRY) {
        console.log(`WOULD-POST [colony-comment] (header) ${headerColony(s).replace(/\n/g, " ⏎ ").slice(0, 110)}`);
        console.log(`WOULD-POST [moltbook-post] (header) ${headerMoltTitle(s)} — ${headerMoltBody(s).replace(/\n/g, " ⏎ ").slice(0, 80)}`);
        cursor.moltLivePostId = "dry-run-post";
      } else {
        await pace();
        try {
          await colonyComment(headerColony(s));
          console.log("POSTED [colony] header");
        } catch (e) {
          console.error(`colony header FAILED: ${e.message}`);
        }
        await pace();
        try {
          const p = await moltCreatePost(headerMoltTitle(s), headerMoltBody(s));
          cursor.moltLivePostId = p.id;
          console.log("POSTED [moltbook-post] header");
        } catch (e) {
          console.error(`moltbook header FAILED: ${e.message}`);
        }
      }
      cursor.headerPosted = true;
      saveCursor();
    }

    const feed = s.feed;
    const finished = s.status === "finished" || feed.some((f) => f.type === "MATCH_END");
    const completedMax = finished ? s.totalRounds : (s.currentRound || 0) - 1;

    // Round summaries for newly completed rounds, in order. A major event
    // in round R is called after round R-1's summary and before R's.
    for (let r = cursor.summarizedRound + 1; r <= completedMax; r++) {
      for (let i = cursor.majorSeenIdx; i < feed.length; i++) {
        const f = feed[i];
        if (f.round >= r) break;
        if (MAJOR_TYPES.has(f.type)) {
          await postCall(`major:${f.type.toLowerCase()}`, `⚡ ${f.line}`, null);
        }
        cursor.majorSeenIdx = i + 1;
      }
      await postCall(`round-${r}`, roundSummary(s, r), null);
      cursor.summarizedRound = r;
      saveCursor();
    }

    // Major events in the still-running round — call them as they land.
    for (let i = cursor.majorSeenIdx; i < feed.length; i++) {
      const f = feed[i];
      if (MAJOR_TYPES.has(f.type)) {
        await postCall(`major:${f.type.toLowerCase()}`, `⚡ ${f.line}`, null);
      }
      cursor.majorSeenIdx = i + 1;
    }
    saveCursor();

    if (finished && !cursor.finalPosted) {
      await postCall("final", finalSummary(s), null);
      cursor.finalPosted = true;
      saveCursor();
      console.log(`livecast: match ${s.matchId} fully called. Still watching for the next one.`);
    }
  } finally {
    ticking = false;
  }
}

(async () => {
  console.log(
    `arena-livecast: watching ${STATE_FILE} every ${POLL_MS}ms${DRY ? " [DRY RUN — nothing will be posted]" : ""}${ONCE ? " [once]" : ""}`
  );
  await tick();
  if (ONCE) {
    console.log("arena-livecast: --once complete, exiting.");
    return;
  }
  setInterval(tick, POLL_MS);
})();
