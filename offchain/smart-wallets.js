/**
 * Flow Smart-Wallet Tracker — leaderboard builder.
 * Runs every 15 min (cron: smart-wallets-leaderboard).
 *
 * Methodology (descriptive, not predictive):
 *  1. Build a watchlist of Base tokens: DexScreener boosts + sniper-registry
 *     discoveries + WETH/USDC.
 *  2. A token is a "pumper" when its best pair is up >=50% in 24h with
 *     >=$50k volume and >=$20k liquidity.
 *  3. For each pumper, pull recent pool trades from GeckoTerminal (free, no key).
 *     A buy counts as "early" when it executed at <50% of the token's current
 *     price — i.e. the wallet was in before most of the run-up.
 *  4. Wallets are ranked by distinct pumpers caught early. No win-rate is
 *     fabricated: we only observe buys on tokens that already pumped, so the
 *     honest metric is "pumpers caught", with sample-size flags.
 *
 * Honest-math rules:
 *  - Wallets with <3 distinct pumpers are flagged sample_small.
 *  - Router/aggregator addresses (very high trade counts in one scan) are skipped.
 *  - This leaderboard describes the past. It does not predict future returns.
 *    Most copy-traders lose to latency: followers get worse fills than the
 *    wallet they copy.
 *
 * Output: offchain/smart-wallets.json (leaderboard + hot pools + signals slot),
 * plus a best-effort write to Upstash Redis (flow:smartwallets) when the
 * UPSTASH_* env vars are present, so /api/smart-wallets can serve it in <200ms.
 */

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "smart-wallets.json");
const REGISTRY_PATH = path.join(__dirname, "..", "logs", "sniper-registry.json");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PUMP_MIN_PCT = 50; // h24 gain (%) to count as a pumper
const MIN_VOL_USD = 50000; // h24 volume floor
const MIN_LIQ_USD = 20000; // liquidity floor
const EARLY_PRICE_FRAC = 0.5; // bought below 50% of current price = early
const MAX_WALLETS = 50; // leaderboard size
const MAX_HOT_POOLS = 12; // pools the fast signal poller watches
const MAX_TRADES_PER_WALLET_PER_RUN = 50; // router/aggregator guard
const REDIS_KEY = "flow:smartwallets";

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function getWatchlist() {
  const set = new Set([WETH, USDC]);
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
    const boosts = await r.json();
    (Array.isArray(boosts) ? boosts : [])
      .filter((b) => b.chainId === "base" && b.tokenAddress)
      .slice(0, 10)
      .forEach((b) => set.add(b.tokenAddress));
  } catch (e) {
    console.log("boosts fetch failed:", e.message.slice(0, 80));
  }
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")).tokens || {};
    Object.entries(reg)
      .sort((a, b) => String(b[1].firstSeen || "").localeCompare(String(a[1].firstSeen || "")))
      .slice(0, 15)
      .forEach(([addr]) => set.add(addr));
  } catch {
    /* registry optional */
  }
  return [...set].slice(0, 30);
}

async function getPairs(addresses) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`);
  if (!r.ok) throw new Error(`dexscreener HTTP ${r.status}`);
  const d = await r.json();
  return (d.pairs || []).filter((p) => p.chainId === "base");
}

function bestPairFor(pairs, tokenAddr) {
  const t = tokenAddr.toLowerCase();
  const mine = pairs.filter(
    (p) =>
      p.baseToken.address.toLowerCase() === t || p.quoteToken.address.toLowerCase() === t
  );
  mine.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return mine[0] || null;
}

async function getPoolTrades(poolAddr) {
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddr}/trades`);
  if (!r.ok) throw new Error(`geckoterminal HTTP ${r.status}`);
  const d = await r.json();
  return d.data || [];
}

