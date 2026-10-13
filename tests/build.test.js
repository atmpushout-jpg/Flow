// Tests for the web fighter builds (v1):
//   - api/_build.js        creation (validator-voice refusals, duplicate
//                          name/spec guards, hash-only token storage),
//                          dashboard assembly, one-step tuning guard,
//                          META-rule recommendations
//   - api/_forgecore.js    spec derivation must be IDENTICAL to the
//                          Telegram bot's (telegram/flow-bot.js loads
//                          the forge.html core at runtime; the API uses
//                          the extracted copy — this suite proves the
//                          two agree on every style × dial combination)
//   - api/build/index.js + api/build/apply-tuning/index.js
//                          endpoint-level behavior
//
//   node tests/build.test.js
//
// Everything is local and mocked: in-memory store (Upstash env vars
// removed), published arena JSON served from the repo files on disk
// through a fetch stub. No network, no spending.

"use strict";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const build = require("../api/_build.js");
const bk = require("../api/_builderkey.js");
const bot = require("../telegram/flow-bot.js");
const buildHandler = require("../api/build/index.js");
const tuneHandler = require("../api/build/apply-tuning/index.js");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}

// Published arena state: serve the repo's real files through fetch.
const REPO = path.join(__dirname, "..");
const PUBLISHED_FILES = {
  "/arena-standings.json": path.join(REPO, "arena-standings.json"),
  "/arena-live.json": path.join(REPO, "arena-live.json"),
  "/arena-buyin.json": path.join(REPO, "arena-buyin.json"),
};
global.fetch = async (url) => {
  const u = new URL(String(url));
  const file = PUBLISHED_FILES[u.pathname];
  if (!file) throw new Error(`unexpected fetch in tests: ${url}`);
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ok: true, status: 200, json: async () => body };
};
const publishedFixtures = () => ({
  standings: JSON.parse(fs.readFileSync(PUBLISHED_FILES["/arena-standings.json"], "utf8")),
  live: JSON.parse(fs.readFileSync(PUBLISHED_FILES["/arena-live.json"], "utf8")),
  buyin: JSON.parse(fs.readFileSync(PUBLISHED_FILES["/arena-buyin.json"], "utf8")),
});

