// POST /api/exchange/push — the house operator's full-state push for
// the Problem Exchange (seeding + importer sync). Body: {state}.
//
// AUTH: header `x-exchange-key` must hash (sha256) to the value stored
// in Upstash under px:pushkeyhash. The key lives only in a 600-perm
// file on the house VM (~/.config/exchange_push_key).
//
// BOOTSTRAP (one-time claim, same discipline as /api/gigabyte-push):
// while px:pushkeyhash is unset, a request carrying
// {bootstrap:true, keyHash:<sha256 hex>} TOGETHER with a fully valid
// state claims the hash via SET NX and applies the state in the same
// request. Once claimed, bootstrap is closed forever (409).
const px = require("../../_exchange");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!px.storeConfigured()) return res.status(503).json({ error: "exchange store not configured" });
  const body = req.body || {};
  const state = body.state;
  const stateErr = px.validateState(state);
  if (stateErr) return res.status(400).json({ error: stateErr });
  try {
    let storedHash = await px.store.get(px.KEY_PUSHKEYHASH);
    if (!storedHash) {
      const claim = body.bootstrap === true ? String(body.keyHash || "") : "";
      if (!/^[0-9a-f]{64}$/.test(claim)) {
        return res.status(503).json({ error: "operator key not bootstrapped yet" });
      }
      const claimed = await px.store.setNx(px.KEY_PUSHKEYHASH, claim);
      if (!claimed) return res.status(409).json({ error: "operator key already claimed" });
      storedHash = claim;
    } else {
      if (body.bootstrap === true) return res.status(409).json({ error: "operator key already claimed" });
      if (!px.keyMatches(req.headers["x-exchange-key"], storedHash)) {
        return res.status(401).json({ error: "bad or missing x-exchange-key" });
      }
    }
    await px.saveState(state);
    return res.status(200).json({
      ok: true,
      listings: state.listings.length,
      updated_at: state.updated_at,
    });
  } catch (e) {
    return res.status(503).json({ error: `exchange store unreachable: ${e.message}` });
  }
};
