// Tests for the Flow Starter Wallet kit:
//   - api/starter/index.js      seed-pilot claim validation + caps (mock store)
//   - mcp-server/wallet.js      wallet generation/storage, spend caps,
//                               x402 payment-header signing (port of x402_pay.py)
//   - offchain/seed-worker.js   idempotent payment decisions (no real sends)
//
//   node tests/starter-kit.test.js
//
// Everything is local and mocked: no real USDC moves, no network calls
// except one loopback HTTP round-trip for the auto-pay flow, and the
// wallet under test is a throwaway generated in a temp directory.

const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { ethers } = require("ethers");

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

const addr = (i) => `0x${i.toString(16).padStart(40, "0")}`;

// ---------------------------------------------------------------------------
// api/starter — validation (pure)
// ---------------------------------------------------------------------------

const starter = require("../api/starter/index.js");
const { validateAddress, handleClaim, handleStats, createMemoryStore, PILOT } = starter._test;
const OP_WALLET_MIXEDCASE = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const PAYEE = "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA";

test("validateAddress rejects malformed input", () => {
  assert.strictEqual(validateAddress(undefined).ok, false);
  assert.strictEqual(validateAddress(42).ok, false);
  assert.strictEqual(validateAddress("0x123").ok, false);
  assert.strictEqual(validateAddress("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").ok, false); // no 0x
  assert.strictEqual(validateAddress("0xZZ3589fCD6eDb6E08f4c7C32D4f71b54bdA02913").ok, false); // non-hex
});

test("validateAddress rejects zero address, operational wallet, and payee", () => {
  assert.match(validateAddress("0x0000000000000000000000000000000000000000").error, /zero address/);
  assert.match(validateAddress(OP_WALLET_MIXEDCASE).error, /operational wallet/);
  assert.match(validateAddress(PAYEE, { payee: PAYEE }).error, /payee wallet/);
});

test("validateAddress accepts a normal address and canonicalizes case", () => {
  const v = validateAddress("0xAbC000000000000000000000000000000000dEaD");
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.address, "0xabc000000000000000000000000000000000dead");
});

// ---------------------------------------------------------------------------
// api/starter — claim + cap logic against the in-memory store
// ---------------------------------------------------------------------------

async function starterTests() {
  const DAY1 = Date.UTC(2026, 9, 11, 12, 0, 0); // 2026-10-11T12:00Z
  const DAY2 = DAY1 + 24 * 3600 * 1000;

  await testAsync("first claim is recorded pending; duplicate is idempotent", async () => {
    const store = createMemoryStore();
    const r1 = await handleClaim(store, { address: addr(101) }, { nowMs: DAY1 });
    assert.strictEqual(r1.status, 201);
    assert.strictEqual(r1.body.status, "pending");
    assert.strictEqual(r1.body.seedUsd, 0.05);
    // Same address, different case spelling -> same claim, no second slot.
    const r2 = await handleClaim(store, { address: addr(101).toUpperCase().replace("0X", "0x") }, { nowMs: DAY1 });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.alreadyClaimed, true);
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.claimsRecorded, 1);
    assert.strictEqual(stats.body.seedsPending, 1);
    assert.strictEqual(stats.body.seedsClaimed, 0);
    assert.strictEqual(stats.body.usdcSpent, 0);
  });

  await testAsync("invalid claims are rejected without consuming pilot slots", async () => {
    const store = createMemoryStore();
    const bad = await handleClaim(store, { address: "0x123" }, { nowMs: DAY1 });
    assert.strictEqual(bad.status, 400);
    const self = await handleClaim(store, { address: OP_WALLET_MIXEDCASE }, { nowMs: DAY1 });
    assert.strictEqual(self.status, 400);
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.claimsRecorded, 0);
  });

  await testAsync("daily cap: 5 claims per UTC day, the 6th waits for tomorrow", async () => {
    const store = createMemoryStore();
    for (let i = 1; i <= PILOT.MAX_PER_DAY; i++) {
      const r = await handleClaim(store, { address: addr(200 + i) }, { nowMs: DAY1 });
      assert.strictEqual(r.status, 201, `claim ${i} should succeed`);
    }
    const sixth = await handleClaim(store, { address: addr(299) }, { nowMs: DAY1 });
    assert.strictEqual(sixth.status, 429);
    assert.strictEqual(sixth.body.code, "daily-cap");
    const tomorrow = await handleClaim(store, { address: addr(299) }, { nowMs: DAY2 });
    assert.strictEqual(tomorrow.status, 201);
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.claimsRecorded, 6, "rejected claim must not consume a slot");
  });

  await testAsync("total cap: pilot fills at 19 and the 20th claim is refused", async () => {
    const store = createMemoryStore();
    let n = 0;
    for (let day = 0; day < 4; day++) {
      for (let i = 0; i < PILOT.MAX_PER_DAY && n < PILOT.MAX_TOTAL; i++) {
        const r = await handleClaim(store, { address: addr(300 + n) }, { nowMs: DAY1 + day * 24 * 3600 * 1000 });
        assert.strictEqual(r.status, 201, `claim ${n + 1} should succeed`);
        n++;
      }
    }
    assert.strictEqual(n, 19);
    const over = await handleClaim(store, { address: addr(399) }, { nowMs: DAY1 + 4 * 24 * 3600 * 1000 });
    assert.strictEqual(over.status, 409);
    assert.strictEqual(over.body.code, "pilot-full");
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.claimsRecorded, 19);
  });

  await testAsync("stats report claimed seeds and USDC spent after payout", async () => {
    const store = createMemoryStore();
    const a = addr(401);
    await handleClaim(store, { address: a }, { nowMs: DAY1 });
    store._markClaimed(a.toLowerCase());
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.seedsClaimed, 1);
    assert.strictEqual(stats.body.seedsPending, 0);
    assert.strictEqual(stats.body.usdcSpent, 0.05);
    // A paid address claiming again sees its claimed status + tx fields path.
    const again = await handleClaim(store, { address: a }, { nowMs: DAY1 });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.status, "claimed");
    assert.strictEqual(again.body.alreadyClaimed, true);
  });
}

