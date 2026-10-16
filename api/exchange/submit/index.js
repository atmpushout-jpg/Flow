// POST /api/exchange/submit — the assigned solver submits proof for a
// DONE solve. Body: { id, proof: [{kind, ref, observed?}] } — evidence
// refs anyone can look up; prose is not proof.
const px = require("../../_exchange");

const PROOF_KINDS = ["tx", "receipt", "page", "repo"];

module.exports = async (req, res) => {
  if (!(await px.actionPrelude(req, res))) return;
  const b = req.body || {};
  const id = String(b.id || "").toUpperCase();
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id PX-0001" });
  if (!Array.isArray(b.proof) || !b.proof.length) {
    return res.status(400).json({ error: "proof must be a non-empty array of evidence refs", code: "PROOF_MISSING" });
  }
  for (const p of b.proof) {
    if (!p || !PROOF_KINDS.includes(p.kind) || !p.ref) {
      return res.status(400).json({ error: `each proof ref needs kind (${PROOF_KINDS.join("|")}) and ref` });
    }
  }
  try {
    const state = await px.loadStateForWrite();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id}`, code: "NO_LISTING" });
    if (listing.status !== "ASSIGNED") {
      return res.status(409).json({ error: `Listing is ${listing.status} — only ASSIGNED listings take proof`, code: "NOT_ASSIGNED" });
    }
    listing.solution = {
      solver: listing.assignment.solver,
      proof: b.proof,
      submitted_at: new Date().toISOString(),
    };
    listing.reasons = (listing.reasons || []).filter((r) => r.code !== "PROOF_MISSING");
    listing.status = "PROOF_SUBMITTED";
    px.applyEvent(listing, "PROOF_SUBMITTED", { refs: b.proof.length });
    px.recordEvent(state, "PROOF_SUBMITTED", id, { solver: listing.assignment.solver.id, refs: b.proof.length });
    await px.saveState(state);
    return res.status(200).json({ ok: true, listing });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
