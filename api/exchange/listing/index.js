// GET /api/exchange/listing?id=PX-0001 — one listing, full record
// (bids, solution, verdict, and the history the history_root commits to).
const px = require("../../_exchange");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("Cache-Control", "no-store");
  const u = new URL(req.url, "https://flow-kg4x.vercel.app");
  const id = (u.searchParams.get("id") || "").toUpperCase();
  if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide ?id=PX-0001" });
  try {
    const { state } = await px.loadState();
    const listing = px.findListing(state, id);
    if (!listing) return res.status(404).json({ error: `No listing ${id} on the board`, code: "NO_LISTING" });
    res.setHeader("Link", '<https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json>; rel="describedby"; type="application/schema+json"');
    return res.status(200).json(listing);
  } catch (e) {
    return res.status(503).json({ error: `exchange state unavailable: ${e.message}` });
  }
};
