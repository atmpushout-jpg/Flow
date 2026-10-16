#!/usr/bin/env node
// Problem Exchange — house operator CLI (spec step 4/6 tooling).
//
//   node offchain/exchange-operate.js keygen
//   node offchain/exchange-operate.js seed
//   node offchain/exchange-operate.js pull
//   node offchain/exchange-operate.js push
//   node offchain/exchange-operate.js bid    --id PX-0001 --bidder flowexecutor --amount 0 --note "..."
//   node offchain/exchange-operate.js assign --id PX-0001 --bidder flowexecutor
//   node offchain/exchange-operate.js submit --id PX-0001 --proof proof.json
//   node offchain/exchange-operate.js grade  --id PX-0001 --contract 0x... [--chain base]
//   node offchain/exchange-operate.js settle --id PX-0001 --tx 0x...
//   node offchain/exchange-operate.js attach-bypass --id PX-0001 --file bypass.json
//   node offchain/exchange-operate.js note   --id PX-0001 --type GRADE_ATTEMPT_FAILED --detail '{...}'
//
// The operator key lives ONLY in ~/.config/exchange_push_key (600);
// its sha256 hash is what the server stores. Working state lives in
// offchain/exchange-state.json; every mutation is appended to
// offchain/exchange-events.jsonl. `grade` shells out to
// offchain/exchange-verify.py, which pays the EXISTING /api/verify on
// the real x402 rail (the $0.02 DONE toll) and maps its answer to the
// five-field verdict — this script never invents a grade.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const px = require("../api/_exchange.js");

const BASE = process.env.EXCHANGE_BASE || "https://flow-kg4x.vercel.app";
const KEY_FILE = path.join(os.homedir(), ".config", "exchange_push_key");
const STATE_FILE = path.join(__dirname, "exchange-state.json");
const EVENTS_FILE = path.join(__dirname, "exchange-events.jsonl");
const SEED_FILE = path.join(__dirname, "..", "api", "_exchange-seed.json");

function args() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
    else out._.push(a[i]);
  }
  return out;
}

function readKey() {
  return fs.readFileSync(KEY_FILE, "utf8").trim();
}

async function api(method, p, body, key) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-exchange-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json, text };
}

function logEvent(type, listing, detail) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ type, listing, at: new Date().toISOString(), detail }) + "\n");
}

function loadLocalState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  return JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
}

