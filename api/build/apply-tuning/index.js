// POST /api/build/apply-tuning — apply ONE recommended tuning step to
// a web-built fighter: {token, dial, to}. One dial, one step from its
// current setting — a stale suggestion is refused (409), exactly like
// the Telegram dashboard's Apply buttons (telegram/flow-bot.js
// applyTune). The change is rebuilt through the Forge core, stored as
// the fighter's new version, and logged to its event log.
// Logic lives in api/_build.js.

const build = require("../../_build");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let input = req.body;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return res.status(400).json({ error: "request body must be JSON: {token, dial, to}" });
    }
  }
  if (!input || typeof input !== "object" || typeof input.token !== "string") {
    return res.status(400).json({ error: "request body must be JSON: {token, dial, to}" });
  }

  const store = build.getStore();
  try {
    const published = await build.fetchPublished();
    const { status, body } = await build.applyTuning(store, input.token, input, published);
    return res.status(status).json(body);
  } catch (e) {
    return res
      .status(503)
      .json({ error: `build store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
