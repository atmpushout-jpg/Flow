// GET /api/exchange/listings — the Problem Exchange board as data.
// Free read (the wire starts free; paid wire is a later version).
// Optional filters: ?status=OPEN|WATCH|... ?door=DONE|BYPASS|ROUTE
// The response carries the board's honesty fields verbatim: funding
// states, reason codes, and the standing baseline — outside settled
// volume is whatever the listings themselves prove, never asserted.
const px = require("../../_exchange");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("Cache-Control", "no-store");
  try {
    const { state, source } = await px.loadState();
    const u = new URL(req.url, "https://flow-kg4x.vercel.app");
    const status = u.searchParams.get("status");
    const door = u.searchParams.get("door");
    let listings = state.listings || [];
    if (status) listings = listings.filter((l) => l.status === status.toUpperCase());
    if (door) listings = listings.filter((l) => (l.doors || []).includes(door.toUpperCase()));
    return res.status(200).json({
      service: "flow-problem-exchange",
      schema: "problem-listing/0.1",
      schema_url: "https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json",
      solver_schema_url: "https://flow-kg4x.vercel.app/schemas/exchange-solver-record-0.1.json",
      name: state.name || "Problem Exchange",
      state_source: source,
      updated_at: state.updated_at,
      listing_fee_usd: state.listing_fee_usd,
      listing_fee_note: state.listing_fee_note,
      done_toll: state.done_toll,
      counts: {
        total: (state.listings || []).length,
        shown: listings.length,
        open: (state.listings || []).filter((l) => l.status === "OPEN").length,
        watch: (state.listings || []).filter((l) => l.status === "WATCH").length,
        settled: (state.listings || []).filter((l) => l.status === "SETTLED").length,
      },
      listings,
      events: (state.events || []).slice(-50),
      read: "GET /api/exchange/listing?id=PX-0001 — one listing with its full history. GET /api/exchange/solver?id=<solver> — a solver's exchange passport record.",
    });
  } catch (e) {
    return res.status(503).json({ error: `exchange state unavailable: ${e.message}` });
  }
};
