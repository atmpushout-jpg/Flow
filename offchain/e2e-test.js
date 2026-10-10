/**
 * End-to-end closed-loop test on the fork.
 * Signs a USDC->WETH intent as the test user and POSTs it to the server.
 * Run: node offchain/e2e-test.js
 */
const { ethers } = require("ethers");
const fs = require("fs");

const RPC = "http://localhost:8545";
const SERVER = "http://localhost:8787";
const ROUTER = fs.readFileSync("/tmp/fork-router.txt", "utf8").trim();
const USER_KEY = fs.readFileSync("/tmp/user-key.txt", "utf8").trim();
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const CHAIN_ID = 8453;

const ROUTER_ABI = ["function nonces(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const user = new ethers.Wallet(USER_KEY, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);

  const amountIn = ethers.parseUnits("20", 6); // $20 USDC (under $25 cap)

  // Get a baseline for minAmountOut
  const q = await fetch(
    `${SERVER}/quote?tokenIn=${USDC}&tokenOut=${WETH}&amountIn=${amountIn}`
  ).then((r) => r.json());
  console.log("baseline:", ethers.formatUnits(q.baselineOut, 18), "WETH");
  console.log("best:    ", ethers.formatUnits(q.bestOut, 18), "WETH");

  const nonce = await router.nonces(user.address);
  const intent = {
    user: user.address,
    tokenIn: USDC,
    tokenOut: WETH,
    amountIn: amountIn.toString(),
    minAmountOut: ((BigInt(q.baselineOut) * 98n) / 100n).toString(),
    expiry: Math.floor(Date.now() / 1000) + 180,
    nonce: nonce.toString(),
  };
  const domain = {
    name: "FlowIntentRouter", version: "0",
    chainId: CHAIN_ID, verifyingContract: ROUTER,
  };
  const types = { Intent: [
    { name: "user", type: "address" }, { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" }, { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ]};
  const userSig = await user.signTypedData(domain, types, intent);
  console.log("intent signed, sending to auction...");

  const res = await fetch(`${SERVER}/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...intent, userSig }),
  }).then((r) => r.json());

  console.log("\nresult:", JSON.stringify(res, null, 2));

  if (res.status === "filled") {
    const pnl = await fetch(`${SERVER}/pnl`).then((r) => r.json());
    console.log("\n/pnl:", JSON.stringify(pnl, null, 2));
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
