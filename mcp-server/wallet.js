/**
 * Flow Starter Wallet — local, user-owned x402 payer wallet for the MCP server.
 *
 * Design rules (non-negotiable):
 *  - The private key is generated LOCALLY, stored only in the user's own
 *    environment at ~/.config/flow-wallet.json with 0600 permissions, and
 *    is NEVER sent anywhere, never returned by any tool, never logged.
 *  - Payments are x402 v2 "exact" EIP-3009 USDC authorizations on Base,
 *    ported from the reference signer (x402_pay.py): the payload carries
 *    `accepted` verbatim (PayAI's facilitator requires it) plus the
 *    `resource`/`extensions` from the 402 response when present.
 *  - Hard caps enforced in code BEFORE signing: max $0.05 per call and a
 *    daily cap (default $1, override with FLOW_DAILY_SPEND_CAP_USD),
 *    tracked in a rolling-24h local ledger next to the wallet file.
 *  - Cap discipline (reservation pattern — the fix for the bypass class in
 *    ClawRouter report ET-CLAWROUTER-20261010): spend is RESERVED against
 *    the daily cap atomically (lockfile + check + append, no awaits) BEFORE
 *    anything is signed, so concurrent calls — in this process or any other
 *    process sharing the wallet file — cannot race past the cap on stale
 *    ledger state. A reservation is released only when the payment provably
 *    never left this machine (insufficient balance, invalid 402, signing
 *    failure). Once an authorization has been broadcast, the reservation
 *    counts toward the cap PERMANENTLY — even if the response is an error
 *    or never arrives — because the facilitator may have settled it.
 *  - This client only ever pays Flow's own payee address (pinned below) —
 *    a 402 asking to pay anyone else is refused, not signed.
 */
import { ethers } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const FLOW_PAYEE = (
  process.env.FLOW_PAYEE_ADDRESS || "0xcF8A8350cb42a6680005ca7FF9E485Bb55fa74FA"
).trim();
export const NETWORK = "eip155:8453"; // Base mainnet
export const CHAIN_ID = 8453;
export const PER_CALL_CAP_USD = 0.05;
export const DEFAULT_RPC = "https://mainnet.base.org";

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

export function dailyCapUsd() {
  const v = parseFloat(process.env.FLOW_DAILY_SPEND_CAP_USD || "1");
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function walletPath() {
  return (
    process.env.FLOW_WALLET_PATH ||
    path.join(os.homedir(), ".config", "flow-wallet.json")
  );
}

export function ledgerPath() {
  if (process.env.FLOW_SPEND_LEDGER_PATH) return process.env.FLOW_SPEND_LEDGER_PATH;
  return path.join(path.dirname(walletPath()), "flow-spend-ledger.jsonl");
}

// ---------------------------------------------------------------------------
// Wallet storage
// ---------------------------------------------------------------------------

function readWalletFile() {
  const p = walletPath();
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!data.privateKey || !data.address) {
    throw new Error(`Wallet file at ${p} is malformed (missing address/privateKey)`);
  }
  return data;
}

function enforcePerms(p) {
  try {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode !== 0o600) fs.chmodSync(p, 0o600);
  } catch {
    /* best effort — write path below also sets the mode */
  }
}

/**
 * Load the starter wallet, generating and persisting one on first use.
 * Returns { wallet, address, created } — the private key stays inside
 * `wallet` and must never be serialized into tool output.
 */
export function loadOrCreateWallet() {
  const p = walletPath();
  const existing = readWalletFile();
  if (existing) {
    enforcePerms(p);
    const wallet = new ethers.Wallet(existing.privateKey);
    if (wallet.address.toLowerCase() !== existing.address.toLowerCase()) {
      throw new Error(`Wallet file at ${p} is inconsistent (address does not match key)`);
    }
    return { wallet, address: wallet.address, created: false };
  }
  const wallet = ethers.Wallet.createRandom();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const record = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString(),
    note: "Flow starter wallet — LOCAL ONLY. Never share this file or its key.",
  };
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  enforcePerms(p);
  return { wallet, address: wallet.address, created: true };
}

