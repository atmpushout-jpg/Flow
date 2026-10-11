/**
 * Flow Social-Velocity Signal — "read the replies, not just the chart."
 *
 * Reply-velocity in the wild (the savipww/Grok-bot pattern) is attention
 * accelerating around a token BEFORE the price fully moves. We can't read
 * X replies without an API key, so v1 measures the two free, public,
 * no-key attention proxies that move first when a social push starts:
 *
 *   1. DexScreener boosts — teams/communities pay to promote a token;
 *      a sudden rise in boost total is a social campaign switching on.
 *   2. GeckoTerminal trending rank (Base) — a token entering / climbing
 *      the trending list is crowd attention, measured by a third party.
 *
 * Method: snapshot both feeds every ~8 min (piggybacked on the 2-min
 * signal poller), keep ~6h of samples, and compute per-token velocity
 * against a ~1h-ago baseline. Every score ships with its RAW inputs
 * (boost totals then/now, ranks then/now, sample window) so consumers
 * can judge the signal themselves — no black box.
 *
 * Honest limits: boosts are paid promotion, not organic replies; a boost
 * spike can be a team buying attention for a dump as easily as genuine
 * community energy. This is an attention signal, not a quality signal.
 */

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "social-velocity-state.json");
const REFRESH_MS = 8 * 60 * 1000; // snapshot cadence
const KEEP_MS = 6 * 60 * 60 * 1000; // sample history kept
const BASELINE_MS = 60 * 60 * 1000; // velocity measured vs ~1h ago
const FETCH_TIMEOUT_MS = 6000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { samples: [], updatedAt: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

// One snapshot of Base attention right now:
// { addrLower: { boostsTotal, boostEvents, trendingRank, buyersH1 } }
async function takeSample() {
  const tokens = {};
  const get = (addr) => {
    const k = addr.toLowerCase();
    if (!tokens[k])
      tokens[k] = { boostsTotal: 0, boostEvents: 0, trendingRank: null, buyersH1: null };
    return tokens[k];
  };

  // DexScreener boosts: "top" gives cumulative totals, "latest" gives the
  // most recent boost events (a token appearing repeatedly = campaign live).
  try {
    const top = await fetchJson("https://api.dexscreener.com/token-boosts/top/v1");
    for (const t of Array.isArray(top) ? top : []) {
      if (t.chainId !== "base" || !t.tokenAddress) continue;
      get(t.tokenAddress).boostsTotal = Math.max(get(t.tokenAddress).boostsTotal, t.totalAmount || 0);
    }
  } catch (e) {
    console.log("social-velocity: boosts/top failed:", e.message.slice(0, 60));
  }
  try {
    const latest = await fetchJson("https://api.dexscreener.com/token-boosts/latest/v1");
    for (const t of Array.isArray(latest) ? latest : []) {
      if (t.chainId !== "base" || !t.tokenAddress) continue;
      const rec = get(t.tokenAddress);
      rec.boostEvents += 1;
      rec.boostsTotal = Math.max(rec.boostsTotal, t.totalAmount || 0);
      if (t.description && !rec.sampleNarrative) rec.sampleNarrative = String(t.description).slice(0, 140);
    }
  } catch (e) {
    console.log("social-velocity: boosts/latest failed:", e.message.slice(0, 60));
  }

  // GeckoTerminal trending pools on Base: rank = position in list.
  try {
    const trend = await fetchJson("https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1");
    (trend.data || []).forEach((p, i) => {
      const rel = p.relationships?.base_token?.data?.id || "";
      const addr = rel.replace(/^base_/, "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
      const rec = get(addr);
      rec.trendingRank = i + 1;
      const buyers = parseFloat(p.attributes?.transactions?.h1?.buyers);
      if (Number.isFinite(buyers)) rec.buyersH1 = buyers;
      if (p.attributes?.name && !rec.symbol) rec.symbol = String(p.attributes.name).split(" / ")[0];
    });
  } catch (e) {
    console.log("social-velocity: trending failed:", e.message.slice(0, 60));
  }

  return tokens;
}

function pickBaseline(samples, nowTs) {
  // Sample closest to (now - BASELINE_MS); falls back to oldest sample so
  // velocity is computable during the first hour (window is reported raw).
  let best = null;
  for (const s of samples) {
    if (s.ts >= nowTs - 5 * 60 * 1000) continue; // not the current sample
    if (!best || Math.abs(s.ts - (nowTs - BASELINE_MS)) < Math.abs(best.ts - (nowTs - BASELINE_MS)))
      best = s;
  }
  return best || samples[0] || null;
}

function computeView(state) {
  const samples = state.samples || [];
  if (!samples.length) return { updatedAt: state.updatedAt || null, tokens: {}, spikes: [] };
  const cur = samples[samples.length - 1];
  const base = pickBaseline(samples, cur.ts);
  const windowMin = base ? Math.max(1, Math.round((cur.ts - base.ts) / 60000)) : 0;
  const hours = Math.max(windowMin / 60, 1 / 12); // floor 5 min to avoid absurd rates

  const tokens = {};
  const spikes = [];
  for (const [addr, c] of Object.entries(cur.tokens)) {
    const b = base?.tokens?.[addr] || { boostsTotal: 0, boostEvents: 0, trendingRank: null, buyersH1: null };
    const boostDelta = Math.max(0, (c.boostsTotal || 0) - (b.boostsTotal || 0));
    const boostPerHour = Math.round((boostDelta / hours) * 10) / 10;
    const enteredTrending = b.trendingRank == null && c.trendingRank != null;
    const rankDelta = b.trendingRank != null && c.trendingRank != null ? b.trendingRank - c.trendingRank : null;

    // Score 0..100: boost acceleration up to 50, trending presence/climb up to 50.
    let score = Math.min(50, boostPerHour); // 50 boosts/hr saturates
    if (c.trendingRank != null) score += Math.max(0, 31 - c.trendingRank); // rank 1 = +30
    if (enteredTrending) score += 10;
    if (rankDelta != null && rankDelta > 0) score += Math.min(10, rankDelta);
    score = Math.round(Math.min(100, score));

    const level = score >= 60 || (enteredTrending && c.trendingRank <= 10) || boostPerHour >= 30
      ? "hot"
      : score >= 25
        ? "warm"
        : "quiet";

    const rec = {
      score,
      level,
      raw: {
        boostsTotalNow: c.boostsTotal || 0,
        boostsTotalBaseline: b.boostsTotal || 0,
        boostDelta,
        boostPerHour,
        boostEventsNow: c.boostEvents || 0,
        trendingRankNow: c.trendingRank,
        trendingRankBaseline: b.trendingRank,
        enteredTrending,
        rankDelta,
        buyersH1: c.buyersH1,
        windowMin,
      },
    };
    if (c.symbol) rec.symbol = c.symbol;
    tokens[addr] = rec;
    if (level !== "quiet") spikes.push({ token: addr, ...rec });
  }
  spikes.sort((a, b) => b.score - a.score);
  return { updatedAt: state.updatedAt || null, tokens, spikes: spikes.slice(0, 20) };
}

// Refresh the snapshot if the last one is older than REFRESH_MS, then
// return the computed view. Safe to call every 2 min from the poller.
async function refreshIfDue() {
  const state = loadState();
  const last = state.samples?.length ? state.samples[state.samples.length - 1].ts : 0;
  if (Date.now() - last >= REFRESH_MS) {
    const tokens = await takeSample();
    state.samples = [...(state.samples || []), { ts: Date.now(), tokens }].filter(
      (s) => Date.now() - s.ts <= KEEP_MS
    );
    state.updatedAt = new Date().toISOString();
    saveState(state);
  }
  return computeView(state);
}

async function main() {
  const view = await refreshIfDue();
  console.log(
    `social-velocity: tracked ${Object.keys(view.tokens).length} tokens | spikes: ${view.spikes.length}` +
      (view.spikes[0] ? ` | top: ${view.spikes[0].symbol || view.spikes[0].token.slice(0, 10)} score ${view.spikes[0].score}` : "")
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e.message.slice(0, 200));
    process.exit(1);
  });
}

module.exports = { refreshIfDue, loadView: () => computeView(loadState()), STATE_PATH };
