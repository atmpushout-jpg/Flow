"use strict";
// Deploy FlowVerdictRegistry to Arc mainnet (chain 5042).
//
//   node scripts/deploy.js            -> preflight only (no tx sent)
//   node scripts/deploy.js --send     -> deploy for real
//
// Deployer: the Flow OPERATIONAL wallet (key in ~/.config, 600 perms).
// The derived address is asserted against the expected ops address so the
// wrong key file can never be used by accident. Atm's payee wallet is never
// touched. Proxy: run with the VM proxy env sourced and
// NODE_USE_ENV_PROXY=1 (see DEPLOY.md).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ARC_RPC = process.env.ARC_RPC || "https://rpc.mainnet.arc.io";
const ARC_CHAIN_ID = 5042n;
const EXPLORER = "https://explorer.arc.io";
const KEY_FILE = path.join(process.env.HOME, ".config", "flowexecutor_wallet_key");
const EXPECTED_OPS = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561";
const MIN_BALANCE_USDC = 0.05; // native USDC (18-dec view) floor to deploy

function loadWallet(provider) {
  const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
  const pk = raw.startsWith("0x") ? raw : "0x" + raw;
  const w = new ethers.Wallet(pk, provider);
  if (w.address.toLowerCase() !== EXPECTED_OPS.toLowerCase()) {
    throw new Error(`key file derives ${w.address}, expected ops wallet ${EXPECTED_OPS} — refusing`);
  }
  return w;
}

(async () => {
  const send = process.argv.includes("--send");
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "FlowVerdictRegistry.json"), "utf8"));

  const provider = new ethers.JsonRpcProvider(ARC_RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== ARC_CHAIN_ID) throw new Error(`RPC chainId is ${net.chainId}, expected 5042 — refusing`);
  const wallet = loadWallet(provider);
  const balance = await provider.getBalance(wallet.address); // native USDC, 18 decimals
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice || 20_000_000_000n;
  const deployGas = await provider.estimateGas({ from: wallet.address, data: artifact.bytecode }).catch(() => 900_000n);
  const estCost = ethers.formatEther(deployGas * gasPrice);

  console.log("Arc mainnet preflight");
  console.log("  chainId:      ", net.chainId.toString());
  console.log("  deployer (ops):", wallet.address);
  console.log("  native balance:", ethers.formatEther(balance), "USDC");
  console.log("  gas price:     ", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  console.log("  deploy gas est:", deployGas.toString(), "-> cost est:", estCost, "USDC");

  if (!send) {
    console.log("\nPreflight only. Re-run with --send to deploy.");
    if (balance < ethers.parseEther(String(MIN_BALANCE_USDC))) {
      console.log(`NOTE: balance is below the ${MIN_BALANCE_USDC} USDC floor — fund the ops wallet on Arc first (see DEPLOY.md, funding section).`);
    }
    return;
  }

  if (balance < ethers.parseEther(String(MIN_BALANCE_USDC))) {
    throw new Error(`balance ${ethers.formatEther(balance)} USDC < ${MIN_BALANCE_USDC} floor — fund first (DEPLOY.md)`);
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  const deployTx = contract.deploymentTransaction();
  console.log("\ndeploy tx:", deployTx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await deployTx.wait();
  const total = await contract.totalVerdicts();

  const record = {
    network: "arc-mainnet",
    chainId: 5042,
    registry: address,
    deployTx: deployTx.hash,
    block: receipt.blockNumber,
    deployer: wallet.address,
    totalVerdictsAtDeploy: Number(total),
    explorer: `${EXPLORER}/address/${address}`,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, "deployments", "5042.json"), JSON.stringify(record, null, 2));

  const cfg = `// Written by scripts/deploy.js — Arc mainnet deployment of the Flow Verdict Registry.\nwindow.FLOW_ARC = {\n  registry: "${address}",\n  deployTx: "${deployTx.hash}",\n  chainId: 5042,\n  rpc: "${ARC_RPC}",\n  explorer: "${EXPLORER}",\n  flowSite: "https://flow-kg4x.vercel.app",\n};\n`;
  fs.writeFileSync(path.join(ROOT, "demo", "config.js"), cfg);

  // Single-file live demo (config inlined) — this is the file uploaded to
  // the Flow repo root as arc-verdict.html so Vercel serves it directly.
  const demoSrc = fs.readFileSync(path.join(ROOT, "demo", "arc-verdict.html"), "utf8");
  const live = demoSrc.replace('<script src="config.js"></script>', "<script>\n" + cfg + "</script>");
  if (live === demoSrc) throw new Error("demo config inline failed: script tag not found");
  fs.writeFileSync(path.join(ROOT, "demo", "arc-verdict.live.html"), live);

  console.log("DEPLOYED FlowVerdictRegistry:", address);
  console.log("  explorer:", record.explorer);
  console.log("  record:   deployments/5042.json");
  console.log("  demo cfg: demo/config.js updated");
})().catch((e) => {
  console.error("deploy failed:", e.message);
  process.exit(1);
});