// ---------------------------------------------------------------------------
// offchain/seed-worker — idempotent decisions (pure)
// ---------------------------------------------------------------------------

const worker = require("../offchain/seed-worker.js");

test("seed worker pays only a fresh pending claim", () => {
  assert.deepStrictEqual(
    worker.decidePayment({ claimStatus: "pending", inLedger: false, onchainTx: null }),
    { action: "pay" }
  );
  assert.strictEqual(
    worker.decidePayment({ claimStatus: "claimed", inLedger: false, onchainTx: null }).reason,
    "already-claimed"
  );
  assert.strictEqual(
    worker.decidePayment({ claimStatus: "pending", inLedger: true, onchainTx: null }).reason,
    "in-ledger"
  );
  const onchain = worker.decidePayment({ claimStatus: "pending", inLedger: false, onchainTx: "0xdeadbeef" });
  assert.strictEqual(onchain.reason, "already-onchain");
  assert.strictEqual(onchain.markTx, "0xdeadbeef");
  assert.strictEqual(worker.SEED_ATOMIC, 50000n);
});

test("seed worker ledger parsing tolerates corrupt lines and lowercases", () => {
  const entries = worker.parseLedgerText(
    [
      JSON.stringify({ address: "0xABC0000000000000000000000000000000000001", txHash: "0x1" }),
      "not json",
      "",
      JSON.stringify({ txHash: "0xnoaddress" }),
      JSON.stringify({ address: "0xabc0000000000000000000000000000000000002", txHash: "0x2" }),
    ].join("\n")
  );
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].address, "0xabc0000000000000000000000000000000000001");
});

// ---------------------------------------------------------------------------
// mcp-server/wallet.js — generation, storage, caps, signing (ESM, dynamic import)
// ---------------------------------------------------------------------------

