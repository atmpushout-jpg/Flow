/**
 * Flow Smart-Wallet Signal Feed — fast poll loop (runs every 2 min,
 * cron: smart-wallet-signals).
 *
 * The Grok lesson: the signal (top wallet bought) beats the latency cost
 * only if you act fast. This poller watches the hot pools from the
 * leaderboard builder and surfaces buys by top-50 wallets within minutes.
 *
 * Each signal carries a timestamp AND block number so consuming agents can
 * judge freshness themselves. Signals older than 10 min are flagged stale —
 * honest about decay: in memecoins, a 10-minute-old signal is a different
 * trade than a 1-minute-old one.
 *
 * Also feeds the paper trader (offchain/smart-wallet-paper.js): fresh top-10
 * buys open $50 paper positions; detected sells / 24h timeouts close them.
 *
 * Rate-limit budget: <=12 pools x 1 call per 2 min = ~6 calls/min against
 * GeckoTerminal's 30/min free tier. DexScreener price lookups are batched.
 */

const fs = require("fs");
const path = require("path");
const paper = require("./smart-wallet-paper");

const STATE_PATH = path.join(__dirname, "smart-wallets.json");
const REDIS_KEY = "flow:smartwallets";

const MAX_SIGNALS = 60; // kept in state; API serves the latest 20
const FRESH_WINDOW_MS = 6 * 60 * 1000; // only emit signals from last 6 min
const STALE_AFTER_MS = 10 * 60 * 1000; // flag signals older than 10 min
const TOP_WALLET_CUTOFF = 50; // signals from top-50 wallets
const PAPER_WALLET_CUTOFF = 10; // paper copies top-10 only

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
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

async function getPoolTrades(poolAddr) {
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddr}/trades`);
  if (!r.ok) throw new Error(`geckoterminal HTTP ${r.status}`);
  return (await r.json()).data || [];
}

// Batch current USD prices for a set of token addresses via DexScreener.
async function priceMap(addresses) {
  const out = {};
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 30);
  if (!list.length) return out;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${list.join(",")}`);
    if (!r.ok) return out;
    const d = await r.json();
    for (const p of d.pairs || []) {
      if (p.chainId !== "base") continue;
      for (const side of [p.baseToken, p.quoteToken]) {
        const k = (side.address || "").toLowerCase();
        if (list.includes(k) && !out[k]) out[k] = parseFloat(p.priceUsd) || 0;
      }
    }
  } catch {
    /* prices optional */
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const state = loadState();
  if (!state || !state.leaderboard?.length || !state.hotPools?.length) {
    console.log("no leaderboard/hotPools yet — run smart-wallets.js first");
    return;
  }

  const topWallets = new Map(); // addr -> {rank, wins}
  state.leaderboard.slice(0, TOP_WALLET_CUTOFF).forEach((w) => {
    topWallets.set(w.wallet.toLowerCase(), { rank: w.rank, wins: w.wins });
  });
  const paperWallets = new Set(
    state.leaderboard.slice(0, PAPER_WALLET_CUTOFF).map((w) => w.wallet.toLowerCase())
  );

  const seenTx = new Set((state.signals || []).map((s) => s.txHash));
  const freshBuys = []; // signals emitted this run
  const sells = []; // sells by paper wallets (for paper exits)

  for (const hp of state.hotPools) {
    let trades;
    try {
      trades = await getPoolTrades(hp.poolAddress);
    } catch (e) {
      console.log(`trades failed ${hp.symbol}:`, e.message.slice(0, 60));
      continue;
    }
    const subj = hp.tokenAddress.toLowerCase();
    for (const t of trades) {
      const a = t.attributes || {};
      const ts = new Date(a.block_timestamp).getTime();
      if (!ts || Date.now() - ts > FRESH_WINDOW_MS) continue; // only fresh trades
      const maker = (a.tx_from_address || "").toLowerCase();
      if (!maker || !topWallets.has(maker)) continue;
      if (seenTx.has(a.tx_hash)) continue;
      const fromTok = (a.from_token_address || "").toLowerCase();
      const toTok = (a.to_token_address || "").toLowerCase();
      const meta = topWallets.get(maker);
      if (toTok === subj) {
        // maker BOUGHT the subject token
        freshBuys.push({
          wallet: a.tx_from_address,
          walletRank: meta.rank,
          walletWins: meta.wins,
          token: hp.tokenAddress,
          symbol: hp.symbol,
          side: "buy",
          amountUsd: Math.round((parseFloat(a.volume_in_usd) || 0) * 100) / 100,
          txHash: a.tx_hash,
          blockNumber: a.block_number,
          timestamp: a.block_timestamp,
        });
        seenTx.add(a.tx_hash);
      } else if (fromTok === subj && paperWallets.has(maker)) {
        // maker SOLD the subject token — paper exit trigger
        sells.push({
          wallet: a.tx_from_address,
          token: hp.tokenAddress,
          price: parseFloat(a.price_from_in_usd) || null,
          txHash: a.tx_hash,
        });
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // Merge fresh signals, newest first; recompute stale flags honestly.
  const signals = [...freshBuys, ...(state.signals || [])]
    .slice(0, MAX_SIGNALS)
    .map((s) => ({
      ...s,
      ageSec: Math.max(0, Math.round((Date.now() - new Date(s.timestamp).getTime()) / 1000)),
    }))
    .map((s) => ({ ...s, stale: s.ageSec * 1000 > STALE_AFTER_MS }));

  // Paper trader: copy fresh top-10 buys, close on sells / 24h.
  const prices = await priceMap([
    ...freshBuys.map((b) => b.token),
    ...sells.map((s) => s.token),
    ...(loadPaperTokens()),
  ]);
  const getPrice = async (addr) => prices[addr.toLowerCase()] || null;
  const paperBuys = freshBuys.filter((b) => paperWallets.has(b.wallet.toLowerCase()));
  let paperRecord = state.paperRecord || null;
  try {
    paperRecord = await paper.updatePaper({ buys: paperBuys, sells, getPrice });
  } catch (e) {
    console.log("paper update failed:", e.message.slice(0, 80));
  }

  state.signals = signals;
  state.signalsUpdatedAt = now;
  state.updatedAt = now;
  state.paperRecord = paperRecord;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
  const redisOk = await redisWrite(state);
  console.log(
    `poll ${(Date.now() - t0) / 1000}s | fresh signals: ${freshBuys.length} | sells seen: ${sells.length} | paper trades: ${paperRecord?.totalTrades ?? "?"} paperPnl: ${paperRecord?.totalPnlUsd ?? "?"} | redis: ${redisOk ? "ok" : "skipped"}`
  );
}

function loadPaperTokens() {
  try {
    const p = JSON.parse(fs.readFileSync(paper.PAPER_PATH, "utf8"));
    return (p.positions || []).map((x) => x.token);
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message.slice(0, 200));
  process.exit(1);
});
