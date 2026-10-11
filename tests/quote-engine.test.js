// Tests for the widened quote engine (api/_lib.js) and the dashboard
// best-edge scan (api/dashboard/index.js).
//
//   node tests/quote-engine.test.js            -> unit tests only (no network)
//   FLOW_LIVE_TEST=1 node tests/quote-engine.test.js
//                                              -> + live read-only checks
//                                                 against Base mainnet RPC
//                                                 and the dashboard handler
//
// Live checks never send a transaction: quotes are eth_call / staticCall.

const assert = require("node:assert");
const { ethers } = require("ethers");
const { rankResults, getBestQuote, VENUES } = require("../api/_lib");

const coder = ethers.AbiCoder.defaultAbiCoder();
const encSingle = (amt) => coder.encode(["uint256", "uint160", "uint32", "uint256"], [amt, 0, 0, 0]);
const encHop = (amt) => coder.encode(["uint256", "uint160[]", "uint32[]", "uint256"], [amt, [], [], 0]);
const encAero = (amt) => coder.encode(["uint256"], [amt]);
const ok = (returnData) => ({ success: true, returnData });
const fail = { success: false, returnData: "0x" };

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}
async function testAsync(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---------- unit: widened venue configuration ----------
test("venue config includes the widened tiers/spacings", () => {
  assert.ok(VENUES.UNI_TIERS.includes(100), "uniswap 0.01% tier added");
  assert.deepStrictEqual(VENUES.PANCAKE_TIERS, [100, 500, 2500, 10000]);
  assert.ok(VENUES.AERO_SPACINGS.includes(10), "aerodrome spacing 10 added");
  assert.strictEqual(VENUES.HOP_FEE_COMBOS.length, 3);
  assert.strictEqual(VENUES.PANCAKE_QUOTER, "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
});

// ---------- unit: ranking ----------
test("pancakeswap can win; baseline stays the best direct uniswap quote", () => {
  const meta = [
    { venue: "uniswap", key: 500, kind: "v3-single", baseline: true },
    { venue: "pancakeswap", key: 100, kind: "v3-single", baseline: false },
    { venue: "aerodrome", key: 100, kind: "aero", baseline: false },
  ];
  const results = [ok(encSingle(1000n)), ok(encSingle(1010n)), ok(encAero(900n))];
  const { best, bestUni, secondBest } = rankResults(results, meta, coder);
  assert.strictEqual(best.venue, "pancakeswap");
  assert.strictEqual(best.amountOut, 1010n);
  assert.strictEqual(bestUni, 1000n);
  assert.strictEqual(secondBest, 1000n);
});

test("a two-hop route can win but never inflates the uniswap baseline", () => {
  const meta = [
    { venue: "uniswap", key: 500, kind: "v3-single", baseline: true },
    { venue: "pancakeswap", key: 100, kind: "v3-single", baseline: false },
    { venue: "uniswap", key: "500>500", kind: "v3-hop", baseline: false, via: "WETH" },
  ];
  const results = [ok(encSingle(1000n)), ok(encSingle(1010n)), ok(encHop(1050n))];
  const { best, bestUni } = rankResults(results, meta, coder);
  assert.strictEqual(best.kind, "v3-hop");
  assert.strictEqual(best.amountOut, 1050n);
  assert.strictEqual(bestUni, 1000n); // edge = 500 bps vs the direct baseline
});

test("failed calls and undecodable results are skipped, venue stays null", () => {
  const meta = [
    { venue: "uniswap", key: 500, kind: "v3-single", baseline: true },
    { venue: "aerodrome", key: 100, kind: "aero", baseline: false },
  ];
  const results = [fail, ok("0xdeadbeef")];
  const { best, bestUni, secondBest } = rankResults(results, meta, coder);
  assert.strictEqual(best.amountOut, 0n);
  assert.strictEqual(best.venue, null);
  assert.strictEqual(bestUni, 0n);
  assert.strictEqual(secondBest, 0n);
});

test("aerodrome-only liquidity: winner set, baseline 0 (edge reads honest 0)", () => {
  const meta = [
    { venue: "uniswap", key: 500, kind: "v3-single", baseline: true },
    { venue: "aerodrome", key: 100, kind: "aero", baseline: false },
  ];
  const results = [fail, ok(encAero(777n))];
  const { best, bestUni } = rankResults(results, meta, coder);
  assert.strictEqual(best.venue, "aerodrome");
  assert.strictEqual(bestUni, 0n);
});

// ---------- live: read-only against Base mainnet ----------
async function live() {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";

  await testAsync("live USDC->WETH: widened direct scan (13 routes, no hops)", async () => {
    const q = await getBestQuote(USDC, WETH, "100000000");
    assert.ok(BigInt(q.bestOut) > 0n, "bestOut > 0");
    assert.strictEqual(q.routesScanned, 13); // 4 uni + 4 pancake + 5 aero
    assert.strictEqual(q.routeType, "direct");
    assert.ok(["uniswap", "pancakeswap", "aerodrome"].includes(q.venue), `venue ${q.venue}`);
    assert.ok(q.blockNumber > 0);
    console.log(`   -> venue=${q.venue} edge=${q.edgeBps}bps bestOut=${q.bestOut} latency=${q.latencyMs}ms`);
  });

  await testAsync("live USDC->VIRTUAL: hop routes join the scan (16 routes)", async () => {
    const q = await getBestQuote(USDC, VIRTUAL, "100000000");
    assert.ok(BigInt(q.bestOut) > 0n, "bestOut > 0");
    assert.strictEqual(q.routesScanned, 16); // 13 direct + 3 two-hop via WETH
    console.log(`   -> venue=${q.venue} routeType=${q.routeType} edge=${q.edgeBps}bps bestOut=${q.bestOut}`);
  });

  await testAsync("live dashboard handler: bestEdge covers all probes, honest labeling", async () => {
    const handler = require("../api/dashboard/index.js");
    assert.strictEqual(handler.PROBES.length, 6);
    let body = null;
    const res = {
      status(code) { this.code = code; return this; },
      json(b) { body = b; return this; },
    };
    await handler({ method: "GET" }, res);
    assert.ok(body, "handler produced a body");
    assert.ok(body.quote && !body.quote.error, "canonical USDC->WETH quote ok");
    assert.strictEqual(body.probes.length, 6);
    assert.strictEqual(body.bestEdge.pairsScanned, 6);
    // Hero edge = best CORROBORATED edge: thin-liquidity probes (phantom
    // dust-pool baselines) are published in `probes` but never ranked.
    const maxProbeEdge = Math.max(0, ...body.probes.filter((p) => p.liquidity !== "thin").map((p) => p.edgeBps || 0));
    assert.strictEqual(body.bestEdge.edgeBps, maxProbeEdge);
    for (const p of body.probes) {
      if ((p.edgeBps || 0) > body.bestEdge.edgeBps) {
        assert.strictEqual(p.liquidity, "thin", `probe beating the hero edge must be thin-excluded: ${p.pair}`);
      }
    }
    assert.strictEqual(typeof body.bestEdge.thinExcluded, "number");
    if (body.bestEdge.edgeBps > 0) {
      assert.ok(body.bestEdge.pair && body.bestEdge.venue, "edge is labeled with pair + venue");
    } else {
      assert.strictEqual(body.bestEdge.pair, null, "zero edge carries no pair label");
      assert.strictEqual(body.bestEdge.venue, null, "zero edge carries no venue label");
    }
    console.log(`   -> bestEdge=${body.bestEdge.edgeBps}bps pair=${body.bestEdge.pair} venue=${body.bestEdge.venue}`);
    console.log(`   -> probes: ${body.probes.map((p) => `${p.pair}=${p.error ? "ERR" : p.edgeBps + "bps/" + p.venue}`).join(" | ")}`);
  });
}

(async () => {
  if (process.env.FLOW_LIVE_TEST === "1") {
    await live();
  } else {
    console.log("(live tests skipped — set FLOW_LIVE_TEST=1 to run them)");
  }
  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
