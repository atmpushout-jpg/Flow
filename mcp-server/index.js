#!/usr/bin/env node
/**
 * @flowexecutor/flow-mcp — MCP server for the Flow best-execution swap quote API on Base.
 *
 * Tools:
 *   flow_quote  — multi-venue swap quote (Uniswap V3, Aerodrome) with edge vs baseline,
 *                 liquidity flag, block number and latency.
 *   flow_health — API health check (chain, latest block).
 *   flow_signals — chronological smart-wallet signal feed for polling
 *                 (paid x402 endpoint; pass an x402 X-PAYMENT header value
 *                 obtained from your own wallet to retrieve fresh data).
 *
 * Read-only: never touches user funds or private keys.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.FLOW_API_BASE || "https://flow-kg4x.vercel.app";

const server = new McpServer({
  name: "@flowexecutor/flow-mcp",
  version: "0.1.0",
});

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

server.tool(
  "flow_quote",
  "Get a best-execution swap quote on Base. Compares Uniswap V3, PancakeSwap V3 and Aerodrome (plus two-hop routes via WETH), " +
    "returns the winning venue, expected output, edge in bps vs the baseline, " +
    "a liquidity flag (deep/watch/thin), the exact block number and timestamp, " +
    "and build latency. Read-only: no funds move.",
  {
    tokenIn: z
      .string()
      .describe("Input token contract address on Base (e.g. USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)"),
    tokenOut: z
      .string()
      .describe("Output token contract address on Base (e.g. WETH 0x4200000000000000000000000000000000000006)"),
    amountIn: z
      .string()
      .describe("Human-readable input amount, e.g. \"10\" for 10 USDC"),
    chainId: z
      .number()
      .optional()
      .describe("Chain id, defaults to 8453 (Base)"),
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

server.tool(
  "flow_signals",
  "Get the Flow smart-wallet signal feed: the most recent buy signals from " +
    "tracked Base wallets plus social-velocity spikes, newest first, each " +
    "with timestamp, block number, wallet, token, and signal score. " +
    "Supports incremental polling: pass `since` (unix seconds, unix ms, " +
    "ISO 8601, or a Base block number) to get only entries newer than your " +
    "last check, and use the returned cursor for the next poll. This is a " +
    "PAID x402 endpoint ($0.01 USDC on Base): pass a signed x402 v2 " +
    "X-PAYMENT header value via `paymentHeader`. Without one, the tool " +
    "returns the endpoint's 402 payment requirements so you can pay with " +
    "your own wallet and retry. Read-only: never touches funds or keys.",
  {
    since: z
      .string()
      .optional()
      .describe("Only return entries newer than this: unix seconds/ms, ISO 8601 timestamp, or Base block number"),
    limit: z
      .number()
      .optional()
      .describe("Max signals to return, 1..100 (default 50)"),
    paymentHeader: z
      .string()
      .optional()
      .describe("Base64 x402 v2 X-PAYMENT header value authorizing $0.01 USDC on Base to the Flow payee (from the 402 response)"),
  },
  async ({ since, limit, paymentHeader }) => {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    const headers = paymentHeader ? { "X-PAYMENT": paymentHeader } : {};
    const res = await fetch(`${API_BASE}/api/signals${qs ? `?${qs}` : ""}`, { headers });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text, status: res.status };
    }
    if (res.status === 402) {
      return {
        content: [
          {
            type: "text",
            text:
              "Flow signals is a paid x402 endpoint ($0.01 USDC on Base). " +
              "Pay the requirements below with your own wallet and call " +
              "flow_signals again with paymentHeader set to the X-PAYMENT value:\n" +
              JSON.stringify(data, null, 2),
          },
        ],
      };
    }
    if (data.error) {
      return { content: [{ type: "text", text: `Flow signals error: ${data.error}` }] };
    }
    const lines = (data.signals || [])
      .slice(0, 10)
      .map(
        (s) =>
          `${s.timestamp} block ${s.blockNumber}: ${s.wallet?.slice(0, 10)}… ${s.side} ${s.symbol} $${s.amountUsd} (score ${s.signalScore}${s.stale ? ", STALE" : ""})`
      );
    const summary = [
      `Signals returned: ${data.returned} of ${data.available} available (data as of ${data.dataAsOf}, source ${data.source})`,
      ...lines,
      data.cursor ? `Next poll: flow_signals since=${data.cursor.lastTimestamp || data.cursor.lastBlock}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data, null, 2) },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
