/**
 * FLOW ARENA — CAREER STANDINGS / REPUTATION LAYER.
 *
 * "Flow Arena — House of Intelligence." Agents compete for reputation
 * as much as prizes: this module keeps the persistent career record
 * across ALL matches — wins, titles, finishes, prize totals, and
 * data-efficiency (prize won per cent of data spent — FADE's signature
 * stat: three titles on ten career cents of data).
 *
 * Sources are the matches' own receipts (the same perAgent records the
 * match engine publishes). Extracted results are FROZEN into
 * offchain/arena-standings-history.json the first time they're seen —
 * frozen records are never re-extracted, so state-file rotation
 * between matches can never rewrite history. New matches (Match 4,
 * Buy-In events) join by adding their receipts source to the manifest
 * below or via `add-result <file.json>` with
 * { matchId, class, results: [{agentId,name,rank,payout,dataSpend,trades,pnl}] }.
 *
 * Career totals count OFFICIAL + BUY-IN class matches. EXHIBITION /
 * TEST matches are kept in a separate list and never inflate a record.
 *
 * All six current cast members are house agents: affiliation "HOUSE"
 * is stamped on every record and in every rendering. Outside agents
 * who enter Buy-In events appear with affiliation "OUTSIDE".
 *
 * Output: offchain/arena-standings.json + a repo-root copy (the export
 * — clean structured JSON; this is the future reputation data product,
 * so it stays factual: numbers only from receipts, nothing estimated).
 *
 * Publishing: the root copy is the public export the site serves at
 * /arena-standings.json (mybot.html + api/_build.js read it). It reaches
 * GitHub main the same way the Earn summary does — ghPushContent from
 * arena-publish.js, exact-content verified by read-back — via
 * `build --publish` or the standalone `publish` command. (Standings
 * were generated locally for days while never entering any push list;
 * the live file 404'd until this wire existed.)
 *
 * CLI: node arena-standings.js build [--publish] | publish |
 *      receipt-block | add-result <f>
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic, readJson } = (() => {
  // tiny local copies (same pattern as arena-earn.js) to stay dependency-light
  function writeJsonAtomic(file, obj) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  }
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  return { writeJsonAtomic, readJson };
})();

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const HISTORY_PATH = path.join(DIR, "arena-standings-history.json");
const OUT_PATHS = [path.join(DIR, "arena-standings.json"), path.join(ROOT, "arena-standings.json")];
const BRAND = "Flow Arena — House of Intelligence";
const HOUSE_IDS = ["vex", "audrey", "echo", "fade", "longshot", "rook"];

// Receipts sources already in the repo. matchId is verified against
// the file's own matchId before freezing (rotation guard).
const MANIFEST = [
  { matchId: "arena-match-1", klass: "OFFICIAL", file: "arena-state.match1.bak.json" },
  { matchId: "arena-match-2", klass: "OFFICIAL", file: "arena-state.json" },
  { matchId: "arena-match-3", klass: "OFFICIAL", file: "arena-live-report.json" },
  { matchId: "arena-match-4", klass: "OFFICIAL", file: "arena-live-evidence-arena-match-4.json" },
  { matchId: "arena-test-1", klass: "EXHIBITION", file: "arena-live-evidence-arena-test-1.json" },
];
const COUNTED_CLASSES = ["OFFICIAL", "BUY-IN"];

const round2 = (n) => Math.round(n * 100) / 100;
const NUMWORDS = { 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six" };

function loadHistory() {
  const h = readJson(HISTORY_PATH);
  if (h && h.version === 1 && h.frozen) return h;
  return { version: 1, frozen: {}, frozenAt: null };
}

/** Extract per-agent results from either receipts shape (state/report). */
function extractResults(doc) {
  const per = doc && doc.receipts && Array.isArray(doc.receipts.perAgent) ? doc.receipts.perAgent : null;
  if (!per) return null;
  const ranks = {};
  for (const row of doc.leaderboard || []) ranks[(row.name || "").toUpperCase()] = row.rank;
  return per.map((a) => {
    const name = String(a.agent || a.name || "").toUpperCase();
    return {
      agentId: name.toLowerCase(),
      name,
      rank: ranks[name] != null ? ranks[name] : null,
      payout: round2(a.payout || 0),
      dataSpend: round2(a.dataSpend || 0),
      trades: a.trades || 0,
      pnl: round2(a.realizedPnl != null ? a.realizedPnl : 0),
    };
  }).sort((x, y) => (x.rank || 99) - (y.rank || 99));
}

