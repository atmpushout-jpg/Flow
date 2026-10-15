// POST /api/gigabyte-push — the VM push relay's write door for the
// GIGABYTE live room. Body: {state, lines:[{id, member, mp3b64}]}.
//
// AUTH: header `x-gigabyte-key` must hash (sha256) to the value stored
// in Upstash under gigabyte:pushkeyhash. The key itself lives only in a
// 600-perm file on the VM and is never committed or stored anywhere.
//
// BOOTSTRAP (one-time claim): while gigabyte:pushkeyhash is unset, a
// request carrying {bootstrap:true, keyHash:<sha256 hex>} TOGETHER with
// a fully valid push payload claims the hash via SET NX and applies
// the payload in the same request. Once claimed, bootstrap is closed
// forever (409). The pusher claims within seconds of deploy and the
// end-to-end public read-back proves the claim is the house's: if the
// hash were anyone else's, every real push would 401 and the public
// state would never move.
const gb = require("../_gigabyte");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (!gb.storeConfigured()) {
    return res.status(503).json({ error: "relay store not configured" });
  }
  const body = req.body || {};
  const state = body.state;
  const lines = body.lines === undefined ? [] : body.lines;

  // Payload validity is checked before any auth bookkeeping: a garbage
  // body gets a 400 regardless of who sent it (and can never bootstrap).
  const stateErr = gb.validateState(state);
  if (stateErr) return res.status(400).json({ error: stateErr });
  const linesErr = gb.validateLines(lines, state);
  if (linesErr) return res.status(400).json({ error: linesErr });

  try {
    let storedHash = await gb.store.get(gb.KEY_PUSHKEYHASH);

    if (!storedHash) {
      // Bootstrap window: only a well-formed claim + valid payload lands.
      const claim = body.bootstrap === true ? String(body.keyHash || "") : "";
      if (!/^[0-9a-f]{64}$/.test(claim)) {
        return res.status(503).json({ error: "push key not bootstrapped yet" });
      }
      const claimed = await gb.store.setNx(gb.KEY_PUSHKEYHASH, claim);
      if (!claimed) {
        return res.status(409).json({ error: "push key already claimed" });
      }
      storedHash = claim; // fall through and apply this payload as ours
    } else {
      if (body.bootstrap === true) {
        return res.status(409).json({ error: "push key already claimed" });
      }
      const presented = req.headers["x-gigabyte-key"];
      if (!gb.keyMatches(presented, storedHash)) {
        return res.status(401).json({ error: "bad or missing x-gigabyte-key" });
      }
    }

    // Session + monotonic line tracking. Line ids are scoped to a show
    // session (state.startedAt): a restarted show starts a fresh count.
    const storedSession = await gb.store.get(gb.KEY_SESSION);
    const sameSession = storedSession !== null && Number(storedSession) === state.startedAt;
    let last = sameSession ? parseInt((await gb.store.get(gb.KEY_LASTLINE)) || "0", 10) || 0 : 0;
    for (const l of lines) {
      if (l.id <= last) {
        return res
          .status(409)
          .json({ error: `line ${l.id} is not ahead of the stored transcript (at ${last})` });
      }
      last = l.id;
    }

    // Writes: audio first (so a state never points at a missing line),
    // then the state overwrite, then the session watermark.
    for (const l of lines) {
      await gb.store.set(gb.audioKey(l.id), l.mp3b64, gb.AUDIO_TTL_SEC);
    }
    await gb.store.set(gb.KEY_STATE, JSON.stringify(state), gb.STATE_TTL_SEC);
    if (!sameSession) await gb.store.set(gb.KEY_SESSION, String(state.startedAt));
    if (lines.length) await gb.store.set(gb.KEY_LASTLINE, String(last));

    return res.status(200).json({
      ok: true,
      storedLines: lines.map((l) => l.id),
      lastLine: last,
      session: state.startedAt,
    });
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
