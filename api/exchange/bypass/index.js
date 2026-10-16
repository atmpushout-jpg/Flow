// /api/exchange/bypass?id=PX-0001 — the BYPASS door: a verified
// workaround sold as data behind the existing x402 gate (api/_x402.js,
// same rail as /api/quote, /api/fill, /api/verify). The price is the
// listing's own bypass_offer.price_usd; the payload is delivered from
// exchange state only after the gate passes. A hold on a build key
// (FLOW_BUILDER_KEY) passes free, per the enrolled/builder pattern.
//
// GET or POST both work; the id rides the query string either way.
const px = require("../../_exchange");
const { requirePayment } = require("../../_x402");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT"
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  const u = new URL(req.url, "https://flow-kg4x.vercel.app");
  const id = (u.searchParams.get("id") || (req.body && req.body.id) || "").toUpperCase();
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide ?id=PX-0001" });
  try {
    const { state } = await px.loadState();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id} on the board`, code: "NO_LISTING" });
    if (!listing.bypass_offer || !listing.bypass_offer.payload) {
      return res.status(404).json({ error: `${id} carries no bypass offer`, code: "NO_BYPASS_OFFER" });
    }
    const price = listing.bypass_offer.price_usd;
    if (!(typeof price === "number" && price > 0)) {
      return res.status(500).json({ error: "bypass_offer.price_usd is not set on this listing" });
    }
    const paid = await requirePayment(req, res, {
      priceUsd: price,
      path: "/api/exchange/bypass",
      description: `Problem Exchange BYPASS payload for ${id}: ${listing.bypass_offer.summary || listing.problem.title}`,
    });
    if (!paid) return; // 402 (or 400) already sent by the gate
    return res.status(200).json({
      service: "flow-problem-exchange-bypass",
      listing: id,
      title: listing.problem.title,
      summary: listing.bypass_offer.summary || null,
      payload: listing.bypass_offer.payload,
      evidence: listing.bypass_offer.evidence || [],
      note: "BYPASS = the workaround as data. It does not close the listing; the DONE door stays open for a full solve.",
    });
  } catch (e) {
    return res.status(503).json({ error: `exchange bypass unavailable: ${e.message}` });
  }
};
