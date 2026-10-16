// POST /api/space/ticket — the Gigabyte Space TICKET RAIL: buy a
// question in the live Space speaker queue.
//
// An audience member (human or agent) pays $0.50 USDC on Base via
// x402 (v2 "exact" — the same rails as /api/cast/guest-chair and
// /api/verify) and receives a queue ticket: their question, in
// writing, answered on air by name when the cast calls it. One
// ticket = one question. Payment settles payer→payee directly;
// Flow never custodies anything beyond the payment itself.
//
// Access rule (Atm, 2026-10-16): the ONLY gate for asking the cast
// a question is a verified user who has paid the fee. Verification
// here is the settlement itself — a paid ticket IS the credential,
// and the queue (GET /api/space/queue) is public, so anyone can
// confirm a ticket exists before it is called.
//
// Safety posture (mirrors /api/cast/guest-chair):
//   - The payment gate is ALWAYS on — an entry endpoint that can be
//     switched free is a free-entry bug.
//   - The body is validated BEFORE payment, so nobody can pay for a
//     ticket the door would refuse (bad handle, empty or >500-char
//     question).
//   - Builder keys do NOT mint tickets: the key is a build-phase
//     test budget, not show money. Its reservation is released and
//     the caller gets the plain 402 challenge instead.
//   - The $0.50 price is final (Atm's standing word).

const x402 = require("../../_x402");
const sp = require("../../_space");

const DESCRIPTION =
  "Gigabyte Space — ask-the-cast ticket. Pay $0.50 USDC on Base and put one written question into the live Space speaker queue: when the cast calls your ticket, you come up as a speaker and your question is answered on air, by name. One ticket buys one question. House rules: no shilling without a graded record, claims carry numbers — never product, always results. Listening is free; the ticket buys the question, not a verdict.";

function offerBody() {
  return {
    door: "Gigabyte Space — ask-the-cast ticket rail",
    priceUsd: sp.TICKET_PRICE_USD,
    asset: "USDC on Base (eip155:8453)",
    buys:
      "One written question in the live Space speaker queue, answered on air by name when the cast calls your ticket. One ticket = one question.",
    body: {
      handle: "your X @handle (letters, digits, underscore)",
      name: "display name read on air (max 50 chars)",
      question: "your question (max 500 chars)",
    },
    rules:
      "Verified user + paid fee is the only gate. No shilling without a graded record; claims carry numbers; never product, always results.",
    queue: "GET /api/space/queue — the public speaker queue, in order.",
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-FLOW-BUILDER-KEY"
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json(offerBody());
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  if (!sp.storeConfigured()) {
    return res.status(503).json({ error: "space store not configured" });
  }

  // Validate BEFORE payment (see header): a refused body never costs
  // the caller a settlement.
  const body = req.body || {};
  const handle = sp.sanitizeHandle(body.handle);
  if (!handle) {
    return res.status(400).json({ error: "handle is required: an X @handle (letters, digits, underscore, max 15 chars)", code: "HANDLE_REQUIRED" });
  }
  const name = sp.sanitizeName(body.name);
  if (!name) {
    return res.status(400).json({ error: "name is required (printable text, max 50 chars)", code: "NAME_REQUIRED" });
  }
  const question = sp.sanitizeQuestion(body.question);
  if (!question) {
    return res.status(400).json({ error: "question is required (non-empty, max 500 chars)", code: "QUESTION_REQUIRED" });
  }
  const isTest = body.test === true;

  const meta = {
    priceUsd: sp.TICKET_PRICE_USD,
    path: "/api/space/ticket",
    description: DESCRIPTION,
    bazaarInput: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: { handle: "yourhandle", name: "Your Name", question: "What does the verdict score actually measure?" },
    },
    bazaarOutput: {
      ticket: { id: "SP-0001", state: "queued", position: 1 },
    },
  };
  const gate = await x402.requirePayment(req, res, meta);
  if (!gate) return; // 402 / 400 / 500 / 502 already sent

  if (gate.builderKey) {
    // Builder keys are a build-phase test budget, not show money —
    // hand the reservation back and issue the plain 402 challenge.
    await x402.releaseBuilderKey(gate);
    return x402.send402(
      res, req,
      "Builder keys do not mint Space tickets. Pay the $0.50 ticket in USDC via x402 — see accepts[] for exact requirements.",
      meta
    );
  }

  let settled;
  try {
    settled = await x402.settlePayment(gate);
  } catch (e) {
    return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
  }
  if (!settled.success) {
    // Same discipline as /api/cast/guest-chair: if a settlement
    // transaction exists despite the failure verdict, surface it —
    // the buyer's money may have moved and the hash is their receipt.
    return res.status(402).json({
      error: `Payment settlement failed: ${settled.response.errorReason || "unknown"}`,
      transaction: settled.response.transaction || null,
      note: settled.response.transaction
        ? "A settlement transaction exists for this payment. Give this transaction hash to the Flow desk — if it settled on-chain, your ticket claim stands on the chain, not on this response."
        : undefined,
    });
  }
  x402.paymentResponseHeaders(res, settled.response);

  const payer = settled.response.payer || gate.payer || null;
  const tx = settled.response.transaction || null;

  // Payment has settled payer→payee. Write the ticket; if the store
  // write fails, surface the tx so the desk can reconcile by hand —
  // never swallow a paid ticket silently.
  let ticket, position;
  try {
    const state = await sp.loadStateForWrite();
    state.seq = (state.seq || 0) + 1;
    ticket = {
      id: `SP-${String(state.seq).padStart(4, "0")}`,
      handle,
      name,
      question,
      tx,
      payer,
      amount_usd: sp.TICKET_PRICE_USD,
      paid_at: new Date().toISOString(),
      state: "queued",
      test: isTest,
      state_history: [{ state: "queued", at: new Date().toISOString() }],
    };
    state.tickets.push(ticket);
    await sp.saveState(state);
    position = sp.queuePosition(state, ticket.id);
  } catch (e) {
    return res.status(500).json({
      error: `Payment settled but the ticket could not be written: ${e.message.slice(0, 150)}`,
      transaction: tx,
      note: "Your $0.50 settled on-chain (transaction above). Give this hash to the Flow desk — your place in the queue will be honored from the chain record.",
    });
  }

  return res.status(201).json({
    ok: true,
    ticket: {
      id: ticket.id,
      handle: ticket.handle,
      name: ticket.name,
      question: ticket.question,
      state: ticket.state,
      position,
      paid_at: ticket.paid_at,
      test: ticket.test,
    },
    payment: {
      amountUsd: sp.TICKET_PRICE_USD,
      transaction: tx,
      network: settled.response.network,
      payer,
    },
    note: "You are in the queue. Listening is free; this ticket is your question. When the cast calls your ticket, come up as a speaker — your question is answered on air, by name. One ticket = one question. Never product, always results.",
  });
};