async function walletTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-wallet-test-"));
  const walletFile = path.join(tmp, "flow-wallet.json");
  process.env.FLOW_WALLET_PATH = walletFile;
  process.env.FLOW_SPEND_LEDGER_PATH = path.join(tmp, "ledger.jsonl");
  delete process.env.FLOW_DAILY_SPEND_CAP_USD;

  const W = await import("../mcp-server/wallet.js");

  await testAsync("no wallet yet: auto-pay reports needsWallet on a 402", async () => {
    const required = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "10000",
          asset: W.USDC_BASE,
          payTo: W.FLOW_PAYEE,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const srv = http.createServer((req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify(required));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const out = await W.fetchWithPayment(`http://127.0.0.1:${srv.address().port}/api/quote`, { method: "POST" });
      assert.strictEqual(out.res.status, 402);
      assert.strictEqual(out.needsWallet, true);
      assert.strictEqual(out.payment, null);
    } finally {
      srv.close();
    }
  });

  let address;
  await testAsync("wallet is generated locally, stored 0600, and reused", async () => {
    const first = W.loadOrCreateWallet();
    address = first.address;
    assert.strictEqual(first.created, true);
    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(!("privateKey" in first), "tool-facing result must not carry the key");
    assert.ok(fs.existsSync(walletFile));
    assert.strictEqual(fs.statSync(walletFile).mode & 0o777, 0o600);
    const onDisk = JSON.parse(fs.readFileSync(walletFile, "utf8"));
    assert.strictEqual(onDisk.address, address);
    const second = W.loadOrCreateWallet();
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.address, address);
  });

  await testAsync("loose permissions on an existing wallet file are tightened to 0600", async () => {
    fs.chmodSync(walletFile, 0o644);
    W.loadOrCreateWallet();
    assert.strictEqual(fs.statSync(walletFile).mode & 0o777, 0o600);
  });

  const now = Math.floor(Date.now() / 1000);
  test("spend caps: per-call cap and rolling-24h daily cap", () => {
    const fresh = [{ ts: now - 3600, usd: 0.5 }];
    assert.doesNotThrow(() => W.checkCaps(0.05, fresh, { nowSec: now }));
    assert.throws(() => W.checkCaps(0.06, fresh, { nowSec: now }), /per-call cap/);
    const almostFull = [{ ts: now - 60, usd: 0.98 }];
    assert.throws(() => W.checkCaps(0.05, almostFull, { nowSec: now }), /daily spend cap/);
    assert.doesNotThrow(() => W.checkCaps(0.05, almostFull, { nowSec: now, dailyCapUsd: 2 }));
    const stale = [{ ts: now - 90000, usd: 0.99 }]; // >24h old: no longer counts
    assert.doesNotThrow(() => W.checkCaps(0.05, stale, { nowSec: now }));
  });

  const throwaway = ethers.Wallet.createRandom();
  const goodAccepts = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: W.USDC_BASE,
    payTo: W.FLOW_PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };

  await testAsync("payment header matches x402_pay.py semantics and verifies", async () => {
    const { header, priceUsd, payer } = await W.buildPaymentHeader({
      accepts: goodAccepts,
      wallet: throwaway,
      extensions: { bazaar: { info: { input: { type: "http" } } } },
      resource: { url: "https://flow-kg4x.vercel.app/api/quote" },
      ledgerEntries: [],
    });
    assert.strictEqual(priceUsd, 0.01);
    assert.strictEqual(payer, throwaway.address);
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.strictEqual(payload.x402Version, 2);
    assert.strictEqual(payload.scheme, "exact");
    assert.deepStrictEqual(payload.accepted, goodAccepts); // PayAI requires `accepted`
    assert.ok(payload.extensions && payload.resource, "resource/extensions echoed");
    const auth = payload.payload.authorization;
    assert.strictEqual(auth.from, throwaway.address);
    assert.strictEqual(auth.to, ethers.getAddress(W.FLOW_PAYEE));
    assert.strictEqual(auth.value, "10000");
    assert.match(payload.payload.signature, /^0x[0-9a-fA-F]{130}$/);
    const recovered = ethers.verifyTypedData(
      { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: W.USDC_BASE },
      {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      payload.payload.signature
    );
    assert.strictEqual(recovered, throwaway.address);
  });

  await testAsync("payment header refuses wrong payee / network / asset / scheme / over-cap amount", async () => {
    const base = { wallet: throwaway, ledgerEntries: [] };
    await assert.rejects(() => W.buildPaymentHeader({ ...base, accepts: { ...goodAccepts, payTo: addr(777) } }), /only pays Flow's payee/);
    await assert.rejects(() => W.buildPaymentHeader({ ...base, accepts: { ...goodAccepts, network: "eip155:1" } }), /Wrong network/);
    await assert.rejects(() => W.buildPaymentHeader({ ...base, accepts: { ...goodAccepts, asset: addr(778) } }), /Wrong asset/);
    await assert.rejects(() => W.buildPaymentHeader({ ...base, accepts: { ...goodAccepts, scheme: "upto" } }), /Unsupported scheme/);
    await assert.rejects(() => W.buildPaymentHeader({ ...base, accepts: { ...goodAccepts, amount: "60000" } }), /per-call cap/);
  });

  await testAsync("auto-pay loop: 402 -> sign -> retry succeeds and spend is recorded", async () => {
    let seen = null;
    const srv = http.createServer((req, res) => {
      const pay = req.headers["x-payment"];
      if (!pay) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ x402Version: 2, accepts: [goodAccepts], resource: { url: "x" } }));
        return;
      }
      seen = JSON.parse(Buffer.from(pay, "base64").toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const out = await W.fetchWithPayment(`http://127.0.0.1:${srv.address().port}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }, { wallet: W.loadWallet(), rpcUrl: "http://127.0.0.1:9/dead" });
      assert.strictEqual(out.res.status, 200);
      assert.strictEqual(out.payment.priceUsd, 0.01);
      assert.strictEqual(out.payment.payer, address);
      assert.ok(seen, "server received an X-PAYMENT header");
      assert.strictEqual(seen.payload.authorization.from, address);
      const ledger = W.readLedger();
      assert.strictEqual(ledger.length, 1);
      assert.strictEqual(ledger[0].usd, 0.01);
    } finally {
      srv.close();
    }
  });
}

// ---------------------------------------------------------------------------
// CAP-BYPASS AUDIT — the two bypasses fixed upstream by ClawRouter PR #440
// (report ET-CLAWROUTER-20261010), reproduced against mcp-server/wallet.js:
//   Case A: concurrent calls racing a cumulative cap — spend was recorded
//           only after a successful response, with nothing reserved for
//           in-flight requests, so parallel checks all pass on stale state.
//   Case B: a payment broadcast but answered with an error (502 / dropped
//           connection) never counted toward the cap, so a retry signed a
//           fresh authorization and settled a second time.
// The wallet must hold both: reserve before signing (atomic across
// processes sharing one wallet file), and count every broadcast attempt.
// ---------------------------------------------------------------------------

async function capBypassTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-wallet-audit-"));
  process.env.FLOW_WALLET_PATH = path.join(tmp, "flow-wallet.json");
  process.env.FLOW_SPEND_LEDGER_PATH = path.join(tmp, "ledger.jsonl");

  const W = await import("../mcp-server/wallet.js");
  W.loadOrCreateWallet();
  const DEAD_RPC = "http://127.0.0.1:9/dead";

  const acceptsFor = (amountAtomic) => ({
    scheme: "exact",
    network: "eip155:8453",
    amount: amountAtomic,
    asset: W.USDC_BASE,
    payTo: W.FLOW_PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  });

  function startServer(onPaid) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        req.on("error", () => {});
        res.on("error", () => {});
        const pay = req.headers["x-payment"];
        if (!pay) {
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ x402Version: 2, accepts: [acceptsFor("50000")] }));
          return;
        }
        const payload = JSON.parse(Buffer.from(pay, "base64").toString("utf8"));
        onPaid(payload.payload.authorization.nonce, req, res);
      });
      srv.on("clientError", (err, socket) => socket.destroy());
      srv.listen(0, "127.0.0.1", () => resolve(srv));
    });
  }
  const urlFor = (srv) => `http://127.0.0.1:${srv.address().port}/api/quote`;
  const ledgerTotal = () => W.readLedger().reduce((s, e) => s + e.usd, 0);
  const freshLedger = (name) => {
    process.env.FLOW_SPEND_LEDGER_PATH = path.join(tmp, name);
  };

  await testAsync("AUDIT Case A: concurrent auto-pays cannot race past the daily cap", async () => {
    freshLedger("ledger-a.jsonl");
    process.env.FLOW_DAILY_SPEND_CAP_USD = "0.10";
    let paidCount = 0;
    const srv = await startServer((nonce, req, res) => {
      paidCount++;
      // Settlement latency is the race window: the response (and, in the
      // vulnerable code, the spend record) lands well after every
      // concurrent call has already passed its cap check.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, 100);
    });
    try {
      const wallet = W.loadWallet();
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          W.fetchWithPayment(urlFor(srv), { method: "POST", body: "{}" }, { wallet, rpcUrl: DEAD_RPC })
        )
      );
      const okCount = attempts.filter((a) => a.status === "fulfilled" && a.value.res.status === 200).length;
      assert.strictEqual(paidCount, okCount);
      assert.ok(paidCount <= 2, `daily cap $0.10 breached: ${paidCount} concurrent $0.05 payments settled`);
      assert.ok(ledgerTotal() <= 0.10 + 1e-9, `ledger total $${ledgerTotal()} exceeds the $0.10 daily cap`);
    } finally {
      srv.close();
      delete process.env.FLOW_DAILY_SPEND_CAP_USD;
    }
  });

  await testAsync("AUDIT Case A (multi-process): separate MCP processes sharing one wallet file cannot race the cap", async () => {
    freshLedger("ledger-amp.jsonl");
    let paidCount = 0;
    const srv = await startServer((nonce, req, res) => {
      paidCount++;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, 150);
    });
    try {
      const childScript = path.join(tmp, "child-pay.mjs");
      fs.writeFileSync(
        childScript,
        [
          'import fs from "node:fs";',
          "const W = await import(process.env.WALLET_MODULE_URL);",
          "while (!fs.existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 5));",
          "try {",
          '  const out = await W.fetchWithPayment(process.env.TARGET_URL, { method: "POST", body: "{}" });',
          '  console.log("RESULT", out.res.status);',
          '} catch (e) { console.log("ERROR", e.message); }',
        ].join("\n")
      );
      const env = {
        ...process.env,
        WALLET_MODULE_URL: pathToFileURL(path.join(__dirname, "..", "mcp-server", "wallet.js")).href,
        TARGET_URL: urlFor(srv),
        GO_FILE: path.join(tmp, "go"),
        FLOW_DAILY_SPEND_CAP_USD: "0.10",
        FLOW_BASE_RPC: DEAD_RPC,
      };
      const kids = [0, 1, 2].map(
        () =>
          new Promise((resolve) => {
            const p = spawn(process.execPath, [childScript], { env });
            let out = "";
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (out += d));
            const killer = setTimeout(() => p.kill("SIGKILL"), 30000);
            p.on("close", () => {
              clearTimeout(killer);
              resolve(out.trim());
            });
          })
      );
      await new Promise((r) => setTimeout(r, 700)); // all children reach the barrier
      fs.writeFileSync(path.join(tmp, "go"), "go");
      const results = await Promise.all(kids);
      assert.ok(
        paidCount <= 2,
        `daily cap breached across processes: ${paidCount} settlements (children: ${results.join(" | ")})`
      );
    } finally {
      srv.close();
    }
  });

  await testAsync("AUDIT Case B: a payment answered 502 still counts toward the cap; the retry cannot settle twice", async () => {
    freshLedger("ledger-b.jsonl");
    process.env.FLOW_DAILY_SPEND_CAP_USD = "0.05"; // exactly one $0.05 payment fits
    const nonces = new Set();
    const srv = await startServer((nonce, req, res) => {
      nonces.add(nonce); // the facilitator settles…
      res.writeHead(502, { "Content-Type": "application/json" }); // …then the gateway fails
      res.end(JSON.stringify({ error: "bad gateway" }));
    });
    try {
      const wallet = W.loadWallet();
      const first = await W.fetchWithPayment(urlFor(srv), { method: "POST", body: "{}" }, { wallet, rpcUrl: DEAD_RPC });
      assert.strictEqual(first.res.status, 502);
      assert.ok(first.payment, "a payment was broadcast");
      assert.ok(
        ledgerTotal() >= 0.05 - 1e-9,
        `lost payment not counted toward the cap (ledger total $${ledgerTotal()})`
      );
      // The caller retries the same call after the 502 — ClawRouter's
      // explicit-pin retry. It must be refused BEFORE signing anything new.
      let refused = false;
      try {
        await W.fetchWithPayment(urlFor(srv), { method: "POST", body: "{}" }, { wallet, rpcUrl: DEAD_RPC });
      } catch (e) {
        refused = /daily spend cap/.test(e.message);
      }
      assert.ok(refused, "retry after a lost payment was not refused by the daily cap");
      assert.strictEqual(nonces.size, 1, `expected exactly 1 settlement, server saw ${nonces.size} distinct authorizations`);
    } finally {
      srv.close();
      delete process.env.FLOW_DAILY_SPEND_CAP_USD;
    }
  });

  await testAsync("AUDIT Case B2: a payment whose connection drops mid-flight still counts toward the cap", async () => {
    freshLedger("ledger-b2.jsonl");
    process.env.FLOW_DAILY_SPEND_CAP_USD = "0.05";
    const nonces = new Set();
    const srv = await startServer((nonce, req) => {
      nonces.add(nonce);
      req.socket.destroy(); // settlement may have happened; the response never arrives
    });
    try {
      const wallet = W.loadWallet();
      let threw = false;
      try {
        await W.fetchWithPayment(urlFor(srv), { method: "POST", body: "{}" }, { wallet, rpcUrl: DEAD_RPC });
      } catch {
        threw = true;
      }
      assert.ok(threw, "a dropped paid request should surface as an error");
      assert.ok(
        ledgerTotal() >= 0.05 - 1e-9,
        `dropped payment not counted toward the cap (ledger total $${ledgerTotal()})`
      );
      let refused = false;
      try {
        await W.fetchWithPayment(urlFor(srv), { method: "POST", body: "{}" }, { wallet, rpcUrl: DEAD_RPC });
      } catch (e) {
        refused = /daily spend cap/.test(e.message);
      }
      assert.ok(refused, "retry after a dropped payment was not refused by the daily cap");
      assert.strictEqual(nonces.size, 1, `expected exactly 1 settlement, server saw ${nonces.size} distinct authorizations`);
    } finally {
      srv.close();
      delete process.env.FLOW_DAILY_SPEND_CAP_USD;
    }
  });
}

