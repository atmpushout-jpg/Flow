/**
 * Local smoke test for the Flow MCP server.
 * Spawns index.js over stdio, runs MCP initialize -> tools/list -> tools/call,
 * and prints results. Exits non-zero on failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [path.join(dir, "index.js")], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null) continue; // notification, ignore
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

child.on("close", (code) => {
  if (pending.size > 0) {
    console.error(`child closed (code ${code}) with ${pending.size} pending requests`);
    process.exit(1);
  }
});

function notify(method, params) {
  // true JSON-RPC notification: no id, no response expected
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function send(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method} (id ${id})`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(payload, (err) => { if (err) { clearTimeout(t); pending.delete(id); reject(err); } });
  });
}

const fail = (m) => { console.error("FAIL:", m); child.kill(); process.exit(1); };

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flow-mcp-test", version: "0.0.1" },
  });
  if (init.error) fail("initialize: " + JSON.stringify(init.error));
  console.log("initialize ok ->", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  notify("notifications/initialized", {});

  const list = await send("tools/list", {});
  if (list.error) fail("tools/list: " + JSON.stringify(list.error));
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log("tools:", names.join(", "));
  if (!names.includes("flow_quote") || !names.includes("flow_health")) fail("missing tools");

  const health = await send("tools/call", { name: "flow_health", arguments: {} });
  if (health.error) fail("flow_health rpc: " + JSON.stringify(health.error));
  const healthText = health.result?.content?.[0]?.text ?? "";
  console.log("flow_health ->", healthText.slice(0, 300));
  if (health.result?.isError) fail("flow_health errored: " + healthText.slice(0, 200));

  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  const quote = await send("tools/call", {
    name: "flow_quote",
    arguments: { tokenIn: USDC, tokenOut: WETH, amountIn: "1000000" },
  });
  if (quote.error) fail("flow_quote rpc: " + JSON.stringify(quote.error));
  const qText = quote.result?.content?.[0]?.text ?? "";
  console.log("flow_quote (USDC->WETH $1) ->", qText);
  if (quote.result?.isError) fail("flow_quote errored: " + qText.slice(0, 200));
  const q = JSON.parse(qText);
  if (!q.bestOut || !q.venue) fail("quote missing bestOut/venue: " + qText.slice(0, 200));
  console.log(`parsed: bestOut=${q.bestOut} venue=${q.venue} edgeBps=${q.edgeBps}`);

  const bad = await send("tools/call", {
    name: "flow_quote",
    arguments: { tokenIn: "nope", tokenOut: WETH, amountIn: "1000000" },
  });
  console.log("bad-input ->", bad.result?.isError ? "isError (good)" : "MISSING isError");
  if (!bad.result?.isError) fail("bad input did not return isError");

  console.log("\nALL TESTS PASSED");
  child.kill();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
