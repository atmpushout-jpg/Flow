const { ethers } = require("ethers");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const { intent, userSig } = req.body || {};
  if (!intent || !userSig) {
    return res.status(400).json({ error: "Missing intent or userSig" });
  }
  res.json({
    status: "queued",
    message: "Intent received. Onchain execution activates after FlowFlashFiller mainnet deployment.",
    intentHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(intent))).slice(0, 18) + "...",
  });
};
