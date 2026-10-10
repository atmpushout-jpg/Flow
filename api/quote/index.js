const { getBestQuote } = require("../_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const { tokenIn, tokenOut, amountIn } = req.body || {};
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "Missing tokenIn, tokenOut, or amountIn" });
  }
  try {
    const quote = await getBestQuote(tokenIn, tokenOut, amountIn);
    res.json({
      ...quote,
      protocolFee: "25% of price improvement over Uniswap baseline",
    });
  } catch (e) {
    res.status(500).json({ error: (e.message || "quote failed").slice(0, 200) });
  }
};
