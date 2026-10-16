// /api/space/opkey — one-time bootstrap for the Space operator key.
//
// The operator key itself lives only in a 600-perm file on the house
// VM (~/.config/space_op_key); the server stores only its sha256
// hash, in Upstash under sp:opkeyhash — the Exchange push-key
// pattern (api/exchange/push) verbatim.
//
//   GET  — { bootstrapped: true|false } (never exposes the hash).
//   POST — while sp:opkeyhash is unset, { bootstrap: true,
//          keyHash: <sha256 hex of the operator key> } claims the
//          hash via SET NX. Once claimed, bootstrap is closed
//          forever (409). There is no rotation endpoint in v1: a
//          lost key means a deliberate store edit by the house,
//          never a silent re-claim.
const sp = require("../../_space");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (!sp.storeConfigured()) return res.status(503).json({ error: "space store not configured" });
  try {
    if (req.method === "GET") {
      const stored = await sp.store.get(sp.KEY_OPKEYHASH);
      return res.status(200).json({ service: "flow-space-opkey", bootstrapped: Boolean(stored) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
    const body = req.body || {};
    const stored = await sp.store.get(sp.KEY_OPKEYHASH);
    if (stored) return res.status(409).json({ error: "operator key already claimed" });
    const claim = body.bootstrap === true ? String(body.keyHash || "") : "";
    if (!/^[0-9a-f]{64}$/.test(claim)) {
      return res.status(400).json({ error: "bootstrap requires { bootstrap: true, keyHash: <sha256 hex> }" });
    }
    const claimed = await sp.store.setNx(sp.KEY_OPKEYHASH, claim);
    if (!claimed) return res.status(409).json({ error: "operator key already claimed" });
    return res.status(200).json({ ok: true, bootstrapped: true });
  } catch (e) {
    return res.status(503).json({ error: `space opkey unavailable: ${e.message}` });
  }
};
