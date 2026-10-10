/**
 * Flow Smart-Wallet Paper Trader (PAPER ONLY — no real money, ever).
 *
 * Copies buy signals from top-10 leaderboard wallets with fixed $50 paper
 * positions. Tracks token prices via DexScreener. Closes a paper position
 * when the copied wallet sells the token, or after 24h, whichever first.
 *
 * Every trade is logged with entry/exit price and time. Wins, losses, and
 * total PnL are reported honestly — a negative paper record is data, not
 * failure: it means the signal needs work.
 *
 * Used by offchain/smart-wallet-signals.js (the 2-min poll loop). Not run
 * standalone: require() it and call updatePaper().
 */

const fs = require("fs");
const path = require("path");

const PAPER_PATH = path.join(__dirname, "smart-wallet-paper.json");
const STARTING_BALANCE = 1000; // paper USD
const POSITION_SIZE_USD = 50; // fixed paper size per copy
const MAX_POSITIONS = 10; // max concurrent paper positions
const HOLD_MS = 24 * 3600 * 1000; // close after 24h if wallet hasn't sold

function load() {
  try {
    return JSON.parse(fs.readFileSync(PAPER_PATH, "utf8"));
  } catch {
    return null;
  }
}

function init() {
  return {
    label: "PAPER TRADING ONLY — simulated, no real money involved",
    startingBalance: STARTING_BALANCE,
    balance: STARTING_BALANCE, // = startingBalance + realized paper PnL
    positionSizeUsd: POSITION_SIZE_USD,
    maxPositions: MAX_POSITIONS,
    positions: [], // {token, symbol, wallet, entryPrice, entryTime, entryTx, sizeUsd}
    closedTrades: [], // {…entry, exitPrice, exitTime, exitReason, pnlUsd, pnlPct}
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: null, // null until >=1 closed trade; always shown with totalTrades
      totalPnlUsd: 0,
      bestTradeUsd: null,
      worstTradeUsd: null,
    },
    updatedAt: new Date().toISOString(),
  };
}

function recomputeStats(s) {
  const n = s.closedTrades.length;
  const wins = s.closedTrades.filter((t) => t.pnlUsd > 0).length;
  s.stats.totalTrades = n;
  s.stats.wins = wins;
  s.stats.losses = n - wins;
  s.stats.winRate = n > 0 ? wins / n : null;
  s.stats.totalPnlUsd = s.closedTrades.reduce((a, t) => a + t.pnlUsd, 0);
  s.balance = STARTING_BALANCE + s.stats.totalPnlUsd;
  if (n > 0) {
    s.stats.bestTradeUsd = Math.max(...s.closedTrades.map((t) => t.pnlUsd));
    s.stats.worstTradeUsd = Math.min(...s.closedTrades.map((t) => t.pnlUsd));
  }
}

/**
 * buys:  fresh buy signals [{wallet, token, symbol, txHash, timestamp}]
 * sells: detected sells by watched wallets [{wallet, token, price}] (price may be null)
 * getPrice: async (tokenAddress) => current USD price or null
 * Returns the paper summary for embedding in the API state.
 */
async function updatePaper({ buys, sells, getPrice }) {
  const s = load() || init();
  const now = Date.now();

  // --- Entries: copy top-10 wallet buys at $50 paper ---
  for (const b of buys || []) {
    if (s.positions.length >= MAX_POSITIONS) break;
    if (s.positions.some((p) => p.token.toLowerCase() === b.token.toLowerCase())) continue;
    const price = await getPrice(b.token);
    if (!price || price <= 0) continue;
    s.positions.push({
      token: b.token,
      symbol: b.symbol,
      wallet: b.wallet,
      entryPrice: price,
      entryTime: new Date().toISOString(),
      entryTx: b.txHash,
      sizeUsd: POSITION_SIZE_USD,
    });
  }

  // --- Exits: wallet sold, or 24h elapsed ---
  const remaining = [];
  for (const p of s.positions) {
    const sell = (sells || []).find(
      (x) => x.wallet.toLowerCase() === p.wallet.toLowerCase() && x.token.toLowerCase() === p.token.toLowerCase()
    );
    let exitPrice = null;
    let reason = null;
    if (sell) {
      exitPrice = sell.price && sell.price > 0 ? sell.price : await getPrice(p.token);
      reason = "wallet_sold";
    } else if (now - new Date(p.entryTime).getTime() >= HOLD_MS) {
      exitPrice = await getPrice(p.token);
      reason = "expired_24h";
    }
    if (exitPrice && exitPrice > 0 && reason) {
      const pnlPct = (exitPrice - p.entryPrice) / p.entryPrice;
      const pnlUsd = pnlPct * p.sizeUsd;
      s.closedTrades.push({
        ...p,
        exitPrice,
        exitTime: new Date().toISOString(),
        exitReason: reason,
        pnlUsd: Math.round(pnlUsd * 100) / 100,
        pnlPct: Math.round(pnlPct * 10000) / 100, // percent
      });
    } else {
      remaining.push(p);
    }
  }
  s.positions = remaining;

  recomputeStats(s);
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(PAPER_PATH, JSON.stringify(s, null, 1));

  const st = s.stats;
  return {
    label: "PAPER ONLY — simulated copy-trading, no real money",
    startingBalance: STARTING_BALANCE,
    balance: Math.round(s.balance * 100) / 100,
    positionSizeUsd: POSITION_SIZE_USD,
    openPositions: s.positions.length,
    totalTrades: st.totalTrades,
    wins: st.wins,
    losses: st.losses,
    winRate: st.winRate, // null until first closed trade; always paired with totalTrades
    totalPnlUsd: Math.round(st.totalPnlUsd * 100) / 100,
    bestTradeUsd: st.bestTradeUsd,
    worstTradeUsd: st.worstTradeUsd,
    updatedAt: s.updatedAt,
  };
}

module.exports = { updatePaper, PAPER_PATH };
