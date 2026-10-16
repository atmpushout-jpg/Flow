// GET /api/gigabyte-preview-viseme?id=<lineId> — one preview line's
// Rhubarb mouth-cue track ({mouthCues:[{start,end,value}]}), generated on
// the house VM from the line's real TTS audio and stored under
// gbp:viseme:<id>. The stage asks here first; a 404 simply drops it to
// the amplitude lip-sync tier.
const gb = require("../_gigabyte_preview");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const id = parseInt(req.query && req.query.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }
  if (!gb.storeConfigured()) {
    return res.status(503).json({ error: "relay store not configured" });
  }
  try {
    const raw = await gb.store.get(gb.visemeKey(id));
    if (!raw) {
      return res.status(404).json({ error: `no viseme track stored for preview line ${id}` });
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(200).send(raw);
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
