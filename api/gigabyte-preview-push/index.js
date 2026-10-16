// POST /api/gigabyte-preview-push — the VM preview loop's write door.
// Body: {state, lines:[{id, member, mp3b64}], visemes:[{id, mouthCues}]}.
//
// AUTH + BOOTSTRAP mirror the production gigabyte-push door exactly, in
// the preview's own namespace: header `x-gigabyte-key` must hash (sha256)
// to gbp:pushkeyhash; while that key is unset, one well-formed
// {bootstrap:true, keyHash} request carrying a fully valid payload claims
// it via SET NX, once, forever.
const gb = require("../_gigabyte_preview");

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
  const visemes = body.visemes === undefined ? [] : body.visemes;

  const stateErr = gb.validateState(state);
  if (stateErr) return res.status(400).json({ error: stateErr });
  const linesErr = gb.validateLines(lines, state);
  if (linesErr) return res.status(400).json({ error: linesErr });
  const visErr = gb.validateVisemes(visemes, state);
  if (visErr) return res.status(400).json({ error: visErr });

  try {
    let storedHash = await gb.store.get(gb.KEY_PUSHKEYHASH);

    if (!storedHash) {
      const claim = body.bootstrap === true ? String(body.keyHash || "") : "";
      if (!/^[0-9a-f]{64}$/.test(claim)) {
        return res.status(503).json({ error: "push key not bootstrapped yet" });
      }
      const claimed = await gb.store.setNx(gb.KEY_PUSHKEYHASH, claim);
      if (!claimed) {
        return res.status(409).json({ error: "push key already claimed" });
      }
      storedHash = claim;
    } else {
      if (body.bootstrap === true) {
        return res.status(409).json({ error: "push key already claimed" });
      }
      const presented = req.headers["x-gigabyte-key"];
      if (!gb.keyMatches(presented, storedHash)) {
        return res.status(401).json({ error: "bad or missing x-gigabyte-key" });
      }
    }

    // Composite "<session>:<lastId>" watermark — same lesson as production:
    // the session flip and its watermark reset are ONE write, never two.
    const rawLast = await gb.store.get(gb.KEY_LASTLINE);
    let wmSession = null;
    let wmLast = 0;
    if (rawLast !== null) {
      const m = /^(\d+):(\d+)$/.exec(String(rawLast));
      if (m) {
        wmSession = Number(m[1]);
        wmLast = parseInt(m[2], 10) || 0;
      }
    }
    const storedSessionRaw = await gb.store.get(gb.KEY_SESSION);
    const knownSession = wmSession !== null
      ? wmSession
      : storedSessionRaw !== null
        ? Number(storedSessionRaw)
        : null;
    if (knownSession !== null && state.startedAt < knownSession) {
      return res
        .status(409)
        .json({ error: `stale session ${state.startedAt} (stored session is ${knownSession})` });
    }
    const sameSession = knownSession === state.startedAt;
    let last = sameSession ? wmLast : 0;
    for (const l of lines) {
      if (l.id <= last) {
        return res
          .status(409)
          .json({ error: `line ${l.id} is not ahead of the stored transcript (at ${last})` });
      }
      last = l.id;
    }

    // Writes: audio + visemes first (a state never points at missing media),
    // then the state overwrite, then session + watermark together.
    for (const l of lines) {
      await gb.store.set(gb.audioKey(l.id), l.mp3b64, gb.AUDIO_TTL_SEC);
    }
    for (const v of visemes) {
      const track = JSON.stringify({ mouthCues: v.mouthCues });
      await gb.store.set(gb.visemeKey(v.id), track, gb.AUDIO_TTL_SEC);
    }
    await gb.store.set(gb.KEY_STATE, JSON.stringify(state), gb.STATE_TTL_SEC);
    await gb.store.set(gb.KEY_SESSION, String(state.startedAt));
    await gb.store.set(gb.KEY_LASTLINE, `${state.startedAt}:${last}`);

    return res.status(200).json({
      ok: true,
      storedLines: lines.map((l) => l.id),
      storedVisemes: visemes.map((v) => v.id),
      lastLine: last,
      session: state.startedAt,
    });
  } catch (e) {
    return res.status(503).json({ error: `relay store unreachable: ${e.message}` });
  }
};
