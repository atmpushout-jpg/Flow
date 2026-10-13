// Tests for the fighter passports + the per-seat results feed:
//   - api/_records.js             the shared fold over the frozen
//                                 record set (api/_records-data.json)
//   - api/passport/index.js       minted passports only; unknown id
//                                 -> 404 (never a fabricated card)
//   - api/arena/results/index.js  per-seat counted rows (the SKR
//                                 format: "per-seat results")
//   - offchain/mint-passport.js   signature verification, counted /
//                                 exhibition separation, FLOWX rules,
//                                 the fictional PULSE is never minted
//
//   node tests/passport.test.js
//
// Everything is local and read-only. No network, no spending.

"use strict";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const assert = require("node:assert");

const records = require("../api/_records.js");
const passportHandler = require("../api/passport/index.js");
const resultsHandler = require("../api/arena/results/index.js");
const mint = require("../offchain/mint-passport.js");
const passportData = require("../api/_passport-data.json");

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

(async () => {
  // ------------------------------------------------------------------
  console.log("results feed (per-seat, counted only)");
  await t("24 counted seats: 4 matches x the 6-fighter cast", async () => {
    const body = records.resultsBody();
    assert.strictEqual(body.rows.length, 24);
    assert.deepStrictEqual(body.matches, ["arena-match-1", "arena-match-2", "arena-match-3", "arena-match-4"]);
    assert.ok(body.note.includes("Exhibitions are excluded"));
  });
  await t("FADE's match-4 seat: placing 1, $12.75 prize, $0.03 data, 4.25 efficiency", async () => {
    const row = records.countedRows().find((r) => r.matchId === "arena-match-4" && r.fighterId === "fade");
    assert.strictEqual(row.placing, 1);
    assert.strictEqual(row.prizeUsd, 12.75);
    assert.strictEqual(row.dataUsd, 0.03);
    assert.strictEqual(row.efficiency, 4.25);
  });
  await t("results endpoint serves the same rows", async () => {
    const res = mockRes();
    await resultsHandler({ method: "GET", url: "/api/arena/results" }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.rows.length, 24);
    assert.strictEqual(res.body.service, "flow-arena-results");
  });

  // ------------------------------------------------------------------
  console.log("passports — minted from the same rows");
  await t("the minted set is the house cast + FLOWX, and nothing else", async () => {
    assert.deepStrictEqual(Object.keys(passportData.passports).sort(), ["audrey", "echo", "fade", "flowx", "longshot", "rook", "vex"]);
  });
  await t("FADE counted: 4 matches, 4 wins, $51.00 prizes, $0.13 data, 3.92 per cent", async () => {
    const p = passportData.passports.fade;
    assert.strictEqual(p.counted.matches, 4);
    assert.strictEqual(p.counted.wins, 4);
    assert.strictEqual(p.counted.titles, 4);
    assert.strictEqual(p.counted.prizesUsd, 51);
    assert.strictEqual(p.counted.dataUsd, 0.13);
    assert.strictEqual(p.counted.efficiency.prizePerDataCent, 3.92);
    assert.strictEqual(p.counted.receipts.length, 4);
  });
  await t("cast career lines match the folded records", async () => {
    const expect = {
      rook: [30.6, 0.44], longshot: [10.2, 0.78], echo: [10.2, 0.72], vex: [0, 1.27], audrey: [0, 2.15],
    };
    for (const [id, [prizes, data]] of Object.entries(expect)) {
      const p = passportData.passports[id];
      assert.strictEqual(p.counted.prizesUsd, prizes, id);
      assert.strictEqual(p.counted.dataUsd, data, id);
      assert.strictEqual(p.counted.matches, 4, id);
    }
  });
  await t("FLOWX: counted is null (exhibition only); v1 series 3/3, $4.47 on $0.03", async () => {
    const p = passportData.passports.flowx;
    assert.strictEqual(p.counted, null);
    assert.ok(p.countedNote.includes("never played a counted match"));
    assert.strictEqual(p.exhibition.matches, 3);
    assert.strictEqual(p.exhibition.wins, 3);
    assert.strictEqual(p.exhibition.prizesUsd, 4.47);
    assert.strictEqual(p.exhibition.dataUsd, 0.03);
    assert.deepStrictEqual(
      p.exhibition.receipts.map((r) => r.matchId).sort(),
      ["exhibition-flowx-formula-v1-011267", "exhibition-flowx-formula-v1-165998", "exhibition-flowx-formula-v1-841656"]
    );
  });
  await t("counted and exhibition are separate sections, never blended", async () => {
    const p = passportData.passports.fade;
    assert.strictEqual(p.counted.matches, 4, "counted stays the 4 OFFICIAL matches");
    assert.ok(p.exhibition.matches > 0, "exhibitions live in their own section");
    const countedIds = new Set(p.counted.receipts.map((r) => r.matchId));
    for (const r of p.exhibition.receipts) assert.ok(!countedIds.has(r.matchId), "no exhibition receipt leaks into counted");
  });
  await t("passport figures equal the results-feed fold (can never disagree)", async () => {
    const rows = records.countedRows();
    for (const id of ["fade", "rook", "longshot", "echo", "vex", "audrey"]) {
      const mine = rows.filter((r) => r.fighterId === id);
      const p = passportData.passports[id];
      assert.strictEqual(mine.length, p.counted.matches, id);
      assert.strictEqual(Math.round(mine.reduce((s, r) => s + r.prizeUsd, 0) * 100) / 100, p.counted.prizesUsd, id);
      assert.strictEqual(Math.round(mine.reduce((s, r) => s + r.dataUsd, 0) * 100) / 100, p.counted.dataUsd, id);
    }
  });
  await t("every minted signature verifies against the ops wallet", async () => {
    for (const [id, p] of Object.entries(passportData.passports)) {
      assert.strictEqual(p.signature.signer, "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561", id);
      assert.strictEqual(mint.verifyPassport(p), true, id);
    }
    const forged = JSON.parse(JSON.stringify(passportData.passports.fade));
    forged.counted.prizesUsd = 9999;
    assert.strictEqual(mint.verifyPassport(forged), false, "a tampered figure breaks the signature");
  });
  await t("the fictional sample PULSE is never minted", async () => {
    assert.ok(!("pulse" in passportData.passports));
    assert.strictEqual(mint.buildPassport("pulse", new Date().toISOString()), null, "PULSE has no counted/exhibition record in the record set — no card");
  });

  // ------------------------------------------------------------------
  console.log("passport endpoint");
  await t("GET ?id=fade -> 200 signed passport; unknown id -> 404; bare GET lists the minted set", async () => {
    const res1 = mockRes();
    await passportHandler({ method: "GET", url: "/api/passport?id=fade" }, res1);
    assert.strictEqual(res1.code, 200);
    assert.strictEqual(res1.body.fighterId, "fade");
    const res2 = mockRes();
    await passportHandler({ method: "GET", url: "/api/passport?id=pulse" }, res2);
    assert.strictEqual(res2.code, 404);
    assert.strictEqual(res2.body.code, "NO_PASSPORT");
    const res3 = mockRes();
    await passportHandler({ method: "GET", url: "/api/passport" }, res3);
    assert.strictEqual(res3.code, 200);
    assert.ok(res3.body.passports.includes("flowx"));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });
