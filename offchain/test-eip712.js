/** Verify auctioneer EIP-712 hash matches contract's _hashTypedDataV4 */
const { ethers } = require("ethers");

const CHAIN_ID = 84532;
const ROUTER = "0x1111111111111111111111111111111111111111";

const domain = { name: "FlowIntentRouter", version: "0", chainId: CHAIN_ID, verifyingContract: ROUTER };
const types = {
  Intent: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

const intent = {
  user: "0x2222222222222222222222222222222222222222",
  tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  tokenOut: "0x4200000000000000000000000000000000000006",
  amountIn: "10000000",
  minAmountOut: "3800000000000000",
  expiry: 1790000000,
  nonce: 0,
};

// Method 1: TypedDataEncoder.hash (what auctioneer uses)
const h1 = ethers.TypedDataEncoder.hash(domain, types, intent);

// Method 2: manual construction exactly like Solidity _hashTypedDataV4
const EIP712_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const INTENT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("Intent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)"));
const domainSeparator = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32","bytes32","bytes32","uint256","address"],
  [EIP712_TYPEHASH, ethers.keccak256(ethers.toUtf8Bytes("FlowIntentRouter")), ethers.keccak256(ethers.toUtf8Bytes("0")), CHAIN_ID, ROUTER]
));
const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32","address","address","address","uint256","uint256","uint256","uint256"],
  [INTENT_TYPEHASH, intent.user, intent.tokenIn, intent.tokenOut, intent.amountIn, intent.minAmountOut, intent.expiry, intent.nonce]
));
const h2 = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));

console.log("TypedDataEncoder:", h1);
console.log("Manual Solidity :", h2);
console.log(h1 === h2 ? "[PASS] hashes match - auctioneer and contract agree" : "[FAIL] MISMATCH");
