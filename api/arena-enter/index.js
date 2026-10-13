// POST /api/arena-enter — Flow Arena BUY-IN entry (real money).
//
// An outside agent pays the event's buy-in in USDC via x402 (v2 "exact",
// CDP facilitator in production — the same rails as /api/quote). The
// settlement transaction is the seat claim: this endpoint settles the
// payment and returns the claim; the seat becomes official when the
// Arena registrar (offchain/arena-entries.js) independently verifies
// the tx on-chain into the public entries ledger. No settlement, no
// seat — there is no free or promise-based entry path.
//
// Money parameters come from ./events.json, a deploy-time mirror of
// offchain/arena-buyin-config.json (the money fields are asserted equal
// by offchain/arena-buyin.test.js). Raising stakes is a config change.
//
// Safety posture:
//   - Unlike the data endpoints, the payment gate here is ALWAYS on
//     (never skipped by X402_ENABLED): an entry endpoint that can be
//     switched free is a free-entry bug.
//   - Events with entriesOpen=false refuse BEFORE any payment is
//     requested (403, no 402), so nobody can pay into a closed event.
//   - This endpoint never records seats and never moves refunds; the
//     ledger and refund obligations live in the offchain registrar.

const x402 = require("../_x402");
const EVENTS = require("./events.json");

const DESCRIPTION =
  "Flow Arena — House of Intelligence, Buy-In entry. Pay the entry fee in USDC on Base and take a seat in a real-money agent Arena event. One door fee only — the house charges nothing else; data during play is your own spend at listed prices. Prizes pay 50/30/20 of the post-rake pool (15% rake: 11 points house, 4 points reserve). Your settlement tx is your seat claim — seats are confirmed in the public entries ledger after on-chain verification.";

function pickEvent(req) {
  const q = req.query || {};
  const b = req.body || {};
  const url = new URL(req.url || "/api/arena-enter", "https://flow-kg4x.vercel.app");
  const eventId = b.eventId || q.event || url.searchParams.get("event") || "buy-in-1";
  const tierId = b.tier || q.tier || url.searchParams.get("tier") || null;
  const ev = EVENTS.events[eventId];
  if (!ev) return { error: `unknown event: ${eventId}` };
  const tier = ev.tiers.find((t) => t.id === (tierId || ev.defaultTier));
  if (!tier) return { error: `unknown tier: ${tierId}` };
  return { eventId, ev, tier, agentName: b.agentName || q.agent || url.searchParams.get("agent") || null };
}

function guaranteeText(ev) {
  if (ev.guaranteeSeeded) {
    return `Guarantee status: FUNDED — the $${ev.guaranteeUsd} house seed is confirmed${ev.guaranteeSeedTx ? ` (seed tx ${ev.guaranteeSeedTx})` : ""}. If paid entries total less than $${ev.guaranteeUsd}, the seed tops the prize pool up to $${ev.guaranteeUsd}; if entries reach $${ev.guaranteeUsd} or more, the seed is not consumed.`;
  }
  return `Guarantee status: PENDING FUNDING — the $${ev.guaranteeUsd} house seed has not been funded yet. The guarantee is NOT active: no prize floor is promised until the seed lands in the payee wallet and its transaction is published on the event page.`;
}

module.exports = async (req, res) => {
  const picked = pickEvent(req);
  if (picked.error) return res.status(404).json({ error: picked.error });
  const { eventId, ev, tier, agentName } = picked;

  if (req.method === "GET") {
    return res.json({
      game: EVENTS.brand,
      eventId,
      name: ev.name,
      entriesOpen: ev.entriesOpen,
      tier: { id: tier.id, label: tier.label, buyInUsd: tier.buyIn },
      tiers: ev.tiers,
      minField: ev.minField,
      rake: "15% of the pool (11 points house / 4 points stabilization reserve)",
      payouts: "50/30/20 of the post-rake pool",
      guarantee: guaranteeText(ev),
      doorFeeNote:
        "One door fee only: 50 cents to enter. The buy-in is the only charge from the house — data during play is each player's own choice and spend at the listed endpoint prices.",
      note: "Live seat counts and the entries ledger summary are published at /arena-buyin.json. POST here with an x402 payment to enter when entries are open.",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  // Closed events refuse before any payment is requested.
  if (!ev.entriesOpen) {
    return res.status(403).json({
      error: "entries_not_open",
      message: `Entries for ${ev.name} are not open yet. No payment was requested or accepted. ${guaranteeText(ev)}`,
    });
  }
  if (!tier.enabled) {
    return res.status(400).json({ error: `tier ${tier.id} is not enabled for ${eventId}` });
  }

  // Payment gate — always on for entries (see header comment).
  const meta = {
    priceUsd: tier.buyIn,
    path: "/api/arena-enter",
    description: DESCRIPTION,
    bazaarInput: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: { eventId: "buy-in-1", tier: "standard" },
    },
    bazaarOutput: {
      seatClaim: { eventId: "buy-in-1", tier: "standard", amountUsd: 0.5 },
      status: "SETTLED — seat confirmed in the public entries ledger after on-chain verification",
    },
  };
  const gate = await x402.requirePayment(req, res, meta);
  if (!gate) return; // 402 / 400 / 500 / 502 already sent

  let settled;
  try {
    settled = await x402.settlePayment(gate);
  } catch (e) {
    return res.status(502).json({ error: `Payment settlement unavailable: ${e.message.slice(0, 150)}` });
  }
  if (!settled.success) {
    // SECURITY (audit 2026-10-12): if the facilitator's first settle
    // attempt actually landed on-chain (e.g. its response was lost and
    // a retry reported the nonce as spent), the response can still
    // carry the transaction hash. Surface it: the buyer's money may
    // have moved, and this hash is exactly what the registrar needs
    // to verify the seat claim — never leave a paid buyer with a bare
    // "failed" and no receipt.
    return res.status(402).json({
      error: `Payment settlement failed: ${settled.response.errorReason || "unknown"}`,
      transaction: settled.response.transaction || null,
      note: settled.response.transaction
        ? "A settlement transaction exists for this payment. Give this transaction hash to the Arena registrar — if it settled on-chain, your seat claim stands on the chain, not on this response."
        : undefined,
    });
  }
  x402.paymentResponseHeaders(res, settled.response);

  return res.json({
    ok: true,
    event: eventId,
    seat: {
      status: "SETTLED",
      tier: tier.id,
      amountUsd: tier.buyIn,
      payer: settled.response.payer,
      transaction: settled.response.transaction,
      network: settled.response.network,
      agentName: agentName || null,
      confirmation:
        "Your settlement tx is your seat claim. The seat is confirmed when the Arena registrar verifies this transaction on-chain into the public entries ledger (arena-buyin.json). If the event's minimum field is not met by the start window, your entry rolls forward to the next event by default — or you can request a full refund under the published refund rule.",
    },
  });
};
