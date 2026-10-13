"use strict";
// Flow Verdict Registry feed.
//
//   node scripts/arc-feed.js check <address> [--chain base]          dry run:
//       pay Flow /api/verify $0.02 (x402, ops wallet), print the verdict
//       and the exact verdictHash that would be anchored on Arc.
//   node scripts/arc-feed.js check <address> [--chain base] --send   also
//       record the verdict in the Arc registry (needs deployments/5042.json).
//   node scripts/arc-feed.js hash <payload.json>                     recompute
//       the canonical verdictHash for a saved canonical payload.
//
// Safety pins: the x402 payment is only ever signed when the 402 asks for
// <= $0.05, in Base USDC, to Flow's own payee wallet. The Arc write uses
// the same operational wallet. Run with the VM proxy env sourced and
// NODE_USE_ENV_PROXY=1 (see DEPLOY.md).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const VERIFY_URL = process.env.FLOW_VERIFY_URL || "https://flow-kg4x.vercel.app/api/verify";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ARC_RPC = process.env.ARC_RPC || "https://rpc.mainnet.arc.io";
const EXPLORER = "https://explorer.arc.io";
const KEY_FILE = path.join(process.env.HOME, ".config", "flowexecutor_wallet_key");
const EXPECTED_OPS = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const FLOW_PAYEE = "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_PRICE_ATOMIC = 50000n; // $0.05 hard cap per verify call
const CHAINS = { base: 8453, ethereum: 1, optimism: 10, arbitrum: 42161, polygon: 137 };
const VERDICT_ENUM = { safe: 0, caution: 1, danger: 2 };

function loadOpsKey() {
  const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

/// Canonical payload -> the hash anchored on Arc. Key order is fixed and
/// flags are normalized to "severity:text" strings and sorted, so anyone
/// can recompute this from the API response.
function canonicalPayload(v, subject, chainKey) {
  const flags = (v.flags || [])
    .map((f) => (typeof f === "string" ? f : `${f.severity}:${f.text}`))
    .sort();
  return {
    address: subject.toLowerCase(),
    chain: chainKey,
    chainId: CHAINS[chainKey],
    verdict: v.verdict,
    score: v.score,
    summary: v.summary || "",
    flags,
    agentAdvice: v.agentAdvice || "",
  };
}
function verdictHashOf(payload) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
}

