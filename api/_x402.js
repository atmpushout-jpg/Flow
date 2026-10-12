// x402 (v2) pay-per-call protection for Vercel serverless functions.
// Implements the x402 v2 wire protocol directly (no extra npm deps):
//   - 402 responses carry a base64 PaymentRequired object in the
//     PAYMENT-REQUIRED header (and as the JSON body).
//   - Clients pay by sending X-PAYMENT (or PAYMENT-SIGNATURE) with a
//     base64 PaymentPayload (EIP-3009 "exact" USDC authorization).
//   - verify/settle run against the facilitator (CDP by default).
// Spec: https://github.com/x402-foundation/x402 (specs/x402-specification-v2.md,
// specs/transports-v2/http.md, specs/extensions/bazaar.md)

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // verified on-chain
const USDC_DECIMALS = 6;
const DEFAULT_NETWORK = "eip155:8453"; // Base mainnet
// Default facilitator: PayAI (no API key required, settles Base mainnet,
// x402 v2 "exact"). CDP remains available by setting X402_FACILITATOR_URL to
// https://api.cdp.coinbase.com/platform/v2/x402 plus CDP_API_KEY_ID/SECRET.
const DEFAULT_FACILITATOR = "https://facilitator.payai.network";
const CDP_HOST = "api.cdp.coinbase.com";

function isEnabled() {
  return process.env.X402_ENABLED === "true";
}

function getConfig(meta) {
  const payTo = (process.env.X402_PAYEE_ADDRESS || "").trim();
  // Per-endpoint price override: a handler's RESOURCE_META may set priceUsd
  // (e.g. /api/verify charges $0.02 — the market-proven verdict price).
  // Everything else falls back to X402_PRICE_USD (default $0.01).
  const metaPrice = meta && Number.isFinite(meta.priceUsd) && meta.priceUsd > 0 ? meta.priceUsd : null;
  const priceUsd = metaPrice !== null ? metaPrice : parseFloat(process.env.X402_PRICE_USD || "0.01");
  const network = (process.env.X402_NETWORK || DEFAULT_NETWORK).trim();
  const facilitator = (process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR).trim().replace(/\/+$/, "");
  const amount = String(Math.round(priceUsd * 10 ** USDC_DECIMALS)); // atomic units
  return { payTo, priceUsd, network, facilitator, amount };
}

function configError() {
  const c = getConfig();
  if (!c.payTo) return "X402_PAYEE_ADDRESS is not set";
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.payTo)) return "X402_PAYEE_ADDRESS is not a valid EVM address";
  if (!Number.isFinite(c.priceUsd) || c.priceUsd <= 0) return "X402_PRICE_USD must be a positive number";
  return null;
}

// ---------------------------------------------------------------------------
// PaymentRequired (402) builder
// ---------------------------------------------------------------------------

function resourceUrl(req, resourcePath) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host || "flow-kg4x.vercel.app";
  const fallback = (req.url || "/api/quote").split("?")[0];
  return `${proto}://${host}${resourcePath || fallback}`;
}

function paymentRequirements(req, meta) {
  const c = getConfig(meta);
  return {
    scheme: "exact",
    network: c.network,
    amount: c.amount,
    asset: USDC_BASE,
    payTo: c.payTo,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" }, // USDC EIP-712 domain on Base
  };
}

// Bazaar discovery extension (top-level `extensions`, NOT inside accepts[]).
// Facilitator catalogs (PayAI/CDP Bazaar) and Agentic.Market index this
// declaration from settled payment payloads. Per-endpoint accuracy
// matters: a wrong input example lists the resource wrong everywhere,
// so handlers pass their own bazaarInput/bazaarOutput in RESOURCE_META.
const DEFAULT_BAZAAR_INPUT = {
  type: "http",
  method: "POST",
  bodyType: "json",
  body: {
    tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenOut: "0x4200000000000000000000000000000000000006",
    amountIn: "1000000",
  },
};
const DEFAULT_BAZAAR_OUTPUT = {
  bestOut: "396812",
  venue: "aerodrome",
  edgeBps: 12,
  protocolFee: "25% of price improvement over Uniswap baseline",
};

function bazaarExtension(meta) {
  const input = (meta && meta.bazaarInput) || DEFAULT_BAZAAR_INPUT;
  const info = {
    input,
    output: {
      type: "json",
      example: (meta && meta.bazaarOutput) || DEFAULT_BAZAAR_OUTPUT,
    },
  };
  const hasBody = !!input.body;
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH"] },
          bodyType: { type: "string", enum: ["json", "form-data", "text"] },
          body: { type: "object" },
          queryParams: { type: "object", additionalProperties: { type: "string" } },
          headers: { type: "object", additionalProperties: { type: "string" } },
        },
        required: hasBody ? ["type", "method", "bodyType", "body"] : ["type", "method"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          type: { type: "string" },
          example: { type: "object" },
        },
        required: ["type"],
      },
    },
    required: ["input"],
  };
  return { info, schema };
}