export function loadWallet() {
  const existing = readWalletFile();
  if (!existing) return null;
  enforcePerms(walletPath());
  return new ethers.Wallet(existing.privateKey);
}

// ---------------------------------------------------------------------------
// Spend ledger + caps (rolling 24h, same semantics as x402_pay.py)
// ---------------------------------------------------------------------------

export function readLedger() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (Number.isFinite(e.ts) && Number.isFinite(e.usd)) out.push(e);
    } catch {
      /* skip corrupt lines */
    }
  }
  return out;
}

export function spentLast24h(entries, nowSec = Date.now() / 1000) {
  return entries
    .filter((e) => nowSec - e.ts < 86400)
    .reduce((sum, e) => sum + e.usd, 0);
}

/**
 * Pure cap check — throws with a plain-language reason when a payment of
 * `amountUsd` would breach the per-call cap or the rolling daily cap.
 */
export function checkCaps(amountUsd, entries, opts = {}) {
  const perCall = opts.perCallCapUsd ?? PER_CALL_CAP_USD;
  const daily = opts.dailyCapUsd ?? dailyCapUsd();
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`Invalid payment amount: ${amountUsd}`);
  }
  if (amountUsd > perCall) {
    throw new Error(
      `Refusing to pay $${amountUsd}: above the hard per-call cap of $${perCall}`
    );
  }
  const spent = spentLast24h(entries, nowSec);
  if (spent + amountUsd > daily) {
    throw new Error(
      `Refusing to pay $${amountUsd}: daily spend cap of $${daily} would be exceeded ` +
        `(already spent $${spent.toFixed(4)} in the last 24h)`
    );
  }
  return { spentLast24h: spent, dailyCapUsd: daily, perCallCapUsd: perCall };
}

function appendLedgerEntry(entry) {
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n", { mode: 0o600 });
  return entry;
}

export function recordSpend(usd, url) {
  const release = acquireLedgerLock();
  try {
    return appendLedgerEntry({
      ts: Date.now() / 1000,
      at: new Date().toISOString(),
      usd,
      url,
      status: "settled",
    });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Ledger lock + spend reservations
//
// The cap check and the ledger write must be one atomic step, or concurrent
// payers (parallel tool calls here, or separate MCP server processes sharing
// ~/.config/flow-wallet.json) all validate against the same stale snapshot
// and settle past the cap. All ledger mutations below are SYNCHRONOUS (no
// awaits inside the critical section, so they cannot interleave within a
// process) and run under an exclusive lockfile (so they cannot interleave
// across processes either).
// ---------------------------------------------------------------------------

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function acquireLedgerLock(timeoutMs = 10000) {
  const lockPath = ledgerPath() + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } catch {
        /* the lock is the file's existence, not its contents */
      }
      return () => {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A lock older than 30s belongs to a dead holder (critical sections
      // here are milliseconds long) — steal it rather than wedging forever.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* raced a release — just retry */
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error("Timed out waiting for the spend-ledger lock — refusing to pay unlocked");
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, 10);
    }
  }
}

function rewriteLedger(entries) {
  const p = ledgerPath();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), {
    mode: 0o600,
  });
  fs.renameSync(tmp, p);
}

/**
 * Atomically check the caps AND record a reservation for `usd`. Throws the
 * checkCaps error (writing nothing) when the payment would breach a cap.
 * The reservation counts toward the daily cap from this moment — before
 * signing — and is only removed by voidReservation() on paths where the
 * payment provably never left this machine.
 * Returns the reservation id.
 */
export function reserveSpend(usd, url) {
  const release = acquireLedgerLock();
  try {
    const entries = readLedger();
    checkCaps(usd, entries);
    const entry = {
      ts: Date.now() / 1000,
      at: new Date().toISOString(),
      usd,
      url,
      id: ethers.hexlify(ethers.randomBytes(8)),
      status: "reserved",
    };
    appendLedgerEntry(entry);
    return entry.id;
  } finally {
    release();
  }
}

