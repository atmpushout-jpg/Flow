#!/usr/bin/env node
/**
 * Flow MCP Server — Model Context Protocol wrapper for the Flow best-execution API.
 *
 * Gives any MCP-compatible AI agent direct access to Flow's multi-venue DEX
 * quoting on Base (Uniswap V3 + Aerodrome Slipstream/legacy). No API key needed.
 *
 * Tools:
 *   - flow_quote  : get best-execution quote for a token swap
 *   - flow_health : check API / chain health
 *
 * Transport: stdio (standard MCP server).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const FLOW_API = process.env.FLOW_API_URL || "https://flow-kg4x.vercel.app";
const CHAIN_ID = 8453; // Base

async function apiCall(path, body) {
  const res = await fetch(`${FLOW_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Flow API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const server = new Server(
  { name: "@flowexecutor/flow-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "flow_quote",
      description:
        "Get the best-execution quote for swapping one ERC-20 token for another on Base. " +
        "Compares Uniswap V3 and Aerodrome venues and returns the best route, expected output, " +
        "venue, fee tier, and edge vs baseline in basis points. No API key required. " +
        "amountIn is in raw token units (e.g. USDC has 6 decimals, so $1 = \"1000000\").",
      inputSchema: {
        type: "object",
        properties: {
          tokenIn: {
            type: "string",
            description: "ERC-20 contract address of the input token (checksummed or lowercase).",
          },
          tokenOut: {
            type: "string",
            description: "ERC-20 contract address of the output token.",
          },
          amountIn: {
            type: "string",
            description: "Amount of input token in raw units (wei-style integer as string).",
          },
        },
        required: ["tokenIn", "tokenOut", "amountIn"],
        additionalProperties: false,
      },
    },
    {
      name: "flow_health",
      description:
        "Check the health of the Flow API and the Base chain connection. " +
        "Returns chain id, latest block, and API status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "flow_quote") {
      const { tokenIn, tokenOut, amountIn } = args ?? {};
      if (!tokenIn || !tokenOut || !amountIn) {
        throw new Error("flow_quote requires tokenIn, tokenOut, and amountIn");
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenIn) || !/^0x[0-9a-fA-F]{40}$/.test(tokenOut)) {
        throw new Error("tokenIn and tokenOut must be valid 0x Ethereum addresses");
      }
      if (!/^\d+$/.test(String(amountIn))) {
        throw new Error("amountIn must be a non-negative integer string of raw units");
      }
      const quote = await apiCall("/api/quote", {
        tokenIn,
        tokenOut,
        amountIn: String(amountIn),
        chainId: CHAIN_ID,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(quote, null, 2) }],
      };
    }

    if (name === "flow_health") {
      const res = await fetch(`${FLOW_API}/api/health`);
      if (!res.ok) {
        throw new Error(`Flow API /api/health returned ${res.status}`);
      }
      const health = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Server speaks MCP over stdio from here on. Keep stderr for logs only.
console.error("flow-mcp listening on stdio");