async function redisWrite(obj) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/set/${REDIS_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(obj),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  const now = new Date().toISOString();
  const prev = loadState() || {};
  const wallets = prev.wallets || {}; // addr -> {wins, earlyBuys, tokens:{}, lastSeen}

  const watchlist = await getWatchlist();
  console.log(`watchlist: ${watchlist.length} tokens`);
  const pairs = await getPairs(watchlist);

  // Identify pumpers among the watchlist.
  const pumpers = [];
  for (const addr of watchlist) {
    const p = bestPairFor(pairs, addr);
    if (!p) continue;
    const chg = p.priceChange?.h24 || 0;
    const vol = p.volume?.h24 || 0;
    const liq = p.liquidity?.usd || 0;
    if (chg >= PUMP_MIN_PCT && vol >= MIN_VOL_USD && liq >= MIN_LIQ_USD) {
      const isBase = p.baseToken.address.toLowerCase() === addr.toLowerCase();
      const subj = isBase ? p.baseToken : p.quoteToken;
      pumpers.push({
        token: subj.address,
        symbol: subj.symbol,
        priceUsd: parseFloat(p.priceUsd) || 0,
        chg24: chg,
        pool: p.pairAddress,
        dex: p.dexId,
      });
    }
  }
  console.log(`pumpers: ${pumpers.length}`);

  // For each pumper, find early buyers from pool trades.
  const perWalletThisRun = {};
  const hotPools = [];
  for (const pm of pumpers) {
    if (!pm.priceUsd) continue;
    hotPools.push({
      poolAddress: pm.pool,
      tokenAddress: pm.token,
      symbol: pm.symbol,
      priceUsd: pm.priceUsd,
      dex: pm.dex,
    });
    let trades;
    try {
      trades = await getPoolTrades(pm.pool);
    } catch (e) {
      console.log(`trades failed for ${pm.symbol}:`, e.message.slice(0, 80));
      continue;
    }
    const subj = pm.token.toLowerCase();
    for (const t of trades) {
      const a = t.attributes || {};
      const toTok = (a.to_token_address || "").toLowerCase();
      if (toTok !== subj) continue; // only buys of the pumper token
      const maker = (a.tx_from_address || "").toLowerCase();
      if (!maker || maker === pm.pool.toLowerCase()) continue;
      const execPrice = parseFloat(a.price_to_in_usd) || 0;
      if (!execPrice || execPrice >= EARLY_PRICE_FRAC * pm.priceUsd) continue; // not early
      perWalletThisRun[maker] = perWalletThisRun[maker] || { count: 0, txs: [] };
      perWalletThisRun[maker].count++;
      perWalletThisRun[maker].txs.push({
        token: pm.token,
        symbol: pm.symbol,
        execPrice,
        txHash: a.tx_hash,
        blockNumber: a.block_number,
        timestamp: a.block_timestamp,
      });
    }
    await new Promise((r) => setTimeout(r, 400)); // respect GeckoTerminal rate limits
  }

  // Merge into running wallet records (skip likely routers).
  for (const [maker, info] of Object.entries(perWalletThisRun)) {
    if (info.count > MAX_TRADES_PER_WALLET_PER_RUN) {
      console.log(`skip likely router ${maker.slice(0, 10)} (${info.count} txs)`);
      continue;
    }
    const w = wallets[maker] || { wins: 0, earlyBuys: 0, tokens: {}, lastSeen: null };
    for (const tx of info.txs) {
      const tk = tx.token.toLowerCase();
      if (!w.tokens[tk]) {
        w.tokens[tk] = { symbol: tx.symbol, firstEarlyBuy: tx.timestamp, txHash: tx.txHash };
        w.wins++;
      }
      w.earlyBuys++;
    }
    w.lastSeen = now;
    wallets[maker] = w;
  }

  // Build leaderboard: most distinct pumpers caught early first.
  const leaderboard = Object.entries(wallets)
    .map(([wallet, w]) => ({
      wallet,
      wins: w.wins, // distinct pumper tokens bought early
      earlyBuys: w.earlyBuys, // total early-buy transactions observed
      sample_small: w.wins < 3, // too few observations to mean much
      lastSeen: w.lastSeen,
    }))
    .sort((a, b) => b.wins - a.wins || b.earlyBuys - a.earlyBuys)
    .slice(0, MAX_WALLETS)
    .map((w, i) => ({ rank: i + 1, ...w }));

  // Prune wallet map to leaderboard members to bound file size.
  const keep = new Set(leaderboard.map((w) => w.wallet));
  for (const k of Object.keys(wallets)) if (!keep.has(k)) delete wallets[k];

  // Also seed hot pools from high-volume watchlist pairs so the fast poller
  // has something to watch even when no pumpers are active.
  if (hotPools.length < MAX_HOT_POOLS) {
    const byVol = [...pairs]
      .filter((p) => (p.volume?.h24 || 0) >= MIN_VOL_USD && (p.liquidity?.usd || 0) >= MIN_LIQ_USD)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    for (const p of byVol) {
      if (hotPools.length >= MAX_HOT_POOLS) break;
      if (hotPools.some((h) => h.poolAddress === p.pairAddress)) continue;
      hotPools.push({
        poolAddress: p.pairAddress,
        tokenAddress: p.baseToken.address,
        symbol: p.baseToken.symbol,
        priceUsd: parseFloat(p.priceUsd) || 0,
        dex: p.dexId,
      });
    }
  }

  const state = {
    updatedAt: now,
    leaderboardUpdatedAt: now,
    signalsUpdatedAt: prev.signalsUpdatedAt || null,
    wallets,
    leaderboard,
    hotPools: hotPools.slice(0, MAX_HOT_POOLS),
    signals: prev.signals || [], // preserved; the fast poller owns this list
    paperRecord: prev.paperRecord || null, // preserved; paper module owns this
    methodology: {
      pumperDefinition: `h24 >= +${PUMP_MIN_PCT}% with >=$${MIN_VOL_USD / 1000}k volume and >=$${MIN_LIQ_USD / 1000}k liquidity`,
      earlyBuyDefinition: `buy executed below ${(EARLY_PRICE_FRAC * 100).toFixed(0)}% of current price`,
      ranking: "distinct pumper tokens caught early (descending)",
      honesty:
        "Descriptive only. Past pumps do not predict future returns. sample_small wallets have too few observations to evaluate.",
    },
  };

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
  const redisOk = await redisWrite(state);
  console.log(
    `leaderboard: ${leaderboard.length} wallets | hotPools: ${state.hotPools.length} | redis: ${redisOk ? "ok" : "skipped"}`
  );
  leaderboard.slice(0, 3).forEach((w) =>
    console.log(`  #${w.rank} ${w.wallet.slice(0, 12)}… wins=${w.wins} buys=${w.earlyBuys}${w.sample_small ? " (small sample)" : ""}`)
  );
}

main().catch((e) => {
  console.error("FATAL:", e.message.slice(0, 200));
  process.exit(1);
});