function updateReservation(id, fn) {
  const release = acquireLedgerLock();
  try {
    const entries = readLedger();
    const next = fn(entries);
    if (next) rewriteLedger(next);
  } finally {
    release();
  }
}

/**
 * Mark a reservation with its final status ("settled" or
 * "broadcast-unconfirmed"). The entry STAYS in the ledger and keeps counting
 * toward the daily cap either way: once an authorization has been sent, the
 * money must be treated as spent, because a failed or lost response does not
 * prove the facilitator didn't settle it.
 */
export function finalizeReservation(id, status) {
  updateReservation(id, (entries) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return null;
    e.status = status;
    return entries;
  });
}

/**
 * Remove a reservation WITHOUT counting it. Only for paths where nothing
 * was ever signed or sent: insufficient balance found before signing, an
 * invalid 402, or a signing failure.
 */
export function voidReservation(id) {
  updateReservation(id, (entries) => entries.filter((x) => x.id !== id));
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/** USDC balance in dollars, or null when the RPC is unreachable. */
export async function getUsdcBalance(address, rpcUrl = process.env.FLOW_BASE_RPC || DEFAULT_RPC) {
  try {
    // Static network: without it ethers retries network detection forever
    // against a dead RPC, which would stall the MCP server. The timeout
    // race bounds a black-holed endpoint the same way.
    const network = ethers.Network.from(CHAIN_ID);
    const provider = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
    const usdc = new ethers.Contract(USDC_BASE, ERC20_BALANCE_ABI, provider);
    const raw = await Promise.race([
      usdc.balanceOf(address),
      new Promise((_, reject) => setTimeout(() => reject(new Error("balance check timed out")), 8000)),
    ]);
    return Number(raw) / 1e6;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// x402 payment signing — port of x402_pay.py's build_payment_header()
// ---------------------------------------------------------------------------

/**
 * Build the base64 X-PAYMENT header for a 402 `accepts` entry.
 * Mirrors x402_pay.py exactly: validates scheme/network/asset/payTo,
 * enforces caps, signs EIP-712 TransferWithAuthorization against the
 * USDC domain ("USD Coin", version "2", chainId 8453), and echoes
 * `accepted`, `resource` and `extensions` into the payload.
 */
export async function buildPaymentHeader({ accepts, wallet, extensions, resource, ledgerEntries, nowSec, skipCapCheck }) {
  if (!accepts || accepts.scheme !== "exact") {
    throw new Error(`Unsupported scheme: ${accepts?.scheme}`);
  }
  if (accepts.network !== NETWORK) {
    throw new Error(`Wrong network: ${accepts.network} (expected ${NETWORK})`);
  }
  if (String(accepts.asset || "").toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new Error(`Wrong asset: ${accepts.asset} (expected USDC on Base)`);
  }
  if (String(accepts.payTo || "").toLowerCase() !== FLOW_PAYEE.toLowerCase()) {
    throw new Error(
      `Wrong payTo: ${accepts.payTo} — this client only pays Flow's payee ${FLOW_PAYEE}`
    );
  }
  const amountAtomic = BigInt(accepts.amount);
  const priceUsd = Number(amountAtomic) / 1e6;
  // fetchWithPayment passes skipCapCheck because it has ALREADY reserved
  // this amount against the caps (reserveSpend ran the same checkCaps);
  // checking again here would double-count the reservation. Direct callers
  // keep the standalone check.
  if (!skipCapCheck) {
    checkCaps(priceUsd, ledgerEntries ?? readLedger(), { nowSec });
  }

  const validBefore = Math.floor(nowSec ?? Date.now() / 1000) + Number(accepts.maxTimeoutSeconds || 300);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const authorization = {
    from: wallet.address,
    to: ethers.getAddress(accepts.payTo),
    value: amountAtomic.toString(),
    validAfter: "0",
    validBefore: String(validBefore),
    nonce,
  };
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: CHAIN_ID,
    verifyingContract: USDC_BASE,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: amountAtomic,
    validAfter: 0n,
    validBefore: BigInt(validBefore),
    nonce,
  };
  const signature = await wallet.signTypedData(domain, types, message);
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    accepted: accepts,
    payload: { authorization, signature },
  };
  if (extensions) paymentPayload.extensions = extensions;
  if (resource) paymentPayload.resource = resource;
  const header = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  return { header, priceUsd, payer: wallet.address };
}

/**
 * fetch() with x402 auto-pay: on a 402, if a local starter wallet exists,
 * is funded, and the price is within caps, sign and retry ONCE.
 * Returns { res, payment } — payment is null when no payment was made.
 * Throws only for cap breaches / wrong-payee 402s (caller surfaces them);
 * a missing or unfunded wallet returns the original 402 response.
 */
export async function fetchWithPayment(url, init = {}, opts = {}) {
  const res = await fetch(url, init);
  if (res.status !== 402) return { res, payment: null };

  const bodyText = await res.text();
  let required;
  try {
    required = JSON.parse(bodyText);
  } catch {
    return { res: syntheticResponse(402, bodyText), payment: null };
  }
  const accepts = required?.accepts?.[0];
  if (!accepts) return { res: syntheticResponse(402, bodyText), payment: null };

  const wallet = opts.wallet || loadWallet();
  if (!wallet) return { res: syntheticResponse(402, bodyText), payment: null, needsWallet: true };

  // RESERVE FIRST: the cap check and the reservation are one atomic step,
  // taken before the balance check and before signing, so no concurrent
  // caller — in this process or another — can pass the daily cap on the
  // strength of spend that is still in flight. A cap breach throws here,
  // before anything is signed or written beyond the check itself.
  const amountUsd = Number(BigInt(accepts.amount)) / 1e6;
  const reservationId = reserveSpend(amountUsd, url);
  let reservationOpen = true;
  const voidIt = () => {
    voidReservation(reservationId);
    reservationOpen = false;
  };
  const finalizeIt = (status) => {
    finalizeReservation(reservationId, status);
    reservationOpen = false;
  };

  try {
    // Balance check before signing so an unfunded wallet gets a funding
    // message, not a signed-but-doomed authorization. Nothing has been
    // signed or sent yet, so the reservation is released, not counted.
    const balance = await getUsdcBalance(wallet.address, opts.rpcUrl);
    if (balance !== null && balance < amountUsd) {
      voidIt();
      return { res: syntheticResponse(402, bodyText), payment: null, insufficientFunds: { balance, needed: amountUsd } };
    }

    let signed;
    try {
      signed = await buildPaymentHeader({
        accepts,
        wallet,
        extensions: required.extensions,
        resource: required.resource,
        skipCapCheck: true, // already enforced by the reservation above
      });
    } catch (e) {
      // Invalid 402 (wrong payee/network/asset) or signing failure: the
      // authorization never existed on the wire. Release the reservation.
      voidIt();
      throw e;
    }

    let retry;
    try {
      retry = await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), "X-PAYMENT": signed.header },
      });
    } catch (e) {
      // The signed authorization was SENT but the outcome is unknown — the
      // request may have reached the server and settled. Count it toward
      // the cap permanently; never let a retry treat it as unspent.
      finalizeIt("broadcast-unconfirmed");
      throw e;
    }
    if (retry.status >= 200 && retry.status < 300) {
      finalizeIt("settled");
    } else {
      // Broadcast and answered with an error (e.g. a 502 after the
      // facilitator settled). The payment counts toward the cap exactly
      // like a successful one — this is the lost-payment bypass, closed.
      finalizeIt("broadcast-unconfirmed");
    }
    return { res: retry, payment: { priceUsd: signed.priceUsd, payer: signed.payer } };
  } finally {
    // Safety net: any path that leaves with the reservation still open
    // (an unexpected throw after signing) counts the spend, never frees it.
    if (reservationOpen) finalizeReservation(reservationId, "broadcast-unconfirmed");
  }
}

function syntheticResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