function paymentRequiredBody(req, resourceMeta) {
  const meta = resourceMeta || {};
  const c = getConfig(meta);
  const builderCode = (process.env.X402_BUILDER_CODE || "").trim();
  const body = {
    x402Version: 2,
    error: `Payment required: sign an x402 v2 "exact" payment of $${c.priceUsd} USDC on Base and retry with an X-PAYMENT header.`,
    resource: {
      url: resourceUrl(req, meta.path),
      description:
        meta.description ||
        "Use when an agent is about to swap on Base and needs the best executable price before committing funds. Flow best-execution quotes: compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, and returns the best venue, expected output, edge vs Uniswap baseline, block number, and an expiry window so the agent knows exactly how long the price holds.",
      mimeType: "application/json",
      serviceName: "Flow",
      tags: ["trading", "defi", "base", "dex", "quotes"],
    },
    accepts: [paymentRequirements(req, meta)],
    extensions: { bazaar: bazaarExtension(meta) },
  };
  // Base Builder Code (ERC-8021): onchain attribution for x402 settlements.
  // Lets the CDP facilitator attribute payments to Flow for Base rewards.
  if (builderCode) {
    body.builderCode = builderCode;
    body.resource.builderCode = builderCode;
  }
  return body;
}

// x402 Foundation fixed this exact bug in their TypeScript SDK (fixes
// x402-foundation/x402#3722): @x402/fetch failed with "Failed to parse
// payment requirements" even on a correct 402. Flow's paid endpoints are
// called cross-origin by browser agents, so every response carrying a
// payment protocol header must expose both headers (merged with any
// expose list already set, never duplicated).
function exposePaymentHeaders(res) {
  const names = ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"];
  let existing = [];
  try {
    const cur = typeof res.getHeader === "function" ? res.getHeader("Access-Control-Expose-Headers") : null;
    if (cur) existing = String(cur).split(",").map((s) => s.trim()).filter(Boolean);
  } catch {}
  const merged = [...existing];
  for (const n of names) {
    if (!merged.some((e) => e.toLowerCase() === n.toLowerCase())) merged.push(n);
  }
  res.setHeader("Access-Control-Expose-Headers", merged.join(", "));
  // Cross-origin browser clients also need an allow-origin to read the
  // response at all; MCP and well-known endpoints already send "*".
  try {
    if (typeof res.getHeader !== "function" || !res.getHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
  } catch {}
}

function send402(res, req, errorDetail, resourceMeta) {
  const body = paymentRequiredBody(req, resourceMeta);
  if (errorDetail) body.error = errorDetail;
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  res.setHeader("PAYMENT-REQUIRED", header);
  exposePaymentHeaders(res);
  return res.status(402).json(body);
}

// ---------------------------------------------------------------------------
// Incoming payment parsing
// ---------------------------------------------------------------------------

function decodePaymentHeader(req) {
  const raw = req.headers["x-payment"] || req.headers["payment-signature"];
  if (!raw) return { ok: false, reason: "missing" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(raw).trim(), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "Payment header is not valid base64 JSON" };
  }
  if (payload.x402Version !== 2) return { ok: false, reason: "Unsupported x402Version (expected 2)" };
  if (payload.scheme !== "exact" && payload.accepted?.scheme !== "exact")
    return { ok: false, reason: "Unsupported scheme (expected exact)" };
  return { ok: true, payload };
}

// Local sanity checks before spending facilitator quota.
function localChecks(payload, meta) {
  const c = getConfig(meta);
  const network = payload.network || payload.accepted?.network;
  if (network !== c.network) return `Wrong network (expected ${c.network})`;
  const auth = payload.payload?.authorization;
  if (!auth) return "Missing EIP-3009 authorization in payment payload";
  if (String(auth.to).toLowerCase() !== c.payTo.toLowerCase()) return "Payment recipient does not match payTo";
  if (String(auth.value) !== c.amount) return `Payment amount must be exactly ${c.amount} atomic USDC`;
  const sig = payload.payload?.signature;
  if (!sig || !/^0x[0-9a-fA-F]+$/.test(sig)) return "Missing or malformed authorization signature";
  return null;
}

// ---------------------------------------------------------------------------
// CDP facilitator auth (Ed25519 JWT, stdlib crypto only)
// ---------------------------------------------------------------------------

