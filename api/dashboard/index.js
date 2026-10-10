// GET /api/dashboard — aggregated dashboard data in one same-origin call.
// Avoids CORS issues from client-side fetches to raw.githubusercontent.com.
const { getBestQuote } = require("../_lib");

const GH_RAW = "https://raw.githubusercontent.com/atmpushout-jpg/Flow/main/stats/";

async function fetchJson(url) {
  try {
    const r = await fetch(url + "?t=" + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  // Live quote (standard $100 USDC -> WETH probe)
  let quote = null;
  try {
    quote = await getBestQuote(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0x4200000000000000000000000000000000000006",
      "100000000"
    );
  } catch (e) {
    quote = { error: e.message.slice(0, 100) };
  }

  const [explanation, total] = await Promise.all([
    fetchJson(GH_RAW + "explanation.json"),
    fetchJson(GH_RAW + "total.json"),
  ]);

  res.json({ quote, explanation, total, at: new Date().toISOString() });
};
