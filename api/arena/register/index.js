// POST /api/arena/register — register a Flow Arena fighter from a
// persona spec: the request body IS the spec JSON ({specVersion: 1,
// name, owner: {name, payoutWallet}, display?, dataBudgetUsd,
// strategy, participation?}). The validated, normalized spec is
// stored as data — never code — with funnel status VALIDATED.
// GET  /api/arena/register?id=<fighterId> — the stored record with
// its computed funnel status (VALIDATED / QUALIFIED).
// GET  /api/arena/register — the program offer.
//
// All logic + storage live in api/_register.js; validation is
// api/_register-validator.js, the byte-faithful port of
// offchain/arena-register.js's validateSpec.

const register = require("../../_register");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = register.getStore();
  try {
    if (req.method === "GET") {
      let id = null;
      try {
        id = new URL(req.url, "https://flow-kg4x.vercel.app").searchParams.get("id");
      } catch {
        id = null;
      }
      if (!id) {
        const { status, body } = await register.programSummary(store);
        return res.status(status).json(body);
      }
      const { status, body } = await register.getRegistration(store, id);
      return res.status(status).json(body);
    }
    if (req.method === "POST") {
      let input = req.body;
      if (typeof input === "string") {
        // A malformed-JSON body is a first-class refusal in the
        // validator (MALFORMED_JSON) — pass the raw text through.
        const { status, body } = await register.createRegistration(store, input);
        return res.status(status).json(body);
      }
      if (!input || typeof input !== "object") {
        return res.status(400).json({
          error: "request body must be the fighter spec JSON: {specVersion: 1, name, owner: {name, payoutWallet}, dataBudgetUsd, strategy}",
          code: "SPEC_NOT_OBJECT",
        });
      }
      const { status, body } = await register.createRegistration(store, input);
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res
      .status(503)
      .json({ error: `register store unavailable: ${String(e.message || e).slice(0, 150)}` });
  }
}

module.exports = handler;
