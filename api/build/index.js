// POST /api/build — build a Flow Arena fighter from the browser:
// {name, style, dials:{appetite, aggression, patience}, ownerName?}.
// The response carries the owner token + dashboard link ONCE; only a
// hash of the token is stored.
// GET  /api/build?token=… — the owner's dashboard data (fighter card,
// status, seat/balance state, counted-match report, tuning
// recommendations, event log). The token is the credential.
// GET  /api/build — the program offer.
//
// All logic + storage live in api/_build.js (Upstash via
// api/_builderkey.js's store). This is the web twin of the Telegram
// bot's /build + /mybot (telegram/flow-bot.js).

const build = require("../_build");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = build.getStore();
  try {
    if (req.method === "GET") {
      let token = null;
      try {
        token = new URL(req.url, "https://flow-kg4x.vercel.app").searchParams.get("token");
      } catch {
        token = null;
      }
      if (!token) {
        const { status, body } = await build.programSummary(store);
        return res.status(status).json(body);
      }
      const published = await build.fetchPublished();
      const { status, body } = await build.getDashboard(store, token, published);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      let input = req.body;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          return res.status(400).json({ error: "request body must be JSON: {name, style, dials:{appetite, aggression, patience}, ownerName?}" });
        }
      }
      if (!input || typeof input !== "object") {
        return res.status(400).json({ error: "request body must be JSON: {name, style, dials:{appetite, aggression, patience}, ownerName?}" });
      }
      const { status, body } = await build.createBuild(store, input);
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res
      .status(503)
      .json({ error: `build store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
