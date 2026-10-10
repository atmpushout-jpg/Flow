# x402 pay-per-call on POST /api/quote

$0.01 USDC per quote on Base mainnet, settled via the Coinbase CDP facilitator.
Zero new npm dependencies (uses the x402 v2 wire protocol directly + Node stdlib crypto).

## Env vars (Vercel → Project → Settings → Environment Variables)

| Var | Required | Value |
|---|---|---|
| `X402_ENABLED` | to charge | `true` (anything else = endpoint stays free, current behavior) |
| `X402_PAYEE_ADDRESS` | when enabled | Your EVM address that receives the USDC (no default — never hardcoded) |
| `CDP_API_KEY_ID` | when enabled | From [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) → API keys |
| `CDP_API_KEY_SECRET` | when enabled | Same CDP API key (Ed25519). Free tier: 1,000 facilitator txns/mo |
| `X402_PRICE_USD` | optional | Default `0.01` |
| `X402_NETWORK` | optional | Default `eip155:8453` (Base mainnet) |
| `X402_FACILITATOR_URL` | optional | Default `https://api.cdp.coinbase.com/platform/v2/x402` |

Deploy order: push code with `X402_ENABLED` unset (free mode, safe) → set the
four vars in Vercel → flip `X402_ENABLED=true` when ready to charge.

## How it works

1. **Unpaid request** → `402` with a `PAYMENT-REQUIRED` header (base64
   `PaymentRequired` JSON) and the same JSON as the body. `accepts[0]` is
   `{scheme:"exact", network:"eip155:8453", amount:"10000", asset:<USDC on Base>,
   payTo:<X402_PAYEE_ADDRESS>, extra:{name:"USD Coin",version:"2"}}`.
   The 402 also carries top-level `extensions.bazaar` (name "Flow Best-Execution
   Quotes", category Trading) — this is what Agentic.Market auto-indexes after
   the first settled payment.
2. **Paid request** → client signs an EIP-3009 USDC authorization and retries
   with `X-PAYMENT` (or `PAYMENT-SIGNATURE`) = base64 `PaymentPayload`.
   Server runs local checks (network/recipient/exact amount), then
   `POST {facilitator}/verify`. Invalid → `402`. Valid → quote logic runs →
   `POST {facilitator}/settle` → `200` with the quote plus
   `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE` headers (base64 SettlementResponse)
   and a `payment: {transaction, network, payer}` field in the body.
   If settle fails, the quote is NOT returned (402).

CDP auth: each facilitator call carries a fresh Ed25519 JWT
(`iss:cdp`, 120s expiry) minted from the CDP key — no SDK needed.

## Test with a paid call

```bash
# 1. Should 402 with payment terms (free to try)
curl -s -X POST https://flow-kg4x.vercel.app/api/quote \
  -H 'Content-Type: application/json' \
  -d '{"tokenIn":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","tokenOut":"0x4200000000000000000000000000000000000006","amountIn":"1000000"}' \
  -D - -o /tmp/q402.json -w '\nHTTP %{http_code}\n'

# 2. Decode the challenge
python3 -c "import base64,json; print(json.dumps(json.loads(base64.b64decode(open('/tmp/q402.json').read().split('PAYMENT-REQUIRED:')[1].split()[0] if False else '')), indent=1))" 2>/dev/null || \
  grep -i payment-required -A1 /tmp/headers.txt

# 3. Pay it: easiest is an x402-aware client, e.g. Coinbase's "Pay for Service"
#    skill, or @x402/fetch in Node:
#    npm i @x402/fetch @x402/evm
#    → wrap fetch, POST the same body; the wrapper signs the $0.01 USDC
#      EIP-3009 auth from your wallet and retries with X-PAYMENT automatically.
#    Expect 200 + PAYMENT-RESPONSE header + payment.transaction in the body.

# 4. Confirm Bazaar indexing (after first settled payment, up to ~10 min):
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?payTo=<X402_PAYEE_ADDRESS>" | head -c 600

# 5. Validate discoverability any time (no auth needed):
curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -H 'Content-Type: application/json' -d @/tmp/q402.json | head -c 600
```

Notes:
- Test on Base Sepolia first by setting `X402_NETWORK=eip155:8453`→`eip155:84532`
  and using the [x402.org facilitator](https://x402.org/facilitator) (no CDP key
  needed on testnet) — but the 402 `asset` must then be Sepolia USDC.
- First mainnet settlement is what triggers Agentic.Market indexing; the
  buyer's client must echo `extensions` from the 402 into its payment payload
  (spec-compliant clients like @x402/fetch do this automatically).