// ---------------------------------------------------------------------------
// CHOKEPOINT AUDIT — regression guard for the THIRD bypass class found in
// ClawRouter PR #440 review: a request that starts FREE gets a non-strict
// spend tracker, so when a fallback later goes PAID the cap check is
// skipped. The disease is a payment path wired AROUND the enforcement
// chokepoint. These source-level assertions pin Flow's shape: exactly one
// signing site, exactly one caller of it (fetchWithPayment, after
// reserveSpend), and a tool layer that cannot even name the signing
// machinery. If a future paid tool is wired around fetchWithPayment, this
// test fails before the code ships.
// ---------------------------------------------------------------------------

function chokepointTests() {
  const walletSrc = fs.readFileSync(path.join(__dirname, "..", "mcp-server", "wallet.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "mcp-server", "index.js"), "utf8");

  test("CHOKEPOINT: exactly one signing site exists in the MCP client (wallet.js)", () => {
    const signSites = walletSrc.match(/signTypedData/g) || [];
    assert.strictEqual(signSites.length, 1, `expected 1 signTypedData site, found ${signSites.length}`);
    assert.ok(!/signTypedData/.test(indexSrc), "index.js must never sign");
  });

  test("CHOKEPOINT: buildPaymentHeader has exactly one production caller — fetchWithPayment, after reserveSpend", () => {
    const defsAndCalls = walletSrc.match(/buildPaymentHeader\(/g) || [];
    assert.strictEqual(
      defsAndCalls.length,
      2,
      `expected the definition + exactly one call site, found ${defsAndCalls.length} occurrences`
    );
    const fwp = walletSrc.slice(walletSrc.indexOf("export async function fetchWithPayment"));
    const reserveAt = fwp.indexOf("reserveSpend(");
    const signAt = fwp.indexOf("buildPaymentHeader(");
    assert.ok(reserveAt !== -1, "fetchWithPayment must reserve spend");
    assert.ok(signAt !== -1, "fetchWithPayment must be the signing caller");
    assert.ok(reserveAt < signAt, "the reservation must precede signing — no sign-before-reserve path");
    const skipFlags = walletSrc.match(/skipCapCheck: true/g) || [];
    assert.strictEqual(skipFlags.length, 1, "the cap-check skip may exist only on the already-reserved path");
    assert.ok(
      walletSrc.indexOf("skipCapCheck: true") > walletSrc.indexOf("export async function fetchWithPayment"),
      "skipCapCheck: true appears outside fetchWithPayment"
    );
  });

  test("CHOKEPOINT: the tool layer cannot reach the signer except through fetchWithPayment", () => {
    for (const banned of ["buildPaymentHeader", "signTypedData", "X-PAYMENT", "skipCapCheck"]) {
      assert.ok(!indexSrc.includes(banned), `index.js references ${banned} — a tool is wired around the chokepoint`);
    }
    assert.ok(indexSrc.includes("fetchWithPayment"), "index.js lost its payment wrapper");
  });

  test("CHOKEPOINT: the seed claim in flow_wallet_setup stays free (no payment path in the setup tool)", () => {
    const start = indexSrc.indexOf('"flow_wallet_setup"');
    const end = indexSrc.indexOf("server.tool(", start);
    assert.ok(start !== -1 && end !== -1, "could not isolate the flow_wallet_setup tool block");
    const setupBlock = indexSrc.slice(start, end);
    assert.ok(setupBlock.includes("/api/starter"), "setup tool no longer claims the seed");
    assert.ok(!setupBlock.includes("fetchWithPayment"), "setup tool must never auto-pay");
    assert.ok(!/sign/i.test(setupBlock.replace(/design/gi, "")), "setup tool must never sign");
  });
}

// ---------------------------------------------------------------------------
// api/starter — claim-action bridge: ops-signed void / mark-paid, with the
// on-chain transfer check mocked at the verifySeedTx seam (and the pure
// receipt matcher tested directly). No network, no real keys: a throwaway
// wallet stands in for the operational wallet via opts.opsAddress.
// ---------------------------------------------------------------------------

const {
  handleListClaims,
  handleClaimAction,
  canonicalClaimActionMessage,
  verifyOpsSignature,
  matchSeedTransfer,
  padTopicAddress,
  USDC_BASE,
} = starter._test;

const OPS_TEST = ethers.Wallet.createRandom();
const STRANGER = ethers.Wallet.createRandom();
const TXH = "0x" + "ab".repeat(32);
const signAction = (wallet, fields) => wallet.signMessage(canonicalClaimActionMessage(fields));

test("claim-action canonical message: exact format, lowercased, empty txHash segment", () => {
  assert.strictEqual(
    canonicalClaimActionMessage({ action: "void", address: "0xABC0000000000000000000000000000000000001", timestamp: 123 }),
    "flow-starter:void:0xabc0000000000000000000000000000000000001::123"
  );
  assert.strictEqual(
    canonicalClaimActionMessage({ action: "mark-paid", address: addr(501), txHash: TXH.toUpperCase().replace("0X", "0x"), timestamp: 456 }),
    `flow-starter:mark-paid:${addr(501)}:${TXH}:456`
  );
});

test("verifyOpsSignature recovers the ops signer and rejects everyone else", async () => {
  const msg = canonicalClaimActionMessage({ action: "void", address: addr(502), timestamp: 789 });
  const sig = await OPS_TEST.signMessage(msg);
  assert.strictEqual(verifyOpsSignature(msg, sig, OPS_TEST.address), true);
  assert.strictEqual(verifyOpsSignature(msg, sig, STRANGER.address), false);
  const strangerSig = await STRANGER.signMessage(msg);
  assert.strictEqual(verifyOpsSignature(msg, strangerSig, OPS_TEST.address), false);
  assert.strictEqual(verifyOpsSignature(msg, "0x1234", OPS_TEST.address), false);
  assert.strictEqual(verifyOpsSignature(msg, undefined, OPS_TEST.address), false);
});

test("matchSeedTransfer: only an exact 0.05 ops->claimant USDC transfer in a successful tx counts", () => {
  const receiptFor = (value, to = addr(503)) => ({
    status: "0x1",
    blockNumber: "0x100",
    logs: [
      {
        address: USDC_BASE,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          padTopicAddress(OPS_TEST.address),
          padTopicAddress(to),
        ],
        data: "0x" + value.toString(16).padStart(64, "0"),
      },
    ],
  });
  assert.strictEqual(matchSeedTransfer(receiptFor(50000n), { from: OPS_TEST.address, to: addr(503) }), true);
  assert.strictEqual(matchSeedTransfer(receiptFor(49999n), { from: OPS_TEST.address, to: addr(503) }), false); // underpaid
  assert.strictEqual(matchSeedTransfer(receiptFor(50000n, addr(504)), { from: OPS_TEST.address, to: addr(503) }), false); // wrong recipient
  assert.strictEqual(matchSeedTransfer(receiptFor(50000n), { from: STRANGER.address, to: addr(503) }), false); // wrong sender
  assert.strictEqual(matchSeedTransfer({ ...receiptFor(50000n), status: "0x0" }, { from: OPS_TEST.address, to: addr(503) }), false); // reverted
  assert.strictEqual(matchSeedTransfer(null, { from: OPS_TEST.address, to: addr(503) }), false);
});

async function claimActionTests() {
  const NOW = Date.UTC(2026, 9, 13, 0, 30, 0); // fixed clock for the whole section
  const baseOpts = { nowMs: NOW, opsAddress: OPS_TEST.address };

  await testAsync("void: ops-signed action voids a pending claim; list + stats reflect it", async () => {
    const store = createMemoryStore();
    const target = addr(511);
    await handleClaim(store, { address: target }, { nowMs: NOW });
    const signature = await signAction(OPS_TEST, { action: "void", address: target, timestamp: NOW });
    const r = await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature }, baseOpts);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "void");
    const list = await handleListClaims(store);
    assert.strictEqual(list.body.count, 1);
    assert.strictEqual(list.body.claims[0].address, target);
    assert.strictEqual(list.body.claims[0].status, "void");
    assert.ok(list.body.claims[0].createdAt, "createdAt is listed");
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.seedsPending, 0);
    assert.strictEqual(stats.body.seedsClaimed, 0);
    // Idempotent: voiding again is a 200, not an error.
    const again = await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature }, baseOpts);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyVoid, true);
  });

  await testAsync("bad signature is refused and the claim stays pending", async () => {
    const store = createMemoryStore();
    const target = addr(512);
    await handleClaim(store, { address: target }, { nowMs: NOW });
    const signature = await signAction(STRANGER, { action: "void", address: target, timestamp: NOW });
    const r = await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature }, baseOpts);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "bad-signature");
    const rec = await store.getClaim(target);
    assert.strictEqual(rec.status, "pending");
  });

  await testAsync("stale timestamps are rejected even with a valid signature; a signature over another timestamp fails", async () => {
    const store = createMemoryStore();
    const target = addr(513);
    await handleClaim(store, { address: target }, { nowMs: NOW });
    const staleTs = NOW - 11 * 60 * 1000;
    const staleSig = await signAction(OPS_TEST, { action: "void", address: target, timestamp: staleTs });
    const stale = await handleClaimAction(store, { action: "void", address: target, timestamp: staleTs, signature: staleSig }, baseOpts);
    assert.strictEqual(stale.status, 401);
    assert.strictEqual(stale.body.code, "stale-timestamp");
    // Signature is genuine but covers a different timestamp than the body claims.
    const mismatched = await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature: staleSig }, baseOpts);
    assert.strictEqual(mismatched.status, 403);
    const rec = await store.getClaim(target);
    assert.strictEqual(rec.status, "pending");
  });

  await testAsync("mark-paid: mocked on-chain proof marks the claim claimed with its tx hash", async () => {
    const store = createMemoryStore();
    const target = addr(514);
    await handleClaim(store, { address: target }, { nowMs: NOW });
    const signature = await signAction(OPS_TEST, { action: "mark-paid", address: target, txHash: TXH, timestamp: NOW });
    const okOpts = { ...baseOpts, verifySeedTx: async () => ({ ok: true, blockNumber: 4242, confirmations: 3 }) };
    const r = await handleClaimAction(store, { action: "mark-paid", address: target, txHash: TXH, timestamp: NOW, signature }, okOpts);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "claimed");
    assert.strictEqual(r.body.txHash, TXH);
    const list = await handleListClaims(store);
    assert.strictEqual(list.body.claims[0].status, "claimed");
    assert.strictEqual(list.body.claims[0].txHash, TXH);
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.seedsClaimed, 1);
    assert.strictEqual(stats.body.seedsPending, 0);
    assert.strictEqual(stats.body.usdcSpent, 0.05);
    // Paid claims cannot be voided after the fact.
    const voidSig = await signAction(OPS_TEST, { action: "void", address: target, timestamp: NOW });
    const v = await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature: voidSig }, baseOpts);
    assert.strictEqual(v.status, 409);
  });

  await testAsync("mark-paid: failed on-chain proof changes nothing (claim stays pending)", async () => {
    const store = createMemoryStore();
    const target = addr(515);
    await handleClaim(store, { address: target }, { nowMs: NOW });
    const signature = await signAction(OPS_TEST, { action: "mark-paid", address: target, txHash: TXH, timestamp: NOW });
    const failOpts = { ...baseOpts, verifySeedTx: async () => ({ ok: false, reason: "no matching transfer" }) };
    const r = await handleClaimAction(store, { action: "mark-paid", address: target, txHash: TXH, timestamp: NOW, signature }, failOpts);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "tx-verify-failed");
    const rec = await store.getClaim(target);
    assert.strictEqual(rec.status, "pending");
    assert.ok(!rec.txHash, "no tx hash may be recorded on a failed proof");
    const stats = await handleStats(store);
    assert.strictEqual(stats.body.seedsClaimed, 0);
    assert.strictEqual(stats.body.seedsPending, 1);
    // And a voided claim can never be marked paid afterwards.
    const voidSig = await signAction(OPS_TEST, { action: "void", address: target, timestamp: NOW });
    await handleClaimAction(store, { action: "void", address: target, timestamp: NOW, signature: voidSig }, baseOpts);
    const okOpts = { ...baseOpts, verifySeedTx: async () => ({ ok: true, blockNumber: 1, confirmations: 9 }) };
    const payAfterVoid = await handleClaimAction(store, { action: "mark-paid", address: target, txHash: TXH, timestamp: NOW, signature }, okOpts);
    assert.strictEqual(payAfterVoid.status, 409);
    assert.strictEqual(payAfterVoid.body.code, "already-void");
  });

  await testAsync("claim-action on an unknown address 404s; bad actions 400", async () => {
    const store = createMemoryStore();
    const signature = await signAction(OPS_TEST, { action: "void", address: addr(516), timestamp: NOW });
    const r = await handleClaimAction(store, { action: "void", address: addr(516), timestamp: NOW, signature }, baseOpts);
    assert.strictEqual(r.status, 404);
    const bad = await handleClaimAction(store, { action: "refund", address: addr(516), timestamp: NOW, signature }, baseOpts);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.code, "bad-action");
  });
}

(async () => {
  await starterTests();
  await claimActionTests();
  await walletTests();
  await capBypassTests();
  chokepointTests();
  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
