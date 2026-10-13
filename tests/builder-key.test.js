// Tests for the Early Builder Key program (v1):
//   - api/_builderkey.js   issuance (caps, one-per-address, hash-only
//                          storage), status, atomic budget reserve
//   - api/_x402.js         honoring through requirePayment: valid key
//                          serves free + decrements, invalid/exhausted
//                          keys fall through to the normal 402, and
//                          the keyless paid flow is byte-for-byte the
//                          old behavior (402 + exposed payment headers)
//   - api/quote/index.js   endpoint-level: builder key → 200 with
//                          builderKey.callsRemaining; malformed body
//                          refunds the reservation
//
//   node tests/builder-key.test.js
//
// Everything is local and mocked: in-memory store, stubbed
// facilitator fetch, stubbed quote engine. No network, no spending.

"use strict";

process.env.X402_PAYEE_ADDRESS = "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA"; // Flow payee (public)
process.env.X402_FACILITATOR_URL = "https://facilitator.test"; // non-CDP host → no JWT needed
process.env.X402_ENABLED = "true";
delete process.env.X402_PRICE_USD; // default $0.01 → amount "10000"
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const assert = require("node:assert");

const bk = require("../api/_builderkey.js");
const x402 = require("../api/_x402.js");

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

function freshStore() {
  const s = bk._test.createMemoryStore();
  bk._test.setStoreOverride(s);
  return s;
}

