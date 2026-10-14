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
// The same registry + signature discipline prices the DATA endpoints —
// /api/signals, /api/smart-wallets, /api/verify — at $0.005 for enrolled
// agents (see ENROLLED_DATA_PRICE_USD and the message builders below).
// Invalid or absent identity always falls through to each endpoint's
// standard challenge, unchanged.
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

// ---------------------------------------------------------------------------
// Enrolled DATA price — /api/signals, /api/smart-wallets, /api/verify
// charge enrolled agents $0.005 (5,000 atomic USDC) instead of their
// standard price, when the request proves control of a listed address.
// The x402 gate itself is unchanged: the handler verifies identity
// first, then passes priceUsd = ENROLLED_DATA_PRICE_USD to the gate.
// ---------------------------------------------------------------------------

const ENROLLED_DATA_PRICE_USD = 0.005;
// GET identity carries a signed ts (unix seconds); handlers reject the
// identity (fall through to the standard price — never an error) when
// the timestamp is more than this many seconds from server time, so a
// captured signature cannot be replayed beyond a short window.
const ENROLLED_DATA_MAX_SKEW_SEC = 300;

// Render a params object as sorted "k=v" pairs joined by "&" — the
// canonical tail of the data messages below. Values are verbatim (the
// exact strings the caller sent / will send); pairs whose value is
// undefined, null, or "" are omitted.
function canonicalParams(params) {
  return Object.keys(params || {})
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

// Canonical message for the GET data endpoints (/api/signals,
// /api/smart-wallets). Identity rides in query params:
//   ?agent=0x…&agentSig=0x…&ts=<unix seconds>[&since=…][&limit=…]
// agentSig is an EIP-191 signature (wallet.signMessage) over
//   "flow:data:<agent>:<path>:<params>"
// with the agent lowercased, path verbatim, and <params> the
// canonicalParams() rendering of the signed query params: `ts` always,
// plus the endpoint's request-shaping params (`since`, `limit` on
// /api/signals) with their values verbatim as sent. The signature binds
// the agent to this endpoint AND the exact view being bought, inside a
// ±ENROLLED_DATA_MAX_SKEW_SEC freshness window.
function enrolledDataMessage({ agent, path, params }) {
  return [
    "flow:data",
    String(agent).toLowerCase(),
    String(path),
    canonicalParams(params),
  ].join(":");
}

// Canonical message for /api/verify (POST). Identity rides in the JSON
// body as agent + agentSig — the same field names as /api/quote — and
// the signed message is the enrolledDataMessage format bound to the
// exact check being bought:
//   "flow:data:<agent>:/api/verify:address=<address>[&chain=<chain>]"
// address lowercased; `chain` included only when the body carries one,
// its value lowercased.
function enrolledVerifyMessage({ agent, address, chain }) {
  const params = { address: String(address).toLowerCase() };
  if (chain !== undefined && chain !== null && String(chain) !== "") {
    params.chain = String(chain).toLowerCase();
  }
  return enrolledDataMessage({ agent, path: "/api/verify", params });
}

module.exports = {
  ENROLLED_AGENTS,
  isEnrolled,
  enrolledQuoteMessage,
  ENROLLED_DATA_PRICE_USD,
  ENROLLED_DATA_MAX_SKEW_SEC,
  canonicalParams,
  enrolledDataMessage,
  enrolledVerifyMessage,
};
