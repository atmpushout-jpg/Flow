// Tests for the production /api/fill endpoint (Path C — sell the fill as a
// paid instruction):
//   - api/_fill.js          pure fee math: the design-doc prototype cases
//   - api/fill/index.js     handler: zero-improvement serves free with NO
//                           gate and NO facilitator call; unpaid improving
//                           fill gets a 402 whose accepts[0].amount is the
//                           DYNAMIC fee; a stale pinned block is a 409 with
//                           no facilitator call; a builder-key gate is
//                           released and answered with a priced 402 (keys
//                           do not cover fill)
//   - api/_lib.js blockTag  pinned re-quote support (unit-checked via the
//                           stub contract below: opts.blockTag is forwarded)
//
//   node tests/fill.test.js
//
// Everything is local and mocked: in-memory builder-key store, stubbed
// facilitator fetch, stubbed quote engine (require-cache), stubbed chain
// block number. No network, no spending.
//
// Prototype note: the design doc's Case 1 records fee $0.0917 and
// improvement $0.3667 from the UNTRUNCATED live outputs. Recomputing from
// the doc's displayed (3-decimal truncated) outputs — 138.343 / 138.852 —
// with the authoritative formula gives improvement $0.366577 and fee
// $0.091644 (atomic 91644). The tests assert the formula's exact result on
// the truncated inputs AND that it sits within $0.0001 of the recorded
// prototype values. The cap case reproduces exactly ($0.1000, cap binds)
// and the zero case is exactly $0.

"use strict";

process.env.X402_PAYEE_ADDRESS = "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA"; // Flow payee (public)
process.env.X402_FACILITATOR_URL = "https://facilitator.test"; // non-CDP host → no JWT needed
process.env.X402_ENABLED = "true";
delete process.env.X402_PRICE_USD;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const assert = require("node:assert");

const fill = require("../api/_fill.js");
const bk = require("../api/_builderkey.js");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const PAYEE = process.env.X402_PAYEE_ADDRESS;
const addr = (i) => `0x${i.toString(16).padStart(40, "0")}`;

// --- facilitator fetch stub -------------------------------------------------
let facilitatorCalls = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  facilitatorCalls.push(u);
  if (u.startsWith("https://facilitator.test")) {
    const op = u.split("/").pop();
    const payload =
      op === "verify"
        ? { isValid: true, payer: "0x1111111111111111111111111111111111111111" }
        : { success: true, transaction: "0x" + "ef".repeat(32), network: "eip155:8453", payer: "0x1111111111111111111111111111111111111111" };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  }
  throw new Error(`unexpected fetch in tests: ${u}`);
};

