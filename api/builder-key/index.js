// POST /api/builder-key — claim a free Early Builder Key for a wallet
// address (one per address; the key is shown ONCE in the response).
// GET  /api/builder-key?address=0x… — public status for an address
// (issued?, callsUsed, callsRemaining — never the key or its hash).
// GET  /api/builder-key — the program offer + live issuance count.
//
// The key is a test budget: 100 free calls total across /api/quote,
// /api/verify, /api/signals and /api/smart-wallets, sent as the
// x-flow-builder-key header. When the budget is used, standard x402
// per-call prices apply. All logic + storage live in
// api/_builderkey.js (Upstash; only the key's SHA-256 hash is kept).

const builderKey = require("../_builderkey");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Flow-Builder-Key");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = builderKey.getStore();
  try {
    if (req.method === "GET") {
      let address = null;
      try {
        address = new URL(req.url, "https://flow-kg4x.vercel.app").searchParams.get("address");
      } catch {
        address = null;
      }
      const { status, body } = address
        ? await builderKey.getStatus(store, address)
        : await builderKey.programSummary(store);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      let input = req.body;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          return res.status(400).json({ error: "request body must be JSON: {address, botName?}" });
        }
      }
      if (!input || typeof input !== "object") {
        return res.status(400).json({ error: "request body must be JSON: {address, botName?}" });
      }
      const { status, body } = await builderKey.issueKey(store, input);
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res
      .status(503)
      .json({ error: `builder-key store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