function mockRes() {
  return {
    code: null, body: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

const GOOD = { name: "PULSE9", style: "sniper", dials: { appetite: "careful", aggression: "big", patience: "ride" }, ownerName: "Mara Voss" };

(async () => {
  const store = build.getStore();
  assert.strictEqual(store.kind, "memory", "tests must run on the in-memory store");

  // ------------------------------------------------------------------
  console.log("validation refusals (validator's sentences)");
  await t("malformed name refused with the validator's sentence", async () => {
    const r = await build.createBuild(store, { ...GOOD, name: "BAD NAME" });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /a ring name is 2–10 characters, letters and digits only/);
  });
  await t("one-character and over-long names refused", async () => {
    assert.strictEqual((await build.createBuild(store, { ...GOOD, name: "A" })).status, 400);
    assert.strictEqual((await build.createBuild(store, { ...GOOD, name: "ABCDEFGHIJK" })).status, 400);
  });
  await t("reserved house names refused (cast, FLOWX, FORMULA — any case)", async () => {
    for (const n of ["FADE", "vex", "FlowX", "FORMULA", "ROOK"]) {
      const r = await build.createBuild(store, { ...GOOD, name: n });
      assert.strictEqual(r.status, 400, n);
      assert.match(r.body.error, /is a house name/, n);
    }
  });
  await t("unknown style and unknown dial refused in plain words", async () => {
    const r1 = await build.createBuild(store, { ...GOOD, style: "wizard" });
    assert.strictEqual(r1.status, 400);
    assert.match(r1.body.error, /six Forge styles/);
    const r2 = await build.createBuild(store, { ...GOOD, dials: { appetite: "huge", aggression: "big", patience: "ride" } });
    assert.strictEqual(r2.status, 400);
    assert.match(r2.body.error, /Data appetite dial takes one of/);
  });

  // ------------------------------------------------------------------
  console.log("creation");
  let created;
  await t("happy path: 201, built status, dashboard link, spec shape", async () => {
    const r = await build.createBuild(store, GOOD);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    created = r.body;
    assert.strictEqual(r.body.status, "built");
    assert.strictEqual(r.body.statusText, "Built — awaiting floor seating");
    assert.ok(r.body.ownerToken.startsWith(build.TOKEN_PREFIX));
    assert.strictEqual(r.body.dashboardUrl, `${build.DASHBOARD_PATH}?t=${r.body.ownerToken}`);
    assert.strictEqual(r.body.spec.name, "PULSE9");
    assert.strictEqual(r.body.spec.owner.payoutWallet, "", "v1 collects no payout wallet");
    assert.strictEqual(r.body.spec.owner.name, "Mara Voss");
    assert.match(r.body.specHash, /^[a-f0-9]{64}$/);
    // The locked human entry rides along: $1.00 = $0.50 seat +
    // ~$0.33 card costs + ~$0.17 starting data credit; card not live.
    assert.strictEqual(r.body.entry.priceUsd, 1);
    assert.strictEqual(r.body.entry.seatUsd, 0.5);
    assert.strictEqual(r.body.entry.cardCostsUsd, 0.33);
    assert.strictEqual(r.body.entry.starterDataCreditUsd, 0.17);
    assert.strictEqual(r.body.entry.headline, "A dollar seats your bot.");
    assert.strictEqual(r.body.entry.cardLive, false);
    assert.strictEqual(r.body.balance.funded, false);
    assert.strictEqual(r.body.balance.dataCreditUsd, 0);
  });
  await t("spec is identical to the Telegram bot's build of the same choices", async () => {
    const F = bot.forgeCore();
    const choices = { name: "PULSE9", archetype: "sniper", appetite: "careful", aggression: "big", patience: "ride" };
    const botSpec = F.buildSpec(bot.choicesToForgeState(choices, "Mara Voss"));
    assert.deepStrictEqual(created.spec, botSpec);
  });
  await t("duplicate name refused — same or different dials", async () => {
    const r1 = await build.createBuild(store, GOOD);
    assert.strictEqual(r1.status, 409);
    assert.strictEqual(r1.body.code, "NAME_TAKEN");
    const r2 = await build.createBuild(store, { ...GOOD, dials: { appetite: "big", aggression: "safe", patience: "quick" } });
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(r2.body.code, "NAME_TAKEN");
  });
  await t("duplicate spec hash refused (guard fires when the hash is already claimed)", async () => {
    // A spec carries its name, so a true duplicate spec under another
    // name cannot occur through the API; seed the hash claim directly
    // to prove the guard itself refuses.
    const store2 = build._test.createMemoryStore();
    const probe = await build.createBuild(store2, { name: "ORPHAN", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" } });
    assert.strictEqual(probe.status, 201);
    await store2.set(build._test.KEY_BY_HASH + probe.body.specHash, "fb_someoneelse");
    await store2.del(build._test.KEY_BY_NAME + "ORPHAN");
    await store2.del(build._test.KEY_FIGHTER + probe.body.fighterId);
    const r = await build.createBuild(store2, { name: "ORPHAN", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "SPEC_DUPLICATE");
  });

  // ------------------------------------------------------------------
  console.log("token discipline");
  await t("the raw owner token is stored NOWHERE — only its SHA-256", async () => {
    const kv = store._kv;
    assert.ok(kv, "memory store exposes _kv for tests");
    for (const [k, v] of kv.entries()) {
      assert.ok(!String(v).includes(created.ownerToken), `raw token leaked into ${k}`);
      assert.ok(!k.includes(created.ownerToken), "raw token in a key");
    }
    const byToken = await store.get(build._test.KEY_BY_TOKEN + build.hashToken(created.ownerToken));
    assert.strictEqual(byToken, created.fighterId);
    const rec = JSON.parse(await store.get(build._test.KEY_FIGHTER + created.fighterId));
    assert.strictEqual(rec.ownerTokenHash, build.hashToken(created.ownerToken));
  });
  await t("unknown or malformed tokens get a plain 404", async () => {
    const pub = publishedFixtures();
    assert.strictEqual((await build.getDashboard(store, "flw_own_" + "A".repeat(43), pub)).status, 404);
    assert.strictEqual((await build.getDashboard(store, "nonsense", pub)).status, 404);
    assert.strictEqual((await build.getDashboard(store, "", pub)).status, 404);
  });

  // ------------------------------------------------------------------
  console.log("dashboard assembly");
  await t("fresh fighter: hasn't run yet, not seated, honest notes", async () => {
    const r = await build.getDashboard(store, created.ownerToken, publishedFixtures());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.record, null);
    assert.strictEqual(r.body.recordState, "none");
    assert.strictEqual(r.body.seat.seated, false);
    assert.match(r.body.seat.text, /Not seated in a paid event yet/);
    // Balance model: $0.00 until funded, entry structure exposed,
    // no drawdowns before any counted event.
    assert.strictEqual(r.body.balance.wallet, null);
    assert.strictEqual(r.body.balance.funded, false);
    assert.strictEqual(r.body.balance.dataCreditUsd, 0);
    assert.strictEqual(r.body.balance.creditedUsd, 0);
    assert.strictEqual(r.body.balance.dataSpentUsd, 0);
    assert.deepStrictEqual(r.body.balance.drawdowns, []);
    assert.strictEqual(r.body.balance.entry.priceUsd, 1);
    assert.strictEqual(r.body.balance.entry.copy, "$1 by card — seat, card costs, and your bot's first data included");
    assert.match(r.body.balance.balanceText, /\$0\.00/);
    assert.strictEqual(r.body.fighter.statusText, "Built — awaiting floor seating");
    assert.strictEqual(r.body.events.length, 1);
    assert.strictEqual(r.body.events[0].type, "built");
    // appetite=careful, aggression=big → the baseline starting check fires.
    assert.strictEqual(r.body.tuning.length, 1);
    assert.strictEqual(r.body.tuning[0].dial, "aggression");
    assert.strictEqual(r.body.tuning[0].baseline, true);
  });
  await t("standings unavailable → recordState says so, never 'hasn't run'", async () => {
    const r = await build.getDashboard(store, created.ownerToken, { standings: null, live: null, buyin: null });
    assert.strictEqual(r.body.recordState, "unavailable");
    assert.strictEqual(r.body.seat, null);
  });
  await t("seat detection: a SEATED entry under the fighter's name reads seated", async () => {
    const pub = publishedFixtures();
    pub.buyin.seats.outsideEntries = [{ agentName: "pulse9", eventId: "buy-in-1", tier: "standard", status: "SEATED" }];
    const r = await build.getDashboard(store, created.ownerToken, pub);
    assert.strictEqual(r.body.seat.seated, true);
  });

  // ------------------------------------------------------------------
  console.log("record fold + META tuning rules (equivalence with the bot)");
  const standingsFix = {
    countedMatches: ["arena-match-1"],
    agents: [{
      agentId: "pulse9", name: "PULSE9", matches: 3, wins: 0, prizeTotal: 0,
      dataSpentTotal: 0.9, tradesTotal: 0, pnlTotal: -0.4,
      perMatch: [
        { payout: 0, dataSpend: 0.3, trades: 0 },
        { payout: 0, dataSpend: 0.3, trades: 0 },
        { payout: 0, dataSpend: 0.3, trades: 2 },
      ],
    }],
  };
  await t("fighterRecordFromPublished computes winless spend + zero-trade matches", async () => {
    const rec = build.fighterRecordFromPublished("PULSE9", standingsFix, null);
    assert.strictEqual(rec.matches, 3);
    assert.strictEqual(rec.winlessSpend, 0.9);
    assert.strictEqual(rec.zeroTradeMatches, 2);
    assert.strictEqual(rec.prizePerCent, 0);
  });
  await t("tuningAdvice matches the bot's for the same record (META-2 + never-fired)", async () => {
    const choices = { name: "PULSE9", archetype: "sniper", appetite: "careful", aggression: "big", patience: "ride" };
    const rec = build.fighterRecordFromPublished("PULSE9", standingsFix, null);
    const mine = build.tuningAdvice(choices, rec);
    const theirs = bot.tuningAdvice({ choices }, rec);
    assert.deepStrictEqual(
      mine.map((r) => ({ dial: r.dial, to: r.to, reason: r.reason })),
      theirs.map((r) => ({ dial: r.dial, to: r.to, reason: r.reason }))
    );
    // appetite is already at the bottom step (careful) so META-2 cannot
    // fire; the never-fired rule steps patience ride → standard.
    assert.deepStrictEqual(mine.map((r) => r.dial), ["patience"]);
  });
  await t("META-1: proven efficiency steps aggression up; META-2 steps appetite down", async () => {
    const rich = { matches: 4, wins: 2, prizes: 20, data: 0.2, trades: 9, pnl: 1.5, perMatch: [], winlessSpend: 0, zeroTradeMatches: 0, prizePerCent: 1.0 };
    const choices = { appetite: "balanced", aggression: "mixed", patience: "standard" };
    const recs = build.tuningAdvice(choices, rich);
    assert.deepStrictEqual(recs.map((r) => [r.dial, r.to]), [["aggression", "big"]]);
    const broke = { matches: 3, wins: 0, prizes: 0, data: 0.9, trades: 4, pnl: -0.2, perMatch: [], winlessSpend: 0.9, zeroTradeMatches: 0, prizePerCent: 0 };
    const recs2 = build.tuningAdvice({ appetite: "big", aggression: "safe", patience: "standard" }, broke);
    assert.deepStrictEqual(recs2.map((r) => [r.dial, r.to]), [["appetite", "balanced"]]);
  });
  await t("funded entry: starter credit draws down per counted event", async () => {
    const c = await build.createBuild(store, { name: "FUNDED1", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" } });
    assert.strictEqual(c.status, 201);
    // Simulate a funded $1 card entry (the funding write itself is
    // out of scope for v1 — Stripe doesn't exist yet): flip the
    // stored balance to funded and read the dashboard back.
    const rec = JSON.parse(await store.get(build._test.KEY_FIGHTER + c.body.fighterId));
    rec.balance = { funded: true, dataCreditUsd: 0.17, topUpsUsd: 0 };
    rec.entry = { ...rec.entry, method: "card", funded: true };
    await store.set(build._test.KEY_FIGHTER + c.body.fighterId, JSON.stringify(rec));
    const standingsFunded = {
      countedMatches: ["arena-match-1"],
      agents: [{
        agentId: "funded1", name: "FUNDED1", matches: 3, wins: 1, prizeTotal: 1,
        dataSpentTotal: 0.12, tradesTotal: 5, pnlTotal: 0.5,
        perMatch: [
          { payout: 0, dataSpend: 0.05, trades: 1 },
          { payout: 1, dataSpend: 0.04, trades: 2 },
          { payout: 0, dataSpend: 0.03, trades: 2 },
        ],
      }],
    };
    const r = await build.getDashboard(store, c.body.ownerToken, { standings: standingsFunded, live: null, buyin: publishedFixtures().buyin });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.balance.funded, true);
    assert.strictEqual(r.body.balance.creditedUsd, 0.17);
    assert.strictEqual(r.body.balance.dataSpentUsd, 0.12);
    assert.strictEqual(r.body.balance.dataCreditUsd, 0.05);
    assert.strictEqual(r.body.balance.drawdowns.length, 3);
    assert.deepStrictEqual(
      r.body.balance.drawdowns.map((x) => [x.dataSpendUsd, x.creditBeforeUsd, x.creditAfterUsd]),
      [[0.05, 0.17, 0.12], [0.04, 0.12, 0.08], [0.03, 0.08, 0.05]]
    );
  });
  await t("dashboard surfaces the META recs for a recorded fighter", async () => {
    const r = await build.getDashboard(store, created.ownerToken, { standings: standingsFix, live: null, buyin: publishedFixtures().buyin });
    assert.strictEqual(r.body.recordState, "counted");
    assert.strictEqual(r.body.record.matches, 3);
    assert.ok(r.body.tuning.some((x) => x.dial === "patience" && x.to === "standard"));
  });

  // ------------------------------------------------------------------
  console.log("apply-tuning");
  await t("one step applies: spec rebuilt, event logged, dashboard reflects it", async () => {
    const before = await build.getDashboard(store, created.ownerToken, publishedFixtures());
    const r = await build.applyTuning(store, created.ownerToken, { dial: "aggression", to: "mixed" }, publishedFixtures());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.applied, { dial: "aggression", from: "big", to: "mixed" });
    assert.strictEqual(r.body.dashboard.fighter.dials.aggression.key, "mixed");
    assert.notStrictEqual(r.body.dashboard.fighter.specHash, before.body.fighter.specHash);
    assert.strictEqual(r.body.dashboard.fighter.spec.strategy.sizing.fractionOfCash, 0.3);
    const ev = r.body.dashboard.events;
    assert.strictEqual(ev[0].type, "tuning");
    assert.strictEqual(ev[0].dial, "aggression");
  });
  await t("two-step and zero-step moves are refused as out of date", async () => {
    const r1 = await build.applyTuning(store, created.ownerToken, { dial: "appetite", to: "big" }, publishedFixtures());
    assert.strictEqual(r1.status, 409);
    assert.strictEqual(r1.body.code, "STALE_TUNING");
    const r2 = await build.applyTuning(store, created.ownerToken, { dial: "appetite", to: "careful" }, publishedFixtures());
    assert.strictEqual(r2.status, 409);
  });
  await t("unknown dial / bad token refused", async () => {
    assert.strictEqual((await build.applyTuning(store, created.ownerToken, { dial: "speed", to: "big" }, publishedFixtures())).status, 400);
    assert.strictEqual((await build.applyTuning(store, "flw_own_" + "B".repeat(43), { dial: "appetite", to: "balanced" }, publishedFixtures())).status, 404);
  });
  await t("applied spec still equals the bot's build of the new choices", async () => {
    const F = bot.forgeCore();
    const dash = await build.getDashboard(store, created.ownerToken, publishedFixtures());
    const choices = { name: "PULSE9", archetype: "sniper", appetite: "careful", aggression: "mixed", patience: "ride" };
    const botSpec = F.buildSpec(bot.choicesToForgeState(choices, "Mara Voss"));
    assert.deepStrictEqual(dash.body.fighter.spec, botSpec);
  });

  // ------------------------------------------------------------------
  console.log("forge-core equivalence across the whole dial space");
  await t("every style × appetite × aggression × patience builds the bot's exact spec", async () => {
    const F = bot.forgeCore();
    let n = 0;
    for (const style of Object.keys(F.ARCHETYPES)) {
      for (const appetite of build.DIAL_ORDER.appetite) {
        for (const aggression of build.DIAL_ORDER.aggression) {
          for (const patience of build.DIAL_ORDER.patience) {
            const choices = { name: "EQUIV", archetype: style, appetite, aggression, patience };
            const mine = build.choicesToForgeState(choices, "Owner");
            const theirs = bot.choicesToForgeState(choices, "Owner");
            assert.deepStrictEqual(mine, theirs);
            assert.deepStrictEqual(
              require("../api/_forgecore.js").buildSpec(mine),
              F.buildSpec(theirs)
            );
            n++;
          }
        }
      }
    }
    assert.strictEqual(n, 6 * 3 * 3 * 3);
  });

  // ------------------------------------------------------------------
  console.log("bot shop + payment framing");
  await t("shop tiers are the set prices; payment framing is honest", async () => {
    assert.strictEqual(build.SHOP_TIERS.starter.priceUsd, 5);
    assert.strictEqual(build.SHOP_TIERS.pro.priceUsd, 25);
    assert.strictEqual(build.PAYMENT_FRAMING.card.live, false);
    assert.strictEqual(build.PAYMENT_FRAMING.crypto.live, false);
    assert.deepStrictEqual(build.PAYMENT_FRAMING.crypto.methods, ["USDC", "ETH", "BTC"]);
    assert.match(build.PAYMENT_FRAMING.crypto.text, /Someone else can send it for you/);
    assert.match(build.PAYMENT_FRAMING.doors.coder, /coder lane only/);
    const s = await build.programSummary(store);
    assert.strictEqual(s.body.shop.tiers.length, 2);
    assert.strictEqual(s.body.payments.crypto.live, false);
  });
  await t("a shop purchase (watcher-created after verified payment) lands on the same dashboard", async () => {
    const r = await build.createBuild(store,
      { name: "SHOPBOT", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" } },
      { source: "shop", shopTier: "pro" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.source, "shop");
    assert.strictEqual(r.body.shopTier, "pro");
    const dash = await build.getDashboard(store, r.body.ownerToken, publishedFixtures());
    assert.strictEqual(dash.body.fighter.source, "shop");
    assert.strictEqual(dash.body.fighter.shopTier.label, "Pro-tuned");
    assert.strictEqual(dash.body.fighter.shopTier.priceUsd, 25);
    assert.strictEqual(dash.body.fighter.statusText, "Built — awaiting floor seating");
    assert.strictEqual(dash.body.events[0].type, "purchased");
    // The dashboard itself carries the shop + payment framing.
    assert.strictEqual(dash.body.shop.tiers.length, 2);
    assert.strictEqual(dash.body.shop.paymentsLive, false);
    assert.strictEqual(dash.body.payments.card.live, false);
  });
  await t("the public POST body cannot claim a purchase", async () => {
    const r = await build.createBuild(store,
      { name: "FAKEBUY", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" }, source: "shop", shopTier: "pro" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.source, "web-build");
    assert.strictEqual(r.body.shopTier, null);
  });

  // ------------------------------------------------------------------
  console.log("endpoint level");
  await t("POST /api/build → 201; GET ?token → 200 dashboard; bare GET → offer", async () => {
    const res1 = mockRes();
    await buildHandler({ method: "POST", url: "/api/build", body: { name: "WEBBY", style: "balanced", dials: { appetite: "balanced", aggression: "mixed", patience: "standard" }, ownerName: "Web Tester" } }, res1);
    assert.strictEqual(res1.code, 201, JSON.stringify(res1.body));
    const token = res1.body.ownerToken;
    const res2 = mockRes();
    await buildHandler({ method: "GET", url: `/api/build?token=${encodeURIComponent(token)}` }, res2);
    assert.strictEqual(res2.code, 200);
    assert.strictEqual(res2.body.fighter.name, "WEBBY");
    const res3 = mockRes();
    await buildHandler({ method: "GET", url: "/api/build" }, res3);
    assert.strictEqual(res3.code, 200);
    assert.strictEqual(res3.body.service, "flow-arena-web-build");
    const res4 = mockRes();
    await tuneHandler({ method: "POST", url: "/api/build/apply-tuning", body: { token, dial: "appetite", to: "big" } }, res4);
    assert.strictEqual(res4.code, 200, JSON.stringify(res4.body));
    assert.strictEqual(res4.body.applied.to, "big");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });
