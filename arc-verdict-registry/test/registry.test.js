"use strict";
// Local test suite: deploy FlowVerdictRegistry to an in-process ganache
// chain and exercise every function + guard. Run: npm test
const assert = require("assert");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { compile } = require("../scripts/compile");

let passed = 0;
function ok(name, cond) {
  assert(cond, name);
  passed++;
  console.log("  PASS", name);
}
async function mustRevert(name, promise, needle) {
  try {
    await promise;
  } catch (e) {
    const msg = (e && e.message) || "";
    assert(!needle || msg.includes(needle), `${name}: reverted but without "${needle}" (got: ${msg.slice(0, 160)})`);
    passed++;
    console.log("  PASS", name, "(reverted)");
    return;
  }
  assert.fail(`${name}: expected revert, tx succeeded`);
}

(async () => {
  console.log("== compile ==");
  const artifact = compile();
  ok("bytecode present", artifact.bytecode.length > 100);

  console.log("== local chain (ganache) ==");
  const server = ganache.server({ logging: { quiet: true } });
  await server.listen(0);
  const port = server.address().port;
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  const signer = await provider.getSigner(0);
  const signerAddr = await signer.getAddress();
  ok("ganache signer", /^0x[0-9a-fA-F]{40}$/.test(signerAddr));

  console.log("== deploy ==");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const registry = await factory.deploy();
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  ok("deployed at " + regAddr, /^0x[0-9a-fA-F]{40}$/.test(regAddr));
  ok("totalVerdicts starts 0", (await registry.totalVerdicts()) === 0n);

  console.log("== record verdicts ==");
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH_BASE = "0x4200000000000000000000000000000000000006";
  const payload1 = JSON.stringify({ address: USDC_BASE.toLowerCase(), chain: "base", verdict: "safe", score: 97, agentAdvice: "APPROVE", flags: [], summary: "canonical USDC" });
  const hash1 = ethers.keccak256(ethers.toUtf8Bytes(payload1));

  const tx1 = await registry.recordVerdict(USDC_BASE, 8453, 97, 0, hash1);
  const rc1 = await tx1.wait();
  const ev = rc1.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "VerdictRecorded");
  ok("VerdictRecorded event emitted", !!ev);
  ok("event id = 0", ev.args.id === 0n);
  ok("event subject = USDC", ev.args.subject.toLowerCase() === USDC_BASE.toLowerCase());
  ok("event hash matches keccak of payload", ev.args.verdictHash === hash1);
  ok("event recorder = signer", ev.args.recorder === signerAddr);

  const hash2 = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ address: WETH_BASE.toLowerCase(), chain: "base", verdict: "caution", score: 61 })));
  await (await registry.recordVerdict(WETH_BASE, 8453, 61, 1, hash2)).wait();
  ok("totalVerdicts = 2", (await registry.totalVerdicts()) === 2n);

  // A second, newer verdict for the same subject (danger this time).
  const hash3 = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ address: USDC_BASE.toLowerCase(), chain: "base", verdict: "danger", score: 12 })));
  await (await registry.recordVerdict(USDC_BASE, 8453, 12, 2, hash3)).wait();
  ok("totalVerdicts = 3", (await registry.totalVerdicts()) === 3n);
  ok("verdictCountFor USDC = 2", (await registry.verdictCountFor(USDC_BASE)) === 2n);
  ok("verdictCountFor WETH = 1", (await registry.verdictCountFor(WETH_BASE)) === 1n);

  console.log("== reads ==");
  const v0 = await registry.getVerdict(0);
  ok("getVerdict(0).score = 97", v0.score === 97n || v0.score === 97);
  ok("getVerdict(0).verdict = 0 (safe)", Number(v0.verdict) === 0);
  ok("getVerdict(0).sourceChain = 8453", v0.sourceChain === 8453n);
  ok("getVerdict(0).hash = hash1", v0.verdictHash === hash1);
  ok("getVerdict(0).timestamp > 0", v0.timestamp > 0n);

  const latest = await registry.latestFor(USDC_BASE);
  ok("latestFor found", latest.found === true);
  ok("latestFor id = 2 (newest)", latest.id === 2n);
  ok("latestFor verdict = 2 (danger)", Number(latest.verdict) === 2);
  ok("latestFor score = 12", Number(latest.score) === 12);

  const none = await registry.latestFor("0x000000000000000000000000000000000000dEaD");
  ok("latestFor unknown subject -> found=false", none.found === false);

  console.log("== guards ==");
  // staticCall surfaces the decoded revert reason (estimateGas on ganache
  // hides it); a staticCall revert proves the guard fires before any write.
  await mustRevert("score > 100 rejected", registry.recordVerdict.staticCall(USDC_BASE, 8453, 101, 0, hash1), "score > 100");
  await mustRevert("verdict > 2 rejected", registry.recordVerdict.staticCall(USDC_BASE, 8453, 50, 3, hash1), "verdict > 2");
  await mustRevert("zero subject rejected", registry.recordVerdict.staticCall(ethers.ZeroAddress, 8453, 50, 0, hash1), "zero subject");
  await mustRevert("zero hash rejected", registry.recordVerdict.staticCall(USDC_BASE, 8453, 50, 0, ethers.ZeroHash), "zero hash");
  ok("failed records did not append", (await registry.totalVerdicts()) === 3n);

  console.log("== no funds / no owner surface ==");
  const names = artifact.abi.filter((x) => x.type === "function").map((x) => x.name);
  ok("no payable functions", artifact.abi.every((x) => x.stateMutability !== "payable"));
  ok("no owner()/withdraw surface", !names.includes("owner") && !names.includes("withdraw") && !names.includes("transferOwnership"));

  await server.close();
  console.log(`\nALL TESTS PASSED (${passed} assertions)`);
})().catch((e) => {
  console.error("\nTEST FAILURE:", e.message);
  process.exit(1);
});
