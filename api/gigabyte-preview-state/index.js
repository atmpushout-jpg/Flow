// GET /api/gigabyte-preview-state — the PRIVATE GIGABYTE preview loop's
// show state, relayed from the house VM by offchain/gigabyte-preview and
// stored in Upstash under gbp:state. Polled by /gigabyte-preview.html and
// its stage iframe. Separate namespace from the production show.
const gb = require("../_gigabyte_preview");

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
      return res.status(503).json({ error: "no preview state yet — the preview loop has not checked in" });
    }
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(raw);
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
