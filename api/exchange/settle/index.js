// POST /api/exchange/settle — mark a GRADED_PASS listing SETTLED with
// the payer→solver settlement evidence. The settlement evidence rule
// is enforced here, in code: SETTLED requires a kind:"tx" evidence
// ref (a Base transaction hash). No ref, no settled claim — the same
// rule as the rest of Flow. Flow never touches the funds; this only
// records a payment that travelled the existing x402 rail directly
// from payer to solver.
// Body: { id, tx: "0x<64 hex>", block?: number }
const px = require("../../_exchange");

module.exports = async (req, res) => {
  if (!(await px.actionPrelude(req, res))) return;
  const b = req.body || {};
  const id = String(b.id || "").toUpperCase();
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id PX-0001" });
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(b.tx || ""))) {
    return res.status(400).json({
      error: "SETTLED requires a settlement tx ref (0x + 64 hex) — no ref, no settled claim",
      code: "SETTLEMENT_EVIDENCE_REQUIRED",
    });
  }
  try {
    const state = await px.loadStateForWrite();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id}`, code: "NO_LISTING" });
    if (listing.status !== "GRADED_PASS") {
      return res.status(409).json({ error: `Listing is ${listing.status} — only GRADED_PASS listings can settle`, code: "NOT_GRADED_PASS" });
    }
    listing.verdict = listing.verdict || {};
    listing.verdict.evidence = [
      ...(listing.verdict.evidence || []),
      { kind: "tx", ref: String(b.tx), block: Number.isFinite(b.block) ? b.block : undefined },
    ];
    listing.status = "SETTLED";
    px.applyEvent(listing, "SETTLED", { tx: String(b.tx) });
    px.recordEvent(state, "SETTLED", id, { tx: String(b.tx) });
    await px.saveState(state);
    return res.status(200).json({ ok: true, listing });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