(async () => {
  // =========================================================================
  // Issuance
  // =========================================================================
  let store = freshStore();
  let issued;
  await test("issue: 201, key shown once, budget 100", async () => {
    issued = await bk.issueKey(store, { address: addr(1), botName: "testbot" });
    assert.strictEqual(issued.status, 201);
    assert.ok(issued.body.key.startsWith(bk.PROGRAM.KEY_PREFIX));
    assert.strictEqual(issued.body.callsBudget, 100);
    assert.strictEqual(issued.body.callsRemaining, 100);
    assert.strictEqual(issued.body.botName, "testbot");
  });

  await test("issue: store holds ONLY the hash — raw key appears nowhere", async () => {
    const dump = JSON.stringify([...store._kv.entries()]);
    assert.ok(!dump.includes(issued.body.key), "raw key leaked into store");
    const hash = bk.hashKey(issued.body.key);
    assert.ok(dump.includes(hash), "hash missing from store");
  });

  await test("issue: one per address — re-issue returns status, never the key", async () => {
    const again = await bk.issueKey(store, { address: addr(1).toUpperCase().replace("0X", "0x") });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyIssued, true);
    assert.ok(!("key" in again.body));
    const summary = await bk.programSummary(store);
    assert.strictEqual(summary.body.keysIssued, 1);
  });

  await test("issue: malformed + zero addresses rejected 400", async () => {
    assert.strictEqual((await bk.issueKey(store, { address: "0x123" })).status, 400);
    assert.strictEqual((await bk.issueKey(store, { address: "0x" + "0".repeat(40) })).status, 400);
    assert.strictEqual((await bk.issueKey(store, {})).status, 400);
    assert.strictEqual((await bk.issueKey(store, { address: 42 })).status, 400);
  });

  await test("issue: botName sanitized (control chars stripped, capped)", async () => {
    const r = await bk.issueKey(store, { address: addr(2), botName: "  bad\nname\t" + "x".repeat(60) });
    assert.strictEqual(r.status, 201);
    assert.ok(!/[\n\t]/.test(r.body.botName));
    assert.ok(r.body.botName.length <= 48);
  });

  await test("status: issued address reports budget; unknown reports issued:false", async () => {
    const s1 = await bk.getStatus(store, addr(1));
    assert.strictEqual(s1.body.issued, true);
    assert.strictEqual(s1.body.callsUsed, 0);
    assert.strictEqual(s1.body.callsRemaining, 100);
    const s2 = await bk.getStatus(store, addr(999));
    assert.strictEqual(s2.body.issued, false);
  });

  await test("status: never leaks the key or its hash", async () => {
    const s = await bk.getStatus(store, addr(1));
    const text = JSON.stringify(s.body);
    assert.ok(!text.includes(issued.body.key));
    assert.ok(!text.includes(bk.hashKey(issued.body.key)));
  });

  await test("caps: 25/day enforced with rollback (26th → 429, total stays 25)", async () => {
    const s = freshStore();
    for (let i = 0; i < 25; i++) {
      assert.strictEqual((await bk.issueKey(s, { address: addr(100 + i) })).status, 201);
    }
    const over = await bk.issueKey(s, { address: addr(200) });
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.body.code, "daily-cap");
    assert.strictEqual((await bk.programSummary(s)).body.keysIssued, 25);
  });

  await test("caps: 200 total enforced with rollback (201st → 409, total stays 200)", async () => {
    const s = freshStore();
    let n = 0;
    for (let batch = 0; batch < 8; batch++) {
      for (let i = 0; i < 25; i++) {
        assert.strictEqual((await bk.issueKey(s, { address: addr(1000 + n++) })).status, 201);
      }
      // simulate the next UTC day so the day cap doesn't mask the total cap
      for (const k of [...s._kv.keys()]) if (k.includes(":count:day:")) s._kv.delete(k);
    }
    const over = await bk.issueKey(s, { address: addr(9999) });
    assert.strictEqual(over.status, 409);
    assert.strictEqual(over.body.code, "program-full");
    assert.strictEqual((await bk.programSummary(s)).body.keysIssued, 200);
  });

  // =========================================================================
  // Honoring — reserve semantics on _builderkey directly
  // =========================================================================
  store = freshStore();
  const keyRes = await bk.issueKey(store, { address: addr(7) });
  const rawKey = keyRes.body.key;
  const keyHash = bk.hashKey(rawKey);

  await test("reserve: valid key decrements atomically (99, 98, …)", async () => {
    const r1 = await bk.tryReserve(store, rawKey);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.callsRemaining, 99);
    const r2 = await bk.tryReserve(store, rawKey);
    assert.strictEqual(r2.callsRemaining, 98);
    assert.strictEqual((await bk.getStatus(store, addr(7))).body.callsUsed, 2);
  });

  await test("reserve: 20 concurrent reservations consume exactly 20", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => bk.tryReserve(store, rawKey)));
    assert.ok(rs.every((r) => r.ok));
    const remainings = rs.map((r) => r.callsRemaining).sort((a, b) => a - b);
    assert.deepStrictEqual(remainings, Array.from({ length: 20 }, (_, i) => 78 + i));
    assert.strictEqual((await bk.getStatus(store, addr(7))).body.callsUsed, 22);
  });

  await test("reserve: bad format → format; unknown key → unknown (no consumption)", async () => {
    assert.strictEqual((await bk.tryReserve(store, "not-a-key")).reason, "format");
    assert.strictEqual((await bk.tryReserve(store, bk.generateKey())).reason, "unknown");
    assert.strictEqual((await bk.getStatus(store, addr(7))).body.callsUsed, 22);
  });

  await test("reserve: exhaustion at exactly 100, overshoot released", async () => {
    // burn the remaining 78 directly against the used counter
    for (let i = 0; i < 77; i++) await store.incr(`flow:builderkey:used:${keyHash}`);
    const last = await bk.tryReserve(store, rawKey);
    assert.strictEqual(last.ok, true);
    assert.strictEqual(last.callsRemaining, 0);
    const over = await bk.tryReserve(store, rawKey);
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.reason, "exhausted");
    assert.strictEqual((await bk.getStatus(store, addr(7))).body.callsUsed, 100);
  });

  await test("release: gives a call back, floors at 0", async () => {
    await bk.release(store, keyHash);
    assert.strictEqual((await bk.getStatus(store, addr(7))).body.callsUsed, 99);
    const s2 = freshStore();
    const k2 = await bk.issueKey(s2, { address: addr(8) });
    await bk.release(s2, bk.hashKey(k2.body.key)); // release with nothing used
    assert.strictEqual((await bk.getStatus(s2, addr(8))).body.callsUsed, 0);
  });

  // =========================================================================
  // Honoring — through the production _x402.requirePayment
  // =========================================================================
  store = freshStore();
  const live = await bk.issueKey(store, { address: addr(42) });
  const liveKey = live.body.key;
  facilitatorCalls = [];

  await test("gate: keyless request still gets the exact 402 challenge + exposed headers", async () => {
    const res = mockRes();
    const gate = await x402.requirePayment({ headers: { host: "flow-kg4x.vercel.app" }, url: "/api/quote" }, res);
    assert.strictEqual(gate, null);
    assert.strictEqual(res.statusCode, 402);
    assert.ok(res.getHeader("payment-required"), "PAYMENT-REQUIRED header missing");
    const expose = res.getHeader("access-control-expose-headers") || "";
    assert.ok(expose.includes("PAYMENT-REQUIRED"), "expose list lost PAYMENT-REQUIRED");
    assert.ok(expose.includes("PAYMENT-RESPONSE"), "expose list lost PAYMENT-RESPONSE");
    assert.strictEqual(res.body.accepts[0].amount, "10000");
    assert.strictEqual(res.body.accepts[0].payTo, PAYEE);
  });

  await test("gate: valid builder key serves free, decrements, no facilitator call", async () => {
    facilitatorCalls = [];
    const res = mockRes();
    const gate = await x402.requirePayment(
      { headers: { host: "flow-kg4x.vercel.app", "x-flow-builder-key": liveKey }, url: "/api/quote" },
      res
    );
    assert.ok(gate && gate.builderKey, "builder gate not returned");
    assert.strictEqual(gate.builderKey.callsRemaining, 99);
    assert.strictEqual(gate.payer, addr(42));
    assert.strictEqual(res.getHeader("x-flow-builder-key-remaining"), "99");
    assert.strictEqual(facilitatorCalls.length, 0, "facilitator was called for a free key call");
    assert.strictEqual((await bk.getStatus(store, addr(42))).body.callsUsed, 1);
  });

  await test("gate: invalid builder key falls through to the 402 (never an error wall)", async () => {
    const res = mockRes();
    const gate = await x402.requirePayment(
      { headers: { host: "flow-kg4x.vercel.app", "x-flow-builder-key": bk.generateKey() }, url: "/api/quote" },
      res
    );
    assert.strictEqual(gate, null);
    assert.strictEqual(res.statusCode, 402);
  });

  await test("gate: exhausted builder key falls through to the 402", async () => {
    const h = bk.hashKey(liveKey);
    for (let i = 0; i < 99; i++) await store.incr(`flow:builderkey:used:${h}`);
    const res = mockRes();
    const gate = await x402.requirePayment(
      { headers: { host: "flow-kg4x.vercel.app", "x-flow-builder-key": liveKey }, url: "/api/quote" },
      res
    );
    assert.strictEqual(gate, null);
    assert.strictEqual(res.statusCode, 402);
    assert.strictEqual((await bk.getStatus(store, addr(42))).body.callsUsed, 100);
  });

  await test("gate: paid flow regression — valid X-PAYMENT still verifies to a gate", async () => {
    facilitatorCalls = [];
    const payload = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        authorization: {
          from: "0x1111111111111111111111111111111111111111",
          to: PAYEE,
          value: "10000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "ab".repeat(32),
        },
        signature: "0x" + "cd".repeat(65),
      },
    };
    const res = mockRes();
    const gate = await x402.requirePayment(
      {
        headers: {
          host: "flow-kg4x.vercel.app",
          "x-payment": Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
        url: "/api/quote",
      },
      res
    );
    assert.ok(gate, "paid gate not returned");
    assert.ok(!gate.builderKey, "paid gate must not carry a builderKey");
    assert.strictEqual(gate.payer, "0x1111111111111111111111111111111111111111");
    assert.ok(facilitatorCalls.some((u) => u.endsWith("/verify")));
  });

  await test("gate: releaseBuilderKey is a no-op for payment gates and null", async () => {
    await x402.releaseBuilderKey(null);
    await x402.releaseBuilderKey({ payer: addr(1) });
    await x402.releaseBuilderKey({ builderKey: { keyHash: bk.hashKey(liveKey) } });
    assert.strictEqual((await bk.getStatus(store, addr(42))).body.callsUsed, 99);
  });

  // =========================================================================
  // Endpoint level — /api/quote with a stubbed quote engine
  // =========================================================================
  store = freshStore();
  const ep = await bk.issueKey(store, { address: addr(77) });
  const epKey = ep.body.key;

  const libPath = require.resolve("../api/_lib.js");
  require.cache[libPath] = {
    id: libPath,
    filename: libPath,
    loaded: true,
    exports: {
      getBestQuote: async () => ({ bestOut: "396812", venue: "aerodrome", edgeBps: 12 }),
    },
  };
  const quoteHandler = require("../api/quote/index.js");
  const quoteReq = (headers, body) => ({ method: "POST", headers, url: "/api/quote", body });

  await test("endpoint: builder key → 200 with builderKey.callsRemaining, no payment block", async () => {
    const res = mockRes();
    await quoteHandler(
      quoteReq(
        { host: "flow-kg4x.vercel.app", "x-flow-builder-key": epKey },
        { tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x4200000000000000000000000000000000000006", amountIn: "1000000" }
      ),
      res
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.bestOut, "396812");
    assert.deepStrictEqual(res.body.builderKey, { callsRemaining: 99 });
    assert.ok(!res.body.payment, "free call must not carry a payment block");
  });

  await test("endpoint: no key → 402 exactly as before", async () => {
    const res = mockRes();
    await quoteHandler(
      quoteReq(
        { host: "flow-kg4x.vercel.app" },
        { tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x4200000000000000000000000000000000000006", amountIn: "1000000" }
      ),
      res
    );
    assert.strictEqual(res.statusCode, 402);
    assert.strictEqual(res.body.x402Version, 2);
  });

  await test("endpoint: builder key + malformed body → 400 and the call is refunded", async () => {
    const before = (await bk.getStatus(store, addr(77))).body.callsUsed;
    const res = mockRes();
    await quoteHandler(quoteReq({ host: "flow-kg4x.vercel.app", "x-flow-builder-key": epKey }, {}), res);
    assert.strictEqual(res.statusCode, 400);
    const after = (await bk.getStatus(store, addr(77))).body.callsUsed;
    assert.strictEqual(after, before, "malformed request consumed builder budget");
  });

  console.log(`\nALL ${passed} BUILDER-KEY TESTS PASSED`);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
