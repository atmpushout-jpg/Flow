/**
 * Flow seed-pilot worker — pays out the $0.05 starter seeds.
 *
 * Flow of a seed:
 *   1. An agent POSTs its new wallet address to /api/starter, which records
 *      a "pending" claim in Upstash (the API holds NO private key).
 *   2. This worker (VM-side only) reads the pending set, sends exactly
 *      0.05 USDC on Base from the Flow OPERATIONAL wallet, and marks the
 *      claim "claimed" with the tx hash.
 *
 * Key handling: the operational key is read at runtime from
 * ~/.config/flowexecutor_wallet_key, used in memory only, and never
 * printed, logged, or copied anywhere. Atm's personal wallet is never
 * touched — the loaded key's address must equal the operational wallet
 * below or the worker aborts before sending anything.
 *
 * Idempotency (an address is paid AT MOST once, ever):
 *   - the Upstash claim record is created once (SET NX at claim time) and
 *     its status flips pending -> claimed exactly here;
 *   - a local append-only ledger (offchain/seed-ledger.jsonl) is checked
 *     before every payment and survives restarts;
 *   - backstop: before paying, the worker scans on-chain USDC Transfer
 *     logs from the operational wallet to the claimant — if a seed already
 *     landed (e.g. a previous run crashed after sending), it marks the
 *     claim claimed with that tx instead of paying again.
 *
 * HONEST SYBIL NOTE: claims are one-per-ADDRESS, and fresh addresses are
 * free to create, so this cannot stop a farmer with many addresses. The
 * pilot caps bound the worst case: 19 seeds total x $0.05 = $0.95 (plus a
 * few cents of gas). That is the accepted cost of removing first-call
 * friction for real agents; see api/starter/index.js.
 *
 * Run:
 *   node offchain/seed-worker.js --dry-run   # log what WOULD be sent
 *   node offchain/seed-worker.js             # pay pending claims
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (required),
 *      BASE_RPC_URL (optional, default https://mainnet.base.org),
 *      SEED_DRY_RUN=1 (same as --dry-run).
 * On this VM, outbound traffic goes through the egress proxy — run it the
 * same way as the other bots: source /etc/flow-bots-proxy.env and set
 * NODE_USE_ENV_PROXY=1 first.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OP_WALLET_ADDRESS = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const SEED_USD = 0.05;
const SEED_ATOMIC = 50000n; // 0.05 USDC (6 decimals)
const KEY_PATH = path.join(os.homedir(), ".config", "flowexecutor_wallet_key");
const LEDGER_PATH = path.join(__dirname, "seed-ledger.jsonl");
const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const KEY_CLAIM_PREFIX = "flow:starter:claim:";
const KEY_PENDING = "flow:starter:pending";
const KEY_CLAIMED = "flow:starter:claimed";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const SCAN_CHUNK_BLOCKS = 10000;
const SCAN_MAX_BLOCKS = 200000; // ~4.6 days of Base blocks — the pilot is young

// ---------------------------------------------------------------------------
// Ledger (local, append-only)
// ---------------------------------------------------------------------------

function parseLedgerText(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.address) entries.push({ ...e, address: String(e.address).toLowerCase() });
    } catch {
      /* skip corrupt lines */
    }
  }
  return entries;
}

