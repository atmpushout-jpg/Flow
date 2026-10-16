// GET /api/exchange/solver?id=<solver> — the solver's Problem Exchange
// passport record. A record is created at a solver's first assignment
// (a state fact, all counts zero); solved / failed / graded counts
// move ONLY on real verdict-engine grades — an assignment alone earns
// nothing, and a solver with no assignment has no record at all: 404,
// never a fabricated card — the same spirit as /api/passport.
const px = require("../../_exchange");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("Cache-Control", "no-store");
  const u = new URL(req.url, "https://flow-kg4x.vercel.app");
  const id = (u.searchParams.get("id") || "").trim();
  try {
    const { state } = await px.loadState();
    const solvers = state.solvers || {};
    if (!id) {
      return res.status(200).json({
        service: "flow-problem-exchange-solvers",
        solvers: Object.keys(solvers).sort(),
        read: "GET /api/exchange/solver?id=<solver>",
      });
    }
    const rec = solvers[id];
    if (!rec) {
      return res.status(404).json({
        error: `No exchange record for solver "${id}" — records are minted only from graded DONE outcomes.`,
        code: "NO_SOLVER_RECORD",
      });
    }
    res.setHeader("Link", '<https://flow-kg4x.vercel.app/schemas/exchange-solver-record-0.1.json>; rel="describedby"; type="application/schema+json"');
    return res.status(200).json({ schema: "exchange-solver-record/0.1", ...rec });
  } catch (e) {
    return res.status(503).json({ error: `exchange state unavailable: ${e.message}` });
  }
};
