// Tests for the Flow Arena registration API (v1):
//   - api/_register-validator.js  the port of offchain/arena-
//     register.js's validateSpec — a differential battery runs both
//     over the same specs and requires IDENTICAL verdicts
//   - api/_register.js            create (201 + VALIDATED), duplicate
//     name (409 NAME_TAKEN), read-back, computed funnel status
//   - api/arena/register/index.js endpoint-level behavior
//
//   node tests/register.test.js
//
// Everything is local: in-memory store (Upstash env vars removed).
// No network, no spending.

"use strict";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const assert = require("node:assert");

const validator = require("../api/_register-validator.js");
const houseValidator = require("../offchain/arena-register.js");
const register = require("../api/_register.js");
const handler = require("../api/arena/register/index.js");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}

function mockRes() {
  return {
    code: null, body: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

// A complete, valid spec (the shape the Adjustment Center emits).
const GOOD = {
  specVersion: 1,
  name: "TESTREG",
  owner: { name: "Test Owner", payoutWallet: "0x1111111111111111111111111111111111111111" },
  display: { emoji: "🌱", color: "#feca57", tagline: "The playbook fighter: a bit of everything, rules for every case." },
  dataBudgetUsd: 0.3,
  strategy: {
    target: "smartMoneyTop",
    entry: { minSpikeScore: 0, minVerdictScore: 75, requireVerdictSafe: true, requireDeepLiquidity: false, requireSmartMoneyBuy: false, maxPositions: 2, maxEntriesPerMatch: null },
    sizing: { fractionOfCash: 0.2, minBuyUsd: 1, cashReserveFraction: 0 },
    data: { buySignalsFeed: true, quoteBeforeBuy: true, verdictBeforeBuy: true, verdictOncePerToken: false, requoteHoldingsPerRound: 0, reverifyHoldingsEveryRounds: 0 },
    exits: [
      { type: "pctMove", atPct: -6, fraction: 1 },
      { type: "pctMove", atPct: 5, fraction: 1 },
      { type: "maxHoldRounds", rounds: 6 },
      { type: "smartMoneyExit" },
    ],
    scramble: { action: "pass", fractionOfCash: 0.2, requireVerdictSafe: true, requireSmartMoneyBuy: false },
  },
  participation: { floor: true, events: true },
};

(async () => {
  const store = register.getStore();
  assert.strictEqual(store.kind, "memory", "tests must run on the in-memory store");

  // ------------------------------------------------------------------
  console.log("validator port — differential battery vs offchain/arena-register.js");
  const cases = {
    good: GOOD,
    reservedHouse: { ...GOOD, name: "fade" },
    reservedFlowx: { ...GOOD, name: "FLOWX" },
    reservedFormula: { ...GOOD, name: "Formula" },
    overCap: { ...GOOD, dataBudgetUsd: 0.61 },
    atCap: { ...GOOD, dataBudgetUsd: 0.6 },
    zeroBudget: { ...GOOD, dataBudgetUsd: 0 },
    badWallet: { ...GOOD, owner: { name: "X", payoutWallet: "0x123" } },
    zeroWallet: { ...GOOD, owner: { name: "X", payoutWallet: "0x0000000000000000000000000000000000000000" } },
    bannedKey: { ...GOOD, strategy: { ...GOOD.strategy, webhook: "x" } },
    codeInString: { ...GOOD, display: { tagline: "run require('fs') now" } },
    urlInString: { ...GOOD, display: { tagline: "see https://example.com" } },
    unknownTarget: { ...GOOD, strategy: { ...GOOD.strategy, target: "moon" } },
    signalsMissing: { ...GOOD, strategy: { ...GOOD.strategy, data: { ...GOOD.strategy.data, buySignalsFeed: false } } },
    verdictGateNoData: { ...GOOD, strategy: { ...GOOD.strategy, data: { ...GOOD.strategy.data, verdictBeforeBuy: false } } },
    sizingContradiction: { ...GOOD, strategy: { ...GOOD.strategy, sizing: { fractionOfCash: 0.8, minBuyUsd: 1, cashReserveFraction: 0.5 } } },
    unknownField: { ...GOOD, turboMode: true },
    badVersion: { ...GOOD, specVersion: 2 },
    noOwner: { specVersion: 1, name: "NOOWNER1", dataBudgetUsd: 0.3, strategy: { target: "coldest" } },
    minimal: { specVersion: 1, name: "MINIMAL1", owner: { name: "M", payoutWallet: "0x2222222222222222222222222222222222222222" }, dataBudgetUsd: 0.6, strategy: { target: "coldest" } },
    notAnObject: "hello",
    anArray: [1, 2, 3],
  };
  for (const [name, spec] of Object.entries(cases)) {
    await t(`identical verdict: ${name}`, async () => {
      assert.strictEqual(JSON.stringify(validator.validateSpec(spec)), JSON.stringify(houseValidator.validateSpec(spec)));
    });
  }
  await t("identical verdict: malformed JSON text", async () => {
    assert.strictEqual(JSON.stringify(validator.validateSpecText("{bad json")), JSON.stringify(houseValidator.validateSpecText("{bad json")));
  });

  // ------------------------------------------------------------------
  console.log("create + read-back");
  await t("valid spec -> 201, status VALIDATED, normalized spec stored", async () => {
    const r = await register.createRegistration(store, GOOD);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.fighterId, "testreg");
    assert.strictEqual(r.body.name, "TESTREG");
    assert.strictEqual(r.body.status, "VALIDATED");
    assert.strictEqual(r.body.qualification.qualified, false);
    assert.strictEqual(r.body.qualification.roundsRecorded, 0);
    assert.strictEqual(r.body.spec.dataBudgetUsd, 0.3);
    assert.ok(/^[0-9a-f]{64}$/.test(r.body.specHash), "specHash is a sha256");
  });
  await t("GET read-back returns the stored record", async () => {
    const r = await register.getRegistration(store, "testreg");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.name, "TESTREG");
    assert.strictEqual(r.body.spec.owner.payoutWallet, GOOD.owner.payoutWallet);
  });
  await t("GET unknown id -> 404 NOT_REGISTERED", async () => {
    const r = await register.getRegistration(store, "nosuchbot");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, "NOT_REGISTERED");
  });

  // ------------------------------------------------------------------
  console.log("refusals");
  await t("reserved name -> 400 with the validator's NAME_RESERVED error verbatim", async () => {
    const r = await register.createRegistration(store, { ...GOOD, name: "FADE" });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "NAME_RESERVED");
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length >= 1);
    assert.strictEqual(r.body.errors[0].message, houseValidator.validateSpec({ ...GOOD, name: "FADE" }).errors[0].message);
  });
  await t("duplicate name -> 409 NAME_TAKEN (case-insensitive)", async () => {
    const r = await register.createRegistration(store, { ...GOOD, name: "testreg" });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "NAME_TAKEN");
  });
  await t("over-cap budget -> 400 DATA_BUDGET_OVER_CAP", async () => {
    const r = await register.createRegistration(store, { ...GOOD, name: "OVERBUD1", dataBudgetUsd: 0.61 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "DATA_BUDGET_OVER_CAP");
  });
  await t("bad wallet -> 400 PAYOUT_WALLET_INVALID", async () => {
    const r = await register.createRegistration(store, { ...GOOD, name: "BADWAL1", owner: { name: "X", payoutWallet: "0x123" } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "PAYOUT_WALLET_INVALID");
  });
  await t("a spec carrying code is refused (specs are data, never code)", async () => {
    const r = await register.createRegistration(store, { ...GOOD, name: "CODEBOT1", strategy: { ...GOOD.strategy, script: "steal()" } });
    assert.strictEqual(r.status, 400);
    assert.ok(r.body.errors.some((e) => e.code === "BANNED_FIELD"));
  });

  // ------------------------------------------------------------------
  console.log("computed funnel status (never hand-set)");
  await t("QUALIFIED computes from recorded rounds: >=3, in-budget, net PnL > 0", async () => {
    const rec = JSON.parse(await store.get(register.KEY_FIGHTER + "testreg"));
    rec.rounds = [
      { netPnl: 0.05, withinBudget: true },
      { netPnl: 0.02, withinBudget: true },
      { netPnl: -0.01, withinBudget: true },
    ];
    const q = register.evaluateStatus(rec);
    assert.strictEqual(q.status, "QUALIFIED");
    assert.strictEqual(q.netPnlUsd, 0.06);
    rec.rounds[1].withinBudget = false;
    assert.strictEqual(register.evaluateStatus(rec).status, "VALIDATED", "an out-of-budget round blocks qualification");
    rec.rounds[1].withinBudget = true;
    rec.rounds = rec.rounds.slice(0, 2);
    assert.strictEqual(register.evaluateStatus(rec).status, "VALIDATED", "two rounds is not enough");
  });

  // ------------------------------------------------------------------
  console.log("endpoint level");
  await t("POST /api/arena/register -> 201; GET ?id= -> 200; duplicate POST -> 409", async () => {
    const res1 = mockRes();
    await handler({ method: "POST", url: "/api/arena/register", body: { ...GOOD, name: "WEBREG1" } }, res1);
    assert.strictEqual(res1.code, 201, JSON.stringify(res1.body));
    const res2 = mockRes();
    await handler({ method: "GET", url: "/api/arena/register?id=webreg1" }, res2);
    assert.strictEqual(res2.code, 200);
    assert.strictEqual(res2.body.name, "WEBREG1");
    const res3 = mockRes();
    await handler({ method: "POST", url: "/api/arena/register", body: { ...GOOD, name: "WEBREG1" } }, res3);
    assert.strictEqual(res3.code, 409);
    const res4 = mockRes();
    await handler({ method: "GET", url: "/api/arena/register" }, res4);
    assert.strictEqual(res4.code, 200);
    assert.strictEqual(res4.body.service, "flow-arena-register");
    const res5 = mockRes();
    await handler({ method: "POST", url: "/api/arena/register", body: "{not json" }, res5);
    assert.strictEqual(res5.code, 400);
    assert.strictEqual(res5.body.code, "MALFORMED_JSON");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });
