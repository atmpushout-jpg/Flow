/**
 * GENERATE api/_records-data.json — the frozen record set behind
 * GET /api/arena/results and the fighter passports (offchain/
 * mint-passport.js). One generator, one data file, two consumers:
 * the results feed and the passports can never disagree because both
 * fold THESE rows through api/_records.js.
 *
 * Sources (repo records only — nothing is estimated):
 *   COUNTED (OFFICIAL class):
 *     - offchain/arena-standings-history.json "frozen" matches with
 *       klass OFFICIAL (arena-match-1..3), per-seat results as frozen
 *       by offchain/arena-standings.js.
 *     - offchain/arena-live-report.json — the newest counted match
 *       (arena-match-4) that the frozen standings predate: seats join
 *       its leaderboard (rank) with its receipts.perAgent (payout,
 *       dataSpend, trades, realizedPnl). If the frozen history ever
 *       absorbs that match id, the frozen rows win and this source
 *       is skipped for it.
 *   EXHIBITION class (never counted, kept in a separate list):
 *     - frozen matches with klass EXHIBITION (arena-test-1)
 *     - offchain/floor/exhibition/*.standings-record.json
 *
 * Run: node offchain/generate-records-data.js
 * Re-run after any new counted match freezes into the records; the
 * passports must then be re-minted (node offchain/mint-passport.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "api", "_records-data.json");

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function seatRow(r) {
  return {
    fighterId: String(r.agentId || r.name || "").toLowerCase(),
    name: r.name,
    rank: r.rank,
    payout: round2(r.payout),
    dataSpend: round2(r.dataSpend),
    trades: r.trades || 0,
    pnl: round2(r.pnl !== undefined ? r.pnl : r.realizedPnl),
  };
}

function main() {
  const history = JSON.parse(fs.readFileSync(path.join(__dirname, "arena-standings-history.json"), "utf8"));
  const counted = [];
  const exhibitions = [];
  const seenExhibition = new Set();

  for (const m of Object.values(history.frozen || {})) {
    const seats = (m.results || []).map(seatRow);
    if (m.klass === "OFFICIAL") {
      counted.push({ matchId: m.matchId, klass: m.klass, source: "offchain/arena-standings-history.json", seats });
    } else {
      exhibitions.push({ matchId: m.matchId, klass: m.klass || "EXHIBITION", source: "offchain/arena-standings-history.json", seats });
      seenExhibition.add(m.matchId);
    }
  }

  // The newest counted match, from its live report (the same fold
  // api/_build.js performs for the dashboard record).
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, "arena-live-report.json"), "utf8"));
  const liveMatchId = live.match || live.matchId;
  if (liveMatchId && !counted.some((m) => m.matchId === liveMatchId)) {
    const perAgent = new Map((live.receipts.perAgent || []).map((p) => [String(p.agent).toLowerCase(), p]));
    const seats = (live.leaderboard || []).map((row) => {
      const p = perAgent.get(String(row.agentId || row.name).toLowerCase()) || {};
      return seatRow({
        agentId: row.agentId,
        name: row.name,
        rank: row.rank,
        payout: p.payout || 0,
        dataSpend: p.dataSpend !== undefined ? p.dataSpend : row.dataSpend,
        trades: p.trades || 0,
        pnl: p.realizedPnl,
      });
    });
    counted.push({ matchId: liveMatchId, klass: "OFFICIAL", source: "offchain/arena-live-report.json", seats });
  }

  const exhDir = path.join(__dirname, "floor", "exhibition");
  for (const f of fs.readdirSync(exhDir).filter((x) => x.endsWith(".standings-record.json")).sort()) {
    const rec = JSON.parse(fs.readFileSync(path.join(exhDir, f), "utf8"));
    if (!rec.matchId || seenExhibition.has(rec.matchId)) continue;
    seenExhibition.add(rec.matchId);
    exhibitions.push({
      matchId: rec.matchId,
      klass: rec.class || "EXHIBITION",
      source: `offchain/floor/exhibition/${f}`,
      seats: (rec.results || []).map(seatRow),
    });
  }

  counted.sort((a, b) => a.matchId.localeCompare(b.matchId, undefined, { numeric: true }));
  exhibitions.sort((a, b) => a.matchId.localeCompare(b.matchId));

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    countedMatches: counted,
    exhibitionEvents: exhibitions,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(
    `wrote ${path.relative(ROOT, OUT)}: ${counted.length} counted matches (${counted.reduce((s, m) => s + m.seats.length, 0)} seats), ${exhibitions.length} exhibition events (${exhibitions.reduce((s, m) => s + m.seats.length, 0)} seats)`
  );
}

if (require.main === module) main();

module.exports = { main };
