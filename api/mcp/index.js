// /api/mcp — Flow MCP server over Streamable HTTP (stateless).
//
// Same tools as the @flowexecutor/flow-mcp stdio package, but hosted at a
// public HTTPS URL for directories/clients that require a remote endpoint
// (e.g. Smithery's "Publish an MCP Server").
//
// Tools: flow_quote, flow_health. Read-only: never touches funds or keys.
// Stateless: a fresh server + transport is created per request, so this runs
// fine on Vercel serverless. No session state kept.

const API_BASE = process.env.FLOW_API_BASE || "https://flow-kg4x.vercel.app";

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  return res.json();
}

async function createServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { z } = await import("zod");

  const server = new McpServer({
    name: "@flowexecutor/flow-mcp",
    version: "0.1.0",
  });

  server.tool(
    "flow_quote",
    "Get a best-execution swap quote on Base. Compares Uniswap V3 and Aerodrome, " +
      "returns the winning venue, expected output, edge in bps vs the baseline, " +
      "a liquidity flag (deep/watch/thin), the exact block number and timestamp, " +
      "and build latency. Read-only: no funds move.",
    {
      tokenIn: z
        .string()
        .describe("Input token contract address on Base (e.g. USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4E46E)"),
      tokenOut: z
        .string()
        .describe("Output token contract address on Base (e.g. WETH 0x4200000000000000000000000000000000000006)"),
      amountIn: z
        .string()
        .describe('Human-readable input amount, e.g. "10" for 10 USDC'),
      chainId: z.number().optional().describe("Chain id, defaults to 8453 (Base)"),
    },
    async ({ tokenIn, tokenOut, amountIn, chainId = 8453 }) => {
      const q = await postJson("/api/quote", { tokenIn, tokenOut, amountIn, chainId });
      if (q.error) {
        return { content: [{ type: "text", text: `Flow quote error: ${q.error}` }] };
      }
      const summary = [
        `Best output: ${q.bestOut} ${tokenOut.slice(0, 10)}… via ${q.venue}`,
        `Edge vs baseline: ${q.edgeBps} bps`,
        `Liquidity: ${q.liquidity} | Spread: ${q.spreadBps} bps`,
        `Block ${q.blockNumber} @ ${q.quotedAt} (${q.latencyMs}ms build)`,
        `Protocol fee: ${q.protocolFee}`,
      ].join("\n");
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(q, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "flow_health",
    "Check the Flow quote API health: status, chain, and latest synced block number.",
    {},
    async () => {
      const h = await getJson("/api/health");
      return {
        content: [{ type: "text", text: JSON.stringify(h, null, 2) }],
      };
    }
  );

  return server;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID"
  );
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const server = await createServer();
    // sessionIdGenerator: undefined => stateless mode (no session tracking).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: (e && e.message) || "mcp handler failed" });
    }
  }
};