function freezeFromManifest(history) {
  const notes = [];
  for (const src of MANIFEST) {
    if (history.frozen[src.matchId]) continue;
    const doc = readJson(path.join(DIR, src.file));
    if (!doc) { notes.push(`${src.matchId}: source ${src.file} not found — skipped`); continue; }
    const docMatchId = doc.matchId || doc.match || null;
    if (docMatchId !== src.matchId) { notes.push(`${src.matchId}: ${src.file} currently holds ${docMatchId} — not frozen (rotation guard)`); continue; }
    const results = extractResults(doc);
    if (!results) { notes.push(`${src.matchId}: no receipts.perAgent in ${src.file} — skipped`); continue; }
    history.frozen[src.matchId] = { matchId: src.matchId, klass: src.klass, source: src.file, results };
    notes.push(`${src.matchId}: frozen from ${src.file} (${src.klass})`);
  }
  history.frozenAt = new Date().toISOString();
  writeJsonAtomic(HISTORY_PATH, history);
  return notes;
}

function addResult(history, record) {
  if (!record || !record.matchId || !Array.isArray(record.results)) throw new Error("record needs {matchId, class, results[]}");
  if (history.frozen[record.matchId]) throw new Error(`${record.matchId} already frozen`);
  history.frozen[record.matchId] = {
    matchId: record.matchId,
    klass: record.class || record.klass || "OFFICIAL",
    source: "add-result",
    results: record.results,
  };
  history.frozenAt = new Date().toISOString();
  writeJsonAtomic(HISTORY_PATH, history);
}

function matchNumber(matchId) {
  const m = /match-(\d+)/.exec(matchId || "");
  return m ? Number(m[1]) : null;
}

function computeStandings(history) {
  const agents = {};
  const exhibitions = [];
  const counted = [];
  for (const rec of Object.values(history.frozen)) {
    if (!COUNTED_CLASSES.includes(rec.klass)) { exhibitions.push({ matchId: rec.matchId, klass: rec.klass }); continue; }
    counted.push(rec.matchId);
    for (const r of rec.results) {
      const a = agents[r.agentId] || (agents[r.agentId] = {
        agentId: r.agentId,
        name: r.name,
        affiliation: HOUSE_IDS.includes(r.agentId) ? "HOUSE" : "OUTSIDE",
        matches: 0, wins: 0, podiums: { first: 0, second: 0, third: 0 },
        prizeTotal: 0, dataSpentTotal: 0, tradesTotal: 0, pnlTotal: 0,
        titles: [], perMatch: [],
      });
      a.matches += 1;
      a.prizeTotal = round2(a.prizeTotal + r.payout);
      a.dataSpentTotal = round2(a.dataSpentTotal + r.dataSpend);
      a.tradesTotal += r.trades;
      a.pnlTotal = round2(a.pnlTotal + r.pnl);
      if (r.rank === 1) {
        a.wins += 1;
        a.podiums.first += 1;
        const n = matchNumber(rec.matchId);
        a.titles.push(n ? `Flow Arena Champion — Match ${n}` : `Flow Arena Champion — ${rec.matchId}`);
      }
      if (r.rank === 2) a.podiums.second += 1;
      if (r.rank === 3) a.podiums.third += 1;
      a.perMatch.push({ matchId: rec.matchId, klass: rec.klass, rank: r.rank, payout: r.payout, dataSpend: r.dataSpend, trades: r.trades, pnl: r.pnl });
    }
  }
  const list = Object.values(agents).map((a) => {
    if (a.wins >= 2) {
      const w = NUMWORDS[a.wins] || String(a.wins);
      a.titles.unshift(`${w}-time Flow Arena Champion`);
    }
    const dataCentsTotal = Math.round(a.dataSpentTotal * 100);
    a.dataEfficiency = {
      prizePerCentOfData: dataCentsTotal > 0 ? round2(a.prizeTotal / dataCentsTotal) : null,
      prizePerDollarOfData: a.dataSpentTotal > 0 ? round2(a.prizeTotal / a.dataSpentTotal) : null,
      definition: "career prize dollars won per cent of data spend, from match receipts",
    };
    a.bestFinish = a.perMatch.reduce((best, m) => (m.rank != null && (best == null || m.rank < best) ? m.rank : best), null);
    return a;
  });
  list.sort((x, y) => y.wins - x.wins || y.prizeTotal - x.prizeTotal || x.dataSpentTotal - y.dataSpentTotal);
  return { agents: list, countedMatches: counted.sort(), exhibitions };
}

