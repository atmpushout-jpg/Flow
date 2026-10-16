// POST /api/exchange/bid — record a solver bid on a listing
// (operator-curated in v1; decision #4: house agents solve first).
// Body: { id, bidder: {id, passport?}, amount_usd, ref? }
// WATCH listings are not biddable through the exchange (funding
// unconfirmed) — the endpoint refuses them, in code, not just copy.
const px = require("../../_exchange");

module.exports = async (req, res) => {
  if (!(await px.actionPrelude(req, res))) return;
  const b = req.body || {};
  const id = String(b.id || "").toUpperCase();
  const bidder = b.bidder || {};
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id PX-0001" });
  if (!bidder.id || typeof bidder.id !== "string") return res.status(400).json({ error: "bidder.id is required" });
  // amount_usd is the solver's ask. Zero is allowed and means what it
  // says — a house solve with no solve price (the only money in a
  // house loop is the $0.02 verdict toll); say so in `note` when used.
  if (!(typeof b.amount_usd === "number" && b.amount_usd >= 0)) {
    return res.status(400).json({ error: "amount_usd must be a number >= 0" });
  }
  try {
    const state = await px.loadStateForWrite();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id}`, code: "NO_LISTING" });
    if (listing.status === "WATCH") {
      return res.status(409).json({ error: "WATCH listings are not biddable until funding confirms", code: "WATCH_NOT_BIDDABLE" });
    }
    if (!["OPEN", "BIDDING"].includes(listing.status)) {
      return res.status(409).json({ error: `Listing is ${listing.status} — bids are closed`, code: "BIDS_CLOSED" });
    }
    const bid = {
      bidder: { id: bidder.id, passport: bidder.passport || null },
      amount_usd: b.amount_usd,
      at: new Date().toISOString(),
      ref: b.ref || null,
      note: b.note || null,
    };
    listing.bids = Array.isArray(listing.bids) ? listing.bids : [];
    listing.bids.push(bid);
    listing.status = "BIDDING";
    px.applyEvent(listing, "BID_RECORDED", { bidder: bidder.id, amount_usd: bid.amount_usd });
    px.recordEvent(state, "BID_RECORDED", id, { bidder: bidder.id, amount_usd: bid.amount_usd });
    await px.saveState(state);
    return res.status(200).json({ ok: true, listing });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
