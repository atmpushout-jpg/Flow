// POST /api/exchange/grade — record the verdict engine's grade on a
// PROOF_SUBMITTED listing. The grade itself is produced by the
// EXISTING POST /api/verify ($0.02 — the DONE toll, decision #5); the
// operator runs that call on the real x402 rail and submits its
// five-field mapping here. This endpoint validates the verdict shape,
// writes it to the listing, and writes the outcome back to the
// solver's exchange passport record (pass = solved credit, fail = a
// failure mark — reputation is the collateral).
// Body: { id, verdict: {verdict, reasons, evidence, checked_at,
//         rules_version, checker, engine?} }
const px = require("../../_exchange");

module.exports = async (req, res) => {
  if (!(await px.actionPrelude(req, res))) return;
  const b = req.body || {};
  const id = String(b.id || "").toUpperCase();
  const v = b.verdict || {};
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id PX-0001" });
  if (!["ALLOW", "WARN", "BLOCK"].includes(v.verdict)) {
    return res.status(400).json({ error: "verdict.verdict must be ALLOW | WARN | BLOCK" });
  }
  if (!Array.isArray(v.reasons) || !v.reasons.length) {
    return res.status(400).json({ error: "verdict.reasons must be a non-empty array of {code, severity}" });
  }
  for (const r of v.reasons) {
    if (!r || !/^[A-Z0-9_]+$/.test(r.code || "") || !r.severity) {
      return res.status(400).json({ error: "each reason needs an UPPER_SNAKE code and a severity" });
    }
  }
  if (!Array.isArray(v.evidence) || !v.checked_at || !v.rules_version || !v.checker || !v.checker.id) {
    return res.status(400).json({ error: "verdict needs evidence[], checked_at, rules_version, checker.id (five-field shape)" });
  }
  try {
    const state = await px.loadStateForWrite();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id}`, code: "NO_LISTING" });
    if (listing.status !== "PROOF_SUBMITTED") {
      return res.status(409).json({ error: `Listing is ${listing.status} — only PROOF_SUBMITTED listings can be graded`, code: "NOT_SUBMITTED" });
    }
    listing.verdict = v;
    const solverId = listing.solution && listing.solution.solver && listing.solution.solver.id;
    const rec = solverId ? px.solverRecord(state, solverId) : null;
    if (v.verdict === "ALLOW") listing.status = "GRADED_PASS";
    else if (v.verdict === "BLOCK") listing.status = "GRADED_FAIL";
    // WARN: the verdict is recorded but the listing stays
    // PROOF_SUBMITTED — the operator re-grades with new evidence
    // (v1's only dispute path, per spec §3).
    px.applyEvent(listing, "GRADED", { verdict: v.verdict, status: listing.status });
    px.recordEvent(state, "GRADED", id, { verdict: v.verdict, solver: solverId });
    if (rec && v.verdict !== "WARN") {
      rec.graded += 1;
      if (v.verdict === "ALLOW") rec.solved += 1; else rec.failed += 1;
      rec.events.push({ type: v.verdict === "ALLOW" ? "SOLVED" : "FAILED", listing: id, at: new Date().toISOString() });
    }
    await px.saveState(state);
    return res.status(200).json({ ok: true, listing });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
