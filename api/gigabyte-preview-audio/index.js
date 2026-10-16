// GET /api/gigabyte-preview-audio?id=<lineId> — one preview line's MP3,
// stored base64 in Upstash under gbp:audio:<id> by the preview loop.
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
    const b64 = await gb.store.get(gb.audioKey(id));
    if (!b64) {
      return res.status(404).json({ error: `no audio stored for preview line ${id}` });
    }
    const buf = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Content-Length", String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
