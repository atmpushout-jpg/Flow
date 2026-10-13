"use strict";
// Fund the ops wallet on Arc: bridge $2 USDC from Base via Relay solvers.
//
// Why not raw CCTP (DEPLOY.md Step 1)? CCTP addresses/domains were verified
// against Circle's official reference (developers.circle.com/cctp):
//   TokenMessengerV2     0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
//   MessageTransmitterV2 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
//   Base domain 6, Arc domain 26.
// But CCTP's final leg, MessageTransmitterV2.receiveMessage on Arc, must be
// sent by an account that already holds Arc gas (native USDC) — and the ops
// wallet's Arc balance is 0.0, so the mint could never be claimed. Relay
// solvers pay the Arc-side gas and net it from the amount (~$0.021 on $2),
// delivering native USDC straight to the ops wallet. Same wallets, same $2,
// inside the sprint's $5 cap. Atm's payee wallet is never touched.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const KEY_FILE = path.join(process.env.HOME, ".config", "flowexecutor_wallet_key");
const OPS = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ARC_RPC = process.env.ARC_RPC || "https://rpc.mainnet.arc.io";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT = "2000000"; // $2.00
const MIN_OUT = 1_900_000_000_000_000_000n; // >= 1.90 USDC (18 dec) on Arc
const ETH_FLOOR = ethers.parseEther("0.00051");

function loadWallet(provider) {
  const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
  const pk = raw.startsWith("0x") ? raw : "0x" + raw;
  const w = new ethers.Wallet(pk, provider);
  if (w.address.toLowerCase() !== OPS.toLowerCase()) throw new Error(`key derives ${w.address}, expected ops — refusing`);
  return w;
}

(async () => {
  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const arc = new ethers.JsonRpcProvider(ARC_RPC);
  const wallet = loadWallet(base);
  const usdc = new ethers.Contract(USDC_BASE, ["function balanceOf(address) view returns (uint256)"], base);

  const [usdcBal, ethBal, arcBal] = await Promise.all([
    usdc.balanceOf(OPS), base.getBalance(OPS), arc.getBalance(OPS),
  ]);
  console.log("before: Base USDC", ethers.formatUnits(usdcBal, 6), "| Base ETH", ethers.formatEther(ethBal), "| Arc USDC", ethers.formatEther(arcBal));
  if (usdcBal < BigInt(AMOUNT)) throw new Error("insufficient Base USDC");
  if (ethBal < ETH_FLOOR + ethers.parseEther("0.0001")) throw new Error("Base ETH too close to floor — refusing");
  if (arcBal >= ethers.parseEther("1.9")) { console.log("Arc already funded >= 1.9 USDC — nothing to do."); return; }

  // Fresh Relay quote.
  const res = await fetch("https://api.relay.link/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: OPS, recipient: OPS, originChainId: 8453, destinationChainId: 5042,
      originCurrency: USDC_BASE, destinationCurrency: "0x0000000000000000000000000000000000000000",
      amount: AMOUNT, tradeType: "EXACT_INPUT",
    }),
  });
  const q = await res.json();
  if (!q.steps) throw new Error("quote failed: " + JSON.stringify(q).slice(0, 300));
  const out = BigInt(q.details.currencyOut.amount);
  console.log("quote out:", ethers.formatEther(out), "USDC on Arc | steps:", q.steps.map((s) => s.id).join(","));
  if (out < MIN_OUT) throw new Error(`quote output ${ethers.formatEther(out)} < 1.90 floor — refusing`);

  // Bind the steps together: the approve step must target Base USDC and its
  // spender must equal the deposit step's target (Relay's depository).
  const approveItem = q.steps.find((s) => s.id === "approve")?.items?.[0];
  const depositItem = q.steps.find((s) => s.id === "deposit")?.items?.[0];
  if (!approveItem || !depositItem) throw new Error("quote missing approve/deposit steps");
  if (approveItem.data.to.toLowerCase() !== USDC_BASE.toLowerCase()) throw new Error("approve step does not target Base USDC — refusing");
  const spender = "0x" + approveItem.data.data.slice(34, 74);
  if (depositItem.data.to.toLowerCase() !== spender.toLowerCase()) {
    throw new Error(`deposit target ${depositItem.data.to} != approve spender ${spender} — refusing`);
  }
  console.log("depository (spender == deposit target):", spender);

  const txHashes = [];
  for (const step of q.steps) {
    for (const item of step.items) {
      const d = item.data;
      const tx = await wallet.sendTransaction({ to: d.to, data: d.data, value: BigInt(d.value || "0") });
      console.log(`${step.id} tx:`, tx.hash);
      txHashes.push(tx.hash);
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`${step.id} tx reverted: ${tx.hash}`);
      console.log(`${step.id} confirmed in block`, rc.blockNumber);
    }
  }

  // Wait for the solver fill on Arc.
  const deadline = Date.now() + 10 * 60 * 1000;
  let bal = await arc.getBalance(OPS);
  while (bal < MIN_OUT && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    bal = await arc.getBalance(OPS);
    console.log("Arc balance:", ethers.formatEther(bal));
  }
  if (bal < MIN_OUT) throw new Error("fill not observed on Arc within 10 min — check Relay status for the deposit tx");
  const [usdcAfter, ethAfter] = await Promise.all([usdc.balanceOf(OPS), base.getBalance(OPS)]);
  console.log("BRIDGE DONE. Arc USDC:", ethers.formatEther(bal), "| Base USDC:", ethers.formatUnits(usdcAfter, 6), "| Base ETH:", ethers.formatEther(ethAfter));
  console.log("Base txs:", txHashes.join(", "));
})().catch((e) => { console.error("bridge failed:", e.message); process.exit(1); });