// CDP issues the Ed25519 secret in several wraps depending on the export:
// raw base64 seed (32B), base64 seed+pubkey (64B), PEM, or base64-of-PEM,
// sometimes with JSON quotes. Normalize all of them; reject anything else
// with the decoded length so a bad value is diagnosable without seeing it.
function cdpPrivateKey(secret) {
  let s = (secret || "").trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  const asKey = (pemText) => {
    // Values pasted out of JSON downloads often carry literal \n escapes and
    // mangled line breaks. Unescape, then extract the base64 body and re-wrap
    // it cleanly under its original label before handing it to OpenSSL.
    let t = String(pemText).replace(/\\r\\n|\\n|\\r/g, "\n");
    const m = t.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
    let k;
    if (m) {
      const body = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
      const clean =
        "-----BEGIN " + m[1].trim() + "-----\n" +
        (body.match(/.{1,64}/g) || []).join("\n") +
        "\n-----END " + m[1].trim() + "-----\n";
      k = crypto.createPrivateKey({ key: clean, format: "pem" });
    } else {
      k = crypto.createPrivateKey({ key: t, format: "pem" });
    }
    if (k.asymmetricKeyType !== "ed25519")
      throw new Error("CDP_API_KEY_SECRET is a " + k.asymmetricKeyType + " key - the CDP key must be Ed25519");
    return k;
  };
  if (s.startsWith("-----BEGIN")) return asKey(s);
  const raw = Buffer.from(s.replace(/\s+/g, ""), "base64");
  if (raw.subarray(0, 10).toString("latin1").startsWith("-----BEGIN")) return asKey(raw.toString("utf8"));
  let seed = raw;
  if (seed.length === 64) seed = seed.subarray(0, 32); // some exports include the pubkey
  if (seed.length !== 32)
    throw new Error("CDP_API_KEY_SECRET unrecognized format (base64-decoded length " + raw.length + ")");
  const pkcs8Der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pem =
    "-----BEGIN PRIVATE KEY-----\n" +
    pkcs8Der.toString("base64").match(/.{1,64}/g).join("\n") +
    "\n-----END PRIVATE KEY-----\n";
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

function cdpJwt(method, path) {
  const keyId = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  if (!keyId || !secret) throw new Error("CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set");
  const key = cdpPrivateKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput =
    b64u({ alg: "EdDSA", typ: "JWT", kid: keyId }) +
    "." +
    b64u({
      iss: "cdp",
      sub: keyId,
      aud: ["cdp_service"],
      nbf: now,
      exp: now + 120,
      uri: `${method} ${CDP_HOST}${path}`,
    });
  const sig = crypto.sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${sig.toString("base64url")}`;
}

function facilitatorPath() {
  // "/platform/v2/x402" -> path portion used for the JWT `uri` claim
  const u = new URL(getConfig().facilitator);
  return u.pathname.replace(/\/+$/, "");
}

async function facilitatorCall(op, paymentPayload, paymentRequirements) {
  const c = getConfig();
  const path = `${facilitatorPath()}/${op}`; // /verify or /settle
  const url = `${c.facilitator}/${op}`;
  const headers = { "Content-Type": "application/json" };
  if (url.includes(CDP_HOST)) {
    headers.Authorization = `Bearer ${cdpJwt("POST", path)}`;
  }
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Facilitator ${op} returned non-JSON (HTTP ${r.status})`);
  }
  if (!r.ok) throw new Error(`Facilitator ${op} HTTP ${r.status}: ${text.slice(0, 200)}`);
  return data;
}

// ---------------------------------------------------------------------------
// Main gate: call at the top of a protected handler.
// Returns { payload, requirements } on success, or sends the HTTP response
// itself and returns null (caller must `return` immediately).
// ---------------------------------------------------------------------------

async function requirePayment(req, res, resourceMeta) {
  const bad = configError();
  if (bad) {
    res.status(500).json({ error: `x402 misconfigured: ${bad}` });
    return null;
  }

  const decoded = decodePaymentHeader(req);
  if (!decoded.ok) {
    if (decoded.reason === "missing") {
      send402(res, req, undefined, resourceMeta);
      return null;
    }
    res.status(400).json({ error: `Invalid payment: ${decoded.reason}` });
    return null;
  }

  const localErr = localChecks(decoded.payload, resourceMeta);
  if (localErr) {
    send402(res, req, `Invalid payment: ${localErr}. See accepts[] for exact requirements.`, resourceMeta);
    return null;
  }

  const requirements = paymentRequirements(req, resourceMeta);
  let verify;
  try {
    verify = await facilitatorCall("verify", decoded.payload, requirements);
  } catch (e) {
    res.status(502).json({ error: `Payment verification unavailable: ${e.message.slice(0, 150)}` });
    return null;
  }
  if (!verify.isValid) {
    send402(res, req, `Payment invalid: ${verify.invalidReason || "verification failed"}.`, resourceMeta);
    return null;
  }
  return { payload: decoded.payload, requirements, payer: verify.payer };
}

// Settle AFTER the resource has executed (authorization flow).
// Returns { success, response } — response is the SettlementResponse object.
async function settlePayment(gate) {
  const settled = await facilitatorCall("settle", gate.payload, gate.requirements);
  return { success: settled.success === true, response: settled };
}

function paymentResponseHeaders(res, settleResponse) {
  const b64 = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
  res.setHeader("PAYMENT-RESPONSE", b64); // v2 canonical
  res.setHeader("X-PAYMENT-RESPONSE", b64); // v1-style alias many clients read
  exposePaymentHeaders(res);
}

module.exports = {
  isEnabled,
  getConfig,
  configError,
  paymentRequiredBody,
  send402,
  decodePaymentHeader,
  localChecks,
  requirePayment,
  settlePayment,
  paymentResponseHeaders,
  USDC_BASE,
};
