"use strict";
// Fund the ops wallet on Arc: bridge $2 USDC from Base via Across.
//
// Why not raw CCTP (DEPLOY.md Step 1)? CCTP addresses/domains were verified
// against Circle's official reference (developers.circle.com/cctp):
//   TokenMessengerV2     0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
//   MessageTransmitterV2 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
//   Base domain 6, Arc domain 26.
// But CCTP's final leg, MessageTransmitterV2.receiveMessage on Arc, must be
// sent by an account that already holds Arc gas (native USDC) — the ops
// wallet's Arc balance is 0.0, so a CCTP mint could never be claimed.
// (Relay was tried first: its Base depository reverted the deposit with an
// opaque custom error after the approve leg; the allowance it set is
// harmless and unused.) Across relayers pay the Arc-side gas and net a
// ~$0.003 fee from the amount, delivering USDC to the ops wallet on Arc.
// Same wallets, same $2, inside the sprint's $5 cap. Atm's payee wallet is
// never touched.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const KEY_FILE = path.join(process.env.HOME, ".config", "flowexecutor_wallet_key");
const OPS = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ARC_RPC = process.env.ARC_RPC || "https://rpc.mainnet.arc.io";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARC = "0x3600000000000000000000000000000000000000";
const SPOKE_BASE = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64"; // from Across suggested-fees API
const AMOUNT = 2000000n; // $2.00
const MIN_OUT_ATOMIC = 1_950_000n; // >= $1.95 out, 6-dec
const ETH_FLOOR = ethers.parseEther("0.00051");

const SPOKE_ABI = [
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 indexed recipient, bytes32 exclusiveRelayer, bytes message)",
];

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
  const usdc = new ethers.Contract(USDC_BASE, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], wallet);

  const [usdcBal, ethBal, arcBal] = await Promise.all([usdc.balanceOf(OPS), base.getBalance(OPS), arc.getBalance(OPS)]);
  console.log("before: Base USDC", ethers.formatUnits(usdcBal, 6), "| Base ETH", ethers.formatEther(ethBal), "| Arc USDC", ethers.formatEther(arcBal));
  if (usdcBal < AMOUNT) throw new Error("insufficient Base USDC");
  if (ethBal < ETH_FLOOR + ethers.parseEther("0.0001")) throw new Error("Base ETH too close to floor — refusing");
  if (arcBal >= ethers.parseEther("1.9")) { console.log("Arc already funded >= 1.9 USDC — nothing to do."); return; }

  // Fresh Across quote.
  const now = Math.floor(Date.now() / 1000);
  const url = "https://app.across.to/api/suggested-fees?token=" + USDC_BASE +
    "&originChainId=8453&destinationChainId=5042&amount=" + AMOUNT.toString() +
    "&recipient=" + OPS + "&relayer=0x0000000000000000000000000000000000000000&quoteTimestamp=" + now + "&message=0x";
  const fees = await (await fetch(url)).json();
  if (fees.isAmountTooLow) throw new Error("Across says amount too low");
  if (String(fees.spokePoolAddress).toLowerCase() !== SPOKE_BASE.toLowerCase()) {
    throw new Error(`spoke pool mismatch: API says ${fees.spokePoolAddress} — refusing`);
  }
  const outputAmount = BigInt(fees.outputAmount);
  if (outputAmount < MIN_OUT_ATOMIC) throw new Error(`output ${fees.outputAmount} below floor — refusing`);
  console.log(`quote: fee total ${fees.totalRelayFee.total} atomic | out ${ethers.formatUnits(outputAmount, 6)} USDC | quoteTimestamp ${fees.timestamp} | fillDeadline ${fees.fillDeadline}`);

  // Approve the SpokePool if needed, then wait until the allowance is
  // actually readable (the public Base RPC load-balances; a just-confirmed
  // approve can be invisible to the node that estimates the deposit).
  let allowance = await usdc.allowance(OPS, SPOKE_BASE);
  if (allowance < AMOUNT) {
    const atx = await usdc.approve(SPOKE_BASE, AMOUNT);
    console.log("approve tx:", atx.hash);
    const arc2 = await atx.wait();
    if (arc2.status !== 1) throw new Error("approve reverted");
  } else console.log("allowance already sufficient:", allowance.toString());
  for (let i = 0; i < 12 && allowance < AMOUNT; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    allowance = await usdc.allowance(OPS, SPOKE_BASE);
    console.log("allowance now:", allowance.toString());
  }
  if (allowance < AMOUNT) throw new Error("allowance never became visible — refusing to deposit");

  // Deposit.
  const spoke = new ethers.Contract(SPOKE_BASE, SPOKE_ABI, wallet);
  const dtx = await spoke.depositV3(
    OPS, OPS, USDC_BASE, USDC_ARC, AMOUNT, outputAmount, 5042,
    ethers.ZeroAddress, Number(fees.timestamp), Number(fees.fillDeadline), 0, "0x",
    { gasLimit: 400000 }
  );
  console.log("deposit tx:", dtx.hash);
  const drc = await dtx.wait();
  if (drc.status !== 1) throw new Error("deposit reverted");
  let depositId = null;
  const iface = new ethers.Interface(SPOKE_ABI);
  for (const log of drc.logs) {
    try { const p = iface.parseLog(log); if (p && p.name === "FundsDeposited") depositId = p.args.depositId.toString(); } catch { /* not ours */ }
  }
  console.log("deposit confirmed block", drc.blockNumber, "| depositId:", depositId);

  // Wait for the fill on Arc (native balance is the ground truth).
  const deadline = Date.now() + 12 * 60 * 1000;
  let bal = await arc.getBalance(OPS);
  while (bal < ethers.parseEther("1.9") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    bal = await arc.getBalance(OPS);
    console.log("Arc balance:", ethers.formatEther(bal));
  }
  if (bal < ethers.parseEther("1.9")) throw new Error("fill not observed on Arc within 12 min — deposit is safe on Across; check status API");
  const [usdcAfter, ethAfter] = await Promise.all([usdc.balanceOf(OPS), base.getBalance(OPS)]);
  console.log("BRIDGE DONE. Arc USDC:", ethers.formatEther(bal), "| Base USDC:", ethers.formatUnits(usdcAfter, 6), "| Base ETH:", ethers.formatEther(ethAfter));
  console.log("depositTx:", dtx.hash, "| depositId:", depositId);
})().catch((e) => { console.error("bridge failed:", e.message); process.exit(1); });
