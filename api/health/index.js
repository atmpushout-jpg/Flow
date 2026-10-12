const { provider } = require("../_lib");
const { cdpKeyStatus } = require("../_x402");

module.exports = async (req, res) => {
  try {
    const block = await provider().getBlockNumber();
    res.json({ status: "ok", blockNumber: block, chain: "base", cdp: cdpKeyStatus() });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
};