// --- mock req/res ------------------------------------------------------------
function mockRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    headers,
    setHeader(k, v) { headers.set(String(k).toLowerCase(), String(v)); },
    getHeader(k) { return headers.get(String(k).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// --- stubbed quote engine (require-cache, like builder-key.test.js) ---------
const E18 = (human) => {
  const [w, f = ""] = String(human).split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
};
let currentBlock = 1000;
let quoteCalls = 0;
let quoteScenario = "improve"; // improve | cap | zero
const QUOTES = {
  improve: { bestOut: E18("138.852"), uniswapOut: E18("138.343"), venue: "aerodrome", venueKey: 100 },
  cap: { bestOut: E18("138.852"), uniswapOut: E18("138.024"), venue: "aerodrome", venueKey: 100 },
  zero: { bestOut: E18("138.343"), uniswapOut: E18("138.343"), venue: "uniswap", venueKey: 3000 },
};
const libPath = require.resolve("../api/_lib.js");
require.cache[libPath] = {
  id: libPath,
  filename: libPath,
  loaded: true,
  exports: {
    getBestQuote: async (tokenIn, tokenOut, amountIn, opts = {}) => {
      quoteCalls++;
      const q = QUOTES[quoteScenario];
      const blockNumber = opts.blockTag != null ? Number(opts.blockTag) : currentBlock;
      const best = BigInt(q.bestOut);
      return {
        amountIn: String(amountIn),
        bestOut: best.toString(),
        venue: q.venue,
        venueKey: q.venueKey,
        routeType: "direct",
        uniswapOut: BigInt(q.uniswapOut).toString(),
        edgeBps: Number(((best - BigInt(q.uniswapOut)) * 10000n) / (BigInt(q.uniswapOut) || 1n)),
        blockNumber,
        quotedAt: new Date().toISOString(),
        latencyMs: 1,
        liquidity: "deep",
        spreadBps: 0,
        expiresAtBlock: blockNumber + (opts.validBlocks || 10),
        validForBlocks: opts.validBlocks || 10,
        minOutput: ((best * 9950n) / 10000n).toString(),
        minOutputBps: 50,
      };
    },
    provider: () => ({ getBlockNumber: async () => currentBlock }),
  },
};
const fillHandler = require("../api/fill/index.js");
const fillReq = (headers, body) => ({ method: "POST", headers: { host: "flow-kg4x.vercel.app", ...headers }, url: "/api/fill", body });
const BODY = { tokenIn: USDC, tokenOut: VIRTUAL, amountIn: "100000000" };

(async () => {
  // =========================================================================
  // Pure fee math — prototype cases
  // =========================================================================
  await test("math case 1: $100 USDC->VIRTUAL prototype (fee ≈ $0.0917, exact 91644 atomic on truncated inputs)", async () => {
    const f = fill.computeFillFee({
      amountIn: "100000000", // $100 USDC atomic
      bestOut: E18("138.852").toString(),
      uniswapOut: E18("138.343").toString(),
      usdPerTokenIn: "0.000001", // USDC atomic -> USD
    });
    assert.ok(Math.abs(f.improvementValueUsd - 0.3667) < 0.0002, `improvementValueUsd ${f.improvementValueUsd}`);
    assert.ok(Math.abs(f.feeUsd - 0.0917) < 0.0001, `feeUsd ${f.feeUsd} not within $0.0001 of prototype $0.0917`);
    assert.strictEqual(f.feeUsdAtomic, 91644n);
    assert.strictEqual(f.feeUsd, 0.091644);
    assert.strictEqual(f.capApplied, false);
    assert.strictEqual(f.improvementBps, 36);
  });

  await test("math case 1 (human-scale inputs): same fee from whole-token amounts", async () => {
    const f = fill.computeFillFee({
      amountIn: 100, bestOut: "138852", uniswapOut: "138343", usdPerTokenIn: "1",
    });
    // amountIn in whole USDC ($1 per amountIn unit), outputs in milli-units:
    // the improvement ratio is scale-free, so the fee must be identical.
    assert.strictEqual(f.feeUsdAtomic, 91644n);
  });

  await test("math case 2: cap binds — fee exactly $0.1000, capApplied true, uncapped ≈ $0.1491", async () => {
    const f = fill.computeFillFee({
      amountIn: "100000000",
      bestOut: E18("138.852").toString(),
      uniswapOut: E18("138.024").toString(),
      usdPerTokenIn: "0.000001",
    });
    assert.strictEqual(f.capApplied, true);
    assert.strictEqual(f.feeUsdAtomic, 100000n);
    assert.strictEqual(f.feeUsd, 0.1);
    assert.ok(Math.abs(f.uncappedFeeUsd - 0.1491) < 0.0001, `uncapped ${f.uncappedFeeUsd}`);
  });

  await test("math case 3: zero improvement — fee exactly $0", async () => {
    const f = fill.computeFillFee({
      amountIn: "100000000",
      bestOut: E18("138.343").toString(),
      uniswapOut: E18("138.343").toString(),
      usdPerTokenIn: "0.000001",
    });
    assert.strictEqual(f.feeUsdAtomic, 0n);
    assert.strictEqual(f.feeUsd, 0);
    assert.strictEqual(f.capApplied, false);
    assert.strictEqual(f.improvementBps, 0);
  });

  await test("math: non-USDC tokenIn via exact rational rate (WETH-style quote rate)", async () => {
    // tokenIn->USDC conversion quote: amountIn 1e18 -> 2500 USDC atomic*1e6
    const rate = { numerator: 2500000000n, denominator: 1000000000000000000n * 1000000n };
    const f = fill.computeFillFee({
      amountIn: "1000000000000000000", bestOut: "1010000", uniswapOut: "1000000", usdPerTokenIn: rate,
    });
    // improvement 10000 USDC-out units; value = 10000*amountIn/bestOut tokenIn
    // ≈ $24.7524 of improvement on a $2500 input → uncapped 25% ≈ $6.1881,
    // but the 10 bps cap on the $2500 input is exactly $2.50 and binds.
    assert.ok(Math.abs(f.improvementValueUsd - 24.7524) < 0.001, `impVal ${f.improvementValueUsd}`);
    assert.ok(Math.abs(f.uncappedFeeUsd - 6.1881) < 0.001, `uncapped ${f.uncappedFeeUsd}`);
    assert.strictEqual(f.capApplied, true);
    assert.strictEqual(f.feeUsd, 2.5);
    assert.strictEqual(f.feeUsdAtomic, 2500000n);
    assert.strictEqual(f.improvementBps, 100);
  });

  await test("route package: aerodrome router + calldata with recipient, uniswap router exact", async () => {
    const quote = {
      venue: "aerodrome", venueKey: 100, routeType: "direct",
      bestOut: E18("138.852").toString(), uniswapOut: E18("138.343").toString(),
      minOutput: E18("138.157").toString(), minOutputBps: 50,
      blockNumber: 1000, expiresAtBlock: 1010, validForBlocks: 10, quotedAt: new Date().toISOString(),
    };
    const fee = fill.computeFillFee({ amountIn: "100000000", bestOut: quote.bestOut, uniswapOut: quote.uniswapOut, usdPerTokenIn: "0.000001" });
    const pkg = fill.buildRoutePackage({ quote, tokenIn: USDC, tokenOut: VIRTUAL, amountIn: "100000000", fee, recipient: addr(9) });
    assert.strictEqual(pkg.router, "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5");
    assert.strictEqual(fill.ROUTERS.uniswap, "0x2626664c2603336E57B271c5C0b26F421741e481");
    assert.ok(pkg.calldata && pkg.calldata.startsWith("0x"), "calldata missing");
    assert.strictEqual(pkg.fee.rule, "25% of price improvement over Uniswap baseline, capped at 10 bps of output");
    assert.strictEqual(pkg.expectedOut, quote.bestOut);
    const noRecip = fill.buildRoutePackage({ quote, tokenIn: USDC, tokenOut: VIRTUAL, amountIn: "100000000", fee });
    assert.strictEqual(noRecip.calldata, null);
    assert.ok(noRecip.calldataNote.includes("recipient"));
  });

  // =========================================================================
  // Handler
  // =========================================================================
  quoteScenario = "zero";
  await test("handler zero-improvement → 200, charged:false, fee $0, NO gate / NO facilitator call", async () => {
    facilitatorCalls = []; quoteCalls = 0;
    const res = mockRes();
    await fillHandler(fillReq({}, { ...BODY }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.charged, false);
    assert.strictEqual(res.body.fee.amountUsd, 0);
    assert.strictEqual(res.body.fee.feeUsd, 0);
    assert.ok(res.body.reason.includes("No improvement"));
    assert.strictEqual(res.body.venue, "uniswap"); // baseline route package
    assert.strictEqual(facilitatorCalls.length, 0, "facilitator called for a $0 fill");
  });

  quoteScenario = "improve";
  await test("handler unpaid → 402 with the DYNAMIC fee in accepts[0].amount", async () => {
    facilitatorCalls = [];
    const res = mockRes();
    await fillHandler(fillReq({}, { ...BODY }), res);
    assert.strictEqual(res.statusCode, 402);
    assert.strictEqual(res.body.accepts[0].amount, "91644");
    assert.strictEqual(res.body.accepts[0].payTo, PAYEE);
    assert.ok(res.getHeader("payment-required"), "PAYMENT-REQUIRED header missing");
    const expose = res.getHeader("access-control-expose-headers") || "";
    assert.ok(expose.includes("PAYMENT-REQUIRED"));
  });

  await test("handler stale pinned block → 409, no facilitator call, no quote call", async () => {
    facilitatorCalls = []; quoteCalls = 0; currentBlock = 1000;
    const res = mockRes();
    await fillHandler(fillReq({}, { ...BODY, blockNumber: 900 }), res); // 900+10 < 1000
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.body.error.includes("quote expired"));
    assert.strictEqual(facilitatorCalls.length, 0);
    assert.strictEqual(quoteCalls, 0);
  });

  await test("handler future pinned block → 400", async () => {
    const res = mockRes();
    await fillHandler(fillReq({}, { ...BODY, blockNumber: 1001 }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("handler builder-key gate → reservation released + priced 402 (keys do not cover fill)", async () => {
    const store = bk._test.createMemoryStore();
    bk._test.setStoreOverride(store);
    const issued = await bk.issueKey(store, { address: addr(55) });
    assert.strictEqual(issued.status, 201);
    facilitatorCalls = [];
    const res = mockRes();
    await fillHandler(fillReq({ "x-flow-builder-key": issued.body.key }, { ...BODY }), res);
    assert.strictEqual(res.statusCode, 402);
    assert.ok(res.body.error.includes("not covered by Early Builder Keys"), res.body.error);
    assert.strictEqual(res.body.accepts[0].amount, "91644");
    assert.strictEqual((await bk.getStatus(store, addr(55))).body.callsUsed, 0, "builder reservation was not released");
    assert.strictEqual(facilitatorCalls.length, 0);
  });

  await test("handler paid → re-quotes pinned, settles, 200 with package + payment block", async () => {
    bk._test.setStoreOverride(bk._test.createMemoryStore());
    quoteCalls = 0; facilitatorCalls = [];
    const payload = {
      x402Version: 2, scheme: "exact", network: "eip155:8453",
      payload: {
        authorization: { from: addr(1), to: PAYEE, value: "91644", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "ab".repeat(32) },
        signature: "0x" + "cd".repeat(65),
      },
    };
    const res = mockRes();
    await fillHandler(fillReq(
      { "x-payment": Buffer.from(JSON.stringify(payload)).toString("base64") },
      { ...BODY, blockNumber: currentBlock, recipient: addr(9) }
    ), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.charged, true);
    assert.strictEqual(res.body.router, "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5");
    assert.ok(res.body.calldata && res.body.calldata.startsWith("0x"));
    assert.strictEqual(res.body.payment.transaction, "0x" + "ef".repeat(32));
    assert.ok(facilitatorCalls.some((u) => u.endsWith("/verify")));
    assert.ok(facilitatorCalls.some((u) => u.endsWith("/settle")));
    assert.ok(quoteCalls >= 2, "expected initial quote + pinned re-quote");
    assert.ok(res.getHeader("payment-response"), "PAYMENT-RESPONSE header missing");
  });

  await test("handler: 405 non-POST and 400 missing fields", async () => {
    const r1 = mockRes();
    await fillHandler({ method: "GET", headers: { host: "x" }, url: "/api/fill", body: {} }, r1);
    assert.strictEqual(r1.statusCode, 405);
    const r2 = mockRes();
    await fillHandler(fillReq({}, { tokenIn: USDC }), r2);
    assert.strictEqual(r2.statusCode, 400);
  });

  console.log(`\nALL ${passed} FILL TESTS PASSED`);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
