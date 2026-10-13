// POST /api/owner-request — an assisted owner's dashboard request:
// {token, type: set-name | rename-fighter | calibrate | withdraw, ...}.
// GET  /api/owner-request?token=… — the owner's request queue (the desk
// reads the same queue with the desk-held token copy and applies requests
// to the local registry; application is confirmed via the published
// snapshot at owners/<sha256(token)>.json, rendered by owner.html).
//
// All logic lives in api/_owner.js (Upstash via api/_builderkey.js).

const owner = require("../_owner");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = owner.getStore();
  try {
    if (req.method === "GET") {
      let token = null;
      try {
        token = new URL(req.url, "https://flow-kg4x.vercel.app").searchParams.get("token");
      } catch {
        token = null;
      }
      const { status, body } = await owner.listRequests(store, token);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      let input = req.body;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          return res.status(400).json({ error: "request body must be JSON: {token, type, ...}" });
        }
      }
      if (!input || typeof input !== "object") {
        return res.status(400).json({ error: "request body must be JSON: {token, type, ...}" });
      }
      const { status, body } = await owner.createRequest(store, input);
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res
      .status(503)
      .json({ error: `owner store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