function saveLocalState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function pushState(state) {
  const key = readKey();
  const keyHash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
  // First push claims the hash (bootstrap); later pushes authenticate
  // with the key itself. The endpoint decides which path applies.
  let r = await api("POST", "/api/exchange/push", { state }, key);
  if (r.status === 503 && /not bootstrapped/.test(r.json?.error || "")) {
    r = await api("POST", "/api/exchange/push", { state, bootstrap: true, keyHash });
  }
  if (r.status !== 200) throw new Error(`push failed ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

async function pull() {
  const r = await api("GET", "/api/exchange/listings");
  if (r.status !== 200) throw new Error(`pull failed ${r.status}: ${r.text.slice(0, 200)}`);
  const local = loadLocalState();
  const state = {
    ...local,
    name: r.json.name,
    listing_fee_usd: r.json.listing_fee_usd,
    listing_fee_note: r.json.listing_fee_note,
    done_toll: r.json.done_toll,
    updated_at: r.json.updated_at,
    listings: r.json.listings,
    events: r.json.events,
  };
  // Refresh solver records from the read endpoint.
  const solvers = {};
  for (const id of Object.keys(local.solvers || {})) {
    const s = await api("GET", `/api/exchange/solver?id=${encodeURIComponent(id)}`);
    if (s.status === 200) {
      const { schema, ...rec } = s.json;
      solvers[id] = rec;
    } else solvers[id] = local.solvers[id];
  }
  state.solvers = solvers;
  saveLocalState(state);
  return state;
}

async function main() {
  const a = args();
  const cmd = a._[0];
  if (!cmd) { console.error("usage: exchange-operate.js <keygen|seed|pull|push|bid|assign|submit|grade|settle|attach-bypass|note>"); process.exit(2); }

  if (cmd === "keygen") {
    if (fs.existsSync(KEY_FILE)) { console.log("key already exists:", KEY_FILE); return; }
    const key = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
    console.log("wrote", KEY_FILE, "(600)");
    console.log("sha256:", crypto.createHash("sha256").update(key, "utf8").digest("hex"));
    return;
  }

  if (cmd === "seed") {
    const state = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const err = px.validateState(state);
    if (err) throw new Error("seed invalid: " + err);
    const out = await pushState(state);
    saveLocalState(state);
    console.log("seeded:", JSON.stringify(out));
    logEvent("SEEDED", null, out);
    return;
  }

  if (cmd === "pull") {
    const s = await pull();
    console.log(`pulled ${s.listings.length} listings, ${s.events.length} events`);
    return;
  }

  if (cmd === "push") {
    const state = loadLocalState();
    const err = px.validateState(state);
    if (err) throw new Error("local state invalid: " + err);
    console.log("pushed:", JSON.stringify(await pushState(state)));
    return;
  }

  const key = readKey();
  const action = async (p, body) => {
    const r = await api("POST", p, body, key);
    console.log(r.status, JSON.stringify(r.json).slice(0, 600));
    if (r.status !== 200) process.exitCode = 1;
    return r;
  };

  if (cmd === "bid") {
    await action("/api/exchange/bid", {
      id: a.id, bidder: { id: a.bidder, passport: a.passport || null },
      amount_usd: Number(a.amount), ref: a.ref || null, note: a.note || null,
    });
    logEvent("BID_RECORDED", a.id, { bidder: a.bidder, amount_usd: Number(a.amount) });
    return;
  }
  if (cmd === "assign") {
    await action("/api/exchange/assign", { id: a.id, bidder_id: a.bidder });
    logEvent("BID_ACCEPTED", a.id, { bidder: a.bidder });
    return;
  }
  if (cmd === "submit") {
    const proof = JSON.parse(fs.readFileSync(a.proof, "utf8"));
    await action("/api/exchange/submit", { id: a.id, proof });
    logEvent("PROOF_SUBMITTED", a.id, { refs: proof.length });
    return;
  }
  if (cmd === "grade") {
    // Pay the real verdict engine and map its answer. If the payment
    // or the call fails, NOTHING is graded — the failure is printed
    // verbatim so the operator can record it with `note`.
    const out = execFileSync("python3", [
      path.join(__dirname, "exchange-verify.py"),
      "--contract", a.contract, "--chain", a.chain || "base",
    ], { encoding: "utf8", timeout: 120000 });
    const verify = JSON.parse(out.trim().split("\n").pop());
    if (!verify.ok) {
      console.error("VERIFY CALL FAILED (no grade recorded):", JSON.stringify(verify, null, 2).slice(0, 1200));
      process.exitCode = 1;
      return;
    }
    const rep = verify.report;
    const verdictWord = rep.verdict === "safe" ? "ALLOW" : rep.verdict === "caution" ? "WARN" : "BLOCK";
    const verdict = {
      verdict: verdictWord,
      reasons: [{
        code: "VERDICT_ENGINE_" + verdictWord,
        severity: verdictWord === "ALLOW" ? "info" : verdictWord === "WARN" ? "medium" : "high",
      }],
      evidence: [
        { kind: "page", ref: `${BASE}/api/verify` },
        ...(verify.payment_tx ? [{ kind: "tx", ref: verify.payment_tx }] : []),
      ],
      checked_at: new Date().toISOString(),
      rules_version: "payee-readiness/1",
      checker: { id: "flowexecutor", via: "POST /api/verify (x402, $0.02 DONE toll)" },
      engine: { score: rep.score, agentAdvice: rep.agentAdvice, summary: rep.summary, flags: rep.flags },
    };
    await action("/api/exchange/grade", { id: a.id, verdict });
    logEvent("GRADED", a.id, { verdict: verdictWord, score: rep.score });
    return;
  }
  if (cmd === "settle") {
    await action("/api/exchange/settle", { id: a.id, tx: a.tx, block: a.block ? Number(a.block) : undefined });
    logEvent("SETTLED", a.id, { tx: a.tx });
    return;
  }
  if (cmd === "attach-bypass") {
    const state = await pull();
    const listing = state.listings.find((l) => l.id === String(a.id).toUpperCase());
    if (!listing) throw new Error("no such listing locally: " + a.id);
    listing.bypass_offer = JSON.parse(fs.readFileSync(a.file, "utf8"));
    // Attaching an offer does not move the listing's status: BYPASSED
    // is a delivery fact, and v1 does not rewrite status on delivery —
    // the offer's presence on the listing is the board signal.
    px.applyEvent(listing, "BYPASS_ATTACHED", { price_usd: listing.bypass_offer.price_usd });
    px.recordEvent(state, "BYPASS_ATTACHED", listing.id, { price_usd: listing.bypass_offer.price_usd });
    const err = px.validateState(state);
    if (err) throw new Error("state invalid after attach: " + err);
    saveLocalState(state);
    console.log("pushed:", JSON.stringify(await pushState(state)));
    logEvent("BYPASS_ATTACHED", listing.id, { price_usd: listing.bypass_offer.price_usd });
    return;
  }
  if (cmd === "note") {
    const state = await pull();
    const listing = state.listings.find((l) => l.id === String(a.id).toUpperCase());
    if (!listing) throw new Error("no such listing locally: " + a.id);
    const detail = a.detail ? JSON.parse(a.detail) : {};
    if (detail.add_reason && px.REASON_CODES.includes(detail.add_reason.code)) {
      listing.reasons = [...(listing.reasons || []).filter((r) => r.code !== detail.add_reason.code), detail.add_reason];
    }
    px.applyEvent(listing, a.type, detail);
    px.recordEvent(state, a.type, listing.id, detail);
    const err = px.validateState(state);
    if (err) throw new Error("state invalid after note: " + err);
    saveLocalState(state);
    console.log("pushed:", JSON.stringify(await pushState(state)));
    logEvent(a.type, listing.id, detail);
    return;
  }

  console.error("unknown command:", cmd);
  process.exit(2);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
