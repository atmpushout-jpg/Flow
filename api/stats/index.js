// GET /api/stats — usage snapshot for this serverless instance.
// Approximate counters (reset on cold start). Polled externally for trends.
const stats = require("../_stats");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  res.json({ service: "flow-executor", ...stats.snapshot() });
};