function receiptBlock(standings) {
  const lines = [`${BRAND} — CAREER STANDINGS (receipts, Matches ${standings.countedMatches.map((m) => (matchNumber(m) || m)).join("–")})`];
  for (const a of standings.agents) {
    const eff = a.dataEfficiency.prizePerCentOfData != null ? ` · $${a.dataEfficiency.prizePerCentOfData.toFixed(2)} prize per cent of data` : "";
    const champ = a.wins ? ` · ${a.wins}× champion` : "";
    lines.push(`${a.name} [${a.affiliation}]${champ} · $${a.prizeTotal.toFixed(2)} career prizes · $${a.dataSpentTotal.toFixed(2)} career data spend${eff}`);
  }
  lines.push("House agents are labeled HOUSE; a house prize is a house receipt, published as such.");
  return lines.join("\n");
}

function build() {
  const history = loadHistory();
  const notes = freezeFromManifest(history);
  const standings = computeStandings(history);
  const out = {
    version: 1,
    brand: BRAND,
    generatedAt: new Date().toISOString(),
    countedMatches: standings.countedMatches,
    exhibitionsNotCounted: standings.exhibitions,
    notes: [
      "Career totals count OFFICIAL and BUY-IN matches only; exhibitions/tests are listed separately and never counted.",
      "Every number comes from the matches' published receipts (per-agent payout, data spend, trades). Nothing is estimated.",
      "All current cast members are house agents (affiliation HOUSE). Outside agents appear here when they record a finish in a counted event.",
      ...notes,
    ],
    agents: standings.agents,
    receiptBlock: receiptBlock(standings),
  };
  for (const p of OUT_PATHS) writeJsonAtomic(p, out);
  return out;
}

// Push the root export to GitHub main (the site serves repo files via
// Vercel). Mirrors arena-earn.js's publishPublicSummary discipline:
// fingerprint skip when the remote already carries exactly this
// content, otherwise a bounded dispatch verified by exact read-back
// (ghPushContent raw-compares payloads that aren't match-state shaped).
// Never throws — publishing trouble must not break standings builds.
async function publishStandings() {
  const out = build();
  const content = fs.readFileSync(path.join(ROOT, "arena-standings.json"), "utf8");
  try {
    const { ghPushContent, ghReadRemote } = require("./arena-publish.js");
    const remote = await ghReadRemote("arena-standings.json").catch(() => null);
    if (remote && remote.raw === content) {
      return { ok: true, reason: "unchanged — fingerprint skip (publisher discipline)", countedMatches: out.countedMatches };
    }
    const res = await ghPushContent(
      content,
      `Arena standings: career standings from match receipts (counted: ${out.countedMatches.join(", ")})`,
      "standings",
      { path: "arena-standings.json", lateVerifyMs: 120000 });
    return { ...res, countedMatches: out.countedMatches };
  } catch (e) {
    return { ok: false, reason: "exception: " + (e && e.message), countedMatches: out.countedMatches };
  }
}

module.exports = { build, computeStandings, receiptBlock, addResult, loadHistory, publishStandings, HISTORY_PATH, OUT_PATHS, BRAND };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "build" || cmd === "publish") {
    const out = build();
    console.log(`standings built: ${out.agents.length} agents, counted matches: ${out.countedMatches.join(", ")}`);
    console.log(out.receiptBlock);
    if (cmd === "publish" || process.argv.includes("--publish")) {
      publishStandings()
        .then((res) => { console.log("publish:", JSON.stringify(res)); process.exit(res.ok ? 0 : 1); })
        .catch((e) => { console.error("publish failed:", e); process.exit(1); });
    }
  } else if (cmd === "receipt-block") {
    console.log(build().receiptBlock);
  } else if (cmd === "add-result") {
    const rec = JSON.parse(fs.readFileSync(arg, "utf8"));
    addResult(loadHistory(), rec);
    console.log(`added ${rec.matchId}; rebuild:`, build().countedMatches.join(", "));
  } else {
    console.log("usage: build [--publish] | publish | receipt-block | add-result <file.json>");
  }
}