function readLedger() {
  try {
    return parseLedgerText(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Payment decision (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Decide what to do with one pending claimant.
 *   claimStatus: "pending" | "claimed" | anything else from the store
 *   inLedger:    the local ledger already records a payment to this address
 *   onchainTx:   tx hash of a prior USDC transfer op-wallet -> claimant, or null
 * Returns { action: "pay" } or { action: "skip", reason, markTx? }.
 */
function decidePayment({ claimStatus, inLedger, onchainTx }) {
  if (claimStatus === "claimed") return { action: "skip", reason: "already-claimed" };
  if (inLedger) return { action: "skip", reason: "in-ledger" };
  if (onchainTx) return { action: "skip", reason: "already-onchain", markTx: onchainTx };
  return { action: "pay" };
}

// ---------------------------------------------------------------------------
// Upstash store (REST command arrays, same env vars as the API)
// ---------------------------------------------------------------------------

function createStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  async function cmd(...parts) {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
    });
    if (!r.ok) throw new Error(`store responded ${r.status}`);
    return (await r.json()).result;
  }
  return {
    async pendingAddresses() {
      return (await cmd("SMEMBERS", KEY_PENDING)) || [];
    },
    async getClaim(addr) {
      const raw = await cmd("GET", KEY_CLAIM_PREFIX + addr);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async markClaimed(addr, record) {
      await cmd("SET", KEY_CLAIM_PREFIX + addr, JSON.stringify(record));
      await cmd("SADD", KEY_CLAIMED, addr);
      await cmd("SREM", KEY_PENDING, addr);
    },
    async removePending(addr) {
      await cmd("SREM", KEY_PENDING, addr);
    },
  };
}

// ---------------------------------------------------------------------------
// On-chain backstop: did we already send this address a seed?
// ---------------------------------------------------------------------------

async function findPriorTransfer(provider, toAddress) {
  const latest = await provider.getBlockNumber();
  const stop = Math.max(0, latest - SCAN_MAX_BLOCKS);
  const topics = [
    TRANSFER_TOPIC,
    ethers.zeroPadValue(OP_WALLET_ADDRESS, 32),
    ethers.zeroPadValue(toAddress, 32),
  ];
  for (let end = latest; end > stop; end -= SCAN_CHUNK_BLOCKS) {
    const from = Math.max(stop, end - SCAN_CHUNK_BLOCKS + 1);
    const logs = await provider.getLogs({
      address: USDC_BASE,
      topics,
      fromBlock: from,
      toBlock: end,
    });
    if (logs.length) {
      const hit = logs.find((l) => BigInt(l.data) === SEED_ATOMIC) || logs[0];
      return hit.transactionHash;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.env.SEED_DRY_RUN === "1";
  const store = createStore();
  if (!store) {
    console.log("seed-worker: UPSTASH_REDIS_REST_URL/TOKEN not set — no claim store, nothing to do.");
    return;
  }
  const pending = await store.pendingAddresses();
  console.log(`seed-worker: ${pending.length} pending claim(s)${dryRun ? " (DRY RUN — nothing will be sent)" : ""}`);
  if (!pending.length) return;

  const baseNetwork = ethers.Network.from(8453);
  const provider = new ethers.JsonRpcProvider(RPC_URL, baseNetwork, { staticNetwork: baseNetwork });
  const ledger = readLedger();
  const ledgerAddrs = new Set(ledger.map((e) => e.address));

  // Live mode only: load the operational key ONCE and prove it is the
  // operational wallet before any payment path is reachable.
  let wallet = null;
  let usdc = null;
  if (!dryRun) {
    const key = fs.readFileSync(KEY_PATH, "utf8").trim(); // never printed
    wallet = new ethers.Wallet(key, provider);
    if (wallet.address.toLowerCase() !== OP_WALLET_ADDRESS.toLowerCase()) {
      throw new Error(`key in ${KEY_PATH} is not the operational wallet — aborting, nothing sent`);
    }
    usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, wallet);
    const [usdcBal, ethBal] = await Promise.all([
      usdc.balanceOf(wallet.address),
      provider.getBalance(wallet.address),
    ]);
    console.log(
      `seed-worker: operational wallet USDC $${(Number(usdcBal) / 1e6).toFixed(4)}, ETH ${ethers.formatEther(ethBal)}`
    );
    if (usdcBal < SEED_ATOMIC) throw new Error("operational wallet has less than 0.05 USDC — cannot seed");
    if (ethBal === 0n) throw new Error("operational wallet has no ETH for gas — cannot seed");
  }

  for (const rawAddr of pending) {
    const addr = String(rawAddr).toLowerCase();
    try {
      const claim = await store.getClaim(addr);
      if (!claim) {
        console.log(`seed-worker: ${addr} in pending set but no claim record — cleaning up`);
        if (!dryRun) await store.removePending(addr);
        continue;
      }
      const onchainTx = await findPriorTransfer(provider, addr).catch(() => null);
      const decision = decidePayment({
        claimStatus: claim.status,
        inLedger: ledgerAddrs.has(addr),
        onchainTx,
      });
      if (decision.action === "skip") {
        console.log(`seed-worker: skip ${addr} (${decision.reason})`);
        if (!dryRun) {
          if (decision.reason === "already-onchain" && decision.markTx) {
            await store.markClaimed(addr, {
              ...claim,
              status: "claimed",
              txHash: decision.markTx,
              claimedAt: new Date().toISOString(),
              note: "reconciled from on-chain transfer (backstop)",
            });
            appendLedger({ address: addr, txHash: decision.markTx, usd: SEED_USD, at: new Date().toISOString(), source: "onchain-backstop" });
          } else if (decision.reason === "in-ledger") {
            const entry = ledger.find((e) => e.address === addr);
            await store.markClaimed(addr, {
              ...claim,
              status: "claimed",
              txHash: entry?.txHash || null,
              claimedAt: entry?.at || new Date().toISOString(),
              note: "reconciled from local ledger",
            });
          } else {
            await store.removePending(addr);
          }
        }
        continue;
      }
      // decision.action === "pay"
      if (dryRun) {
        console.log(`seed-worker: WOULD SEND 0.05 USDC -> ${addr} (claim from ${claim.requestedAt || "?"})`);
        continue;
      }
      const tx = await usdc.transfer(ethers.getAddress(addr), SEED_ATOMIC);
      const receipt = await tx.wait(1);
      const record = {
        ...claim,
        status: "claimed",
        txHash: tx.hash,
        claimedAt: new Date().toISOString(),
        blockNumber: receipt.blockNumber,
      };
      await store.markClaimed(addr, record);
      appendLedger({ address: addr, txHash: tx.hash, usd: SEED_USD, at: record.claimedAt, blockNumber: receipt.blockNumber });
      ledgerAddrs.add(addr);
      console.log(`seed-worker: SENT 0.05 USDC -> ${addr} tx ${tx.hash}`);
    } catch (e) {
      console.error(`seed-worker: failed for ${addr}: ${e.message}`);
    }
  }
  console.log("seed-worker: done");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`seed-worker: fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { decidePayment, parseLedgerText, findPriorTransfer, OP_WALLET_ADDRESS, SEED_ATOMIC, SEED_USD };