async function payAndVerify(subject, chainKey) {
  const wallet = new ethers.Wallet(loadOpsKey());
  if (wallet.address.toLowerCase() !== EXPECTED_OPS.toLowerCase()) {
    throw new Error(`key derives ${wallet.address}, expected ops wallet — refusing`);
  }
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: subject, chain: chainKey }),
  };
  let res = await fetch(VERIFY_URL, init);
  if (res.status === 200) return { verdict: await res.json(), paid: false };
  if (res.status !== 402) throw new Error(`verify returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  // Parse payment requirements (body JSON first, header fallback).
  let required = null;
  const bodyText = await res.text();
  try { required = JSON.parse(bodyText); } catch { /* try header */ }
  if (!required || !required.accepts) {
    const h = res.headers.get("payment-required");
    if (h) required = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  }
  const accepts = required && required.accepts && required.accepts[0];
  if (!accepts) throw new Error("402 without accepts[] — cannot pay");

  // Safety pins.
  if (String(accepts.payTo).toLowerCase() !== FLOW_PAYEE.toLowerCase()) throw new Error(`payTo ${accepts.payTo} != Flow payee — refusing`);
  if (String(accepts.asset).toLowerCase() !== USDC_BASE.toLowerCase()) throw new Error(`asset ${accepts.asset} != Base USDC — refusing`);
  if (accepts.network !== "eip155:8453") throw new Error(`network ${accepts.network} != eip155:8453 — refusing`);
  const amount = BigInt(accepts.amount);
  if (amount > MAX_PRICE_ATOMIC) throw new Error(`price ${amount} atomic > cap ${MAX_PRICE_ATOMIC} — refusing`);

  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const usdc = new ethers.Contract(USDC_BASE, ["function balanceOf(address) view returns (uint256)"], base);
  const bal = await usdc.balanceOf(wallet.address);
  if (bal < amount) throw new Error(`ops USDC balance ${bal} < price ${amount} — cannot pay`);

  const validBefore = Math.floor(Date.now() / 1000) + Number(accepts.maxTimeoutSeconds || 300);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const authorization = {
    from: wallet.address, to: ethers.getAddress(accepts.payTo), value: amount.toString(),
    validAfter: "0", validBefore: String(validBefore), nonce,
  };
  const signature = await wallet.signTypedData(
    { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    { from: authorization.from, to: authorization.to, value: amount, validAfter: 0n, validBefore: BigInt(validBefore), nonce }
  );
  const header = Buffer.from(JSON.stringify({
    x402Version: 2, scheme: "exact", network: "eip155:8453", accepted: accepts,
    payload: { authorization, signature },
  })).toString("base64");

  for (const headerName of ["PAYMENT-SIGNATURE", "X-PAYMENT"]) {
    res = await fetch(VERIFY_URL, { ...init, headers: { ...init.headers, [headerName]: header } });
    if (res.status === 200) return { verdict: await res.json(), paid: true, priceAtomic: amount.toString() };
  }
  throw new Error(`paid verify still HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function recordOnArc(payload, hash) {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "5042.json"), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "FlowVerdictRegistry.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(ARC_RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== 5042n) throw new Error(`Arc RPC chainId ${net.chainId} != 5042 — refusing`);
  const wallet = new ethers.Wallet(loadOpsKey(), provider);
  const bal = await provider.getBalance(wallet.address);
  if (bal < ethers.parseEther("0.005")) throw new Error(`Arc balance ${ethers.formatEther(bal)} USDC too low to record`);
  const registry = new ethers.Contract(dep.registry, artifact.abi, wallet);
  const tx = await registry.recordVerdict(
    payload.address, payload.chainId, payload.score, VERDICT_ENUM[payload.verdict], hash
  );
  const rc = await tx.wait();
  return { tx: tx.hash, block: rc.blockNumber, registry: dep.registry };
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "hash") {
    const payload = JSON.parse(fs.readFileSync(arg, "utf8"));
    console.log(verdictHashOf(payload));
    return;
  }
  if (cmd !== "check" || !arg) {
    console.error("usage: arc-feed.js check <address> [--chain base] [--send] | hash <payload.json>");
    process.exit(2);
  }
  const chainKey = (process.argv.includes("--chain") ? process.argv[process.argv.indexOf("--chain") + 1] : "base").toLowerCase();
  if (!(chainKey in CHAINS)) throw new Error(`unsupported chain ${chainKey}`);
  const subject = ethers.getAddress(arg);
  const send = process.argv.includes("--send");

  const { verdict, paid, priceAtomic } = await payAndVerify(subject, chainKey);
  const payload = canonicalPayload(verdict, subject, chainKey);
  const hash = verdictHashOf(payload);

  console.log("Flow /api/verify verdict");
  console.log("  subject:    ", subject, `(${chainKey}, chainId ${CHAINS[chainKey]})`);
  console.log("  verdict:    ", verdict.verdict, "| score:", verdict.score, "| advice:", verdict.agentAdvice || "-");
  console.log("  summary:    ", verdict.summary || "-");
  console.log("  flags:      ", payload.flags.join(" | ") || "none");
  console.log("  paid:       ", paid ? `${priceAtomic} atomic USDC ($${Number(priceAtomic) / 1e6}) — ops-wallet self-payment, NOT external revenue` : "no (endpoint answered free)");
  console.log("  verdictHash:", hash);

  const entry = { ts: new Date().toISOString(), ...payload, verdictHash: hash, arcTx: null };
  if (send) {
    const rec = await recordOnArc(payload, hash);
    entry.arcTx = rec.tx;
    console.log("\nRECORDED on Arc mainnet");
    console.log("  registry:", rec.registry);
    console.log("  tx:      ", rec.tx, `(block ${rec.block})`);
    console.log("  explorer:", `${EXPLORER}/tx/${rec.tx}`);
  } else {
    console.log("\nDry run — nothing written to Arc. Add --send (after deploy) to anchor it.");
  }
  fs.appendFileSync(path.join(ROOT, "feed-log.jsonl"), JSON.stringify(entry) + "\n");
})().catch((e) => {
  console.error("arc-feed failed:", e.message);
  process.exit(1);
});
