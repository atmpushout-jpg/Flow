const { provider } = require("../_lib");

module.exports = async (req, res) => {
  try {
    const block = await provider().getBlockNumber();
    res.json({ status: "ok", blockNumber: block, chain: "base" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
};
