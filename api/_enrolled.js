// Enrolled agents — the company-AI enrollment program's routing tier.
//
// Wallet addresses listed here get /api/quote FREE (no x402 challenge)
// when the request proves control of the address: the quote request body
// carries
//   agent:    the enrolled wallet address
//   agentSig: an EIP-191 personal signature (wallet.signMessage) over the
//             canonical message built by enrolledQuoteMessage() below,
//             which binds the agent address to THIS quote's exact
//             parameters — a captured signature replays only the
//             identical quote, whose price is stale within ~10 blocks.
// Anyone not listed (or failing signature verification) gets the
// standard $0.01 x402 challenge, unchanged.
//
// Enrollment is a business relationship granted by Flow, so this list
// changes by commit, never by API. Keep it short and every entry labeled.

const ENROLLED_AGENTS = [
  {
    address: "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561",
    label: "house — FlowExecutor's own operational agent wallet (enrolled agent #0)",
  },
];

function isEnrolled(address) {
  if (typeof address !== "string") return false;
  const a = address.toLowerCase();
  return ENROLLED_AGENTS.some((e) => e.address.toLowerCase() === a);
}

// Canonical message an enrolled agent signs to claim the free tier:
// "flow:quote:free:<agent>:<tokenIn>:<tokenOut>:<amountIn>" with all
// addresses lowercased and amountIn verbatim (its string form).
function enrolledQuoteMessage({ agent, tokenIn, tokenOut, amountIn }) {
  return [
    "flow:quote:free",
    String(agent).toLowerCase(),
    String(tokenIn).toLowerCase(),
    String(tokenOut).toLowerCase(),
    String(amountIn),
  ].join(":");
}

module.exports = { ENROLLED_AGENTS, isEnrolled, enrolledQuoteMessage };
