// /api/space/queue — the Gigabyte Space speaker queue.
//
// GET  — public read: every ticket in purchase order (handle, name,
//        question, state), with each queued ticket's live position.
//        This feeds the show floor page and the cast: the cast calls
//        the head of the queue, the floor shows who is next. Free —
//        the wire starts free; the ticket is what costs.
//
// POST — operator-only state advance: { id: "SP-0001", to: "called" }
//        or { id, state: "done" }. Auth: header `x-space-key` must
//        hash (sha256) to the value stored in Upstash under
//        sp:opkeyhash — the Exchange push-key pattern (hash only,
//        timing-safe compare; bootstrap via /api/space/opkey).
//        Transitions are forward-only: queued → called → done
//        (queued → done is allowed for a no-show).
const sp = require("../../_space");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-SPACE-KEY");
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const { state, source } = await sp.loadState();
      const tickets = state.tickets || [];
      return res.status(200).json({
        service: "flow-space-tickets",
        price_usd: sp.TICKET_PRICE_USD,
        state_source: source,
        updated_at: state.updated_at || null,
        counts: {
          total: tickets.length,
          queued: tickets.filter((t) => t.state === "queued").length,
          called: tickets.filter((t) => t.state === "called").length,
          done: tickets.filter((t) => t.state === "done").length,
        },
        queue: tickets.map((t) => sp.publicTicket(state, t)),
        read: "POST /api/space/ticket buys a question ($0.50 USDC via x402). The cast calls the head of the queue; a ticket moves queued → called → done on air.",
      });
    } catch (e) {
      return res.status(503).json({ error: `space queue unavailable: ${e.message}` });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  // Operator advance.
  if (!sp.storeConfigured()) {
    return res.status(503).json({ error: "space store not configured" });
  }
  const auth = await sp.operatorAuthed(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const id = typeof body.id === "string" ? body.id.toUpperCase() : "";
  if (!/^SP-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide id like SP-0001" });
  const to = String(body.to || body.state || "").toLowerCase();
  if (!sp.TICKET_STATES.includes(to)) {
    return res.status(400).json({ error: `to must be one of ${sp.TICKET_STATES.join(", ")}` });
  }

  try {
    const state = await sp.loadStateForWrite();
    const ticket = sp.findTicket(state, id);
    if (!ticket) return res.status(404).json({ error: `No ticket ${id}`, code: "NO_TICKET" });
    const allowed = (sp.TRANSITIONS[ticket.state] || []);
    if (!allowed.includes(to)) {
      return res.status(409).json({
        error: `Ticket ${id} is ${ticket.state}; cannot move to ${to}`,
        code: "BAD_TRANSITION",
        state: ticket.state,
      });
    }
    const at = new Date().toISOString();
    ticket.state = to;
    ticket.state_history = Array.isArray(ticket.state_history) ? ticket.state_history : [];
    ticket.state_history.push({ state: to, at });
    if (to === "called") ticket.called_at = at;
    if (to === "done") ticket.done_at = at;
    await sp.saveState(state);
    return res.status(200).json({
      ok: true,
      ticket: sp.publicTicket(state, ticket),
      counts: {
        queued: state.tickets.filter((t) => t.state === "queued").length,
        called: state.tickets.filter((t) => t.state === "called").length,
        done: state.tickets.filter((t) => t.state === "done").length,
      },
    });
  } catch (e) {
    return res.status(503).json({ error: `space queue advance failed: ${e.message}` });
  }
};
