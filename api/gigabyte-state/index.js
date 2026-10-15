// GET /api/gigabyte-state — the current GIGABYTE live-room show state,
// relayed from the house VM by offchain/gigabyte-live/push-relay.js and
// stored in Upstash under gigabyte:state. Polled by /gigabyte.html.
const gb = require("../_gigabyte");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  res.setHeader("Cache-Control", "no-store");
  if (!gb.storeConfigured()) {
    return res.status(503).json({ error: "relay store not configured" });
  }
  try {
    const raw = await gb.store.get(gb.KEY_STATE);
    if (!raw) {
      return res.status(503).json({ error: "no show state yet — the room has not checked in" });
    }
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(raw);
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
