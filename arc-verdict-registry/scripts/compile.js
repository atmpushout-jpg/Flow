"use strict";
// Compile FlowVerdictRegistry.sol with solc-js -> build/FlowVerdictRegistry.json
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "contracts", "FlowVerdictRegistry.sol");
const OUT = path.join(ROOT, "build", "FlowVerdictRegistry.json");

function compile() {
  const source = fs.readFileSync(SRC, "utf8");
  const input = {
    language: "Solidity",
    sources: { "FlowVerdictRegistry.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("solc compilation failed");
  }
  const warnings = (out.errors || []).filter((e) => e.severity === "warning");
  for (const w of warnings) console.error("solc warning:", w.message);
  const c = out.contracts["FlowVerdictRegistry.sol"].FlowVerdictRegistry;
  const artifact = {
    contractName: "FlowVerdictRegistry",
    solcVersion: solc.version(),
    abi: c.abi,
    bytecode: "0x" + c.evm.bytecode.object,
    sourceHash: require("crypto").createHash("sha256").update(source).digest("hex"),
    compiledAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  return artifact;
}

if (require.main === module) {
  const a = compile();
  console.log("compiled FlowVerdictRegistry");
  console.log("  solc:", a.solcVersion);
  console.log("  bytecode bytes:", (a.bytecode.length - 2) / 2);
  console.log("  artifact:", OUT);
}

module.exports = { compile };
