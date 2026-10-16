// POST /api/exchange/assign — operator accepts a bid and assigns the
// solver (v1 has no auction engine; acceptance is curated by the
// operator, per spec §3 step 4). Body: { id, bidder_id } — a bid from
// that bidder must already be recorded on the listing.
const px = require("../../_exchange");

module.exports = async (req, res) => {
  if (!(await px.actionPrelude(req, res))) return;
  const b = req.body || {};
  const id = String(b.id || "").toUpperCase();
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id PX-0001" });
  if (!b.bidder_id) return res.status(400).json({ error: "bidder_id is required" });
  try {
    const state = await px.loadStateForWrite();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id}`, code: "NO_LISTING" });
    if (listing.status !== "BIDDING") {
      return res.status(409).json({ error: `Listing is ${listing.status} — only BIDDING listings can be assigned`, code: "NOT_BIDDING" });
    }
    const bid = (listing.bids || []).find((x) => x.bidder && x.bidder.id === b.bidder_id);
    if (!bid) return res.status(404).json({ error: `No recorded bid from ${b.bidder_id} on ${id}`, code: "NO_SUCH_BID" });
    listing.assignment = {
      solver: { id: bid.bidder.id, passport: bid.bidder.passport || null },
      amount_usd: bid.amount_usd,
      at: new Date().toISOString(),
      via: "operator-accept",
    };
    listing.status = "ASSIGNED";
    px.applyEvent(listing, "BID_ACCEPTED", { solver: bid.bidder.id, amount_usd: bid.amount_usd });
    px.recordEvent(state, "BID_ACCEPTED", id, { solver: bid.bidder.id, amount_usd: bid.amount_usd });
    px.solverRecord(state, bid.bidder.id);
    await px.saveState(state);
    return res.status(200).json({ ok: true, listing });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
